/**
 * Harness Tool: memory_recall - 搜索用户历史记忆
 *
 * 增强功能：
 * - 访问追踪：召回记忆后更新 accessCount 和 lastAccessedAt
 * - 依赖注入：支持注入 MemoryAssistant 实例作为备用检索源
 */

import type { MemoryAssistant } from '../../../core/MemoryAssistant';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../utils/Logger';

export const MEMORY_RECALL_DEF: ToolDefinition = {
  name: 'memory_recall',
  description:
    '搜索用户的历史记忆和背景信息。注意：系统已自动注入了部分相关记忆到上下文中，此工具用于获取更多或不同维度的记忆。适用场景：用户提到"之前说过"、"上次聊的"、"我记得"、或者你需要了解用户偏好/习惯/背景时。不适用：普通聊天问候、上下文中已有足够信息。',
  category: ToolCategory.MEMORY,
  parameters: {
    query: {
      type: 'string',
      description: '搜索关键词，如"用户喜欢的音乐"、"上次讨论的项目"',
    },
    limit: {
      type: 'number',
      description: '返回结果数量上限，默认3',
      default: 5,
    },
  },
  requiredParams: ['query'],
  requiredPermissions: [Permission.MEMORY_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 10000,
};

/** memory_recall 依赖接口 */
export interface MemoryRecallDeps {
  retrieveRelevant?: (query: {
    query: string;
    limit: number;
  }) => Promise<unknown[]>;
  updateAccessStats?: (query: string) => Promise<void>;
  /** 可选的 MemoryAssistant 实例，当 retrieveRelevant 不可用时作为备用 */
  memoryAssistant?: MemoryAssistant;
  /** 模糊检索模式：启用子串分词匹配 + 相关度排序 */
  fuzzyMatch?: boolean;
}

/** 创建 memory_recall 执行器 */
export function createMemoryRecallExecutor(deps: MemoryRecallDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const query = String(params.query || '');
    const limit = Number(params.limit) || 5;

    if (!query) {
      return {
        success: true,
        output: '请输入搜索关键词',
        duration: 0,
        validated: false,
      };
    }

    // 尝试使用 deps.retrieveRelevant（生产环境注入）
    if (deps.retrieveRelevant) {
      try {
        const memories = await deps.retrieveRelevant({ query, limit });

        if (deps.updateAccessStats && memories.length > 0) {
          deps.updateAccessStats(query).catch((err) =>
            Logger.warn('更新记忆访问统计失败（非关键）', err as Error, 'memory_recall')
          );
        }

        let results = memories;
        if (deps.fuzzyMatch && memories.length === 0) {
          const allMemories = await deps.retrieveRelevant({
            query: '',
            limit: 1000,
          });
          const queryTokens = tokenize(query);
          const scored = allMemories
            .map((m) => {
              const item = m as { content: string; importance?: number };
              const contentTokens = tokenize(item.content);
              let matchScore = 0;
              for (const qt of queryTokens) {
                for (const ct of contentTokens) {
                  if (ct.includes(qt) || qt.includes(ct)) {
                    matchScore += qt.length;
                  }
                }
              }
              if (item.content.includes(query)) matchScore += query.length * 2;
              return { item: m, score: matchScore };
            })
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          results = scored.map((s) => s.item);
        }

        const formatted = results
          .map((m, i) => {
            const item = m as {
              content: string;
              importance?: number;
              accessCount?: number;
            };
            const meta =
              item.importance != null ? ` [重要性:${item.importance}]` : '';
            return `${i + 1}. ${item.content}${meta}`;
          })
          .join('\n');
        return {
          success: true,
          output: formatted || '未找到相关记忆',
          duration: 0,
          validated: false,
        };
      } catch {
        return {
          success: true,
          output: '记忆检索暂不可用',
          duration: 0,
          validated: false,
        };
      }
    }

    // 备用方案：通过 MemoryAssistant.retrieveContext 检索
    if (deps.memoryAssistant) {
      try {
        const result = await deps.memoryAssistant.retrieveContext(query);
        const memories = result.memories || [];

        if (memories.length === 0) {
          return {
            success: true,
            output: '未找到相关记忆',
            duration: 0,
            validated: false,
          };
        }

        const filtered = memories.slice(0, limit);
        const formatted = filtered
          .map(
            (m, i) =>
              `${i + 1}. ${m.content} [类型:${m.type}, 相关度:${(m.relevance * 100).toFixed(0)}%]`
          )
          .join('\n');

        return {
          success: true,
          output: formatted,
          duration: 0,
          validated: false,
        };
      } catch {
        return {
          success: true,
          output: '记忆检索暂不可用',
          duration: 0,
          validated: false,
        };
      }
    }

    // 无任何检索源可用
    return {
      success: true,
      output: '暂无可用记忆',
      duration: 0,
      validated: false,
    };
  };
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  let i = 0;
  while (i < text.length) {
    if (cjkRegex.test(text[i])) {
      for (let len = Math.min(4, text.length - i); len >= 2; len--) {
        tokens.push(text.substring(i, i + len));
      }
      tokens.push(text[i]);
      i++;
    } else {
      let end = i;
      while (
        end < text.length &&
        !cjkRegex.test(text[end]) &&
        /[\w]/.test(text[end])
      ) {
        end++;
      }
      if (end > i) {
        tokens.push(text.substring(i, end).toLowerCase());
      }
      i = end + 1;
    }
  }
  return tokens;
}
