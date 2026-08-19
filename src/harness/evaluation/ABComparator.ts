/**
 * A/B 评估对比器 — 3.3 评估体系扩展
 *
 * 对同一组用例运行两次（baseline 改进前 vs candidate 改进后），
 * 生成对比报告，识别回归用例与提升用例，给出整体裁决。
 */

import { Logger } from '../../utils/Logger';
import { EvalCaseResult, EvalReport } from './EvalTypes';

/** 单个用例的对比结果 */
export interface CaseComparison {
  caseId: string;
  baselinePassed: boolean;
  candidatePassed: boolean;
  baselineScore: number;
  candidateScore: number;
  scoreDelta: number;
}

/** A/B 对比报告 */
export interface ABComparisonReport {
  baseline: EvalReport;
  candidate: EvalReport;
  /** 通过率提升幅度（candidate - baseline） */
  deltaPassRate: number;
  /** 平均分提升幅度 */
  deltaAverageScore: number;
  /** 回归用例（baseline 通过但 candidate 失败） */
  regressions: CaseComparison[];
  /** 提升用例（baseline 失败但 candidate 通过） */
  improvements: CaseComparison[];
  /** 所有用例的逐项对比 */
  caseComparisons: CaseComparison[];
  /** 整体裁决 */
  verdict: 'improvement' | 'regression' | 'neutral';
}

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
export class ABComparator {
  /**
   * 对比两份评估报告，生成 A/B 对比报告
   * @param baseline - 改进前的评估报告
   * @param candidate - 改进后的评估报告
   * @returns A/B 对比报告
   */
  compare(baseline: EvalReport, candidate: EvalReport): ABComparisonReport {
    try {
      const baselineMap = this.indexByCaseId(baseline.results);
      const candidateMap = this.indexByCaseId(candidate.results);

      const allCaseIds = new Set([
        ...baselineMap.keys(),
        ...candidateMap.keys(),
      ]);

      const caseComparisons: CaseComparison[] = [];
      const regressions: CaseComparison[] = [];
      const improvements: CaseComparison[] = [];

      for (const caseId of allCaseIds) {
        const baseResult = baselineMap.get(caseId);
        const candResult = candidateMap.get(caseId);

        const comparison: CaseComparison = {
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
        } else if (!comparison.baselinePassed && comparison.candidatePassed) {
          improvements.push(comparison);
        }
      }

      const deltaPassRate =
        candidate.summary.passRate - baseline.summary.passRate;
      const deltaAverageScore =
        candidate.summary.averageScore - baseline.summary.averageScore;

      const verdict = this.determineVerdict(
        regressions.length,
        improvements.length,
        deltaPassRate
      );

      const report: ABComparisonReport = {
        baseline,
        candidate,
        deltaPassRate,
        deltaAverageScore,
        regressions,
        improvements,
        caseComparisons,
        verdict,
      };

      Logger.info(
        `A/B 对比完成: verdict=${verdict}, ` +
          `通过率变化=${(deltaPassRate * 100).toFixed(1)}%, ` +
          `回归=${regressions.length}, 提升=${improvements.length}`,
        'ABComparator'
      );

      return report;
    } catch (error) {
      Logger.error('A/B 对比失败', error as Error, 'ABComparator');
      throw new Error(`A/B 评估对比失败: ${(error as Error).message}`);
    }
  }

  /**
   * 将用例结果按 caseId 建立索引，便于快速查找
   */
  private indexByCaseId(
    results: EvalCaseResult[]
  ): Map<string, EvalCaseResult> {
    const map = new Map<string, EvalCaseResult>();
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
  private determineVerdict(
    regressionCount: number,
    improvementCount: number,
    deltaPassRate: number
  ): 'improvement' | 'regression' | 'neutral' {
    if (regressionCount > 0) {
      return 'regression';
    }
    if (improvementCount > 0 || deltaPassRate > 0) {
      return 'improvement';
    }
    return 'neutral';
  }
}

/**
 * P2 #13: 灰度发布管理器 — 提示词/模型渐进式发布
 *
 * 流量分配策略：
 * 1. 基于用户ID哈希 → 稳定分流（同一用户始终看到同一版本）
 * 2. 百分比渐进：5% → 20% → 50% → 100%
 * 3. 自动回滚：监控错误率/延迟，超阈值自动回退
 */
export type CanaryTarget = 'prompt' | 'model';

export interface CanaryRule {
  id: string;
  target: CanaryTarget;
  targetName: string;
  baselineValue: string;
  candidateValue: string;
  trafficPercent: number;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'rolled_back';
  createdAt: string;
  updatedAt: string;
  autoRollbackThreshold?: {
    errorRate: number;
    latencyMs: number;
  };
}

export interface CanaryMetrics {
  ruleId: string;
  baselineErrorRate: number;
  candidateErrorRate: number;
  baselineAvgLatencyMs: number;
  candidateAvgLatencyMs: number;
  sampleCount: number;
}

export class CanaryReleaseManager {
  private rules: Map<string, CanaryRule> = new Map();
  private metrics: Map<
    string,
    {
      baseline: number[];
      candidate: number[];
      baselineLatency: number[];
      candidateLatency: number[];
    }
  > = new Map();
  private comparator: ABComparator = new ABComparator();

  /**
   * 创建灰度发布规则
   */
  createRule(input: {
    target: CanaryTarget;
    targetName: string;
    baselineValue: string;
    candidateValue: string;
    initialTrafficPercent?: number;
    autoRollbackThreshold?: { errorRate: number; latencyMs: number };
  }): CanaryRule {
    const rule: CanaryRule = {
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
    Logger.info(
      `灰度规则已创建: ${rule.id} (${rule.target}/${rule.targetName})`,
      'CanaryRelease'
    );
    return rule;
  }

  /**
   * 启动灰度发布
   */
  startRule(ruleId: string): CanaryRule | null {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;
    rule.status = 'running';
    rule.updatedAt = new Date().toISOString();
    Logger.info(
      `灰度发布已启动: ${ruleId}, 流量=${rule.trafficPercent}%`,
      'CanaryRelease'
    );
    return rule;
  }

  /**
   * 递增流量百分比
   */
  increaseTraffic(ruleId: string, step?: number): CanaryRule | null {
    const rule = this.rules.get(ruleId);
    if (!rule || rule.status !== 'running') return null;

    const increment = step ?? 15;
    rule.trafficPercent = Math.min(100, rule.trafficPercent + increment);
    rule.updatedAt = new Date().toISOString();

    if (rule.trafficPercent >= 100) {
      rule.status = 'completed';
      Logger.info(`灰度发布已完成(100%): ${ruleId}`, 'CanaryRelease');
    } else {
      Logger.info(
        `灰度流量递增: ${ruleId} → ${rule.trafficPercent}%`,
        'CanaryRelease'
      );
    }
    return rule;
  }

  /**
   * 回滚灰度发布
   */
  rollback(ruleId: string, reason?: string): CanaryRule | null {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;
    rule.status = 'rolled_back';
    rule.trafficPercent = 0;
    rule.updatedAt = new Date().toISOString();
    Logger.warn(
      `灰度发布已回滚: ${ruleId}, 原因: ${reason || '手动回滚'}`,
      'CanaryRelease'
    );
    return rule;
  }

  /**
   * 判断请求应使用 baseline 还是 candidate
   * 基于用户ID哈希实现稳定分流
   */
  shouldUseCandidate(ruleId: string, userId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule || rule.status !== 'running') return false;

    const hash = this.hashUserId(userId);
    return hash % 100 < rule.trafficPercent;
  }

  /**
   * 获取当前生效的值（baseline 或 candidate）
   */
  getActiveValue(ruleId: string, userId: string): string | null {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;
    return this.shouldUseCandidate(ruleId, userId)
      ? rule.candidateValue
      : rule.baselineValue;
  }

  /**
   * 记录请求指标（用于自动回滚判断）
   */
  recordMetric(
    ruleId: string,
    isCandidate: boolean,
    isError: boolean,
    latencyMs: number
  ): void {
    const metric = this.metrics.get(ruleId);
    if (!metric) return;

    if (isCandidate) {
      metric.candidate.push(isError ? 1 : 0);
      metric.candidateLatency.push(latencyMs);
    } else {
      metric.baseline.push(isError ? 1 : 0);
      metric.baselineLatency.push(latencyMs);
    }

    this.checkAutoRollback(ruleId);
  }

  /**
   * 获取灰度指标摘要
   */
  getMetrics(ruleId: string): CanaryMetrics | null {
    const rule = this.rules.get(ruleId);
    const metric = this.metrics.get(ruleId);
    if (!rule || !metric) return null;

    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

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
  listRules(): CanaryRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * 获取指定规则
   */
  getRule(ruleId: string): CanaryRule | undefined {
    return this.rules.get(ruleId);
  }

  private hashUserId(userId: string): number {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      const char = userId.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private checkAutoRollback(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (!rule || rule.status !== 'running' || !rule.autoRollbackThreshold)
      return;

    const metrics = this.getMetrics(ruleId);
    if (!metrics || metrics.sampleCount < 10) return;

    const { errorRate, latencyMs } = rule.autoRollbackThreshold;

    if (metrics.candidateErrorRate > errorRate) {
      this.rollback(
        ruleId,
        `候选版本错误率 ${(metrics.candidateErrorRate * 100).toFixed(1)}% 超过阈值 ${(errorRate * 100).toFixed(1)}%`
      );
    } else if (metrics.candidateAvgLatencyMs > latencyMs) {
      this.rollback(
        ruleId,
        `候选版本延迟 ${metrics.candidateAvgLatencyMs.toFixed(0)}ms 超过阈值 ${latencyMs}ms`
      );
    }
  }
}
