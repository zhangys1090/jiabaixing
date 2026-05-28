/**
 * QualityScorer 单元测试
 */
import { QualityScorer } from '../../src/harness/evaluation/QualityScorer';
import type { StepEvaluationResult } from '../../src/harness/evaluation/StepEvaluator';

describe('QualityScorer', () => {
  let scorer: QualityScorer;

  beforeEach(() => {
    scorer = new QualityScorer();
  });

  test('全部成功的步骤应该获得高分', () => {
    const steps: StepEvaluationResult[] = [
      { stepId: '1', passed: true, score: 100, issues: [], suggestions: [] },
      { stepId: '2', passed: true, score: 100, issues: [], suggestions: [] },
    ];
    const score = scorer.score(steps, { duration: 100, retries: 0, errors: 0, context: 'test' });
    expect(score.overall).toBeGreaterThan(80);
    expect(score.dimensions.accuracy).toBe(100);
  });

  test('全部失败的步骤应该获得低分', () => {
    const steps: StepEvaluationResult[] = [
      { stepId: '1', passed: false, score: 0, issues: [{ severity: 'error', type: 'FAIL', message: '失败' }], suggestions: ['检查参数'] },
    ];
    const score = scorer.score(steps, { duration: 10000, retries: 3, errors: 3, context: '' });
    expect(score.overall).toBeLessThan(50);
  });

  test('空步骤列表应该获得默认分', () => {
    const score = scorer.score([], { duration: 0, retries: 0, errors: 0, context: '' });
    expect(score.overall).toBeGreaterThan(0);
    expect(score.suggestions).toBeDefined();
  });

  test('安全维度在有敏感信息泄露时应该低分', () => {
    const steps: StepEvaluationResult[] = [
      { stepId: '1', passed: true, score: 100, issues: [{ severity: 'error', type: 'SENSITIVE_DATA', message: '包含电话' }], suggestions: [] },
    ];
    const score = scorer.score(steps, { duration: 100, retries: 0, errors: 0, context: 'test' });
    expect(score.dimensions.safety).toBe(0);
  });

  test('五维评分应该都有值', () => {
    const score = scorer.score([], { duration: 0, retries: 0, errors: 0, context: '正常测试' });
    const dims = ['accuracy', 'efficiency', 'safety', 'persona', 'stability'] as const;
    for (const dim of dims) {
      expect(score.dimensions[dim]).toBeGreaterThanOrEqual(0);
      expect(score.dimensions[dim]).toBeLessThanOrEqual(100);
    }
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(100);
  });
});
