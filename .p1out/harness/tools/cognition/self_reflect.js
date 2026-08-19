"use strict";
/**
 * Harness Tool: self_reflect - 记录自我反思
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SELF_REFLECT_DEF = void 0;
exports.createSelfReflectExecutor = createSelfReflectExecutor;
const types_1 = require("../../types");
exports.SELF_REFLECT_DEF = {
    name: 'self_reflect',
    description: '记录对自己表现的反思，支持趋势分析。适用场景：完成了一个复杂的多步骤任务后，记录哪些做得好、哪些可以改进。不适用：简单的单轮对话。',
    category: types_1.ToolCategory.COGNITION,
    parameters: {
        action: {
            type: 'string',
            description: '你执行了什么操作，如"调用了3个工具完成文件搜索"',
        },
        result: {
            type: 'string',
            description: '操作结果如何，如"成功找到文件但耗时较长"',
        },
        satisfaction: {
            type: 'number',
            description: '满意度评分1-10，10为最满意',
            default: 5,
        },
        category: {
            type: 'string',
            description: '反思分类，如"效率"、"准确性"、"用户体验"、"安全性"',
            default: 'general',
        },
    },
    requiredParams: ['action', 'result', 'satisfaction'],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: false,
    timeout: 5000,
};
function analyzeSentiment(satisfaction) {
    if (satisfaction >= 7)
        return 'positive';
    if (satisfaction >= 4)
        return 'neutral';
    return 'negative';
}
function suggestImprovement(satisfaction, result) {
    if (satisfaction >= 8)
        return undefined;
    if (satisfaction <= 3)
        return `低满意度(${satisfaction}/10): 建议优化 "${result.substring(0, 50)}" 的执行策略`;
    if (satisfaction <= 5)
        return `中等满意度(${satisfaction}/10): 可考虑改进执行效率或结果质量`;
    return undefined;
}
function analyzeTrend(reflectionStore) {
    if (!reflectionStore || reflectionStore.length < 3) {
        return null;
    }
    const recent = reflectionStore.slice(-10);
    const avgSatisfaction = recent.reduce((sum, r) => sum + r.satisfaction, 0) / recent.length;
    const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
    const secondHalf = recent.slice(Math.floor(recent.length / 2));
    const firstAvg = firstHalf.reduce((sum, r) => sum + r.satisfaction, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, r) => sum + r.satisfaction, 0) / secondHalf.length;
    let trend;
    if (secondAvg - firstAvg > 0.5) trend = 'improving';
    else if (firstAvg - secondAvg > 0.5) trend = 'declining';
    else trend = 'stable';
    const categoryStats = {};
    for (const r of recent) {
        const cat = r.category || 'general';
        if (!categoryStats[cat]) categoryStats[cat] = { total: 0, sum: 0 };
        categoryStats[cat].total++;
        categoryStats[cat].sum += r.satisfaction;
    }
    const weakCategories = Object.entries(categoryStats)
        .filter(([, s]) => s.sum / s.total < 5)
        .map(([cat]) => cat);
    return {
        avgSatisfaction: Math.round(avgSatisfaction * 10) / 10,
        trend,
        totalReflections: reflectionStore.length,
        weakCategories: weakCategories.length > 0 ? weakCategories : undefined,
    };
}

/** 创建 self_reflect 执行器 */
function createSelfReflectExecutor(deps) {
    return async (params, context) => {
        const traceId = context?.traceId || '';
        const satisfaction = Math.min(10, Math.max(1, Number(params.satisfaction) || 5));
        const action = String(params.action);
        const result = String(params.result);
        const category = String(params.category || 'general');
        const sentiment = analyzeSentiment(satisfaction);
        const improvement = suggestImprovement(satisfaction, result);
        if (deps.agentSelfReflection) {
            await deps.agentSelfReflection.recordExecution({
                traceId,
                timestamp: Date.now(),
                input: action,
                intent: 'self_reflect',
                skillsUsed: [],
                success: satisfaction >= 5,
                duration: 0,
                output: result,
            });
        }
        const entry = {
            traceId,
            timestamp: Date.now(),
            action,
            result,
            satisfaction,
            sentiment,
            improvement,
            category,
        };
        if (deps.reflectionStore) {
            deps.reflectionStore.add(entry);
        }

        // P0-2: 反思数据持久化到 MemoryEngine（跨会话保留）
        if (deps.memoryEngine) {
            try {
                const memoryContent = JSON.stringify({
                    action,
                    result,
                    satisfaction,
                    sentiment,
                    category,
                    improvement: improvement || undefined,
                });
                const scene = category === 'general' ? 'work' : category;
                const emotion = sentiment === 'positive' ? 'happy' : sentiment === 'negative' ? 'sad' : 'neutral';
                await deps.memoryEngine.storeLongTermMemory(
                    memoryContent,
                    scene,
                    emotion,
                );
            } catch (persistErr) {
                // 持久化失败不阻塞反思记录
            }
        }

        const outputParts = [
            `已记录反思 [满意度:${satisfaction}/10, 情感:${sentiment}, 分类:${category}]`,
        ];
        if (improvement) outputParts.push(`💡 ${improvement}`);
        const trend = analyzeTrend(deps.reflectionStore ? (Array.isArray(deps.reflectionStore) ? deps.reflectionStore : Array.from(deps.reflectionStore)) : null);
        if (trend) {
            outputParts.push(`📊 趋势: ${trend.trend} (近${trend.totalReflections}次平均${trend.avgSatisfaction}/10)`);
            if (trend.weakCategories && trend.weakCategories.length > 0) {
                outputParts.push(`⚠️ 待改进领域: ${trend.weakCategories.join(', ')}`);
            }
        }
        return {
            success: true,
            output: outputParts.join('\n'),
            duration: 0,
            validated: false,
            metadata: { satisfaction, sentiment, category, hasImprovement: !!improvement, trend: trend?.trend },
        };
    };
}
