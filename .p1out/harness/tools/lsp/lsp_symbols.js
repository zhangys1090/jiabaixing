"use strict";
/**
 * Harness Tool: lsp_symbols - 获取 LSP 文档符号
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_SYMBOLS_DEF = void 0;
exports.createLspSymbolsExecutor = createLspSymbolsExecutor;
const types_1 = require("../../types");
exports.LSP_SYMBOLS_DEF = {
    name: 'lsp_symbols',
    description: '获取文件中的文档符号（类、函数、变量等）。适用场景：查看文件结构、了解代码组织、快速定位符号。不适用：诊断问题（用 lsp_diagnostics）、定义跳转（用 lsp_definition）。',
    category: types_1.ToolCategory.CODE,
    parameters: {
        uri: {
            type: 'string',
            description: '文件 URI，如 file:///path/to/file.ts',
        },
    },
    requiredParams: ['uri'],
    requiredPermissions: [types_1.Permission.CODE_EXECUTE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 10000,
};
function createLspSymbolsExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const uri = params.uri;
        try {
            if (!deps.getDocumentSymbols) {
                return {
                    success: false,
                    output: 'LSP 符号服务不可用',
                    error: 'getDocumentSymbols 未提供',
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            const result = await deps.getDocumentSymbols(uri);
            return {
                success: true,
                output: deps.formatSymbols?.(result) ?? JSON.stringify(result.symbols),
                duration: Date.now() - startTime,
                validated: true,
                structuredOutput: {
                    type: 'json',
                    content: JSON.stringify(result.symbols),
                    summary: `${result.uri} — ${result.symbols.length} 个符号`,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: null,
                error: `LSP 符号查找失败: ${error.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
