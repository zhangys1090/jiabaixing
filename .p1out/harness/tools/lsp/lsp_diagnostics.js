"use strict";
/**
 * Harness Tool: lsp_diagnostics - 获取 LSP 代码诊断
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_DIAGNOSTICS_DEF = void 0;
exports.createLspDiagnosticsExecutor = createLspDiagnosticsExecutor;
const types_1 = require("../../types");
exports.LSP_DIAGNOSTICS_DEF = {
    name: 'lsp_diagnostics',
    description: '获取文件的 LSP 诊断信息（错误、警告等）。适用场景：检查代码问题、获取类型错误、查看代码质量。不适用：代码补全（用 lsp_completion）、悬停信息（用 lsp_hover）。',
    category: types_1.ToolCategory.CODE,
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
    requiredPermissions: [types_1.Permission.CODE_EXECUTE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 15000,
};
function createLspDiagnosticsExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const uri = params.uri;
        const severity = params.severity;
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
        }
        catch (error) {
            return {
                success: false,
                output: null,
                error: `LSP 诊断失败: ${error.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
