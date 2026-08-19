"use strict";
/**
 * Harness Tool: lsp_references - 获取 LSP 引用查找
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_REFERENCES_DEF = void 0;
exports.createLspReferencesExecutor = createLspReferencesExecutor;
const types_1 = require("../../types");
exports.LSP_REFERENCES_DEF = {
    name: 'lsp_references',
    description: '查找符号的所有引用位置。适用场景：查找函数调用处、查看变量使用位置、追踪接口实现。不适用：查找定义（用 lsp_definition）、代码补全（用 lsp_completion）。',
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
    timeout: 15000,
};
function createLspReferencesExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const uri = params.uri;
        const line = params.line;
        const character = params.character;
        try {
            if (!deps.getReferences) {
                return {
                    success: false,
                    output: 'LSP 引用服务不可用',
                    error: 'getReferences 未提供',
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            const result = await deps.getReferences(uri, { line, character });
            return {
                success: true,
                output: deps.formatReferences?.(result) ?? JSON.stringify(result.locations),
                duration: Date.now() - startTime,
                validated: true,
                structuredOutput: {
                    type: 'json',
                    content: JSON.stringify(result.locations),
                    summary: `${result.uri}:${line + 1}:${character + 1} → ${result.locations.length} 处引用`,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: null,
                error: `LSP 引用查找失败: ${error.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
