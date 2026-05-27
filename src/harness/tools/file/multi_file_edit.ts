/**
 * Harness Tool: multi_file_edit - 多文件原子修改
 */

import * as fs from 'fs';
import path from 'path';
import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

/** 增量编辑项 */
interface IncrementalEdit {
  search: string;
  replace?: string;
  description?: string;
}

/** 多文件编辑项 */
interface MultiFileEditItem {
  path: string;
  edits?: IncrementalEdit[];
}

/** 多文件编辑结果 */
interface MultiFileEditResult {
  path: string;
  success: boolean;
  appliedCount: number;
  error?: string;
}

/** 文件变更历史条目 */
interface FileChangeHistoryEntry {
  content: string;
  timestamp: number;
  description: string;
}

export const MULTI_FILE_EDIT_DEF: ToolDefinition = {
  name: 'multi_file_edit',
  description:
    '同时修改多个文件，保持修改的原子性。适用场景：重构涉及多个文件、添加功能需要修改多处、API变更需要同步更新。不适用：单文件修改（用 incremental_edit）。',
  category: ToolCategory.FILE,
  parameters: {
    files: {
      type: 'array',
      description:
        '文件修改列表，每项包含 {path, edits: [{search, replace, description}]}',
      items: {
        type: 'object',
        description: '文件修改项',
        properties: {
          path: { type: 'string', description: '文件路径' },
          edits: {
            type: 'array',
            description: '修改列表',
            items: {
              type: 'object',
              description: '修改项',
              properties: {
                search: { type: 'string', description: '要替换的代码' },
                replace: { type: 'string', description: '新代码' },
                description: { type: 'string', description: '修改说明' },
              },
            },
          },
        },
      },
    },
    atomic: {
      type: 'boolean',
      description: '是否原子操作（任一失败则全部回滚）',
      default: false,
    },
  },
  requiredParams: ['files'],
  requiredPermissions: [Permission.FILE_WRITE],
  riskLevel: 'high',
  idempotent: false,
  timeout: 30000,
  requiresConfirmation: true,
};

/** multi_file_edit 依赖接口 */
export interface MultiFileEditDeps {
  addToHistory: (
    filePath: string,
    entry: FileChangeHistoryEntry
  ) => Promise<void>;
  removeHistory: (
    filePath: string,
    steps: number
  ) => Promise<FileChangeHistoryEntry[] | null>;
}

/** 创建 multi_file_edit 执行器 */
export function createMultiFileEditExecutor(deps: MultiFileEditDeps) {
  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const files = (params.files as MultiFileEditItem[]) || [];
    const atomic = Boolean(params.atomic);
    const traceId = context?.traceId || '';

    if (files.length === 0) {
      return {
        success: false,
        output: null,
        error: '请提供至少一个文件修改项',
        duration: 0,
        validated: false,
      };
    }

    if (files.length > 50) {
      return {
        success: false,
        output: null,
        error: '单次最多修改50个文件，请分批操作',
        duration: 0,
        validated: false,
      };
    }

    const results: MultiFileEditResult[] = [];
    const rollbackStack: Array<{ path: string; originalContent: string }> = [];

    for (const file of files) {
      const filePath = file.path;
      const edits = file.edits || [];

      if (!filePath || typeof filePath !== 'string') {
        results.push({
          path: filePath || '未知路径',
          success: false,
          appliedCount: 0,
          error: '无效的文件路径',
        });
        continue;
      }

      try {
        const fileExists = fs.existsSync(filePath);
        let content = fileExists ? fs.readFileSync(filePath, 'utf-8') : '';
        const originalContent = content;

        let appliedCount = 0;
        for (const edit of edits) {
          if (
            edit.search &&
            typeof edit.search === 'string' &&
            content.includes(edit.search)
          ) {
            content = content.replaceAll(edit.search, edit.replace || '');
            appliedCount++;
          }
        }

        if (appliedCount > 0) {
          rollbackStack.push({ path: filePath, originalContent });

          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          fs.writeFileSync(filePath, content, 'utf-8');

          await deps.addToHistory(filePath, {
            content: originalContent,
            timestamp: Date.now(),
            description: `多文件修改: ${appliedCount}处`,
          });

          results.push({ path: filePath, success: true, appliedCount });
        } else {
          results.push({
            path: filePath,
            success: false,
            appliedCount: 0,
            error: '未找到任何匹配的代码片段',
          });
        }
      } catch (err) {
        results.push({
          path: filePath,
          success: false,
          appliedCount: 0,
          error: (err as Error).message,
        });
      }
    }

    const failures = results.filter((r) => !r.success);

    if (atomic && failures.length > 0 && rollbackStack.length > 0) {
      Logger.info(
        `↩️ 原子模式：回滚 ${rollbackStack.length} 个文件`,
        'MultiFileEdit'
      );

      for (const item of rollbackStack) {
        try {
          fs.writeFileSync(item.path, item.originalContent, 'utf-8');
          await deps.removeHistory(item.path, 1);
        } catch {
          // 忽略回滚错误
        }
      }

      return {
        success: false,
        output: null,
        error: `原子模式：部分修改失败，已回滚所有修改\n失败: ${failures.map((f) => `${f.path}: ${f.error}`).join('\n')}`,
        duration: 0,
        validated: false,
      };
    }

    void EventBus.emit('multi_file_modified', {
      traceId,
      files: results.map((r) => ({
        path: r.path,
        changeType: 'modified' as const,
      })),
      timestamp: new Date().toISOString(),
    });

    const successCount = results.filter((r) => r.success).length;
    Logger.info(
      `📝 多文件修改: ${successCount}/${files.length} 个文件成功`,
      'MultiFileEdit'
    );

    return {
      success: failures.length === 0,
      output: `修改完成: ${successCount}/${files.length} 个文件\n${results.map((r) => `- ${r.path}: ${r.success ? `✓ ${r.appliedCount}处修改` : `✗ ${r.error}`}`).join('\n')}`,
      duration: 0,
      validated: false,
      metadata: { results },
    };
  };
}
