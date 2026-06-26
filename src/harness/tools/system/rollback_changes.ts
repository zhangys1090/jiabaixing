/**
 * Harness Tool: rollback_changes - 回滚文件到之前版本
 */

import * as fs from 'fs';
import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

/** 文件变更历史条目 */
interface FileChangeHistoryEntry {
  content: string;
  timestamp: number;
  description: string;
}

export const ROLLBACK_CHANGES_DEF: ToolDefinition = {
  name: 'rollback_changes',
  description:
    '回滚文件到之前的版本。适用场景：用户对修改不满意想要撤销、修改后发现问题需要恢复。不适用：没有修改历史的文件。',
  category: ToolCategory.SYSTEM,
  parameters: {
    file_path: {
      type: 'string',
      description: '要回滚的文件路径',
    },
    steps: {
      type: 'number',
      description: '回滚步数，默认1步（即上一次修改）',
      default: 1,
    },
  },
  requiredParams: ['file_path'],
  requiredPermissions: [Permission.FILE_WRITE],
  riskLevel: 'medium',
  idempotent: false,
  timeout: 10000,
};

/** rollback_changes 依赖接口 */
export interface RollbackChangesDeps {
  getHistory: (filePath: string) => Promise<FileChangeHistoryEntry[]>;
  removeHistory: (
    filePath: string,
    steps: number
  ) => Promise<FileChangeHistoryEntry[] | null>;
  /** 检查点服务（优先使用检查点回滚整个工作目录） */
  checkpointService?: {
    createCheckpoint(label: string): Promise<unknown>;
    listCheckpoints(): Array<{
      id: string;
      label: string;
      timestamp: number;
    }>;
    rollback(labelOrId: string): Promise<boolean>;
  };
}

/** 创建 rollback_changes 执行器 */
export function createRollbackChangesExecutor(deps: RollbackChangesDeps) {
  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const filePath = String(params.file_path || '');
    const steps = Number(params.steps) || 1;
    const traceId = context?.traceId || '';

    if (!filePath) {
      return {
        success: false,
        output: null,
        error: '请提供文件路径',
        duration: 0,
        validated: false,
      };
    }

    if (steps < 1) {
      return {
        success: false,
        output: null,
        error: '回滚步数必须大于0',
        duration: 0,
        validated: false,
      };
    }

    // 优先使用检查点回滚整个工作目录
    if (deps.checkpointService) {
      try {
        const checkpoints = deps.checkpointService.listCheckpoints();
        if (checkpoints.length >= steps) {
          const target = checkpoints[steps - 1];
          const rolledBack = await deps.checkpointService.rollback(target.id);
          if (rolledBack) {
            Logger.info(
              `↩️ 通过检查点回滚工作目录: ${target.label} (${target.id})`,
              'RollbackChanges'
            );

            void EventBus.emit('file_rollback', {
              traceId,
              filePath,
              success: true,
              timestamp: new Date().toISOString(),
            });

            return {
              success: true,
              output: `已通过检查点回滚工作目录到 ${steps} 步前的状态\n检查点: ${target.label}`,
              duration: 0,
              validated: false,
            };
          }
          // 检查点回滚失败，回退到历史记录模式
          Logger.warn('检查点回滚失败，回退到历史记录模式', 'RollbackChanges');
        }
      } catch (cpErr) {
        Logger.warn(
          `检查点回滚异常，回退到历史记录模式: ${(cpErr as Error).message}`,
          'RollbackChanges'
        );
      }
    }

    const history = await deps.getHistory(filePath);
    if (!history || history.length === 0) {
      return {
        success: false,
        output: null,
        error: `文件 ${filePath} 没有修改历史，无法回滚`,
        duration: 0,
        validated: false,
      };
    }

    if (steps > history.length) {
      return {
        success: false,
        output: null,
        error: `回滚步数 ${steps} 超过历史记录数量 ${history.length}`,
        duration: 0,
        validated: false,
      };
    }

    try {
      const targetEntry = history[steps - 1];
      fs.writeFileSync(filePath, targetEntry.content, 'utf-8');
      await deps.removeHistory(filePath, steps);

      Logger.info(
        `↩️ 回滚文件: ${filePath} 到 ${steps} 步前的版本`,
        'RollbackChanges'
      );

      void EventBus.emit('file_rollback', {
        traceId,
        filePath,
        success: true,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        output: `已将 ${filePath} 回滚到 ${steps} 步前的版本\n修改内容: ${targetEntry.description}`,
        duration: 0,
        validated: false,
      };
    } catch (err) {
      Logger.error(`回滚失败: ${filePath}`, err as Error, 'RollbackChanges');
      return {
        success: false,
        output: null,
        error: `回滚失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
