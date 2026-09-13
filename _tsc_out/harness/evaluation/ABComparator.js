"use strict";
/**
 * A/B 评估对比器 — 3.3 评估体系扩展
 *
 * 对同一组用例运行两次（baseline 改进前 vs candidate 改进后），
 * 生成对比报告，识别回归用例与提升用例，给出整体裁决。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanaryReleaseManager = exports.ABComparator = void 0;
const Logger_1 = require("../../utils/Logger");
/**
 * A/B 评估对比器
 *
 * 用法：
 * ```ts
 * const baseline = await evalRunner.runAll(cases); // 改进前配置
 * // ...应用改进...
 * const candidate = await evalRunner.runAll(cases); // 改进后配置
 * const report = new ABComparator().compare(baseline, candidate);
 * ```
 */
class ABComparator {
    /**
     * 对比两份评估报告，生成 A/B 对比报告
     * @param baseline - 改进前的评估报告
     * @param candidate - 改进后的评估报告
     * @returns A/B 对比报告
     */
    compare(baseline, candidate) {
        try {
            const baselineMap = this.indexByCaseId(baseline.results);
            const candidateMap = this.indexByCaseId(candidate.results);
            const allCaseIds = new Set([
                ...baselineMap.keys(),
                ...candidateMap.keys(),
            ]);
            const caseComparisons = [];
            const regressions = [];
            const improvements = [];
            for (const caseId of allCaseIds) {
                const baseResult = baselineMap.get(caseId);
                const candResult = candidateMap.get(caseId);
                const comparison = {
                    caseId,
                    baselinePassed: baseResult?.passed ?? false,
                    candidatePassed: candResult?.passed ?? false,
                    baselineScore: baseResult?.score ?? 0,
                    candidateScore: candResult?.score ?? 0,
                    scoreDelta: (candResult?.score ?? 0) - (baseResult?.score ?? 0),
                };
                caseComparisons.push(comparison);
                if (comparison.baselinePassed && !comparison.candidatePassed) {
                    regressions.push(comparison);
                }
                else if (!comparison.baselinePassed && comparison.candidatePassed) {
                    improvements.push(comparison);
                }
            }
            const deltaPassRate = candidate.summary.passRate - baseline.summary.passRate;
            const deltaAverageScore = candidate.summary.averageScore - baseline.summary.averageScore;
            const verdict = this.determineVerdict(regressions.length, improvements.length, deltaPassRate);
            const report = {
                baseline,
                candidate,
                deltaPassRate,
                deltaAverageScore,
                regressions,
                improvements,
                caseComparisons,
                verdict,
            };
            Logger_1.Logger.info(`A/B 对比完成: verdict=${verdict}, ` +
                `通过率变化=${(deltaPassRate * 100).toFixed(1)}%, ` +
                `回归=${regressions.length}, 提升=${improvements.length}`, 'ABComparator');
            return report;
        }
        catch (error) {
            Logger_1.Logger.error('A/B 对比失败', error, 'ABComparator');
            throw new Error(`A/B 评估对比失败: ${error.message}`);
        }
    }
    /**
     * 将用例结果按 caseId 建立索引，便于快速查找
     */
    indexByCaseId(results) {
        const map = new Map();
        for (const result of results) {
            map.set(result.caseId, result);
        }
        return map;
    }
    /**
     * 根据回归数、提升数和通过率变化确定整体裁决
     *
     * 裁决规则：
     * - 存在回归用例 → regression（即使有提升，回归优先阻断）
     * - 无回归且有提升用例 → improvement
     * - 无回归无提升 → neutral
     */
    determineVerdict(regressionCount, improvementCount, deltaPassRate) {
        if (regressionCount > 0) {
            return 'regression';
        }
        if (improvementCount > 0 || deltaPassRate > 0) {
            return 'improvement';
        }
        return 'neutral';
    }
}
exports.ABComparator = ABComparator;
class CanaryReleaseManager {
    rules = new Map();
    metrics = new Map();
    comparator = new ABComparator();
    /**
     * 创建灰度发布规则
     */
    createRule(input) {
        const rule = {
            id: `canary_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            target: input.target,
            targetName: input.targetName,
            baselineValue: input.baselineValue,
            candidateValue: input.candidateValue,
            trafficPercent: input.initialTrafficPercent ?? 5,
            status: 'draft',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            autoRollbackThreshold: input.autoRollbackThreshold ?? {
                errorRate: 0.1,
                latencyMs: 30000,
            },
        };
        this.rules.set(rule.id, rule);
        this.metrics.set(rule.id, {
            baseline: [],
            candidate: [],
            baselineLatency: [],
            candidateLatency: [],
        });
        Logger_1.Logger.info(`灰度规则已创建: ${rule.id} (${rule.target}/${rule.targetName})`, 'CanaryRelease');
        return rule;
    }
    /**
     * 启动灰度发布
     */
    startRule(ruleId) {
        const rule = this.rules.get(ruleId);
        if (!rule)
            return null;
        rule.status = 'running';
        rule.updatedAt = new Date().toISOString();
        Logger_1.Logger.info(`灰度发布已启动: ${ruleId}, 流量=${rule.trafficPercent}%`, 'CanaryRelease');
        return rule;
    }
    /**
     * 递增流量百分比
     */
    increaseTraffic(ruleId, step) {
        const rule = this.rules.get(ruleId);
        if (!rule || rule.status !== 'running')
            return null;
        const increment = step ?? 15;
        rule.trafficPercent = Math.min(100, rule.trafficPercent + increment);
        rule.updatedAt = new Date().toISOString();
        if (rule.trafficPercent >= 100) {
            rule.status = 'completed';
            Logger_1.Logger.info(`灰度发布已完成(100%): ${ruleId}`, 'CanaryRelease');
        }
        else {
            Logger_1.Logger.info(`灰度流量递增: ${ruleId} → ${rule.trafficPercent}%`, 'CanaryRelease');
        }
        return rule;
    }
    /**
     * 回滚灰度发布
     */
    rollback(ruleId, reason) {
        const rule = this.rules.get(ruleId);
        if (!rule)
            return null;
        rule.status = 'rolled_back';
        rule.trafficPercent = 0;
        rule.updatedAt = new Date().toISOString();
        Logger_1.Logger.warn(`灰度发布已回滚: ${ruleId}, 原因: ${reason || '手动回滚'}`, 'CanaryRelease');
        return rule;
    }
    /**
     * 判断请求应使用 baseline 还是 candidate
     * 基于用户ID哈希实现稳定分流
     */
    shouldUseCandidate(ruleId, userId) {
        const rule = this.rules.get(ruleId);
        if (!rule || rule.status !== 'running')
            return false;
        const hash = this.hashUserId(userId);
        return hash % 100 < rule.trafficPercent;
    }
    /**
     * 获取当前生效的值（baseline 或 candidate）
     */
    getActiveValue(ruleId, userId) {
        const rule = this.rules.get(ruleId);
        if (!rule)
            return null;
        return this.shouldUseCandidate(ruleId, userId)
            ? rule.candidateValue
            : rule.baselineValue;
    }
    /**
     * 记录请求指标（用于自动回滚判断）
     */
    recordMetric(ruleId, isCandidate, isError, latencyMs) {
        const metric = this.metrics.get(ruleId);
        if (!metric)
            return;
        if (isCandidate) {
            metric.candidate.push(isError ? 1 : 0);
            metric.candidateLatency.push(latencyMs);
        }
        else {
            metric.baseline.push(isError ? 1 : 0);
            metric.baselineLatency.push(latencyMs);
        }
        this.checkAutoRollback(ruleId);
    }
    /**
     * 获取灰度指标摘要
     */
    getMetrics(ruleId) {
        const rule = this.rules.get(ruleId);
        const metric = this.metrics.get(ruleId);
        if (!rule || !metric)
            return null;
        const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        return {
            ruleId,
            baselineErrorRate: avg(metric.baseline),
            candidateErrorRate: avg(metric.candidate),
            baselineAvgLatencyMs: avg(metric.baselineLatency),
            candidateAvgLatencyMs: avg(metric.candidateLatency),
            sampleCount: metric.baseline.length + metric.candidate.length,
        };
    }
    /**
     * 获取所有规则
     */
    listRules() {
        return Array.from(this.rules.values());
    }
    /**
     * 获取指定规则
     */
    getRule(ruleId) {
        return this.rules.get(ruleId);
    }
    hashUserId(userId) {
        let hash = 0;
        for (let i = 0; i < userId.length; i++) {
            const char = userId.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }
    checkAutoRollback(ruleId) {
        const rule = this.rules.get(ruleId);
        if (!rule || rule.status !== 'running' || !rule.autoRollbackThreshold)
            return;
        const metrics = this.getMetrics(ruleId);
        if (!metrics || metrics.sampleCount < 10)
            return;
        const { errorRate, latencyMs } = rule.autoRollbackThreshold;
        if (metrics.candidateErrorRate > errorRate) {
            this.rollback(ruleId, `候选版本错误率 ${(metrics.candidateErrorRate * 100).toFixed(1)}% 超过阈值 ${(errorRate * 100).toFixed(1)}%`);
        }
        else if (metrics.candidateAvgLatencyMs > latencyMs) {
            this.rollback(ruleId, `候选版本延迟 ${metrics.candidateAvgLatencyMs.toFixed(0)}ms 超过阈值 ${latencyMs}ms`);
        }
    }
}
exports.CanaryReleaseManager = CanaryReleaseManager;
