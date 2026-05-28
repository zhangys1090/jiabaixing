/**
 * Harness Phase 11: EvaluationPipeline 测试
 *
 * 测试评估流水线的三个阶段：步骤评估、独立评估、质量评分
 */

import { EvaluationPipeline } from '../../src/harness/evaluation/EvaluationPipeline';
import { StepEvaluator } from '../../src/harness/evaluation/StepEvaluator';
import { QualityScorer } from '../../src/harness/evaluation/QualityScorer';
import { IndependentEvaluationService } from '../../src/harness/evaluation/IndependentEvaluationService';
import type { EvaluationContext } from '../../src/harness/evaluation/EvaluationPipeline';
import type { StepEvaluationParams } from '../../src/harness/evaluation/StepEvaluator';

function makeDefaultContext(overrides?: Partial<EvaluationContext>): EvaluationContext {
  return {
    stepParams: [
      {
        stepId: 'step-1',
        toolName: 'memory_recall',
        args: { query: 'test' },
        result: { success: true, output: 'test result' },
        timestamp: Date.now(),
      },
      {
        stepId: 'step-2',
        toolName: 'code_read',
        args: { path: '/test' },
        result: { success: true, output: 'code content' },
        timestamp: Date.now(),
      },
    ],
    evalInput: {
      userInput: '帮我查一下昨天的会议记录，然后读取代码文件',
      conversationHistory: [],
      currentOutput: '好的，已经查看了会议记录和代码文件。会议记录了项目进度...',
      executionTrace: {
        totalToolCalls: 2,
        totalDuration: 5000,
        loopRounds: 1,
        toolResults: [
          { toolName: 'memory_recall', success: true },
          { toolName: 'code_read', success: true },
        ],
      },
    },
    scorerMetadata: {
      duration: 5000,
      retries: 0,
      errors: 0,
      context: '您请放心，我已经为您查看了会议记录和代码文件。',
      totalToolCalls: 2,
      successfulToolCalls: 2,
      loopRounds: 1,
      outputLength: 80,
    },
    ...overrides,
  };
}

describe('EvaluationPipeline', () => {
  let pipeline: EvaluationPipeline;

  beforeEach(() => {
    pipeline = new EvaluationPipeline();
  });

  // ─── 正常场景 ───

  describe('run - 正常场景', () => {
    it('应该成功运行完整的三阶段流水线', async () => {
      const result = await pipeline.run(makeDefaultContext());

      expect(result.passed).toBeDefined();
      expect(result.overallScore).toBeDefined();
      expect(result.stages).toHaveLength(3);
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('应该包含所有三个阶段的结果', async () => {
      const result = await pipeline.run(makeDefaultContext());
      const stageNames = result.stages.map(s => s.stageName);

      expect(stageNames).toContain('step_evaluation');
      expect(stageNames).toContain('independent_evaluation');
      expect(stageNames).toContain('quality_scoring');
    });

    it('应该收集各阶段建议', async () => {
      const result = await pipeline.run(makeDefaultContext());

      expect(result.suggestions).toBeInstanceOf(Array);
    });

    it('成功执行时should pass', async () => {
      const result = await pipeline.run(makeDefaultContext());

      expect(result.passed).toBe(true);
      expect(result.overallScore).toBeGreaterThanOrEqual(50);
    });
  });

  // ─── 阶段配置场景 ───

  describe('run - 阶段配置', () => {
    it('禁用所有阶段时综合分应为0', async () => {
      pipeline.setStageEnabled('step_evaluation', false);
      pipeline.setStageEnabled('independent_evaluation', false);
      pipeline.setStageEnabled('quality_scoring', false);

      const result = await pipeline.run(makeDefaultContext());

      expect(result.overallScore).toBe(0);
      expect(result.stages.every(s => s.passed)).toBe(true);
      result.stages.forEach(s => {
        expect(s.details).toContain('已禁用');
      });
    });

    it('只启用质量评分阶段应只得到该阶段结果', async () => {
      pipeline.setStageEnabled('step_evaluation', false);
      pipeline.setStageEnabled('independent_evaluation', false);

      const result = await pipeline.run(makeDefaultContext());

      const activeStages = result.stages.filter(s => !s.details.includes('已禁用'));
      expect(activeStages).toHaveLength(1);
      expect(activeStages[0].stageName).toBe('quality_scoring');
    });

    it('使用自定义评估器应覆盖默认逻辑', async () => {
      const customEvaluator = new StepEvaluator();
      jest.spyOn(customEvaluator, 'evaluateStep').mockReturnValue({
        stepId: 'custom',
        passed: true,
        score: 0.95,
        issues: [],
        suggestions: ['自定义建议'],
      });

      pipeline.addStage('step_evaluation', customEvaluator, 1.0);
      pipeline.setStageEnabled('independent_evaluation', false);
      pipeline.setStageEnabled('quality_scoring', false);

      const result = await pipeline.run(makeDefaultContext());

      expect(result.stages).toHaveLength(3);
      const stepStage = result.stages.find(s => s.stageName === 'step_evaluation');
      expect(stepStage).toBeDefined();
      expect(stepStage!.passed).toBe(true);
    });
  });

  // ─── 边缘和异常场景 ───

  describe('run - 边缘场景', () => {
    it('空步骤参数应不会崩溃', async () => {
      const context = makeDefaultContext({
        stepParams: [],
        scorerMetadata: {
          duration: 0,
          retries: 0,
          errors: 0,
          context: '',
          totalToolCalls: 0,
          successfulToolCalls: 0,
          loopRounds: 0,
          outputLength: 0,
        },
      });

      const result = await pipeline.run(context);

      expect(result.passed).toBeDefined();
      expect(result.overallScore).toBeGreaterThanOrEqual(0);
    });

    it('大量步骤应能正确处理', async () => {
      const manySteps: StepEvaluationParams[] = [];
      for (let i = 0; i < 50; i++) {
        manySteps.push({
          stepId: `step-${i}`,
          toolName: `tool_${i % 5}`,
          args: { input: `test-${i}` },
          result: { success: true, output: `output-${i}` },
          timestamp: Date.now() + i,
        });
      }

      const context = makeDefaultContext({ stepParams: manySteps });
      const result = await pipeline.run(context);

      expect(result.stages).toHaveLength(3);
      expect(result.overallScore).toBeGreaterThan(0);
    });

    it('所有步骤失败时质量评分应下降', async () => {
      const failedSteps: StepEvaluationParams[] = [
        {
          stepId: 'fail-1',
          toolName: 'memory_recall',
          args: { query: 'test' },
          result: { success: false, error: 'Service unavailable' },
          timestamp: Date.now(),
        },
        {
          stepId: 'fail-2',
          toolName: 'code_read',
          args: { path: '/test' },
          result: { success: false, error: 'File not found' },
          timestamp: Date.now(),
        },
      ];

      const context = makeDefaultContext({
        stepParams: failedSteps,
        scorerMetadata: {
          duration: 30000,
          retries: 3,
          errors: 2,
          context: '出错',
          totalToolCalls: 2,
          successfulToolCalls: 0,
          loopRounds: 1,
          outputLength: 20,
        },
      });

      const result = await pipeline.run(context);

      // 步骤评估阶段应显示未通过
      const stepStage = result.stages.find(s => s.stageName === 'step_evaluation');
      expect(stepStage).toBeDefined();
      expect(stepStage!.score).toBeLessThan(60);

      // 质量评分应低于正常情况
      expect(result.overallScore).toBeLessThan(80);
    });
  });

  // ─── 获取报告场景 ───

  describe('getReport', () => {
    it('应生成包含所有阶段信息的人类可读报告', async () => {
      const result = await pipeline.run(makeDefaultContext());
      const report = pipeline.getReport(result);

      expect(report).toContain('评估流水线报告');
      expect(report).toContain('综合评分');
      expect(report).toContain('step_evaluation');
      expect(report).toContain('independent_evaluation');
      expect(report).toContain('quality_scoring');
      expect(report).toContain('五维质量评分');
    });

    it('失败报告应包含阶段信息和建议', async () => {
      const failedSteps: StepEvaluationParams[] = [
        {
          stepId: 'fail',
          toolName: 'broken_tool',
          args: {},
          result: { success: false, error: 'Critical failure' },
          timestamp: Date.now(),
        },
      ];

      const context = makeDefaultContext({
        stepParams: failedSteps,
        scorerMetadata: {
          duration: 60000,
          retries: 5,
          errors: 3,
          context: '失败',
          totalToolCalls: 1,
          successfulToolCalls: 0,
          loopRounds: 1,
          outputLength: 5,
        },
      });

      const result = await pipeline.run(context);
      const report = pipeline.getReport(result);

      expect(report).toContain('评估流水线报告');
      expect(report).toContain('step_evaluation');
      expect(report).toContain('改进建议');
    });
  });

  // ─── 自定义阶段场景 ───

  describe('run - 自定义阶段', () => {
    it('应支持添加自定义阶段', async () => {
      const customScorer = new QualityScorer();
      pipeline.addStage('custom_quality', customScorer, 0.3);

      const result = await pipeline.run(makeDefaultContext());

      const stageNames = result.stages.map(s => s.stageName);
      expect(stageNames).toContain('custom_quality');
      // 应保留默认3阶段 + 自定义1阶段
      expect(result.stages.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── 管道配置场景 ───

  describe('自定义配置', () => {
    it('应使用自定义配置初始化', async () => {
      const customPipeline = new EvaluationPipeline({
        stages: [
          { name: 'step_evaluation', enabled: true, weight: 0.5 },
          { name: 'quality_scoring', enabled: true, weight: 0.5 },
        ],
      });

      // 启用质量评分
      const result = await customPipeline.run(makeDefaultContext());

      expect(result.stages.length).toBeGreaterThanOrEqual(2);
      const stageNames = result.stages.map(s => s.stageName);
      expect(stageNames).toContain('step_evaluation');
      expect(stageNames).toContain('quality_scoring');
    });
  });
});
