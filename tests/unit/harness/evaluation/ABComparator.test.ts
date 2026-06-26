/**
 * 3.3 评估体系扩展 — A/B 评估：改进前后对比
 *
 * 验证 ABComparator 能对同一组用例运行两次（baseline vs candidate），
 * 生成对比报告，识别回归与提升
 */
import { ABComparator } from '../../../../src/harness/evaluation/ABComparator';
import {
  EvalCaseResult,
  EvalReport,
} from '../../../../src/harness/evaluation/EvalTypes';

function makeReport(
  runId: string,
  passRate: number,
  avgScore: number,
  results: EvalCaseResult[]
): EvalReport {
  return {
    runId,
    timestamp: Date.now(),
    summary: {
      total: results.length,
      passed: Math.round(results.length * passRate),
      passRate,
      averageScore: avgScore,
    },
    byCategory: {},
    results,
    duration: 1000,
  };
}

function makeCaseResult(
  id: string,
  passed: boolean,
  score: number
): EvalCaseResult {
  return {
    caseId: id,
    input: `input-${id}`,
    actualOutput: `output-${id}`,
    passed,
    score,
    duration: 100,
    error: passed ? undefined : 'failed',
  } as unknown as EvalCaseResult;
}

describe('3.3 A/B 评估 — 改进前后对比', () => {
  describe('ABComparator.compare', () => {
    it('应生成对比报告，包含 baseline 与 candidate 两份摘要', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.6, 0.6, [
        makeCaseResult('c1', true, 0.8),
        makeCaseResult('c2', false, 0.4),
      ]);
      const candidate = makeReport('cand', 0.8, 0.8, [
        makeCaseResult('c1', true, 0.9),
        makeCaseResult('c2', true, 0.7),
      ]);

      const report = comparator.compare(baseline, candidate);

      expect(report.baseline.summary.passRate).toBe(0.6);
      expect(report.candidate.summary.passRate).toBe(0.8);
    });

    it('应计算通过率提升幅度（deltaPassRate）', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.5, 0.5, []);
      const candidate = makeReport('cand', 0.8, 0.8, []);

      const report = comparator.compare(baseline, candidate);

      expect(report.deltaPassRate).toBeCloseTo(0.3, 5);
    });

    it('应计算平均分提升幅度（deltaAverageScore）', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.5, 0.5, []);
      const candidate = makeReport('cand', 0.5, 0.75, []);

      const report = comparator.compare(baseline, candidate);

      expect(report.deltaAverageScore).toBeCloseTo(0.25, 5);
    });

    it('应识别回归用例（baseline 通过但 candidate 失败）', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.5, 0.5, [
        makeCaseResult('c1', true, 0.9),
        makeCaseResult('c2', false, 0.3),
      ]);
      const candidate = makeReport('cand', 0.5, 0.5, [
        makeCaseResult('c1', false, 0.2),
        makeCaseResult('c2', true, 0.8),
      ]);

      const report = comparator.compare(baseline, candidate);

      expect(report.regressions).toHaveLength(1);
      expect(report.regressions[0].caseId).toBe('c1');
    });

    it('应识别提升用例（baseline 失败但 candidate 通过）', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.5, 0.5, [
        makeCaseResult('c1', false, 0.3),
      ]);
      const candidate = makeReport('cand', 1.0, 0.9, [
        makeCaseResult('c1', true, 0.9),
      ]);

      const report = comparator.compare(baseline, candidate);

      expect(report.improvements).toHaveLength(1);
      expect(report.improvements[0].caseId).toBe('c1');
    });

    it('当无回归且通过率提升时，verdict 应为 "improvement"', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.5, 0.5, [
        makeCaseResult('c1', false, 0.3),
      ]);
      const candidate = makeReport('cand', 1.0, 0.9, [
        makeCaseResult('c1', true, 0.9),
      ]);

      const report = comparator.compare(baseline, candidate);

      expect(report.verdict).toBe('improvement');
    });

    it('当存在回归时，verdict 应为 "regression"', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.5, 0.5, [
        makeCaseResult('c1', true, 0.9),
      ]);
      const candidate = makeReport('cand', 0.5, 0.5, [
        makeCaseResult('c1', false, 0.2),
      ]);

      const report = comparator.compare(baseline, candidate);

      expect(report.verdict).toBe('regression');
    });

    it('当无变化时，verdict 应为 "neutral"', () => {
      const comparator = new ABComparator();
      const baseline = makeReport('base', 0.5, 0.5, [
        makeCaseResult('c1', true, 0.8),
      ]);
      const candidate = makeReport('cand', 0.5, 0.5, [
        makeCaseResult('c1', true, 0.8),
      ]);

      const report = comparator.compare(baseline, candidate);

      expect(report.verdict).toBe('neutral');
    });
  });
});
