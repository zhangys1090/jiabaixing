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
