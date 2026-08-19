"use strict";
/**
 * Harness Tool: memory_search - 按关键词搜索记忆
 *
 * 与 memory_recall 的区别：
 * - memory_recall: 语义检索，基于向量相似度
 * - memory_search: 关键词搜索，基于精确匹配
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMORY_SEARCH_DEF = void 0;
exports.createMemorySearchExecutor = createMemorySearchExecutor;
const types_1 = require("../../types");
exports.MEMORY_SEARCH_DEF = {
    name: 'memory_search',
    description: '按关键词搜索用户记忆。适用场景：需要精确查找包含特定关键词的记忆，如用户提到的某个地名、人名、技术名词。不适用：模糊语义搜索（用 memory_recall）。',
    category: types_1.ToolCategory.MEMORY,
    parameters: {
        keywords: {
            type: 'string',
            description: '搜索关键词，多个关键词用空格分隔',
        },
        category: {
            type: 'string',
            description: '记忆分类过滤: preference=偏好, fact=事实, task=任务, event=事件',
            enum: ['preference', 'fact', 'task', 'event'],
        },
        limit: {
            type: 'number',
            description: '返回结果数量上限，默认5',
            default: 5,
        },
    },
    requiredParams: ['keywords'],
    requiredPermissions: [types_1.Permission.MEMORY_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 10000,
};
/** 创建 memory_search 执行器 */
function createMemorySearchExecutor(deps) {
    return async (params, _context) => {
        const keywords = String(params.keywords || '');
        const category = params.category;
        const limit = Number(params.limit) || 5;
        if (!deps.searchMemories) {
            return {
                success: false,
                output: null,
                error: '记忆搜索不可用：searchMemories 未注入',
                duration: 0,
                validated: false,
            };
        }
        try {
            const results = await deps.searchMemories({
                keywords,
                category,
                limit,
            });
            if (results.length === 0) {
                return {
                    success: true,
                    output: `未找到包含"${keywords}"的记忆`,
                    duration: 0,
                    validated: false,
                };
            }
            const formatted = results
                .map((m, i) => `${i + 1}. [${m.category}] ${m.content}`)
                .join('\n');
            return {
                success: true,
                output: formatted,
                duration: 0,
                validated: false,
            };
        }
        catch (error) {
            return {
                success: false,
                output: null,
                error: `记忆搜索失败: ${error.message}`,
                duration: 0,
                validated: false,
            };
        }
    };
}
