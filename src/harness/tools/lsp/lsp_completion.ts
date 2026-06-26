/**
 * Harness Tool: lsp_completion - 获取 LSP 代码补全
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const LSP_COMPLETION_DEF: ToolDefinition = {
  name: 'lsp_completion',
  description:
    '获取代码补全建议。适用场景：用户需要代码自动补全、查看可用方法/属性、获取代码片段。不适用：诊断问题（用 lsp_diagnostics）、悬停文档（用 lsp_hover）。',
  category: ToolCategory.CODE,
  parameters: {
    uri: {
      type: 'string',
      description: '文件 URI，如 file:///path/to/file.ts',
    },
    line: {
      type: 'number',
      description: '行号（从0开始）',
    },
    character: {
      type: 'number',
      description: '列号（从0开始）',
    },
  },
  requiredParams: ['uri', 'line', 'character'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'low',
  idempotent: true,
  timeout: 10000,
};

export interface LspCompletionDeps {
  getCompletions?: (
    uri: string,
    position: { line: number; character: number }
  ) => Promise<{
    uri: string;
    position: { line: number; character: number };
    items: Array<{
      label: string;
      kind?: string;
      detail?: string;
      documentation?: string;
      insertText?: string;
    }>;
  }>;
  formatCompletions?: (result: {
    uri: string;
    position: { line: number; character: number };
    items: Array<{
      label: string;
      kind?: string;
      detail?: string;
      documentation?: string;
      insertText?: string;
    }>;
  }) => string;
}

export function createLspCompletionExecutor(deps: LspCompletionDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const uri = params.uri as string;
    const line = params.line as number;
    const character = params.character as number;

    try {
      if (!deps.getCompletions) {
        return {
          success: false,
          output: 'LSP 补全服务不可用',
          error: 'getCompletions 未提供',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const result = await deps.getCompletions(uri, { line, character });

      return {
        success: true,
        output:
          deps.formatCompletions?.(result) ?? JSON.stringify(result.items),
        duration: Date.now() - startTime,
        validated: true,
        structuredOutput: {
          type: 'json',
          content: JSON.stringify(
            result.items.map((i) => ({
              label: i.label,
              kind: i.kind,
              detail: i.detail,
            }))
          ),
          summary: `${result.uri}:${line + 1}:${character + 1} — ${result.items.length} 个补全项`,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: `LSP 补全失败: ${(error as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
