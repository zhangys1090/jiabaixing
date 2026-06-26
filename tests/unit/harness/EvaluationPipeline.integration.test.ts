/**
 * EvaluationPipeline 集成测试
 * 直接测试 evaluateWithPipeline 和 persistEvaluationResult 方法
 * 避免加载完整 LoopController 导致 OOM
 */
import type {
  EvaluationContext,
  PipelineResult,
} from '../../../src/harness/evaluation/EvaluationPipeline';
import type { LoopContext } from '../../../src/harness/types';

// Mock重量级模块 — 必须在import之前
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/evolution/EvolutionOrchestrator', () => ({
  EvolutionOrchestrator: {
    getInstance: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('../../../src/core/DAGTask', () => ({
  DAGTask: jest.fn(),
  TaskNode: jest.fn(),
  TaskStatus: {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
  },
  TaskPriority: { HIGH: 0, MEDIUM: 1, LOW: 2 },
}));

jest.mock('../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'complex',
      estimatedSteps: 3,
      estimatedTime: 5000,
      requiresTools: [],
      riskFactors: [],
      recommendations: [],
      dependencies: [],
      parallelizable: false,
      parallelismScore: 0,
    }),
  })),
}));

jest.mock('../../../src/curator/CuratorService', () => ({
  CuratorService: jest.fn().mockImplementation(() => ({
    generateSkillFromTrace: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../../src/monitoring/PerformanceMonitor', () => ({
  perf: {
    start: jest.fn().mockReturnValue(jest.fn()),
    mark: jest.fn(),
    measure: jest
      .fn()
      .mockImplementation((_name: string, fn: () => any) => fn()),
  },
}));

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    addTracePhase: jest.fn(),
    completeTracePhase: jest.fn(),
    startFullTrace: jest.fn(),
    completeFullTrace: jest.fn(),
    recordTokenUsage: jest.fn(),
    recordToolCall: jest.fn(),
    on: jest.fn(),
    onDynamic: jest.fn(),
    offDynamic: jest.fn(),
  },
}));

jest.mock('../../../src/harness/evaluation/EvaluationPipeline', () => ({
  EvaluationPipeline: jest.fn().mockImplementation(() => ({
    run: jest.fn(),
    addStage: jest.fn(),
  })),
}));

import type {
  EvaluatorOutput,
  LoopControllerDeps,
} from '../../../src/harness/loop/LoopController';
import { LoopController } from '../../../src/harness/loop/LoopController';

/**
 * 创建最小化的 LoopController 实例
 * 只初始化 evaluateWithPipeline 和 persistEvaluationResult 需要的依赖
 */
function createMinimalController(
  pipeline?: any,
  trajectoryDB?: any
): LoopController {
  const mockEvaluator = {
    evaluate: jest.fn().mockResolvedValue({
      goalProgress: 0.95,
      suggestedAction: 'continue' as const,
      reason: '目标已达成',
    }),
  };

  const deps: LoopControllerDeps = {
    planner: { plan: jest.fn() } as any,
    executor: { execute: jest.fn() } as any,
    evaluator: mockEvaluator as any,
    reporter: { report: jest.fn() } as any,
    constraintsService: {
      checkBudget: jest
        .fn()
        .mockReturnValue({ withinBudget: true, warnings: [] }),
      executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
    } as any,
    toolRegistry: {
      getRegisteredToolNames: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(undefined),
    } as any,
    evaluationPipeline: pipeline as any,
    trajectoryDatabase: trajectoryDB as any,
  };

  return new LoopController(deps);
}

function createLoopContext(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    messages: [],
    plan: null,
    currentStepIndex: 0,
    stepResults: new Map(),
    budget: {
      roundsUsed: 1,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 100,
      tokenWarningLimit: 3000,
      tokenHardLimit: 4000,
      startTime: Date.now(),
      maxDurationMs: 30000,
      toolCallsUsed: 1,
      maxToolCalls: 10,
    },
    trace: {
      traceId: 'test-trace-123',
      state: 'evaluating' as any,
      stateTransitions: [],
      trajectory: [],
      totalDuration: 1000,
      totalToolCalls: 1,
      budgetState: {
        roundsUsed: 1,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 100,
        tokenWarningLimit: 3000,
        tokenHardLimit: 4000,
        startTime: Date.now(),
        maxDurationMs: 30000,
        toolCallsUsed: 1,
        maxToolCalls: 10,
      },
    },
    metadata: { input: '测试输入' },
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map(),
    stepStateHistory: [],
    ...overrides,
  };
}

describe('EvaluationPipeline Integration', () => {
  describe('evaluateWithPipeline', () => {
    it('should call pipeline.run when pipeline is provided', async () => {
      const mockPipelineResult: PipelineResult = {
        overallScore: 85,
        passed: true,
        stages: [
          {
            stageName: 'step_evaluation',
            score: 90,
            details: '步骤评估通过',
            passed: true,
            weight: 0.5,
          },
          {
            stageName: 'quality_scoring',
            score: 80,
            details: '五维评分通过',
            passed: true,
            weight: 0.5,
          },
        ],
        suggestions: [],
        timestamp: Date.now(),
        duration: 100,
        qualityScore: {
          dimensions: {
            accuracy: 0.8,
            efficiency: 0.7,
            safety: 1.0,
            persona: 0.8,
            stability: 0.9,
          },
          overall: 0.85,
          breakdown: '五维评分通过',
          suggestions: [],
        },
      };

      const mockPipeline = {
        run: jest.fn().mockResolvedValue(mockPipelineResult),
        addStage: jest.fn(),
      };

      const controller = createMinimalController(mockPipeline);
      const input = {
        text: '测试输入',
        userId: 'test-user',
        traceId: 'test-trace',
      };
      const context = createLoopContext();

      // 访问私有方法 evaluateWithPipeline
      const evaluateWithPipeline = (
        controller as any
      ).evaluateWithPipeline.bind(controller);
      const result: EvaluatorOutput = await evaluateWithPipeline(
        input,
        context
      );

      expect(mockPipeline.run).toHaveBeenCalledTimes(1);
      expect(mockPipeline.run).toHaveBeenCalledWith(
        expect.objectContaining({
          stepParams: expect.any(Array),
          evalInput: expect.any(Object),
          scorerMetadata: expect.any(Object),
        })
      );
      // Pipeline成功时不应调用evaluator
      expect(result).toBeDefined();
      expect(result.goalProgress).toBeGreaterThan(0);
    });

    it('should fall back to evaluator when pipeline throws', async () => {
      const mockPipeline = {
        run: jest.fn().mockRejectedValue(new Error('Pipeline崩溃')),
        addStage: jest.fn(),
      };

      const controller = createMinimalController(mockPipeline);
      const input = {
        text: '测试输入',
        userId: 'test-user',
        traceId: 'test-trace',
      };
      const context = createLoopContext();

      const evaluateWithPipeline = (
        controller as any
      ).evaluateWithPipeline.bind(controller);
      const result: EvaluatorOutput = await evaluateWithPipeline(
        input,
        context
      );

      // 应该降级到evaluator
      expect(result).toBeDefined();
      expect(result.goalProgress).toBe(0.95);
      expect(result.suggestedAction).toBe('continue');
    });

    it('should return abort when pipeline score is very low', async () => {
      const mockPipelineResult: PipelineResult = {
        overallScore: 15,
        passed: false,
        stages: [
          {
            stageName: 'step_evaluation',
            score: 10,
            details: '步骤评估失败',
            passed: false,
            weight: 0.5,
          },
        ],
        suggestions: ['建议中止'],
        timestamp: Date.now(),
        duration: 50,
      };

      const mockPipeline = {
        run: jest.fn().mockResolvedValue(mockPipelineResult),
        addStage: jest.fn(),
      };

      const controller = createMinimalController(mockPipeline);
      const input = {
        text: '测试输入',
        userId: 'test-user',
        traceId: 'test-trace',
      };
      const context = createLoopContext();

      const evaluateWithPipeline = (
        controller as any
      ).evaluateWithPipeline.bind(controller);
      const result: EvaluatorOutput = await evaluateWithPipeline(
        input,
        context
      );

      expect(result.suggestedAction).toBe('abort');
    });

    it('should return replan when pipeline score is medium-low', async () => {
      const mockPipelineResult: PipelineResult = {
        overallScore: 40,
        passed: false,
        stages: [
          {
            stageName: 'step_evaluation',
            score: 35,
            details: '步骤评估不通过',
            passed: false,
            weight: 0.5,
          },
        ],
        suggestions: ['建议重新规划'],
        timestamp: Date.now(),
        duration: 50,
      };

      const mockPipeline = {
        run: jest.fn().mockResolvedValue(mockPipelineResult),
        addStage: jest.fn(),
      };

      const controller = createMinimalController(mockPipeline);
      const input = {
        text: '测试输入',
        userId: 'test-user',
        traceId: 'test-trace',
      };
      const context = createLoopContext();

      const evaluateWithPipeline = (
        controller as any
      ).evaluateWithPipeline.bind(controller);
      const result: EvaluatorOutput = await evaluateWithPipeline(
        input,
        context
      );

      expect(result.suggestedAction).toBe('replan');
    });

    it('should use independentResult for suggestedAction when available', async () => {
      const mockPipelineResult: PipelineResult = {
        overallScore: 85,
        passed: true,
        stages: [],
        suggestions: [],
        timestamp: Date.now(),
        duration: 100,
        independentResult: {
          taskCompletion: { confidence: 0.9, evidence: [] },
          dataGroundedness: { confidence: 0.8, evidence: [] },
          safety: { riskLevel: 'low', concerns: [] },
          overall: {
            suggestedAction: 'continue' as const,
            goalProgress: 0.9,
            summary: '独立评估通过',
          },
        } as any,
      };

      const mockPipeline = {
        run: jest.fn().mockResolvedValue(mockPipelineResult),
        addStage: jest.fn(),
      };

      const controller = createMinimalController(mockPipeline);
      const input = {
        text: '测试输入',
        userId: 'test-user',
        traceId: 'test-trace',
      };
      const context = createLoopContext();

      const evaluateWithPipeline = (
        controller as any
      ).evaluateWithPipeline.bind(controller);
      const result: EvaluatorOutput = await evaluateWithPipeline(
        input,
        context
      );

      expect(result.suggestedAction).toBe('continue');
      expect(result.goalProgress).toBe(0.9);
    });
  });

  describe('persistEvaluationResult', () => {
    it('should write evaluation result to TrajectoryDB', () => {
      const mockDB = {
        recordEvaluationResult: jest.fn(),
        recordPipelineEvaluationResult: jest.fn(),
      };

      const controller = createMinimalController(undefined, mockDB);
      const context = createLoopContext();
      const evalResult: EvaluatorOutput = {
        goalProgress: 0.9,
        suggestedAction: 'continue',
        reason: '目标已达成',
      };

      const persistEvaluationResult = (
        controller as any
      ).persistEvaluationResult.bind(controller);
      persistEvaluationResult(context, evalResult);

      expect(mockDB.recordEvaluationResult).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_id: 'test-trace-123',
          phase: 'evaluating',
          goal_progress: 0.9,
          suggested_action: 'continue',
        })
      );
    });

    it('should write pipeline results including qualityScore and pipelineEvaluationResult', () => {
      const mockDB = {
        recordEvaluationResult: jest.fn(),
        recordPipelineEvaluationResult: jest.fn(),
      };

      const mockPipelineResult: PipelineResult = {
        overallScore: 85,
        passed: true,
        stages: [
          {
            stageName: 'step_evaluation',
            score: 90,
            details: '步骤评估通过',
            passed: true,
            weight: 0.5,
          },
          {
            stageName: 'quality_scoring',
            score: 80,
            details: '五维评分通过',
            passed: true,
            weight: 0.5,
          },
        ],
        suggestions: [],
        timestamp: Date.now(),
        duration: 100,
        qualityScore: {
          dimensions: {
            accuracy: 0.8,
            efficiency: 0.7,
            safety: 1.0,
            persona: 0.8,
            stability: 0.9,
          },
          overall: 0.85,
          breakdown: '五维评分通过',
          suggestions: [],
        },
      };

      const controller = createMinimalController(undefined, mockDB);
      // 设置 lastPipelineResult
      (controller as any).lastPipelineResult = mockPipelineResult;

      const context = createLoopContext();
      const evalResult: EvaluatorOutput = {
        goalProgress: 0.85,
        suggestedAction: 'continue',
        reason: 'Pipeline评估通过',
      };

      const persistEvaluationResult = (
        controller as any
      ).persistEvaluationResult.bind(controller);
      persistEvaluationResult(context, evalResult);

      // 应该写入3条记录：基础评估 + pipeline_quality + pipelineEvaluationResult
      expect(mockDB.recordEvaluationResult).toHaveBeenCalledTimes(2); // evaluating + pipeline_quality
      expect(mockDB.recordPipelineEvaluationResult).toHaveBeenCalledTimes(1);

      // 验证 pipelineEvaluationResult 的参数
      expect(mockDB.recordPipelineEvaluationResult).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'test-trace-123',
          pipelineResult: expect.objectContaining({
            passed: true,
            overallScore: 85,
          }),
          suggestions: [],
        })
      );
    });

    it('should not throw when TrajectoryDB is not provided', () => {
      const controller = createMinimalController(undefined, undefined);
      const context = createLoopContext();
      const evalResult: EvaluatorOutput = {
        goalProgress: 0.9,
        suggestedAction: 'continue',
        reason: '目标已达成',
      };

      const persistEvaluationResult = (
        controller as any
      ).persistEvaluationResult.bind(controller);
      expect(() => persistEvaluationResult(context, evalResult)).not.toThrow();
    });

    it('should handle DB write errors gracefully', () => {
      const mockDB = {
        recordEvaluationResult: jest.fn().mockImplementation(() => {
          throw new Error('DB写入失败');
        }),
        recordPipelineEvaluationResult: jest.fn(),
      };

      const controller = createMinimalController(undefined, mockDB);
      const context = createLoopContext();
      const evalResult: EvaluatorOutput = {
        goalProgress: 0.9,
        suggestedAction: 'continue',
        reason: '目标已达成',
      };

      const persistEvaluationResult = (
        controller as any
      ).persistEvaluationResult.bind(controller);
      expect(() => persistEvaluationResult(context, evalResult)).not.toThrow();
    });
  });

  describe('buildEvaluationContext', () => {
    it('should build correct EvaluationContext from LoopContext', () => {
      const controller = createMinimalController();

      const stepResults = new Map();
      stepResults.set('web_search', {
        success: true,
        output: '搜索结果',
        error: null,
      });
      stepResults.set('calculator', {
        success: false,
        output: null,
        error: '计算错误',
      });

      const context = createLoopContext({ stepResults });

      const buildEvaluationContext = (
        controller as any
      ).buildEvaluationContext.bind(controller);
      const evalContext: EvaluationContext = buildEvaluationContext(
        { text: '计算2+2' },
        context
      );

      expect(evalContext.stepParams).toHaveLength(2);
      expect(evalContext.stepParams[0].toolName).toBe('web_search');
      expect(evalContext.stepParams[0].result.success).toBe(true);
      expect(evalContext.stepParams[1].toolName).toBe('calculator');
      expect(evalContext.stepParams[1].result.success).toBe(false);
      expect(evalContext.evalInput).toBeDefined();
      expect(evalContext.evalInput.userInput).toBe('计算2+2');
      expect(evalContext.scorerMetadata).toBeDefined();
    });
  });
});
