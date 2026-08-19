"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiDimensionalFeedbackAggregator = void 0;
exports.collectLearningSignal = collectLearningSignal;
exports.inferFeedbackDimensions = inferFeedbackDimensions;
/**
 * P5: 学习信号收集器 — 实时收集工具执行和任务完成的学习信号
 *
 * Hermes级别：每次执行都产生学习信号，而非仅依赖 user_correction 事件
 * P1增强：多维反馈（用户满意度、执行效率、质量评分）
 */
const Logger_1 = require("../utils/Logger");
/**
 * 收集学习信号并通过 EventBus 广播
 *
 * @param eventBus - 事件总线，用于广播 learning_signal 事件
 * @param rawSignal - 原始学习信号
 */
function collectLearningSignal(eventBus, rawSignal) {
    let signalType;
    switch (rawSignal.type) {
        case 'tool_success':
            signalType = 'positive';
            break;
        case 'tool_failure':
            signalType = 'negative';
            break;
        case 'task_complete':
            signalType = 'task_success';
            break;
        case 'task_failure':
            signalType = 'task_failure';
            break;
    }
    const signal = {
        signalType,
        toolName: rawSignal.toolName,
        error: rawSignal.error,
        quality: rawSignal.quality,
        duration: rawSignal.duration,
        userInput: rawSignal.userInput,
        toolCount: rawSignal.toolCount,
        timestamp: Date.now(),
        dimensions: rawSignal.dimensions,
    };
    eventBus.emit('learning_signal', signal);
    Logger_1.Logger.debug(`📡 学习信号已收集: ${signalType} ${rawSignal.toolName || ''}`, 'LearningSignalCollector');
}
/**
 * 多维反馈聚合器 — 汇总多维反馈信号，生成综合学习指标
 */
class MultiDimensionalFeedbackAggregator {
    constructor() {
        this.feedbackBuffer = [];
        this.maxBufferSize = 1000;
    }
    /**
     * 记录一条多维反馈
     */
    record(signal) {
        if (!signal.dimensions)
            return;
        this.feedbackBuffer.push({
            dimensions: signal.dimensions,
            signalType: signal.signalType,
            timestamp: signal.timestamp,
        });
        if (this.feedbackBuffer.length > this.maxBufferSize) {
            this.feedbackBuffer.shift();
        }
    }
    /**
     * 获取聚合指标
     */
    getAggregatedMetrics() {
        const buffer = this.feedbackBuffer;
        if (buffer.length === 0) {
            return {
                sampleSize: 0,
                avgSatisfaction: 0,
                avgEfficiency: 0,
                avgQuality: 0,
                avgEngagement: 0,
                avgComplexity: 0,
                compositeScore: 0,
                trend: 'stable',
            };
        }
        const avg = (field) => {
            const values = buffer
                .map((b) => b.dimensions[field])
                .filter((v) => v !== undefined);
            return values.length > 0
                ? values.reduce((a, b) => a + b, 0) / values.length
                : 0;
        };
        const avgSatisfaction = avg('satisfaction');
        const avgEfficiency = avg('efficiency');
        const avgQuality = avg('quality');
        const avgEngagement = avg('engagement');
        const avgComplexity = avg('complexity');
        const compositeScore = avgSatisfaction * 0.3 +
            avgEfficiency * 0.2 +
            avgQuality * 0.3 +
            avgEngagement * 0.2;
        const trend = this.calculateTrend();
        return {
            sampleSize: buffer.length,
            avgSatisfaction,
            avgEfficiency,
            avgQuality,
            avgEngagement,
            avgComplexity,
            compositeScore,
            trend,
        };
    }
    /**
     * 计算趋势方向
     */
    calculateTrend() {
        const buffer = this.feedbackBuffer;
        if (buffer.length < 10)
            return 'stable';
        const half = Math.floor(buffer.length / 2);
        const firstHalf = buffer.slice(0, half);
        const secondHalf = buffer.slice(half);
        const avgComposite = (items) => {
            const scores = items.map((i) => {
                const d = i.dimensions;
                return ((d.satisfaction ?? 0) * 0.3 +
                    (d.efficiency ?? 0) * 0.2 +
                    (d.quality ?? 0) * 0.3 +
                    (d.engagement ?? 0) * 0.2);
            });
            return scores.length > 0
                ? scores.reduce((a, b) => a + b, 0) / scores.length
                : 0;
        };
        const firstScore = avgComposite(firstHalf);
        const secondScore = avgComposite(secondHalf);
        const delta = secondScore - firstScore;
        if (delta > 0.05)
            return 'improving';
        if (delta < -0.05)
            return 'declining';
        return 'stable';
    }
    /**
     * 清空缓冲区
     */
    reset() {
        this.feedbackBuffer = [];
    }
}
exports.MultiDimensionalFeedbackAggregator = MultiDimensionalFeedbackAggregator;
/**
 * 从执行结果推断多维反馈维度
 */
function inferFeedbackDimensions(input) {
    const efficiency = input.duration && input.baselineDuration
        ? Math.min(1, input.baselineDuration / Math.max(1, input.duration))
        : undefined;
    const engagement = input.userActions
        ? (() => {
            let score = 0.5;
            for (const action of input.userActions) {
                if (action === 'copy')
                    score += 0.15;
                if (action === 'accept')
                    score += 0.2;
                if (action === 'modify')
                    score -= 0.1;
                if (action === 'retry')
                    score -= 0.2;
                if (action === 'follow_up')
                    score += 0.05;
            }
            return Math.max(0, Math.min(1, score));
        })()
        : undefined;
    const complexity = input.toolCount
        ? Math.min(1, input.toolCount / 10)
        : undefined;
    const satisfaction = input.userActions
        ? (() => {
            const hasPositive = input.userActions.includes('accept') ||
                input.userActions.includes('copy');
            const hasNegative = input.userActions.includes('retry') ||
                input.userActions.includes('modify');
            if (hasPositive && !hasNegative)
                return 0.8 + Math.random() * 0.2;
            if (hasNegative && !hasPositive)
                return 0.1 + Math.random() * 0.3;
            return 0.5;
        })()
        : undefined;
    return {
        satisfaction,
        efficiency,
        quality: input.qualityScore,
        engagement,
        complexity,
    };
}
