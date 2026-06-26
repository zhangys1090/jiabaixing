/**
 * Harness Tool: lsp_diagnostics - 获取 LSP 代码诊断
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const LSP_DIAGNOSTICS_DEF: ToolDefinition = {
  name: 'lsp_diagnostics',
  description:
    '获取文件的 LSP 诊断信息（错误、警告等）。适用场景：检查代码问题、获取类型错误、查看代码质量。不适用：代码补全（用 lsp_completion）、悬停信息（用 lsp_hover）。',
  category: ToolCategory.CODE,
  parameters: {
    uri: {
      type: 'string',
      description: '文件 URI，如 file:///path/to/file.ts',
    },
    severity: {
      type: 'string',
      description: '过滤严重级别: error, warning, info, hint',
      enum: ['error', 'warning', 'info', 'hint'],
    },
  },
  requiredParams: ['uri'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'low',
  idempotent: true,
  timeout: 15000,
};

export interface LspDiagnosticsDeps {
  getDiagnosticsForFile?: (uri: string) => Promise<{
    uri: string;
    errors: number;
    warnings: number;
    infos: number;
    hints: number;
    total: number;
    items: Array<{
      uri: string;
      line: number;
      character: number;
      severity: string;
      message: string;
      code?: number | string;
      source?: string;
    }>;
  }>;
  filterDiagnostics?: (
    summaries: Array<{
      uri: string;
      errors: number;
      warnings: number;
      infos: number;
      hints: number;
      total: number;
      items: Array<{
        uri: string;
        line: number;
        character: number;
        severity: string;
        message: string;
        code?: number | string;
        source?: string;
      }>;
    }>,
    filter: { severity?: string }
  ) => Array<{
    uri: string;
    errors: number;
    warnings: number;
    infos: number;
    hints: number;
    total: number;
    items: Array<{
      uri: string;
      line: number;
      character: number;
      severity: string;
      message: string;
      code?: number | string;
      source?: string;
    }>;
  }>;
  formatDiagnostics?: (summary: {
    uri: string;
    errors: number;
    warnings: number;
    infos: number;
    hints: number;
    total: number;
    items: Array<{
      uri: string;
      line: number;
      character: number;
      severity: string;
      message: string;
      code?: number | string;
      source?: string;
    }>;
  }) => string;
}

export function createLspDiagnosticsExecutor(deps: LspDiagnosticsDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const uri = params.uri as string;
    const severity = params.severity as string | undefined;

    try {
      if (!deps.getDiagnosticsForFile) {
        return {
          success: false,
          output: 'LSP 诊断服务不可用',
          error: 'getDiagnosticsForFile 未提供',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      let summary = await deps.getDiagnosticsForFile(uri);

      if (severity && deps.filterDiagnostics) {
        const filtered = deps.filterDiagnostics([summary], { severity });
        if (filtered.length > 0) {
          summary = filtered[0];
        }
      }

      const formatted = deps.formatDiagnostics
        ? deps.formatDiagnostics(summary)
        : JSON.stringify(summary, null, 2);

      return {
        success: true,
        output: formatted,
        duration: Date.now() - startTime,
        validated: true,
        structuredOutput: {
          type: 'json',
          content: JSON.stringify(summary),
          summary: `${summary.uri}: ${summary.errors}E ${summary.warnings}W ${summary.infos}I ${summary.hints}H`,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: `LSP 诊断失败: ${(error as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
