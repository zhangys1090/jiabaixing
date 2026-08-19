/**
 * 3.3 评估体系扩展 — A/B 评估：改进前后对比
 *
 * 验证 ABComparator 能对同一组用例运行两次（baseline vs candidate），
 * 生成对比报告，识别回归与提升
 */
import { ABComparator, CanaryReleaseManager } from '../../../../src/harness/evaluation/ABComparator';
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

  describe('CanaryReleaseManager', () => {
    let manager: CanaryReleaseManager;

    beforeEach(() => {
      manager = new CanaryReleaseManager();
    });

    it('应创建灰度发布规则', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'system_prompt',
        baselineValue: 'v1',
        candidateValue: 'v2',
        initialTrafficPercent: 5,
      });

      expect(rule.id).toMatch(/^canary_/);
      expect(rule.target).toBe('prompt');
      expect(rule.trafficPercent).toBe(5);
      expect(rule.status).toBe('draft');
    });

    it('应启动灰度发布', () => {
      const rule = manager.createRule({
        target: 'model',
        targetName: 'gpt-4',
        baselineValue: 'gpt-4',
        candidateValue: 'gpt-4-turbo',
      });

      const started = manager.startRule(rule.id);
      expect(started?.status).toBe('running');
    });

    it('应递增流量百分比', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'test',
        baselineValue: 'v1',
        candidateValue: 'v2',
        initialTrafficPercent: 5,
      });
      manager.startRule(rule.id);

      const updated = manager.increaseTraffic(rule.id, 20);
      expect(updated?.trafficPercent).toBe(25);
    });

    it('流量达到100%时自动标记完成', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'test',
        baselineValue: 'v1',
        candidateValue: 'v2',
        initialTrafficPercent: 80,
      });
      manager.startRule(rule.id);

      const updated = manager.increaseTraffic(rule.id, 30);
      expect(updated?.trafficPercent).toBe(100);
      expect(updated?.status).toBe('completed');
    });

    it('应回滚灰度发布', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'test',
        baselineValue: 'v1',
        candidateValue: 'v2',
      });
      manager.startRule(rule.id);

      const rolledBack = manager.rollback(rule.id, '错误率过高');
      expect(rolledBack?.status).toBe('rolled_back');
      expect(rolledBack?.trafficPercent).toBe(0);
    });

    it('应基于用户ID哈希实现稳定分流', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'test',
        baselineValue: 'v1',
        candidateValue: 'v2',
        initialTrafficPercent: 50,
      });
      manager.startRule(rule.id);

      const result1 = manager.shouldUseCandidate(rule.id, 'user_alice');
      const result2 = manager.shouldUseCandidate(rule.id, 'user_alice');
      expect(result1).toBe(result2);
    });

    it('应获取当前生效的值', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'test',
        baselineValue: 'v1',
        candidateValue: 'v2',
        initialTrafficPercent: 0,
      });
      manager.startRule(rule.id);

      const value = manager.getActiveValue(rule.id, 'user_test');
      expect(value).toBe('v1');
    });

    it('应记录指标并获取摘要', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'test',
        baselineValue: 'v1',
        candidateValue: 'v2',
      });
      manager.startRule(rule.id);

      for (let i = 0; i < 15; i++) {
        manager.recordMetric(rule.id, false, i % 5 === 0, 100 + i * 10);
        manager.recordMetric(rule.id, true, i % 3 === 0, 150 + i * 10);
      }

      const metrics = manager.getMetrics(rule.id);
      expect(metrics).not.toBeNull();
      expect(metrics!.sampleCount).toBe(30);
      expect(metrics!.baselineErrorRate).toBeGreaterThanOrEqual(0);
    });

    it('自动回滚应在错误率超阈值时触发', () => {
      const rule = manager.createRule({
        target: 'prompt',
        targetName: 'test',
        baselineValue: 'v1',
        candidateValue: 'v2',
        autoRollbackThreshold: { errorRate: 0.3, latencyMs: 60000 },
      });
      manager.startRule(rule.id);

      for (let i = 0; i < 15; i++) {
        manager.recordMetric(rule.id, true, true, 100);
      }

      const rolledBackRule = manager.getRule(rule.id);
      expect(rolledBackRule?.status).toBe('rolled_back');
    });

    it('应列出所有规则', () => {
      manager.createRule({
        target: 'prompt',
        targetName: 'a',
        baselineValue: 'v1',
        candidateValue: 'v2',
      });
      manager.createRule({
        target: 'model',
        targetName: 'b',
        baselineValue: 'v1',
        candidateValue: 'v2',
      });

      const rules = manager.listRules();
      expect(rules).toHaveLength(2);
    });
  });
});