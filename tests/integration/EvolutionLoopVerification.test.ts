/**
 * 进化闭环端到端验证
 *
 * 验证 Loop B 真正闭合：
 * 1. 用户交互 → EvolutionEngine.collectFeedback()
 * 2. 低质量交互 → 自动生成 PromptExample
 * 3. PromptExample → 通过 getStrategyOptimizer().getPromptExamples() 返回
 * 4. 工具统计 → getToolWeights() 返回进化权重
 * 5. 权重 → applyEvolutionWeights() 应用到 ToolReliabilityTracker
 * 6. FeedbackCollector → 检测用户纠正 → 通知 EvolutionEngine
 */

import { EvolutionEngine } from '../../src/evolution/EvolutionEngine';
import { FeedbackCollector } from '../../src/evolution/FeedbackCollector';
import { ToolRegistry, ToolReliabilityTracker } from '../../src/harness/tools/registry/ToolRegistry';
import type { ToolCategory, ToolResult, ToolContext } from '../../src/harness/types';

describe('进化闭环端到端验证', () => {
  let evolutionEngine: EvolutionEngine;
  let feedbackCollector: FeedbackCollector;
  let toolRegistry: ToolRegistry;
  let reliabilityTracker: ToolReliabilityTracker;

  beforeEach(() => {
    evolutionEngine = new EvolutionEngine();
    feedbackCollector = new FeedbackCollector();
    toolRegistry = new ToolRegistry();
    reliabilityTracker = toolRegistry.getReliabilityTracker();
  });

  describe('Loop B-1: 交互反馈 → PromptExample 生成', () => {
    it('应该从失败交互中生成 PromptExample', () => {
      // 模拟多次失败交互
      for (let i = 0; i < 5; i++) {
        evolutionEngine.collectFeedback(
          '帮我重构代码中的数据库模块',
          '抱歉，执行失败了',
          { success: false, toolsUsed: ['code_analyze'], error: 'timeout' },
          'coding'
        );
      }

      // 评估质量触发学习
      evolutionEngine.assessQuality('trace-1', false, 0.3, 5000, 'coding');

      // 验证: PromptExample 应该被生成
      const examples = evolutionEngine.getStrategyOptimizer().getPromptExamples();
      expect(examples.length).toBeGreaterThan(0);

      // 验证: 示例包含触发条件和纠正建议
      const first = examples[0];
      expect(first.trigger).toBeDefined();
      expect(first.correction).toBeDefined();
      expect(first.frequency).toBeGreaterThanOrEqual(1);
    });

    it('应该从低质量交互中学习共同模式', () => {
      // 模拟低质量交互（相似场景）
      const inputs = [
        '帮我搜索文件 test.ts',
        '帮我搜索文件 utils.ts',
        '帮我搜索文件 config.ts',
      ];

      for (const input of inputs) {
        evolutionEngine.collectFeedback(
          input,
          '找到了，但是结果不完整',
          { success: false, toolsUsed: ['file_search'], error: 'partial_result' },
          'file_operation'
        );
      }

      evolutionEngine.assessQuality('trace-2', false, 0.4, 3000);

      const examples = evolutionEngine.getStrategyOptimizer().getPromptExamples();
      expect(examples.length).toBeGreaterThan(0);
    });

    it('成功交互不应生成负面 PromptExample', () => {
      // 记录初始示例数（可能从持久化加载）
      const initialCount = evolutionEngine.getStrategyOptimizer().getPromptExamples().length;

      for (let i = 0; i < 5; i++) {
        evolutionEngine.collectFeedback(
          `你好，今天天气怎么样？ ${Date.now()}-${i}`,
          '今天天气晴朗，温度25度',
          { success: true, toolsUsed: ['web_search'] },
          'general'
        );
      }

      evolutionEngine.assessQuality('trace-3', true, 0.9, 1000);

      const examples = evolutionEngine.getStrategyOptimizer().getPromptExamples();
      // 成功交互不应产生新的纠错示例
      expect(examples.length).toBe(initialCount);
    });
  });

  describe('Loop B-2: 工具统计 → 进化权重', () => {
    it('应该从工具调用统计中计算进化权重', () => {
      // 使用唯一工具名避免持久化状态干扰
      const goodTool = `test_good_${Date.now()}`;
      const badTool = `test_bad_${Date.now()}`;

      // 模拟工具调用统计（每个工具至少3次调用才产出权重）
      for (let i = 0; i < 3; i++) {
        evolutionEngine.collectFeedback(
          `good op ${i}`,
          'ok',
          { success: true, toolsUsed: [goodTool] }
        );
      }
      for (let i = 0; i < 3; i++) {
        evolutionEngine.collectFeedback(
          `bad op ${i}`,
          'fail',
          { success: false, toolsUsed: [badTool], error: 'timeout' }
        );
      }

      const weights = evolutionEngine.getToolWeights();

      // 高成功率工具 → 权重 > 1.0
      expect(weights[goodTool]).toBeDefined();
      expect(weights[goodTool]).toBeGreaterThan(1.0);

      // 低成功率工具 → 权重 < 1.0
      expect(weights[badTool]).toBeDefined();
      expect(weights[badTool]).toBeLessThan(1.0);

      // 权重差值应明显
      expect(weights[goodTool] - weights[badTool]).toBeGreaterThan(0.5);
    });

    it('应该将进化权重应用到 ToolReliabilityTracker', () => {
      // 使用唯一工具名
      const toolA = `tracker_a_${Date.now()}`;
      const toolB = `tracker_b_${Date.now()}`;

      // 模拟进化引擎产出权重（每个工具至少3次）
      for (let i = 0; i < 3; i++) {
        evolutionEngine.collectFeedback(`test-a-${i}`, 'ok', { success: true, toolsUsed: [toolA] });
      }
      for (let i = 0; i < 3; i++) {
        evolutionEngine.collectFeedback(`test-b-${i}`, 'fail', { success: false, toolsUsed: [toolB], error: 'err' });
      }

      const weights = evolutionEngine.getToolWeights();

      // 应用权重到 Tracker
      reliabilityTracker.applyEvolutionWeights(weights);

      // 验证: Tracker 中的进化权重已被设置
      expect(reliabilityTracker.getEvolutionWeight(toolA)).toBeGreaterThan(1.0);
      expect(reliabilityTracker.getEvolutionWeight(toolB)).toBeLessThan(1.0);

      // 验证: 综合评分 = 成功率 × 进化权重
      reliabilityTracker.recordCall(toolA, true, 100);
      reliabilityTracker.recordCall(toolB, false, 100, 'err');

      const scoreA = reliabilityTracker.getCompositeScore(toolA);
      const scoreB = reliabilityTracker.getCompositeScore(toolB);
      expect(scoreA).toBeGreaterThan(scoreB);
    });
  });

  describe('Loop B-3: FeedbackCollector 真实反馈收集', () => {
    it('应该检测用户纠正', () => {
      const record = feedbackCollector.analyzeUserInput(
        '不对，我说的是 TypeScript 文件',
        '我帮你找到了 JavaScript 文件',
        'user-1',
        'coding'
      );

      expect(record).not.toBeNull();
      expect(record!.type).toBe('correction');
    });

    it('应该检测重复提问', () => {
      // 第一次提问
      feedbackCollector.analyzeUserInput('帮我搜索 config.ts', '', 'user-1');

      // 短时间内重复提问
      const record = feedbackCollector.analyzeUserInput(
        '帮我搜索 config.ts',
        '没找到文件',
        'user-1'
      );

      expect(record).not.toBeNull();
      expect(record!.type).toBe('retry');
    });

    it('应该记录工具失败', () => {
      feedbackCollector.recordToolFailure(
        'file_search',
        'ECONNREFUSED',
        '搜索文件',
        'user-1'
      );

      const stats = feedbackCollector.getFeedbackStats();
      expect(stats['tool_failure']).toBe(1);
    });

    it('应该记录低质量交互', () => {
      feedbackCollector.recordLowQuality(
        '帮我写代码',
        '无法理解你的需求',
        0.3,
        'user-1',
        'coding'
      );

      const stats = feedbackCollector.getFeedbackStats();
      expect(stats['low_quality']).toBe(1);
    });

    it('反馈应通知 EvolutionEngine', () => {
      let notified = false;
      const collector = new FeedbackCollector({
        onFeedback: () => { notified = true; },
      });

      collector.analyzeUserInput('不对，重新来', '上一次的结果');

      expect(notified).toBe(true);
    });
  });

  describe('完整闭环: FeedbackCollector → EvolutionEngine → Planner/Context', () => {
    it('闭环数据流验证', () => {
      // 1. FeedbackCollector 检测到用户纠正
      const feedback = feedbackCollector.analyzeUserInput(
        '不对，我要的是 Python 文件',
        '已找到 JavaScript 文件',
        'user-1',
        'coding'
      );
      expect(feedback).not.toBeNull();

      // 2. EvolutionEngine 记录反馈
      evolutionEngine.collectFeedback(
        feedback!.input,
        feedback!.response,
        { success: false, toolsUsed: ['file_search'], error: 'correction' },
        feedback!.scene
      );

      // 3. 多次类似反馈后生成 PromptExample
      for (let i = 0; i < 3; i++) {
        evolutionEngine.collectFeedback(
          '不对，Python 不是 JavaScript',
          '抱歉搞混了',
          { success: false, toolsUsed: ['file_search'], error: 'wrong_language' },
          'coding'
        );
      }
      evolutionEngine.assessQuality('trace-loop', false, 0.3, 2000);

      // 4. 验证: getPromptExamples 返回真实数据
      const examples = evolutionEngine.getStrategyOptimizer().getPromptExamples();
      expect(examples.length).toBeGreaterThan(0);

      // 5. 验证: getToolWeights 返回真实数据
      const weights = evolutionEngine.getToolWeights();
      expect(Object.keys(weights).length).toBeGreaterThan(0);

      // 6. 验证: 权重可应用到 ToolReliabilityTracker
      reliabilityTracker.applyEvolutionWeights(weights);
      expect(reliabilityTracker.getEvolutionWeight('file_search')).toBeDefined();

      // 7. 验证: toOpenAITools 会反映进化权重
      // (注册一个测试工具来看效果)
      toolRegistry.register(
        {
          name: 'file_search',
          description: '搜索文件',
          category: 'file' as ToolCategory,
          parameters: {},
          requiredParams: [],
          requiredPermissions: [],
          riskLevel: 'low',
          idempotent: true,
          timeout: 5000,
        },
        async (_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => ({
          success: true,
          output: 'ok',
          duration: 100,
          validated: true,
        })
      );

      // 记录一次成功调用让 tool 有统计数据
      reliabilityTracker.recordCall('file_search', true, 100);

      const openAITools = toolRegistry.toOpenAITools();
      const fileSearchTool = openAITools.find(
        (t) => t.function.name === 'file_search'
      );
      expect(fileSearchTool).toBeDefined();
      // description 应该包含进化权重信息（如果权重 ≠ 1.0）
      const weight = reliabilityTracker.getEvolutionWeight('file_search');
      if (weight !== 1.0) {
        expect(fileSearchTool!.function.description).toContain('进化权重');
      }
    });
  });
});
