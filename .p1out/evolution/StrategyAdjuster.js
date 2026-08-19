"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyAdjuster = void 0;
/**
 * P5: 策略调整器 — 基于学习信号自适应调整策略
 *
 * Hermes级别：基于学习信号自动调整工具优先级、反思深度、重试次数
 */
const Logger_1 = require("../utils/Logger");
class StrategyAdjuster {
    constructor() {
        this.toolStats = new Map();
        this.totalSignals = 0;
        this.taskSuccessCount = 0;
        this.taskFailureCount = 0;
        this._llmHints = null;
    }
    setLLMStrategyHints(hints) {
        this._llmHints = hints;
    }
    /**
     * 记录学习信号
     *
     * 支持两类信号：
     *  - 工具级信号 (positive/negative)：携带 toolName，用于工具优先级调整
     *  - 任务级信号 (task_success/task_failure)：无 toolName，用于整体成功率计算
     *
     * @param signal - 学习信号
     */
    recordSignal(signal) {
        this.totalSignals++;
        // 任务级信号：无 toolName，记录到任务统计
        if (signal.signalType === 'task_success' ||
            signal.signalType === 'task_failure') {
            if (signal.signalType === 'task_success') {
                this.taskSuccessCount++;
            }
            else {
                this.taskFailureCount++;
            }
            Logger_1.Logger.debug(`📊 策略调整器记录任务信号: ${signal.signalType}`, 'StrategyAdjuster');
            return;
        }
        // 工具级信号：需要 toolName
        if (!signal.toolName)
            return;
        const stats = this.toolStats.get(signal.toolName) || {
            successCount: 0,
            failureCount: 0,
            avgQuality: 0,
            lastUsed: Date.now(),
        };
        if (signal.signalType === 'positive') {
            stats.successCount++;
            stats.avgQuality =
                (stats.avgQuality * (stats.successCount - 1) +
                    (signal.quality || 0.5)) /
                    stats.successCount;
        }
        else if (signal.signalType === 'negative') {
            stats.failureCount++;
        }
        stats.lastUsed = Date.now();
        this.toolStats.set(signal.toolName, stats);
        Logger_1.Logger.debug(`📊 策略调整器记录工具信号: ${signal.toolName} (${signal.signalType})`, 'StrategyAdjuster');
    }
    /**
     * 获取调整后的工具优先级
     *
     * @param tools - 候选工具列表
     * @returns 按成功率降序排序后的工具列表
     */
    getAdjustedToolPriority(tools) {
        return [...tools].sort((a, b) => {
            const statsA = this.toolStats.get(a);
            const statsB = this.toolStats.get(b);
            if (!statsA && !statsB)
                return 0;
            if (!statsA)
                return 1;
            if (!statsB)
                return -1;
            const successRateA = statsA.successCount /
                Math.max(statsA.successCount + statsA.failureCount, 1);
            const successRateB = statsB.successCount /
                Math.max(statsB.successCount + statsB.failureCount, 1);
            return successRateB - successRateA;
        });
    }
    /**
     * 获取调整后的反思配置
     *
     * 策略：
     *  - 整体成功率 < 0.5 → 启用深度反思，重试4次
     *  - 整体成功率 > 0.8 且信号数 > 5 → 关闭深度反思，重试1次
     *  - 默认 → 启用深度反思，重试2次
     *
     * 整体成功率 = (工具级成功 + 任务级成功) / (工具级总数 + 任务级总数)
     *
     * @returns 反思配置
     */
    getAdjustedReflectionConfig() {
        let toolFailures = 0;
        let toolSuccesses = 0;
        for (const stats of this.toolStats.values()) {
            toolFailures += stats.failureCount;
            toolSuccesses += stats.successCount;
        }
        const totalSuccesses = toolSuccesses + this.taskSuccessCount;
        const totalFailures = toolFailures + this.taskFailureCount;
        const overallSuccessRate = totalSuccesses / Math.max(totalSuccesses + totalFailures, 1);
        let config;
        if (overallSuccessRate < 0.5) {
            config = {
                enableDeepReflection: true,
                maxRetries: 4,
            };
        }
        else if (overallSuccessRate > 0.8 && this.totalSignals > 5) {
            config = {
                enableDeepReflection: false,
                maxRetries: 1,
            };
        }
        else {
            config = {
                enableDeepReflection: true,
                maxRetries: 2,
            };
        }
        if (this._llmHints) {
            if (this._llmHints.maxRetries !== undefined) {
                config.maxRetries = Math.max(config.maxRetries, this._llmHints.maxRetries);
            }
            if (this._llmHints.lowCapability && !config.enableDeepReflection) {
                config.enableDeepReflection = true;
            }
        }
        return config;
    }
}
exports.StrategyAdjuster = StrategyAdjuster;
