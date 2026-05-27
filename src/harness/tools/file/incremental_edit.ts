/**
 * Harness Tool: incremental_edit - 增量修改代码文件
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

/** 文件变更历史条目 */
interface FileChangeHistoryEntry {
  content: string;
  timestamp: number;
  description: string;
}

export const INCREMENTAL_EDIT_DEF: ToolDefinition = {
  name: 'incremental_edit',
  description:
    '增量修改代码文件，只修改需要改的部分，保持其他代码不变。支持语法验证和预览模式。适用场景：修改函数、添加功能、修复bug、重构局部代码。不适用：创建新文件、完全重写文件。',
  category: ToolCategory.FILE,
  parameters: {
    file_path: {
      type: 'string',
      description: '要修改的文件路径',
    },
    edits: {
      type: 'array',
      description:
        '修改列表，每项包含 {search: "要替换的代码", replace: "新代码", description: "修改说明"}',
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
    create_if_missing: {
      type: 'boolean',
      description: '文件不存在时是否创建',
      default: false,
    },
    preview_only: {
      type: 'boolean',
      description: '仅预览修改，不实际写入文件',
      default: false,
    },
    validate_syntax: {
      type: 'boolean',
      description: '是否验证修改后的语法（仅支持TS/JS）',
      default: false,
    },
  },
  requiredParams: ['file_path', 'edits'],
  requiredPermissions: [Permission.FILE_WRITE],
  riskLevel: 'medium',
  idempotent: false,
  timeout: 15000,
};

/** incremental_edit 依赖接口 */
export interface IncrementalEditDeps {
  addToHistory: (
    filePath: string,
    entry: FileChangeHistoryEntry
  ) => Promise<void>;
  validateCodeSyntax: (code: string, ext: string) => string[];
}

/** 创建 incremental_edit 执行器 */
export function createIncrementalEditExecutor(deps: IncrementalEditDeps) {
  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const filePath = String(params.file_path || '');
    const edits = (params.edits as IncrementalEdit[]) || [];
    const createIfMissing = Boolean(params.create_if_missing);
    const previewOnly = Boolean(params.preview_only);
    const validateSyntax = Boolean(params.validate_syntax);
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

    if (edits.length === 0) {
      return {
        success: false,
        output: null,
        error: '请提供至少一个修改项',
        duration: 0,
        validated: false,
      };
    }

    if (edits.length > 20) {
      return {
        success: false,
        output: null,
        error: '单次最多20个修改项，请分批操作',
        duration: 0,
        validated: false,
      };
    }

    try {
      const fileExists = fs.existsSync(filePath);
      if (!fileExists && !createIfMissing) {
        return {
          success: false,
          output: null,
          error: `文件不存在: ${filePath}。设置 create_if_missing=true 可创建新文件。`,
          duration: 0,
          validated: false,
        };
      }

      let content = fileExists ? fs.readFileSync(filePath, 'utf-8') : '';
      const originalContent = content;
      const appliedEdits: Array<{
        description: string;
        found: boolean;
        lineNumber?: number;
        preview?: string;
      }> = [];
      let modified = false;

      for (const edit of edits) {
        if (!edit.search || typeof edit.search !== 'string') {
          appliedEdits.push({
            description: edit.description || '修改代码',
            found: false,
          });
          continue;
        }

        const searchIndex = content.indexOf(edit.search);
        if (searchIndex !== -1) {
          const beforeLines = content.substring(0, searchIndex).split('\n');
          const lineNumber = beforeLines.length;

          const previewBefore = edit.search.split('\n').slice(0, 3).join('\n');
          const previewAfter = (edit.replace || '')
            .split('\n')
            .slice(0, 3)
            .join('\n');

          content = content.replaceAll(edit.search, edit.replace || '');
          appliedEdits.push({
            description: edit.description || '修改代码',
            found: true,
            lineNumber,
            preview: `行${lineNumber}:\n- ${previewBefore}\n+ ${previewAfter}`,
          });
          modified = true;
        } else {
          appliedEdits.push({
            description: edit.description || '修改代码',
            found: false,
          });
        }
      }

      if (!modified) {
        return {
          success: false,
          output: null,
          error: `未找到任何要修改的代码片段。\n${appliedEdits.map((e) => `- "${e.description}": 未找到`).join('\n')}`,
          duration: 0,
          validated: false,
        };
      }

      if (validateSyntax && !previewOnly) {
        const ext = path.extname(filePath).toLowerCase();
        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
          const syntaxErrors = deps.validateCodeSyntax(content, ext);
          if (syntaxErrors.length > 0) {
            Logger.warn(
              `⚠️ 语法验证发现问题: ${syntaxErrors.length}个`,
              'IncrementalEdit'
            );
            return {
              success: false,
              output: null,
              error: `语法验证失败，修改未应用:\n${syntaxErrors.join('\n')}\n\n建议：检查替换的代码是否完整，或设置 validate_syntax=false 跳过验证。`,
              duration: 0,
              validated: false,
              metadata: { syntaxErrors },
            };
          }
        }
      }

      if (previewOnly) {
        return {
          success: true,
          output: `预览模式 - 以下修改将被应用:\n${appliedEdits
            .filter((e) => e.found)
            .map((e) => e.preview)
            .join(
              '\n\n'
            )}\n\n共${appliedEdits.filter((e) => e.found).length}处修改。设置 preview_only=false 以实际执行。`,
          duration: 0,
          validated: false,
          metadata: {
            preview: appliedEdits.filter((e) => e.found),
            appliedCount: appliedEdits.filter((e) => e.found).length,
          },
        };
      }

      await deps.addToHistory(filePath, {
        content: originalContent,
        timestamp: Date.now(),
        description: appliedEdits
          .filter((e) => e.found)
          .map((e) => e.description)
          .join(', '),
      });

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf-8');

      Logger.info(
        `✏️ 增量修改: ${filePath} (${appliedEdits.filter((e) => e.found).length}/${edits.length}个修改已应用)`,
        'IncrementalEdit'
      );

      void EventBus.emit('file_modified', {
        traceId,
        filePath,
        changeType: 'modified' as const,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        output: `已修改 ${filePath}\n应用的修改: ${appliedEdits.filter((e) => e.found).length}/${edits.length}\n${appliedEdits.map((e) => `- ${e.description}: ${e.found ? `✓ 行${e.lineNumber}` : '✗ 未找到'}`).join('\n')}`,
        duration: 0,
        validated: false,
        metadata: { appliedEdits },
      };
    } catch (err) {
      Logger.error(
        `增量修改失败: ${filePath}`,
        err as Error,
        'IncrementalEdit'
      );
      return {
        success: false,
        output: null,
        error: `修改失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
