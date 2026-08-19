/**
 * 知识查询工具 — 基于知识图谱的智能问答
 *
 * 从 Hermes 学到的核心能力：
 * - 知识与记忆：索引、搜索、记忆并对个人或团队知识进行推理
 * - 不只是搜索，而是推理
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const KNOWLEDGE_QUERY_DEF: ToolDefinition = {
  name: 'knowledge_query',
  description:
    '基于个人知识库的智能问答。USE WHEN: 用户问"我之前做过什么"、"关于XX的记忆"、"我的偏好是什么"、"上次我们聊了什么"。DO NOT USE WHEN: 用户要搜索网络信息（用web_search）或存储新记忆（用memory_store）。从记忆中推理答案，不只是搜索。',
  category: ToolCategory.MEMORY,
  parameters: {
    query: {
      type: 'string',
      description: '用户的问题',
    },
    scope: {
      type: 'string',
      description: '查询范围',
      enum: ['all', 'preferences', 'history', 'knowledge', 'tasks'],
      default: 'all',
    },
    max_results: {
      type: 'number',
      description: '最大结果数',
      default: 10,
    },
  },
  requiredParams: ['query'],
  requiredPermissions: [Permission.MEMORY_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 15000,
};

export interface KnowledgeQueryDeps {
  memoryRecall?: (
    query: string,
    limit: number
  ) => Promise<
    Array<{
      content: unknown;
      type?: string;
      timestamp?: Date;
      relevanceScore?: number;
    }>
  >;
  getUserProfile?: () => {
    name?: string;
    preferences?: Record<string, unknown>;
    recentTopics?: string[];
  } | null;
  getConversationHistory?: (limit: number) => Array<{
    role: string;
    content: string;
    timestamp?: Date;
  }>;
  /** D1: 记忆召回不足时的网络检索降级（RAG 闭环）。由 registerHarnessTools 注入 searchEngine 适配。 */
  webSearch?: (
    query: string,
    limit: number,
    context?: ToolContext
  ) => Promise<Array<{ content: string; source?: string }>>;
  /** D1: 记忆回填（RAG 闭环）—— 网络检索补强结果写回记忆，供后续直接命中 */
  memoryStore?: (query: string, content: string) => Promise<void> | void;
}

export function createKnowledgeQueryExecutor(deps: KnowledgeQueryDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const query = String(params.query || '');
    const scope = String(params.scope || 'all');
    const maxResults = Number(params.max_results || 10);

    try {
      const results: string[] = [];

      // 1. 从记忆中检索
      if (
        deps.memoryRecall &&
        (scope === 'all' || scope === 'knowledge' || scope === 'history')
      ) {
        const memories = await deps.memoryRecall(query, maxResults);
        if (memories.length > 0) {
          results.push('📚 相关记忆:');
          for (const mem of memories) {
            const content =
              typeof mem.content === 'string'
                ? mem.content
                : JSON.stringify(mem.content);
            const time = mem.timestamp
              ? new Date(mem.timestamp).toLocaleString('zh-CN')
              : '';
            results.push(
              `  • ${content.substring(0, 150)}${time ? ` (${time})` : ''}`
            );
          }
          results.push('');
        }
      }

      // 2. 用户偏好
      if (deps.getUserProfile && (scope === 'all' || scope === 'preferences')) {
        const profile = deps.getUserProfile();
        if (profile) {
          results.push('👤 用户画像:');
          if (profile.name) results.push(`  名字: ${profile.name}`);
          if (profile.preferences) {
            for (const [key, value] of Object.entries(profile.preferences)) {
              results.push(`  ${key}: ${JSON.stringify(value)}`);
            }
          }
          if (profile.recentTopics && profile.recentTopics.length > 0) {
            results.push(`  最近话题: ${profile.recentTopics.join(', ')}`);
          }
          results.push('');
        }
      }

      // 3. 对话历史
      if (
        deps.getConversationHistory &&
        (scope === 'all' || scope === 'history')
      ) {
        const history = deps.getConversationHistory(10);
        if (history.length > 0) {
          results.push('💬 最近对话:');
          for (const msg of history.slice(-5)) {
            const time = msg.timestamp
              ? new Date(msg.timestamp).toLocaleTimeString('zh-CN')
              : '';
            results.push(
              `  [${msg.role}] ${msg.content.substring(0, 100)}${time ? ` (${time})` : ''}`
            );
          }
          results.push('');
        }
      }

      // D1: RAG 闭环 — 记忆召回不足时自动降级 web_search 并回填记忆
      if (results.length === 0 && deps.webSearch) {
        try {
          const web = await deps.webSearch(query, maxResults, _context);
          if (web.length > 0) {
            results.push('🌐 网络检索补强 (记忆不足，已自动降级搜索):');
            for (const item of web.slice(0, maxResults)) {
              results.push(
                `  • ${item.content.substring(0, 200)}${item.source ? ` (${item.source})` : ''}`
              );
            }
            results.push('');
            // 回填记忆（RAG 闭环）：把检索到的知识写回，供后续直接命中
            if (deps.memoryStore) {
              const combined = web.map((w) => w.content).join('\n');
              try {
                await deps.memoryStore(query, combined);
              } catch (be) {
                Logger.debug(
                  `⚠️ D1: 记忆回填失败: ${(be as Error).message}`,
                  'KnowledgeQuery'
                );
              }
            }
          }
        } catch (we) {
          Logger.warn(
            `⚠️ D1: web_search 降级失败: ${(we as Error).message}`,
            'KnowledgeQuery'
          );
        }
      }

      if (results.length === 0) {
        return {
          success: true,
          output: `没有找到与"${query}"相关的知识。可以尝试:\n1. 用更简短的关键词\n2. 存储一些记忆: memory_store\n3. 查看用户画像: knowledge_query scope=preferences`,
          duration: Date.now() - startTime,
          validated: true,
        };
      }

      return {
        success: true,
        output: results.join('\n'),
        duration: Date.now() - startTime,
        validated: true,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `知识查询失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
