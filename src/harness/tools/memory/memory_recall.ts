/**
 * Harness Tool: memory_recall - 搜索用户历史记忆
 *
 * 增强功能：
 * - 访问追踪：召回记忆后更新 accessCount 和 lastAccessedAt
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

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
}

/** 创建 memory_recall 执行器 */
export function createMemoryRecallExecutor(deps: MemoryRecallDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const query = String(params.query || '');
    const limit = Number(params.limit) || 5;

    if (!deps.retrieveRelevant) {
      return {
        success: true,
        output: '暂无可用记忆',
        duration: 0,
        validated: false,
      };
    }

    try {
      const memories = await deps.retrieveRelevant({ query, limit });

      if (deps.updateAccessStats && memories.length > 0) {
        deps.updateAccessStats(query).catch(() => {});
      }

      const formatted = memories
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
  };
}
