"use strict";
/**
 * Harness Tool: lsp_completion - 获取 LSP 代码补全
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_COMPLETION_DEF = void 0;
exports.createLspCompletionExecutor = createLspCompletionExecutor;
const types_1 = require("../../types");
exports.LSP_COMPLETION_DEF = {
    name: 'lsp_completion',
    description: '获取代码补全建议。适用场景：用户需要代码自动补全、查看可用方法/属性、获取代码片段。不适用：诊断问题（用 lsp_diagnostics）、悬停文档（用 lsp_hover）。',
    category: types_1.ToolCategory.CODE,
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
    requiredPermissions: [types_1.Permission.CODE_EXECUTE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 10000,
};
function createLspCompletionExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const uri = params.uri;
        const line = params.line;
        const character = params.character;
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
                output: deps.formatCompletions?.(result) ?? JSON.stringify(result.items),
                duration: Date.now() - startTime,
                validated: true,
                structuredOutput: {
                    type: 'json',
                    content: JSON.stringify(result.items.map((i) => ({
                        label: i.label,
                        kind: i.kind,
                        detail: i.detail,
                    }))),
                    summary: `${result.uri}:${line + 1}:${character + 1} — ${result.items.length} 个补全项`,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: null,
                error: `LSP 补全失败: ${error.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
