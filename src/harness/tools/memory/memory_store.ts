/**
 * Harness Tool: memory_store - 保存信息到长期记忆
 *
 * 增强功能：
 * - 重要性评分（1-10），>=7 的记忆可晋升为长期记忆
 * - 去重：内容相似度 >80% 时跳过存储
 * - 生命周期元数据：importance, category, createdAt, accessCount, lastAccessedAt
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const MEMORY_STORE_DEF: ToolDefinition = {
  name: 'memory_store',
  description:
    '保存重要信息到记忆系统。当用户要求"记住"、"记下"、"存储"、"保存"某个信息时，必须使用此工具。适用场景：用户告诉你姓名、职业、偏好、习惯、重要日期、待办事项等个人信息时。不适用：普通对话内容、设置提醒时间。',
  category: ToolCategory.MEMORY,
  parameters: {
    content: {
      type: 'string',
      description: '要保存的信息，如"用户喜欢喝咖啡"、"用户是程序员"',
    },
    category: {
      type: 'string',
      description:
        '信息分类：preference=偏好喜恶, fact=事实身份, task=待办任务, event=重要事件, other=其他',
      enum: ['preference', 'fact', 'task', 'event', 'other'],
    },
    importance: {
      type: 'number',
      description: '重要性评分（1-10），7分及以上可晋升为长期记忆，默认5',
      default: 5,
    },
  },
  requiredParams: ['content', 'category'],
  requiredPermissions: [Permission.MEMORY_WRITE],
  riskLevel: 'low',
  idempotent: false,
  timeout: 5000,
};

/** 记忆生命周期元数据 */
export interface MemoryMetadata {
  importance: number;
  category: string;
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

/** memory_store 依赖接口 */
export interface MemoryStoreDeps {
  storeShortTermMemory?: (
    content: string,
    category: string
  ) => Promise<boolean>;
  checkDuplicate?: (content: string, category: string) => Promise<boolean>;
  storeWithMetadata?: (
    content: string,
    category: string,
    metadata: MemoryMetadata
  ) => Promise<boolean>;
}

/**
 * 计算两个字符串的相似度（0-1）
 * 基于最长公共子序列比率
 */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  let prevRow = new Array(shorter.length + 1).fill(0) as number[];

  for (let i = 1; i <= longer.length; i++) {
    const currRow = new Array(shorter.length + 1).fill(0) as number[];
    for (let j = 1; j <= shorter.length; j++) {
      if (longer[i - 1] === shorter[j - 1]) {
        currRow[j] = prevRow[j - 1] + 1;
      } else {
        currRow[j] = Math.max(currRow[j - 1], prevRow[j]);
      }
    }
    prevRow = currRow;
  }

  const lcsLength = prevRow[shorter.length];
  return (2 * lcsLength) / (a.length + b.length);
}

/**
 * 检查内容是否与已有记忆重复（相似度 >80%）
 */
export function isDuplicateContent(
  content: string,
  existingMemories: string[]
): boolean {
  for (const existing of existingMemories) {
    const similarity = computeSimilarity(content, existing);
    if (similarity > 0.8) {
      return true;
    }
  }
  return false;
}

/** 创建 memory_store 执行器 */
export function createMemoryStoreExecutor(deps: MemoryStoreDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const content = String(params.content || '');
    const category = String(params.category || 'other');
    const importance = Math.min(
      10,
      Math.max(1, Number(params.importance) || 5)
    );

    if (!content.trim()) {
      return {
        success: false,
        output: '内容不能为空',
        duration: 0,
        validated: false,
      };
    }

    try {
      if (deps.checkDuplicate) {
        const isDuplicate = await deps.checkDuplicate(content, category);
        if (isDuplicate) {
          return {
            success: true,
            output: '已存在相似记忆',
            duration: 0,
            validated: false,
          };
        }
      }

      const now = Date.now();
      const metadata: MemoryMetadata = {
        importance,
        category,
        createdAt: now,
        accessCount: 0,
        lastAccessedAt: now,
      };

      if (deps.storeWithMetadata) {
        const stored = await deps.storeWithMetadata(
          content,
          category,
          metadata
        );
        if (stored === false) {
          return {
            success: false,
            output: '存储失败: 记忆引擎不可用',
            error: '记忆引擎不可用',
            duration: 0,
            validated: false,
          };
        }
      } else if (deps.storeShortTermMemory) {
        const stored = await deps.storeShortTermMemory(content, category);
        if (stored === false) {
          return {
            success: false,
            output: '存储失败: 记忆引擎不可用',
            error: '记忆引擎不可用',
            duration: 0,
            validated: false,
          };
        }
      }

      const importanceLabel =
        importance >= 7 ? '（高优先级，可晋升长期记忆）' : '';

      return {
        success: true,
        output: `已存储${importanceLabel}`,
        duration: 0,
        validated: false,
      };
    } catch (error) {
      return {
        success: false,
        output: `存储失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: 0,
        validated: false,
      };
    }
  };
}
