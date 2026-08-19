"use strict";
/**
 * Harness Tool: memory_store - 保存信息到长期记忆
 *
 * 增强功能：
 * - 重要性评分（1-10），>=7 的记忆可晋升为长期记忆
 * - 去重：内容相似度 >80% 时跳过存储
 * - 生命周期元数据：importance, category, createdAt, accessCount, lastAccessedAt
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMORY_STORE_DEF = void 0;
exports.isDuplicateContent = isDuplicateContent;
exports.createMemoryStoreExecutor = createMemoryStoreExecutor;
const types_1 = require("../../types");
exports.MEMORY_STORE_DEF = {
    name: 'memory_store',
    description: '保存重要信息到记忆系统。当用户要求"记住"、"记下"、"存储"、"保存"某个信息时，必须使用此工具。适用场景：用户告诉你姓名、职业、偏好、习惯、重要日期、待办事项等个人信息时。不适用：普通对话内容、设置提醒时间。',
    category: types_1.ToolCategory.MEMORY,
    parameters: {
        content: {
            type: 'string',
            description: '要保存的信息，如"用户喜欢喝咖啡"、"用户是程序员"',
        },
        category: {
            type: 'string',
            description: '信息分类：preference=偏好喜恶, fact=事实身份, task=待办任务, event=重要事件, other=其他',
            enum: ['preference', 'fact', 'task', 'event', 'other'],
        },
        importance: {
            type: 'number',
            description: '重要性评分（1-10），7分及以上可晋升为长期记忆，默认5',
            default: 5,
        },
        tags: {
            type: 'array',
            description: '标签列表，用于分类和检索，如["工作","项目A"]',
            items: { type: 'string', description: '标签名' },
        },
        ttl_seconds: {
            type: 'number',
            description: '记忆存活时间（秒），过期后自动清理。0=永不过期（默认）。如临时记忆设3600（1小时）',
            default: 0,
        },
        source: {
            type: 'string',
            description: '记忆来源标识，如"用户输入"、"系统推断"、"对话摘要"',
            default: '用户输入',
        },
    },
    requiredParams: ['content', 'category'],
    requiredPermissions: [types_1.Permission.MEMORY_WRITE],
    riskLevel: 'low',
    idempotent: false,
    timeout: 5000,
};
/**
 * 计算两个字符串的相似度（0-1）
 * 短文本(<=200字符)使用LCS精确算法，长文本使用Jaccard词集合近似
 */
function computeSimilarity(a, b) {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    if (a.length > 200 || b.length > 200) {
        return computeJaccardSimilarity(a, b);
    }
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    let prevRow = new Array(shorter.length + 1).fill(0);
    for (let i = 1; i <= longer.length; i++) {
        const currRow = new Array(shorter.length + 1).fill(0);
        for (let j = 1; j <= shorter.length; j++) {
            if (longer[i - 1] === shorter[j - 1]) {
                currRow[j] = prevRow[j - 1] + 1;
            } else {
                currRow[j] = Math.max(currRow[j - 1], prevRow[j]);
            }
        }
        prevRow = currRow;
    }
    const lcsLength = prevRow[shorter.length];
    return (2 * lcsLength) / (a.length + b.length);
}

function computeJaccardSimilarity(a, b) {
    const tokenize = (s) => new Set(s.toLowerCase().split(/[\s,，。.！!？?；;：:、]+/).filter(Boolean));
    const setA = tokenize(a);
    const setB = tokenize(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
/**
 * 检查内容是否与已有记忆重复（相似度 >80%）
 */
function isDuplicateContent(content, existingMemories) {
    const maxCheck = Math.min(existingMemories.length, 50);
    for (let i = 0; i < maxCheck; i++) {
        const similarity = computeSimilarity(content, existingMemories[i]);
        if (similarity > 0.8) {
            return true;
        }
    }
    return false;
}
/** 创建 memory_store 执行器 */
function createMemoryStoreExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const content = String(params.content || '');
        const category = String(params.category || 'other');
        const importance = Math.min(10, Math.max(1, Number(params.importance) || 5));
        const tags = Array.isArray(params.tags) ? params.tags.map(String) : [];
        const ttlSeconds = Math.max(0, Number(params.ttl_seconds) || 0);
        const source = String(params.source || '用户输入');
        if (!content.trim()) {
            return {
                success: false,
                output: '内容不能为空',
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        if (content.length > 10000) {
            return {
                success: false,
                output: '内容过长，最大支持10000字符',
                error: '内容超过10000字符限制',
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        try {
            if (deps.checkDuplicate) {
                const isDuplicate = await deps.checkDuplicate(content, category);
                if (isDuplicate) {
                    return {
                        success: true,
                        output: '已存在相似记忆',
                        duration: Date.now() - startTime,
                        validated: false,
                    };
                }
            }
            else if (deps.getAllMemories) {
                const existing = await deps.getAllMemories(category);
                if (isDuplicateContent(content, existing.map((m) => m.content))) {
                    return {
                        success: true,
                        output: '已存在相似记忆（自动去重）',
                        duration: Date.now() - startTime,
                        validated: false,
                    };
                }
            }
            const now = Date.now();
            const metadata = {
                importance,
                category,
                createdAt: now,
                accessCount: 0,
                lastAccessedAt: now,
                tags,
                source,
                expiresAt: ttlSeconds > 0 ? now + ttlSeconds * 1000 : undefined,
            };
            if (deps.storeWithMetadata) {
                const stored = await deps.storeWithMetadata(content, category, metadata);
                if (stored === false) {
                    return {
                        success: false,
                        output: '存储失败: 记忆引擎不可用',
                        error: '记忆引擎不可用',
                        duration: Date.now() - startTime,
                        validated: false,
                    };
                }
            }
            else if (deps.storeShortTermMemory) {
                const stored = await deps.storeShortTermMemory(content, category);
                if (stored === false) {
                    return {
                        success: false,
                        output: '存储失败: 记忆引擎不可用',
                        error: '记忆引擎不可用',
                        duration: Date.now() - startTime,
                        validated: false,
                    };
                }
            }
            const importanceLabel = importance >= 7 ? '（高优先级，可晋升长期记忆）' : '';
            const ttlLabel = ttlSeconds > 0 ? `，${ttlSeconds}秒后过期` : '';
            const tagsLabel = tags.length > 0 ? `，标签:[${tags.join(',')}]` : '';
            return {
                success: true,
                output: `已存储${importanceLabel}${ttlLabel}${tagsLabel}`,
                duration: Date.now() - startTime,
                validated: false,
                metadata: { importance, category, tags, ttlSeconds, source },
            };
        }
        catch (error) {
            return {
                success: false,
                output: `存储失败: ${error.message}`,
                error: error.message,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
