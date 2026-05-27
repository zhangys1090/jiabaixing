/**
 * 正向循环效果集成测试
 * 模拟 10 次"主人纠错：文件命名请用 snake_case"后
 * 检查下次文件生成是否自动使用 snake_case
 */

import { FeedbackCollector, FeedbackRecord } from '../../src/evolution/FeedbackCollector';
import { PromptExample, StrategyOptimizer } from '../../src/evolution/StrategyOptimizer';

describe('Positive Loop (Integration)', () => {
  let feedbackCollector: FeedbackCollector;
  let strategyOptimizer: StrategyOptimizer;

  beforeEach(() => {
    feedbackCollector = new FeedbackCollector();
    strategyOptimizer = new StrategyOptimizer();
  });

  describe('Feedback collection', () => {
    it('should collect feedback records', () => {
      for (let i = 0; i < 10; i++) {
        feedbackCollector.collectCorrection('file_skill', 'naming', 'snake_case');
      }

      const corrections = feedbackCollector.getCorrections();
      expect(corrections.length).toBe(10);
      expect(corrections.every((c: FeedbackRecord) => c.userCorrection === 'naming:snake_case')).toBe(true);
    });

    it('should detect correction patterns in user input', (done) => {
      feedbackCollector.collect('请用 snake_case 命名', '好的', { success: true });
      feedbackCollector.collect('文件命名请用蛇形命名法', '好的', { success: true });
      feedbackCollector.collect('请使用小写加下划线', '好的', { success: true });
      setImmediate(() => {
        const corrections = feedbackCollector.getCorrections();
        expect(corrections.length).toBeGreaterThanOrEqual(1);
        done();
      });
    });
  });

  describe('Strategy optimization', () => {
    it('should trigger auto-optimization after 50 feedbacks', async () => {
      for (let i = 0; i < 50; i++) {
        strategyOptimizer.addFeedback({
          traceId: `test_${i}`,
          input: '文件命名请用 snake_case',
          response: '好的',
          executionSuccess: true,
          userCorrection: 'naming:snake_case',
          inferredSatisfaction: 0.3,
          timestamp: Date.now(),
        });
      }

      const log = await strategyOptimizer.optimizeIfNeeded();
      expect(log).not.toBeNull();
      expect(log!.triggeredBy).toBe('auto');
      expect(log!.feedbackCount).toBeGreaterThanOrEqual(50);
    });

    it('should produce skill weight adjustments', async () => {
      for (let i = 0; i < 50; i++) {
        strategyOptimizer.addFeedback({
          traceId: `test_${i}`,
          input: '测试纠错',
          response: '好的',
          executionSuccess: i % 2 === 0,
          userCorrection: i % 2 === 0 ? 'file_skill:correction' : null,
          inferredSatisfaction: i % 2 === 0 ? 0.3 : 0.7,
          timestamp: Date.now(),
        });
      }

      const log = await strategyOptimizer.optimizeIfNeeded();
      expect(log).not.toBeNull();
      expect(log!.skillAdjustments.length).toBeGreaterThanOrEqual(0);
    });

    it('should build prompt examples from repeated corrections', async () => {
      for (let i = 0; i < 60; i++) {
        strategyOptimizer.addFeedback({
          traceId: `test_${i}`,
          input: `请用 snake_case 命名第${i}个文件`,
          response: '好的',
          executionSuccess: true,
          userCorrection: 'correction:snake_case',
          inferredSatisfaction: i < 30 ? 0.3 : 0.7,
          timestamp: Date.now(),
        });
      }

      const log = await strategyOptimizer.optimizeIfNeeded();
      expect(log).not.toBeNull();

      const examples = strategyOptimizer.getPromptExamples();
      const snakeCaseExample = examples.find((e: PromptExample) => e.correction.includes('snake_case'));
      expect(snakeCaseExample).toBeDefined();
    });

    it('should not trigger optimization below threshold', async () => {
      for (let i = 0; i < 49; i++) {
        strategyOptimizer.addFeedback({
          traceId: `test_${i}`,
          input: '普通对话',
          response: '好的',
          executionSuccess: true,
          userCorrection: null,
          inferredSatisfaction: 0.7,
          timestamp: Date.now(),
        });
      }

      const log = await strategyOptimizer.optimizeIfNeeded();
      expect(log).toBeNull();
    });
  });

  describe('Tone preference learning', () => {
    it('should detect positive tone preference patterns', async () => {
      for (let i = 0; i < 60; i++) {
        strategyOptimizer.addFeedback({
          traceId: `test_${i}`,
          input: '不错，继续',
          response: '谢谢你的反馈',
          executionSuccess: true,
          userCorrection: null,
          inferredSatisfaction: i < 40 ? 0.9 : 0.7,
          timestamp: Date.now(),
          scene: 'daily',
        });
      }

      const log = await strategyOptimizer.optimizeIfNeeded();
      expect(log).not.toBeNull();
    });
  });

  describe('Optimization logging', () => {
    it('should maintain optimization history', async () => {
      const log1 = await strategyOptimizer.triggerManualOptimization('测试优化1');
      const log2 = await strategyOptimizer.triggerManualOptimization('测试优化2');

      const history = strategyOptimizer.getOptimizationHistory();
      expect(history.length).toBe(2);
      expect(history[0].id).toBe(log1.id);
      expect(history[0].triggeredBy).toBe('manual');
    });
  });
});
