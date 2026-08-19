"use strict";
/**
 * 策略优化器
 *
 * 收集反馈数据，分析成功率，生成优化日志（语气调整、技能权重调整、提示词样例）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyOptimizer = void 0;
const Logger_1 = require("../utils/Logger");
const MIN_FEEDBACK_SAMPLES = 5;
const DEFAULT_SKILL_WEIGHTS = {
    file_search: 1.0,
    shell_exec: 0.8,
    code_analyze: 1.0,
    memory_recall: 1.0,
};
const SCENE_TONE_ADJUSTMENTS = {
    coding: {
        targetScene: 'coding',
        temperatureDelta: -0.1,
        formalityDelta: 0,
        verbosityDelta: -0.1,
    },
    daily: {
        targetScene: 'daily',
        temperatureDelta: 0.1,
        formalityDelta: -0.1,
        verbosityDelta: 0.1,
    },
    research: {
        targetScene: 'research',
        temperatureDelta: -0.2,
        formalityDelta: 0.2,
        verbosityDelta: 0.1,
    },
};
class StrategyOptimizer {
    constructor() {
        this.feedbackHistory = [];
        this.optimizationLogs = [];
        this.skillWeights = { ...DEFAULT_SKILL_WEIGHTS };
        this.promptExamples = [];
        this.totalOptimizations = 0;
    }
    /**
     * 收集反馈数据
     */
    collectFeedback(feedback) {
        this.feedbackHistory.push(feedback);
        if (this.feedbackHistory.length > 100) {
            this.feedbackHistory.shift();
        }
    }
    /**
     * 执行优化分析
     * @returns 优化日志，样本不足时返回 null
     */
    optimize() {
        if (this.feedbackHistory.length < MIN_FEEDBACK_SAMPLES) {
            return null;
        }
        const recent = this.feedbackHistory.slice(-20);
        const successCount = recent.filter((f) => f.success).length;
        const successRate = successCount / recent.length;
        // 分析技能使用情况
        const skillStats = {};
        for (const f of recent) {
            for (const tool of f.toolsUsed) {
                if (!skillStats[tool])
                    skillStats[tool] = { success: 0, total: 0 };
                skillStats[tool].total++;
                if (f.success)
                    skillStats[tool].success++;
            }
        }
        // 生成技能权重调整
        const skillAdjustments = [];
        for (const [skill, stats] of Object.entries(skillStats)) {
            const rate = stats.success / stats.total;
            if (rate >= 0.8) {
                const delta = 0.1;
                this.skillWeights[skill] = (this.skillWeights[skill] ?? 1.0) + delta;
                skillAdjustments.push({
                    skillName: skill,
                    weightDelta: delta,
                    reason: `成功率高 (${(rate * 100).toFixed(0)}%)`,
                });
            }
            else if (rate < 0.5) {
                const delta = -0.1;
                this.skillWeights[skill] = Math.max(0.1, (this.skillWeights[skill] ?? 1.0) + delta);
                skillAdjustments.push({
                    skillName: skill,
                    weightDelta: delta,
                    reason: `成功率低 (${(rate * 100).toFixed(0)}%)`,
                });
            }
        }
        // 生成语气调整
        const sceneStats = {};
        for (const f of recent) {
            const scene = f.scene ?? 'default';
            if (!sceneStats[scene])
                sceneStats[scene] = { success: 0, total: 0 };
            sceneStats[scene].total++;
            if (f.success)
                sceneStats[scene].success++;
        }
        const toneAdjustments = [];
        for (const scene of Object.keys(sceneStats)) {
            const preset = SCENE_TONE_ADJUSTMENTS[scene];
            if (preset) {
                toneAdjustments.push(preset);
            }
        }
        // 生成提示词样例（失败→成功的纠错对）
        this.extractPromptExamples();
        const log = {
            id: `opt_${Date.now().toString(36)}`,
            timestamp: new Date(),
            reason: `基于 ${recent.length} 条反馈分析，成功率 ${(successRate * 100).toFixed(0)}%`,
            toneAdjustments,
            skillAdjustments,
            promptExamples: this.promptExamples.filter((p) => p.frequency >= 1),
            success: successRate >= 0.5,
            description: `优化 #${this.totalOptimizations + 1}: 成功率 ${(successRate * 100).toFixed(0)}%，调整 ${skillAdjustments.length} 个技能权重`,
        };
        this.optimizationLogs.push(log);
        this.totalOptimizations++;
        Logger_1.Logger.info(`📊 策略优化完成: ${log.id} (成功率: ${(successRate * 100).toFixed(0)}%)`, 'StrategyOptimizer');
        return log;
    }
    /**
     * 从反馈历史中提取提示词样例
     */
    extractPromptExamples() {
        const failures = this.feedbackHistory.filter((f) => !f.success);
        const successes = this.feedbackHistory.filter((f) => f.success);
        for (const fail of failures) {
            const similar = successes.find((s) => s.input.includes(fail.input.slice(0, 5)) ||
                fail.input.includes(s.input.slice(0, 5)));
            if (similar) {
                const trigger = fail.input;
                const existing = this.promptExamples.find((p) => p.trigger === trigger);
                if (existing) {
                    existing.frequency++;
                }
                else {
                    this.promptExamples.push({
                        trigger,
                        correction: `改用 ${similar.toolsUsed.join(', ')} 代替 ${fail.toolsUsed.join(', ')}`,
                        example: similar.response,
                        frequency: 1,
                    });
                }
            }
        }
    }
    /**
     * 获取技能权重
     */
    getSkillWeights() {
        return { ...this.skillWeights };
    }
    /**
     * 获取场景语气调整
     */
    getToneAdjustment(scene) {
        return SCENE_TONE_ADJUSTMENTS[scene];
    }
    /**
     * 获取提示词样例（仅返回 frequency >= 2 的）
     */
    getPromptExamples() {
        return this.promptExamples.filter((p) => p.frequency >= 2);
    }
    /**
     * 获取优化统计信息
     */
    getOptimizationStats() {
        const recent = this.feedbackHistory.slice(-20);
        const successCount = recent.filter((f) => f.success).length;
        const recentSuccessRate = recent.length > 0 ? successCount / recent.length : 0;
        return {
            totalOptimizations: this.totalOptimizations,
            promptExampleCount: this.getPromptExamples().length,
            recentSuccessRate,
        };
    }
    /**
     * 获取优化日志列表
     */
    getOptimizationLogs() {
        return [...this.optimizationLogs];
    }
}
exports.StrategyOptimizer = StrategyOptimizer;
