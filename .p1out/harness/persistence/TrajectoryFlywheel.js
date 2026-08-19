"use strict";
/**
 * TrajectoryFlywheel - 轨迹数据飞轮引擎
 *
 * 功能：
 * - 轨迹数据收集与分析
 * - 成功率统计与趋势分析
 * - 自动优化建议生成
 * - 工具使用模式分析
 * - 性能瓶颈识别
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectoryFlywheel = void 0;
const Logger_1 = require("../../utils/Logger");
const DEFAULT_CONFIG = {
    analysisWindowHours: 24 * 7, // 7天
    minSampleSize: 10,
    autoApplyOptimizations: false,
    suggestionThreshold: 0.7,
};
class TrajectoryFlywheel {
    constructor(trajectoryDB, config) {
        this.trajectoryDB = trajectoryDB;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.recentAnalyses = [];
        this.appliedOptimizations = new Map();
        this.MAX_APPLIED_OPTIMIZATIONS = 1000;
        Logger_1.Logger.info('⚙️ TrajectoryFlywheel 初始化', 'TrajectoryFlywheel');
    }
    /**
     * 执行完整分析
     */
    analyze(_executionId) {
        const startTime = Date.now();
        Logger_1.Logger.info('📊 开始轨迹数据分析', 'TrajectoryFlywheel');
        // 获取分析时间窗口
        const cutoffTime = Date.now() - this.config.analysisWindowHours * 60 * 60 * 1000;
        // 获取所有执行记录
        // 注意：这里我们需要从数据库获取，但目前 TrajectoryDatabase 没有直接获取所有记录的方法
        // 我们使用模拟数据进行演示
        const executions = this.getRecentExecutions(cutoffTime);
        const toolInvocations = this.getRecentToolInvocations(cutoffTime);
        const analysis = {
            overallStats: this.calculateOverallStats(executions),
            timeSeriesData: this.generateTimeSeriesData(executions),
            toolStats: this.analyzeToolUsage(toolInvocations),
            patternAnalysis: this.detectPatterns(executions, toolInvocations),
            bottlenecks: this.identifyBottlenecks(executions, toolInvocations),
            optimizationSuggestions: this.generateOptimizationSuggestions(executions, toolInvocations),
        };
        // 保存分析结果
        this.recentAnalyses.push(analysis);
        if (this.recentAnalyses.length > 10) {
            this.recentAnalyses.shift();
        }
        const duration = Date.now() - startTime;
        Logger_1.Logger.info(`📊 分析完成: ${executions.length} 次执行，耗时 ${duration}ms`, 'TrajectoryFlywheel');
        return analysis;
    }
    /**
     * 计算总体统计
     */
    calculateOverallStats(executions) {
        if (executions.length === 0) {
            return {
                totalExecutions: 0,
                successRate: 0,
                avgDuration: 0,
                avgToolCalls: 0,
                avgQualityScore: 0,
            };
        }
        const successfulExecutions = executions.filter((e) => e.status === 'success');
        const successRate = successfulExecutions.length / executions.length;
        const avgDuration = executions.reduce((sum, e) => sum + (e.total_duration || 0), 0) /
            executions.length;
        const avgToolCalls = executions.reduce((sum, e) => sum + (e.total_tool_calls || 0), 0) /
            executions.length;
        const avgQualityScore = executions
            .filter((e) => e.quality_overall !== undefined)
            .reduce((sum, e) => sum + (e.quality_overall || 0), 0) /
            Math.max(1, executions.filter((e) => e.quality_overall !== undefined).length);
        return {
            totalExecutions: executions.length,
            successRate,
            avgDuration,
            avgToolCalls,
            avgQualityScore,
        };
    }
    /**
     * 生成时间序列数据
     */
    generateTimeSeriesData(executions) {
        const buckets = new Map();
        const bucketSize = 60 * 60 * 1000; // 1小时桶
        for (const execution of executions) {
            const bucketKey = Math.floor(execution.created_at / bucketSize) * bucketSize;
            if (!buckets.has(bucketKey.toString())) {
                buckets.set(bucketKey.toString(), {
                    successRate: 0,
                    avgDuration: 0,
                    count: 0,
                });
            }
            const bucket = buckets.get(bucketKey.toString());
            bucket.count++;
            const isSuccess = execution.status === 'success' ? 1 : 0;
            bucket.successRate =
                (bucket.successRate * (bucket.count - 1) + isSuccess) / bucket.count;
            const duration = execution.total_duration || 0;
            bucket.avgDuration =
                (bucket.avgDuration * (bucket.count - 1) + duration) / bucket.count;
        }
        return Array.from(buckets.entries())
            .map(([timestamp, data]) => ({
            timestamp: parseInt(timestamp),
            successRate: data.successRate,
            avgDuration: data.avgDuration,
        }))
            .sort((a, b) => a.timestamp - b.timestamp);
    }
    /**
     * 分析工具使用
     */
    analyzeToolUsage(toolInvocations) {
        const toolStats = {};
        const toolErrors = new Map();
        for (const invocation of toolInvocations) {
            const toolName = invocation.tool_name;
            if (!toolStats[toolName]) {
                toolStats[toolName] = {
                    totalCalls: 0,
                    successRate: 0,
                    avgDuration: 0,
                    errorRate: 0,
                    commonErrors: [],
                };
            }
            const stats = toolStats[toolName];
            stats.totalCalls++;
            const success = invocation.result_success === 1;
            stats.successRate =
                (stats.successRate * (stats.totalCalls - 1) + (success ? 1 : 0)) /
                    stats.totalCalls;
            stats.avgDuration =
                (stats.avgDuration * (stats.totalCalls - 1) + invocation.duration) /
                    stats.totalCalls;
            if (!success) {
                stats.errorRate =
                    (stats.errorRate * (stats.totalCalls - 1) + 1) / stats.totalCalls;
                if (!toolErrors.has(toolName)) {
                    toolErrors.set(toolName, []);
                }
                if (invocation.error_message) {
                    toolErrors.get(toolName).push(invocation.error_message);
                }
            }
        }
        // 添加常见错误
        for (const [toolName, errors] of toolErrors.entries()) {
            const errorCounts = new Map();
            for (const error of errors) {
                const simplifiedError = this.simplifyError(error);
                errorCounts.set(simplifiedError, (errorCounts.get(simplifiedError) || 0) + 1);
            }
            const sortedErrors = Array.from(errorCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([error]) => error);
            if (toolStats[toolName]) {
                toolStats[toolName].commonErrors = sortedErrors;
            }
        }
        return toolStats;
    }
    /**
     * 简化错误信息
     */
    simplifyError(error) {
        return error
            .replace(/\d+/g, '[number]')
            .replace(/[a-f0-9]{32}/gi, '[hash]')
            .replace(/['"].*?['"]/g, '[string]')
            .trim();
    }
    /**
     * 检测模式
     */
    detectPatterns(executions, toolInvocations) {
        const commonFailurePatterns = [];
        const commonSuccessPatterns = [];
        const optimalToolSequences = [];
        // 按执行分组工具调用
        const executionsById = new Map();
        for (const invocation of toolInvocations) {
            if (!executionsById.has(invocation.execution_id)) {
                executionsById.set(invocation.execution_id, []);
            }
            executionsById.get(invocation.execution_id).push(invocation);
        }
        // 分析工具序列模式
        const toolSequenceSuccess = new Map();
        for (const [executionId, invocations] of executionsById.entries()) {
            const execution = executions.find((e) => e.id === executionId);
            if (!execution)
                continue;
            const sequence = invocations.map((i) => i.tool_name).join(' → ');
            if (!toolSequenceSuccess.has(sequence)) {
                toolSequenceSuccess.set(sequence, { total: 0, success: 0 });
            }
            const seqData = toolSequenceSuccess.get(sequence);
            seqData.total++;
            if (execution.status === 'success') {
                seqData.success++;
            }
        }
        // 找出高成功率序列
        for (const [sequence, data] of toolSequenceSuccess.entries()) {
            if (data.total >= 3 && data.success / data.total > 0.8) {
                optimalToolSequences.push({
                    sequence: sequence.split(' → '),
                    successRate: data.success / data.total,
                });
            }
        }
        // 简单的模式检测（实际项目中可以用更复杂的算法）
        const failedExecutions = executions.filter((e) => e.status !== 'success');
        if (failedExecutions.some((e) => (e.total_tool_calls || 0) > 15)) {
            commonFailurePatterns.push('工具调用过多导致超时');
        }
        if (failedExecutions.some((e) => (e.total_duration || 0) > 300000)) {
            commonFailurePatterns.push('执行时间过长（>5分钟）');
        }
        const successfulExecutions = executions.filter((e) => e.status === 'success');
        if (successfulExecutions.some((e) => (e.total_tool_calls || 0) >= 3 && (e.total_tool_calls || 0) <= 8)) {
            commonSuccessPatterns.push('工具调用数量适中（3-8次）');
        }
        return {
            commonFailurePatterns,
            commonSuccessPatterns,
            optimalToolSequences: optimalToolSequences.slice(0, 10),
        };
    }
    /**
     * 识别瓶颈
     */
    identifyBottlenecks(executions, toolInvocations) {
        const bottlenecks = [];
        // 查找最慢的工具
        const toolTimings = new Map();
        for (const invocation of toolInvocations) {
            if (!toolTimings.has(invocation.tool_name)) {
                toolTimings.set(invocation.tool_name, { total: 0, count: 0 });
            }
            const timing = toolTimings.get(invocation.tool_name);
            timing.total += invocation.duration;
            timing.count++;
        }
        const sortedTools = Array.from(toolTimings.entries())
            .map(([name, { total, count }]) => ({
            name,
            avgDuration: total / count,
            count,
        }))
            .sort((a, b) => b.avgDuration - a.avgDuration);
        for (const tool of sortedTools.slice(0, 3)) {
            if (tool.avgDuration > 2000 && tool.count >= 5) {
                bottlenecks.push({
                    type: 'tool',
                    description: `工具 "${tool.name}" 平均耗时 ${Math.round(tool.avgDuration)}ms，调用 ${tool.count} 次`,
                    impact: tool.avgDuration > 5000 ? 'high' : 'medium',
                    suggestion: `考虑优化工具 "${tool.name}" 的性能，或减少使用频率`,
                });
            }
        }
        // 查找失败率高的工具
        const toolStats = this.analyzeToolUsage(toolInvocations);
        for (const [toolName, stats] of Object.entries(toolStats)) {
            if (stats.errorRate > 0.3 && stats.totalCalls >= 5) {
                bottlenecks.push({
                    type: 'tool',
                    description: `工具 "${toolName}" 失败率 ${Math.round(stats.errorRate * 100)}% (${stats.totalCalls}次)`,
                    impact: stats.errorRate > 0.5 ? 'high' : 'medium',
                    suggestion: `检查工具 "${toolName}" 的参数验证和错误处理`,
                });
            }
        }
        return bottlenecks;
    }
    /**
     * 生成优化建议
     */
    generateOptimizationSuggestions(executions, toolInvocations) {
        const suggestions = [];
        const toolStats = this.analyzeToolUsage(toolInvocations);
        let suggestionId = 0;
        // 建议1：失败率高的工具优化
        for (const [toolName, stats] of Object.entries(toolStats)) {
            if (stats.errorRate > 0.2 &&
                stats.totalCalls >= this.config.minSampleSize) {
                suggestions.push({
                    id: `tool_${suggestionId++}`,
                    type: 'tool',
                    priority: stats.errorRate > 0.4 ? 'high' : 'medium',
                    description: `工具 "${toolName}" 失败率过高 (${Math.round(stats.errorRate * 100)}%)`,
                    expectedImpact: '减少工具调用失败，提高整体成功率',
                    implementationSteps: [
                        `分析工具 "${toolName}" 的常见错误`,
                        '增强参数验证',
                        '添加重试机制',
                        '优化错误信息提示',
                    ],
                    estimatedImprovement: stats.errorRate * 50,
                    confidence: Math.min(0.9, stats.totalCalls / 50),
                });
            }
        }
        // 建议2：慢工具优化
        for (const [toolName, stats] of Object.entries(toolStats)) {
            if (stats.avgDuration > 3000 &&
                stats.totalCalls >= this.config.minSampleSize) {
                suggestions.push({
                    id: `perf_${suggestionId++}`,
                    type: 'tool',
                    priority: 'medium',
                    description: `工具 "${toolName}" 平均响应时间过长 (${Math.round(stats.avgDuration)}ms)`,
                    expectedImpact: '提高响应速度，改善用户体验',
                    implementationSteps: [
                        `分析工具 "${toolName}" 的性能瓶颈`,
                        '考虑使用缓存',
                        '优化算法或查询',
                        '异步处理非关键任务',
                    ],
                    estimatedImprovement: Math.min(30, (stats.avgDuration / 1000) * 5),
                    confidence: 0.7,
                });
            }
        }
        // 建议3：Prompt 优化（如果有质量评分）
        const lowQualityExecutions = executions.filter((e) => e.quality_overall !== undefined && e.quality_overall < 0.5);
        if (lowQualityExecutions.length >= this.config.minSampleSize) {
            suggestions.push({
                id: `prompt_${suggestionId++}`,
                type: 'prompt',
                priority: 'medium',
                description: `发现 ${lowQualityExecutions.length} 次低质量执行 (评分<0.5)`,
                expectedImpact: '提升输出质量，减少修正次数',
                implementationSteps: [
                    '检查低质量执行的共同点',
                    '优化系统提示词',
                    '添加更多示例',
                    '明确输出格式要求',
                ],
                estimatedImprovement: 20,
                confidence: 0.6,
            });
        }
        return suggestions.sort((a, b) => {
            const priorityWeight = { high: 3, medium: 2, low: 1 };
            return priorityWeight[b.priority] - priorityWeight[a.priority];
        });
    }
    /**
     * 获取最近执行记录（从数据库）
     */
    getRecentExecutions(cutoffTime) {
        // C7 fix: wire to real database instead of returning empty []
        return this.trajectoryDB
            .getRecentExecutions(500)
            .filter((e) => e.created_at >= cutoffTime);
    }
    /**
     * 获取最近工具调用（从数据库）
     */
    getRecentToolInvocations(cutoffTime) {
        const executions = this.getRecentExecutions(cutoffTime);
        return executions.flatMap((exec) => this.trajectoryDB
            .getToolInvocations(exec.id)
            .filter((inv) => inv.created_at >= cutoffTime));
    }
    /**
     * 应用优化建议
     */
    applySuggestion(suggestionId) {
        const suggestion = this.recentAnalyses
            .flatMap((a) => a.optimizationSuggestions)
            .find((s) => s.id === suggestionId);
        if (!suggestion) {
            return { success: false, message: '建议不存在' };
        }
        if (suggestion.confidence < this.config.suggestionThreshold) {
            return { success: false, message: '建议置信度低于阈值' };
        }
        this.appliedOptimizations.set(suggestionId, {
            timestamp: Date.now(),
            impact: suggestion.estimatedImprovement,
        });
        if (this.appliedOptimizations.size > this.MAX_APPLIED_OPTIMIZATIONS) {
            const oldestKey = this.appliedOptimizations.keys().next().value;
            this.appliedOptimizations.delete(oldestKey);
        }
        Logger_1.Logger.info(`🚀 应用优化建议: ${suggestion.description}`, 'TrajectoryFlywheel');
        return {
            success: true,
            message: `已应用建议: ${suggestion.description}`,
        };
    }
    /**
     * 获取应用的优化历史
     */
    getOptimizationHistory() {
        return Array.from(this.appliedOptimizations.entries()).map(([id, data]) => ({
            suggestionId: id,
            timestamp: data.timestamp,
            estimatedImpact: data.impact,
        }));
    }
    /**
     * 获取改进趋势
     */
    getImprovementTrend() {
        if (this.recentAnalyses.length < 2) {
            return { trend: 'stable', data: [] };
        }
        const data = this.recentAnalyses.map((analysis, i) => ({
            timestamp: Date.now() - (this.recentAnalyses.length - i) * 3600000,
            successRate: analysis.overallStats.successRate,
            avgDuration: analysis.overallStats.avgDuration,
        }));
        const first = data[0];
        const last = data[data.length - 1];
        const successRateTrend = last.successRate - first.successRate;
        const durationTrend = first.avgDuration - last.avgDuration;
        let trend = 'stable';
        if (successRateTrend > 0.05 || durationTrend > 10000) {
            trend = 'improving';
        }
        else if (successRateTrend < -0.05 || durationTrend < -10000) {
            trend = 'declining';
        }
        return { trend, data };
    }
    /**
     * 导出分析报告
     */
    exportReport(analysis) {
        const report = `
# 📊 轨迹数据飞轮分析报告

## 总体统计
- 总执行次数: ${analysis.overallStats.totalExecutions}
- 成功率: ${Math.round(analysis.overallStats.successRate * 100)}%
- 平均耗时: ${Math.round(analysis.overallStats.avgDuration)}ms
- 平均工具调用: ${Math.round(analysis.overallStats.avgToolCalls)}次
- 平均质量评分: ${analysis.overallStats.avgQualityScore.toFixed(2)}

## 工具使用统计
${Object.entries(analysis.toolStats)
            .map(([name, stats]) => `- ${name}: ${stats.totalCalls}次, 成功率 ${Math.round(stats.successRate * 100)}%, 平均 ${Math.round(stats.avgDuration)}ms`)
            .join('\n')}

## 瓶颈识别
${analysis.bottlenecks.map((b) => `- [${b.impact.toUpperCase()}] ${b.description}`).join('\n')}

## 优化建议
${analysis.optimizationSuggestions.map((s) => `- [${s.priority.toUpperCase()}] ${s.description} (预期改善: ${s.estimatedImprovement}%)`).join('\n')}

---
报告生成时间: ${new Date().toISOString()}
    `.trim();
        return report;
    }
}
exports.TrajectoryFlywheel = TrajectoryFlywheel;
exports.default = TrajectoryFlywheel;
