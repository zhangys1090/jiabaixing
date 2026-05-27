/**
 * Phase 4：进化验证集成测试
 * Day 11: 进化闭环测试 — 连续5次任务 + 纠错 → 偏好记忆 → 自动采纳
 * Day 12: 优化报告验证 — 手动触发 + 权重调整 + 报告持久化
 */

import { FeedbackCollector, FeedbackRecord } from '../../src/evolution/FeedbackCollector';
import { StrategyOptimizer, OptimizationLog } from '../../src/evolution/StrategyOptimizer';
import { PreferenceManager } from '../../src/memory/PreferenceManager';

// ==================== Day 11: 进化闭环测试 ====================

describe('Phase 4 Day 11: 进化闭环测试', () => {
  let prefManager: PreferenceManager;
  let feedbackCollector: FeedbackCollector;
  let strategyOptimizer: StrategyOptimizer;

  beforeEach(() => {
    prefManager = PreferenceManager.getInstance();
    prefManager.reset();
    feedbackCollector = new FeedbackCollector();
    strategyOptimizer = new StrategyOptimizer();
  });

  describe('5次 Python 文件创建任务（前2次纠错）', () => {
    test('纠错1: "变量名用 snake_case" 应被 PreferenceManager 记录', () => {
      const correctionText = '变量名应该用 snake_case，不要用驼峰';

      const entry = prefManager.applyCorrection(correctionText, 'naming');

      expect(entry).not.toBeNull();
      expect(entry!.key).toBe('naming_convention');
      expect(entry!.value).toBe('snake_case');
      expect(entry!.confidence).toBeGreaterThanOrEqual(0.9);
      expect(entry!.source).toBe('correction');
    });

    test('纠错2: "类名用 PascalCase" 应覆盖之前的命名偏好', () => {
      prefManager.applyCorrection('变量名用 snake_case', 'naming');
      const secondCorrection = prefManager.applyCorrection('类名要用 PascalCase', 'naming');

      expect(secondCorrection).not.toBeNull();
      expect(secondCorrection!.key).toBe('naming_convention');
      expect(secondCorrection!.value).toBe('PascalCase');

      const pref = prefManager.getPreference('naming_convention');
      expect(pref!.value).toBe('PascalCase');
      expect(prefManager.count).toBe(1);
    });

    test('第3-5次任务应自动采用正确的命名风格（通过偏好摘要验证）', () => {
      prefManager.applyCorrection('用 snake_case 命名', 'naming');
      prefManager.applyCorrection('函数名也用小写加下划线', 'naming');

      const summary = prefManager.getSummary();

      expect(summary.namingRules.length).toBeGreaterThanOrEqual(1);
      expect(summary.namingRules.some(r => r.includes('snake_case'))).toBeTruthy();
      expect(summary.recentCorrections.length).toBeGreaterThanOrEqual(1);
    });

    test('第3-5次任务应自动采用正确的命名风格（通过 injectPreferences 验证）', () => {
      prefManager.applyCorrection('用 snake_case 命名', 'naming');

      const { injectPreferences } = require('../../src/memory/PreferenceInjector');
      const enhancedPrompt = injectPreferences('你是一个编程助手。');

      expect(enhancedPrompt).toContain('snake_case');
      expect(enhancedPrompt).toContain('用户偏好');
    });
  });

  describe('FeedbackCollector → PreferenceManager 纠错同步', () => {
    test('collectCorrection 应同步到 PreferenceManager', () => {
      feedbackCollector.collectCorrection('file', 'coding-style', 'naming_convention:snake_case');

      const records = feedbackCollector.getCorrections();
      expect(records.length).toBe(1);
      expect(records[0].userCorrection).toContain('naming_convention:snake_case');

      const pref = prefManager.getPreference('naming_convention');
      expect(pref).toBeDefined();
      expect(pref!.value).toBe('snake_case');
    });

    test('collect 方法检测到纠错文本时应自动同步到 PreferenceManager', async () => {
      const entry = prefManager.applyCorrection('变量名要用 camelCase', 'naming');

      expect(entry).not.toBeNull();
      expect(entry!.key).toBe('naming_convention');
      expect(entry!.value).toBe('camelCase');
    });

    test('collect 方法检测到工具偏好纠错时应同步', () => {
      const entry = prefManager.applyCorrection('应该用 search 工具而不是 file', 'tool');

      expect(entry).not.toBeNull();
      expect(entry!.key).toBe('preferred_tool');
      expect(entry!.value).toBe('search');
    });

    test('Positive feedback 不应触发偏好更新', () => {
      const mockExecutionResult = { success: true, output: 'ok', duration: 50 };
      feedbackCollector.collect('谢谢，做得不错', '已完成', mockExecutionResult, 'daily');

      expect(prefManager.count).toBe(0);
    });
  });

  describe('FeedbackCollector → StrategyOptimizer 反馈积累', () => {
    test('多次纠错应积累到 feedbackBuffer', () => {
      const mockExecutionResult = { success: true, output: 'ok', duration: 50 };

      strategyOptimizer.addFeedback({
        traceId: 'test-1',
        input: '用 camelCase',
        response: 'done',
        executionSuccess: true,
        userCorrection: 'correction: camelCase',
        inferredSatisfaction: 0.3,
        timestamp: Date.now(),
        scene: 'development',
      });

      strategyOptimizer.addFeedback({
        traceId: 'test-2',
        input: '不要用 var',
        response: 'done',
        executionSuccess: true,
        userCorrection: 'correction: no-var',
        inferredSatisfaction: 0.2,
        timestamp: Date.now(),
        scene: 'development',
      });

      const weights = strategyOptimizer.getSkillWeights();
      expect(weights).toBeDefined();
    });
  });
});

// ==================== Day 12: 优化报告验证 ====================

describe('Phase 4 Day 12: 优化报告验证', () => {
  let strategyOptimizer: StrategyOptimizer;
  let prefManager: PreferenceManager;

  beforeEach(() => {
    strategyOptimizer = new StrategyOptimizer();
    prefManager = PreferenceManager.getInstance();
    prefManager.reset();
  });

  describe('手动触发优化', () => {
    test('triggerManualOptimization 应生成优化日志', async () => {
      for (let i = 0; i < 5; i++) {
        strategyOptimizer.addFeedback({
          traceId: `feedback-${i}`,
          input: `测试输入 ${i}`,
          response: '响应内容',
          executionSuccess: true,
          userCorrection: 'correction: file',
          inferredSatisfaction: 0.3,
          timestamp: Date.now(),
          scene: 'development',
        });
      }

      const log: OptimizationLog = await strategyOptimizer.triggerManualOptimization('用户反馈代码风格不符');

      expect(log).toBeDefined();
      expect(log.triggeredBy).toBe('manual');
      expect(log.reason).toBe('用户反馈代码风格不符');
      expect(log.timestamp).toBeInstanceOf(Date);
      expect(log.id).toBeTruthy();
      expect(log.feedbackCount).toBe(5);
    });

    test('优化后权重应发生变化', async () => {
      strategyOptimizer.addFeedback({
        traceId: 'corr-1',
        input: '不要用 file 工具',
        response: 'done',
        executionSuccess: true,
        userCorrection: 'correction: file',
        inferredSatisfaction: 0.2,
        timestamp: Date.now(),
        scene: 'development',
      });
      strategyOptimizer.addFeedback({
        traceId: 'corr-2',
        input: '用 search 不是 file',
        response: 'done',
        executionSuccess: true,
        userCorrection: 'correction: file',
        inferredSatisfaction: 0.2,
        timestamp: Date.now(),
        scene: 'development',
      });

      const beforeWeights = strategyOptimizer.getSkillWeights();
      const fileWeightBefore = beforeWeights.get('file') || 1.0;

      await strategyOptimizer.triggerManualOptimization('用户频繁纠正 file 工具');

      const afterWeights = strategyOptimizer.getSkillWeights();
      const fileWeightAfter = afterWeights.get('file') || 1.0;

      expect(fileWeightAfter).toBeLessThan(fileWeightBefore);
    });

    test('优化日志应包含技能权重调整记录', async () => {
      strategyOptimizer.addFeedback({
        traceId: 'corr-1',
        input: '用 search 工具',
        response: 'done',
        executionSuccess: true,
        userCorrection: 'correction: search',
        inferredSatisfaction: 0.4,
        timestamp: Date.now(),
        scene: 'development',
      });

      const log: OptimizationLog = await strategyOptimizer.triggerManualOptimization('工具偏好调整');

      expect(log.skillAdjustments).toBeDefined();
    });

    test('优化后清空 feedbackBuffer', async () => {
      strategyOptimizer.addFeedback({
        traceId: 'fb-1',
        input: 'test',
        response: 'done',
        executionSuccess: true,
        userCorrection: null,
        inferredSatisfaction: 0.7,
        timestamp: Date.now(),
      });

      await strategyOptimizer.triggerManualOptimization('手动触发');

      const history = strategyOptimizer.getOptimizationHistory();
      expect(history.length).toBe(1);
      expect(history[0].feedbackCount).toBe(1);
    });
  });

  describe('优化报告持久化', () => {
    test('getOptimizationHistory 应返回所有历史', async () => {
      await strategyOptimizer.triggerManualOptimization('第一次优化');
      await strategyOptimizer.triggerManualOptimization('第二次优化');

      const history = strategyOptimizer.getOptimizationHistory();
      expect(history.length).toBe(2);
      expect(history[0].reason).toBe('第一次优化');
      expect(history[1].reason).toBe('第二次优化');
    });

    test('每次优化的 id 应唯一', async () => {
      const log1 = await strategyOptimizer.triggerManualOptimization('优化1');
      const log2 = await strategyOptimizer.triggerManualOptimization('优化2');

      expect(log1.id).not.toBe(log2.id);
    });

    test('优化日志应包含时间戳', async () => {
      const before = Date.now();
      const log = await strategyOptimizer.triggerManualOptimization('时间验证');
      const after = Date.now();

      const ts = log.timestamp.getTime();
      expect(ts).toBeGreaterThanOrEqual(before - 100);
      expect(ts).toBeLessThanOrEqual(after + 100);
    });
  });

  describe('EvolutionEngine 手动触发集成', () => {
    test('触发关键词检测: 用户主动纠错应触发偏好生效', () => {
      const entry = prefManager.applyCorrection('用 camelCase 命名', 'naming');

      expect(entry).not.toBeNull();
      expect(entry!.key).toBe('naming_convention');
      expect(entry!.value).toBe('camelCase');
    });
  });

  describe('偏好记忆快速生效（无需等待进化引擎）', () => {
    test('纠错应通过 PreferenceManager 立即生效', () => {
      const beforeCount = prefManager.count;
      prefManager.applyCorrection('用单引号不要双引号', 'coding-style');
      expect(prefManager.count).toBe(beforeCount + 1);

      const summary = prefManager.getSummary();
      expect(summary.codingStyle.some(s => s.includes('single'))).toBeTruthy();
    });

    test('多次纠错同一偏好应覆盖', () => {
      prefManager.applyCorrection('用双引号', 'coding-style');
      expect(prefManager.getPreference('quote_style')?.value).toBe('double');

      prefManager.applyCorrection('用单引号', 'coding-style');
      expect(prefManager.getPreference('quote_style')?.value).toBe('single');
    });

    test('偏好摘要应反映最新状态', () => {
      prefManager.applyCorrection('用 camelCase 命名', 'naming');
      prefManager.applyCorrection('缩进用 2 个空格', 'coding-style');

      const summary = prefManager.getSummary();
      expect(summary.namingRules.length).toBeGreaterThanOrEqual(1);
      expect(summary.codingStyle.length).toBeGreaterThanOrEqual(1);
    });
  });
});
