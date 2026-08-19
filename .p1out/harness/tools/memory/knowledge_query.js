"use strict";
/**
 * 知识查询工具 — 基于知识图谱的智能问答
 *
 * 从 Hermes 学到的核心能力：
 * - 知识与记忆：索引、搜索、记忆并对个人或团队知识进行推理
 * - 不只是搜索，而是推理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWLEDGE_QUERY_DEF = void 0;
exports.createKnowledgeQueryExecutor = createKnowledgeQueryExecutor;
const types_1 = require("../../types");
exports.KNOWLEDGE_QUERY_DEF = {
    name: 'knowledge_query',
    description: '基于个人知识库的智能问答。USE WHEN: 用户问"我之前做过什么"、"关于XX的记忆"、"我的偏好是什么"、"上次我们聊了什么"。DO NOT USE WHEN: 用户要搜索网络信息（用web_search）或存储新记忆（用memory_store）。从记忆中推理答案，不只是搜索。',
    category: types_1.ToolCategory.MEMORY,
    parameters: {
        query: {
            type: 'string',
            description: '用户的问题',
        },
        scope: {
            type: 'string',
            description: '查询范围',
            enum: ['all', 'preferences', 'history', 'knowledge', 'tasks'],
            default: 'all',
        },
        max_results: {
            type: 'number',
            description: '最大结果数',
            default: 10,
        },
    },
    requiredParams: ['query'],
    requiredPermissions: [types_1.Permission.MEMORY_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 15000,
};
function createKnowledgeQueryExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const query = String(params.query || '');
        const scope = String(params.scope || 'all');
        const maxResults = Number(params.max_results || 10);
        try {
            const results = [];
            // 1. 从记忆中检索
            if (deps.memoryRecall &&
                (scope === 'all' || scope === 'knowledge' || scope === 'history')) {
                const memories = await deps.memoryRecall(query, maxResults);
                if (memories.length > 0) {
                    results.push('📚 相关记忆:');
                    for (const mem of memories) {
                        const content = typeof mem.content === 'string'
                            ? mem.content
                            : JSON.stringify(mem.content);
                        const time = mem.timestamp
                            ? new Date(mem.timestamp).toLocaleString('zh-CN')
                            : '';
                        results.push(`  • ${content.substring(0, 150)}${time ? ` (${time})` : ''}`);
                    }
                    results.push('');
                }
            }
            // 2. 用户偏好
            if (deps.getUserProfile && (scope === 'all' || scope === 'preferences')) {
                const profile = deps.getUserProfile();
                if (profile) {
                    results.push('👤 用户画像:');
                    if (profile.name)
                        results.push(`  名字: ${profile.name}`);
                    if (profile.preferences) {
                        for (const [key, value] of Object.entries(profile.preferences)) {
                            results.push(`  ${key}: ${JSON.stringify(value)}`);
                        }
                    }
                    if (profile.recentTopics && profile.recentTopics.length > 0) {
                        results.push(`  最近话题: ${profile.recentTopics.join(', ')}`);
                    }
                    results.push('');
                }
            }
            // 3. 对话历史
            if (deps.getConversationHistory &&
                (scope === 'all' || scope === 'history')) {
                const history = deps.getConversationHistory(10);
                if (history.length > 0) {
                    results.push('💬 最近对话:');
                    for (const msg of history.slice(-5)) {
                        const time = msg.timestamp
                            ? new Date(msg.timestamp).toLocaleTimeString('zh-CN')
                            : '';
                        results.push(`  [${msg.role}] ${msg.content.substring(0, 100)}${time ? ` (${time})` : ''}`);
                    }
                    results.push('');
                }
            }
            if (results.length === 0) {
                return {
                    success: true,
                    output: `没有找到与"${query}"相关的知识。可以尝试:\n1. 用更简短的关键词\n2. 存储一些记忆: memory_store\n3. 查看用户画像: knowledge_query scope=preferences`,
                    duration: Date.now() - startTime,
                    validated: true,
                };
            }
            return {
                success: true,
                output: results.join('\n'),
                duration: Date.now() - startTime,
                validated: true,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `知识查询失败: ${err.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
