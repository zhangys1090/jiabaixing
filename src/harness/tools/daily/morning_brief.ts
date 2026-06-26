/**
 * 晨报工具 — 自动搜索新闻并生成每日简报
 *
 * 从 Hermes Agent 学到的模式：
 * - 一个命令触发完整工作流
 * - Tavily 搜索获取实时信息
 * - LLM 总结为结构化简报
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const MORNING_BRIEF_DEF: ToolDefinition = {
  name: 'morning_brief',
  description:
    '生成每日简报：自动搜索今日新闻、科技动态、天气等，汇总为结构化简报。USE WHEN: 用户要求晨报、每日简报、今日新闻摘要。DO NOT USE WHEN: 用户要搜索特定话题（用web_search）。',
  category: ToolCategory.DAILY,
  parameters: {
    topics: {
      type: 'string',
      description: '关注的主题，逗号分隔。默认: AI,科技,互联网',
      default: 'AI,科技,互联网',
    },
    max_items: {
      type: 'number',
      description: '每个主题的新闻条数',
      default: 3,
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: true,
  timeout: 60000,
};

export interface MorningBriefDeps {
  llm?: {
    chat(
      prompt: string,
      history?: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  };
  searchExecutor?: (
    params: Record<string, unknown>,
    context?: ToolContext
  ) => Promise<ToolResult>;
}

export function createMorningBriefExecutor(deps: MorningBriefDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const topics = String(params.topics || 'AI,科技,互联网')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const maxItems = Number(params.max_items || 3);

    try {
      // Step 1: 搜索每个主题
      const searchResults: Array<{ topic: string; results: string }> = [];

      for (const topic of topics) {
        if (deps.searchExecutor) {
          try {
            const result = await deps.searchExecutor({
              query: `${topic} 最新消息 今日`,
              max_results: maxItems,
              search_type: 'news',
            });
            if (result.success) {
              searchResults.push({
                topic,
                results: String(result.output),
              });
            }
          } catch (err) {
            Logger.warn(
              `搜索 ${topic} 失败: ${(err as Error).message}`,
              'MorningBrief'
            );
          }
        }
      }

      if (searchResults.length === 0) {
        return {
          success: false,
          output: null,
          error: '所有主题搜索失败，请检查网络连接',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      // Step 2: LLM 总结
      if (deps.llm) {
        const searchContext = searchResults
          .map((r) => `【${r.topic}】\n${r.results}`)
          .join('\n\n');

        const prompt = `你是御姐秘书家百星，请根据以下搜索结果生成今日简报。

搜索结果：
${searchContext}

要求：
1. 每个主题 2-3 条要点
2. 语言简洁专业
3. 有观点但不啰嗦
4. 总字数控制在 300-500 字
5. 用 Markdown 格式输出`;

        const summary = await deps.llm.chat(
          prompt,
          [],
          '你是一个专业的新闻编辑，擅长简洁有力的中文表达。'
        );

        return {
          success: true,
          output: summary,
          duration: Date.now() - startTime,
          validated: true,
          metadata: {
            topics,
            searchResultsCount: searchResults.length,
          },
        };
      }

      // 无 LLM 时返回原始搜索结果
      const rawOutput = searchResults
        .map((r) => `## ${r.topic}\n${r.results}`)
        .join('\n\n');

      return {
        success: true,
        output: rawOutput,
        duration: Date.now() - startTime,
        validated: true,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `晨报生成失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
