"use strict";
/**
 * Harness Tool: get_active_file - 获取当前编辑文件
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET_ACTIVE_FILE_DEF = void 0;
exports.createGetActiveFileExecutor = createGetActiveFileExecutor;
const types_1 = require("../../types");
exports.GET_ACTIVE_FILE_DEF = {
    name: 'get_active_file',
    description: '获取用户当前正在编辑的文件内容（需要IDE集成支持）。适用场景：用户说"改一下这个文件"、"优化这段代码"但没有提供文件路径。不适用：用户已明确提供文件路径。',
    category: types_1.ToolCategory.FILE,
    parameters: {
        includeRelated: {
            type: 'boolean',
            description: '是否同时获取相关文件（如import的文件）',
            default: false,
        },
    },
    requiredParams: [],
    requiredPermissions: [types_1.Permission.FILE_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
};
/** 创建 get_active_file 执行器 */
function createGetActiveFileExecutor(deps = {}) {
    return async (_params, _context) => {
        if (!deps.getActiveFilePath) {
            return {
                success: false,
                output: 'IDE集成未启用。请手动提供文件路径，或安装VSCode扩展以启用此功能。',
                duration: 0,
                validated: false,
                metadata: { fallback: '请提供文件路径，例如: src/utils/helper.ts' },
            };
        }
        try {
            const filePath = await deps.getActiveFilePath();
            if (!filePath) {
                return {
                    success: false,
                    output: '未检测到当前活动文件。请手动提供文件路径。',
                    duration: 0,
                    validated: false,
                    metadata: { fallback: '请提供文件路径，例如: src/utils/helper.ts' },
                };
            }
            if (deps.readFileContent) {
                const content = await deps.readFileContent(filePath);
                return {
                    success: true,
                    output: `文件: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``,
                    duration: 0,
                    validated: false,
                    metadata: { filePath },
                };
            }
            return {
                success: true,
                output: `当前活动文件: ${filePath}`,
                duration: 0,
                validated: false,
                metadata: { filePath },
            };
        }
        catch (error) {
            return {
                success: false,
                output: `获取活动文件失败: ${error.message}`,
                error: error.message,
                duration: 0,
                validated: false,
            };
        }
    };
}
