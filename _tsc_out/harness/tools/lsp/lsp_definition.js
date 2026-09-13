"use strict";
/**
 * Harness Tool: lsp_definition - 获取 LSP 定义跳转
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_DEFINITION_DEF = void 0;
exports.createLspDefinitionExecutor = createLspDefinitionExecutor;
const types_1 = require("../../types");
exports.LSP_DEFINITION_DEF = {
    name: 'lsp_definition',
    description: '查找符号的定义位置。适用场景：跳转到函数定义、查看类声明位置、追踪变量来源。不适用：查找引用（用 lsp_references）、代码补全（用 lsp_completion）。',
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
function createLspDefinitionExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const uri = params.uri;
        const line = params.line;
        const character = params.character;
        try {
            if (!deps.getDefinition) {
                return {
                    success: false,
                    output: 'LSP 定义服务不可用',
                    error: 'getDefinition 未提供',
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            const result = await deps.getDefinition(uri, { line, character });
            return {
                success: true,
                output: deps.formatDefinition?.(result) ?? JSON.stringify(result.locations),
                duration: Date.now() - startTime,
                validated: true,
                structuredOutput: {
                    type: 'json',
                    content: JSON.stringify(result.locations),
                    summary: `${result.uri}:${line + 1}:${character + 1} → ${result.locations.length} 个定义`,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: null,
                error: `LSP 定义查找失败: ${error.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
