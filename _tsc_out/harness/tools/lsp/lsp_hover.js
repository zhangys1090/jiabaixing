"use strict";
/**
 * Harness Tool: lsp_hover - 获取 LSP 悬停信息
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_HOVER_DEF = void 0;
exports.createLspHoverExecutor = createLspHoverExecutor;
const types_1 = require("../../types");
exports.LSP_HOVER_DEF = {
    name: 'lsp_hover',
    description: '获取代码悬停文档信息。适用场景：查看函数/类的文档、了解类型定义、查看方法签名。不适用：代码补全（用 lsp_completion）、诊断（用 lsp_diagnostics）。',
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
function createLspHoverExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const uri = params.uri;
        const line = params.line;
        const character = params.character;
        try {
            if (!deps.getHover) {
                return {
                    success: false,
                    output: 'LSP 悬停服务不可用',
                    error: 'getHover 未提供',
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            const result = await deps.getHover(uri, { line, character });
            if (!result) {
                return {
                    success: true,
                    output: '该位置无悬停信息',
                    duration: Date.now() - startTime,
                    validated: true,
                };
            }
            return {
                success: true,
                output: deps.formatHover?.(result) ?? JSON.stringify(result.contents),
                duration: Date.now() - startTime,
                validated: true,
                structuredOutput: {
                    type: 'json',
                    content: JSON.stringify(result.contents),
                    summary: `${result.uri}:${line + 1}:${character + 1} — ${result.contents.length} 段文档`,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: null,
                error: `LSP 悬停失败: ${error.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
