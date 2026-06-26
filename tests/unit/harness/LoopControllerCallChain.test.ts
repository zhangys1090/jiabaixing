/**
 * LoopController 集成调用链测试 — 验证方法在正确时机被调用
 *
 * 核心问题：LoopController.test.ts 只验证了基本循环流程，
 * 但没验证 shouldReplan / reflectOnFailure / triggerDeepReflection 在正确时机被调用。
 * 本测试验证：方法不仅返回值正确，而且在正确的时机被调用。
 *
 * 关键发现：
 * - shouldReplan 只在 continue 分支且 shouldContinueLoop=true 时被调用
 * - 当 goalProgress >= 0.9 时循环直接结束，shouldReplan 不会被调用
 * - reflectOnFailure 在执行失败且有 reflectionEngine 时被调用
 * - triggerDeepReflection 在 replan 且 goalProgress < 0.5 时被调用
 * - 反思结论通过 buildThoughtPrompt 注入，包含【上一轮反思结论】
 */

import type {
  EvaluatorOutput,
  ExecutorOutput,
  LoopControllerDeps,
  ReporterOutput,
} from '../../../src/harness/loop/LoopController';
import { LoopController } from '../../../src/harness/loop/LoopController';
import { ReflectionEngine } from '../../../src/harness/loop/ReflectionEngine';
import type { ExecutionPlan, UserInput } from '../../../src/harness/types';
import { LoopState } from '../../../src/harness/types';

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

jest.mock('../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'simple',
      confidence: 0.9,
      estimatedSteps: 1,
      estimatedTime: 1000,
      requiresTools: [],
      riskFactors: [],
      recommendations: [],
      dependencies: [],
      parallelizable: false,
      parallelismScore: 0,
    }),
  })),
}));

jest.mock('../../../src/monitoring/PerformanceMonitor', () => ({
  perf: {
    start: jest.fn().mockReturnValue(jest.fn()),
    mark: jest.fn(),
    measure: jest
      .fn()
      .mockImplementation((_name: string, fn: () => unknown) => fn()),
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

jest.mock('../../../src/curator/CuratorService', () => ({
  CuratorService: jest.fn().mockImplementation(() => ({
    generateSkillFromTrace: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../../src/core/DAGTask', () => ({
  DAGTask: jest.fn().mockImplementation(() => ({
    addNode: jest.fn(),
    execute: jest.fn().mockResolvedValue(new Map()),
  })),
  TaskNode: jest.fn().mockImplementation(() => ({})),
  TaskStatus: {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
  },
  TaskPriority: { HIGH: 0, MEDIUM: 1, LOW: 2 },
}));

function createPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    steps: [
      {
        id: 'step-1',
        description: '测试步骤',
        toolName: 'test_tool',
        retryCount: 0,
        maxRetries: 2,
        toUnifiedTaskNode: () => ({ id: 'step-1', status: 'pending' }) as any,
      },
    ],
    dependencies: new Map(),
    estimatedBudget: {
      maxRounds: 4,
      maxToolCalls: 10,
      maxTokens: 4000,
      maxDurationMs: 30000,
    },
    toolCallMode: 'auto' as const,
    recommendedTools: [],
    simple: false,
    planReasoning: '测试推理',
    executionMode: 'sequential',
    ...overrides,
  };
}

function createExecutorOutput(
  overrides: Partial<ExecutorOutput> = {}
): ExecutorOutput {
  return {
    messages: [{ role: 'assistant', content: '执行结果' }],
    toolCallsCount: 1,
    toolDuration: 100,
    completedNaturally: true,
    ...overrides,
  };
}

function createEvaluatorOutput(
  overrides: Partial<EvaluatorOutput> = {}
): EvaluatorOutput {
  return {
    goalProgress: 0.95,
    suggestedAction: 'continue',
    reason: '目标已达成',
    ...overrides,
  };
}

function createReporterOutput(
  overrides: Partial<ReporterOutput> = {}
): ReporterOutput {
  return {
    response: '任务完成',
    quality: {
      overall: 0.9,
      accuracy: 0.9,
      usefulness: 0.9,
      friendliness: 0.9,
      efficiency: 0.9,
      details: '高质量',
    },
    ...overrides,
  };
}

function createInput(overrides: Partial<UserInput> = {}): UserInput {
  return {
    text: '测试输入',
    userId: 'test-user',
    traceId: 'test-trace',
    ...overrides,
  };
}

function createProgrammableLLM() {
  const responses: string[] = [];
  let callIndex = 0;
  const calls: string[] = [];

  return {
    chat: jest.fn().mockImplementation((prompt: string) => {
      calls.push(prompt);
      const response = responses[callIndex] || '{}';
      callIndex++;
      return Promise.resolve(response);
    }),
    chatWithTools: jest.fn().mockResolvedValue({
      content: 'LLM回复',
      toolCalls: undefined,
    }),
    queueResponse: (response: string) => responses.push(response),
    queueJSON: (obj: unknown) => responses.push(JSON.stringify(obj)),
    getCalls: () => calls,
    getCallCount: () => calls.length,
    reset: () => {
      callIndex = 0;
      responses.length = 0;
      calls.length = 0;
    },
  };
}

describe('LoopController 集成调用链', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CHAIN-1: shouldReplan 在 continue 分支中被调用', () => {
    it('shouldReplan 应在 continue 且 goalProgress < 0.9 时被调用', async () => {
      const mockPlanner = { plan: jest.fn().mockResolvedValue(createPlan()) };
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(createExecutorOutput()),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest
          .fn()
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.5,
              suggestedAction: 'continue',
              reason: '进行中',
            })
          )
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.95,
              suggestedAction: 'continue',
              reason: '完成',
            })
          ),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(mockExecutor.shouldReplan).toHaveBeenCalledTimes(1);

      const callArgs = mockExecutor.shouldReplan.mock.calls[0];
      expect(callArgs[0]).toBeInstanceOf(Array);
      expect(typeof callArgs[1]).toBe('number');
    });

    it('shouldReplan 返回 true 时应触发重规划', async () => {
      const mockPlanner = { plan: jest.fn().mockResolvedValue(createPlan()) };
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(createExecutorOutput()),
        shouldReplan: jest
          .fn()
          .mockReturnValueOnce({
            shouldReplan: true,
            reason: '连续低质量执行',
            adjustmentHint: '更换工具组合',
          })
          .mockReturnValue({
            shouldReplan: false,
            reason: '执行质量正常',
          }),
      };
      const mockEvaluator = {
        evaluate: jest
          .fn()
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.2,
              suggestedAction: 'continue',
              reason: '进展缓慢',
            })
          )
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.95,
              suggestedAction: 'continue',
              reason: '完成',
            })
          ),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(mockPlanner.plan).toHaveBeenCalledTimes(2);
    });

    it('shouldReplan 接收的评估历史应与实际评估结果一致', async () => {
      const mockPlanner = { plan: jest.fn().mockResolvedValue(createPlan()) };
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(createExecutorOutput()),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest
          .fn()
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.3,
              suggestedAction: 'continue',
              reason: '进行中',
            })
          )
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.95,
              suggestedAction: 'continue',
              reason: '完成',
            })
          ),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      const evalHistory = mockExecutor.shouldReplan.mock.calls[0][0] as Array<{
        score: number;
        isSufficient: boolean;
      }>;
      expect(evalHistory.length).toBeGreaterThanOrEqual(1);
      expect(evalHistory[0].score).toBe(0.3);
      expect(evalHistory[0].isSufficient).toBe(false);
    });

    it('goalProgress >= 0.9 时 shouldReplan 不应被调用（循环直接结束）', async () => {
      const mockPlanner = { plan: jest.fn().mockResolvedValue(createPlan()) };
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(createExecutorOutput()),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest.fn().mockResolvedValue(createEvaluatorOutput()),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(mockExecutor.shouldReplan).not.toHaveBeenCalled();
    });
  });

  describe('CHAIN-2: reflectOnFailure 在步骤失败时被调用', () => {
    it('执行失败且有 reflectionEngine 时应调用 reflect', async () => {
      const programmableLLM = createProgrammableLLM();
      const reflectionEngine = new ReflectionEngine(programmableLLM as any);

      const failPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '读取文件',
            toolName: 'file_read',
            toolParams: { path: '/wrong/path' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });

      const mockPlanner = { plan: jest.fn().mockResolvedValue(failPlan) };
      const mockExecutor = {
        execute: jest
          .fn()
          .mockRejectedValueOnce(new Error('File not found: /wrong/path'))
          .mockResolvedValueOnce(createExecutorOutput()),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest.fn().mockResolvedValue(createEvaluatorOutput()),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      programmableLLM.queueJSON({
        rootCause: '路径错误',
        correctedArgs: { path: '/correct/path' },
        alternativeTool: null,
        shouldRetry: true,
      });

      const reflectSpy = jest.spyOn(reflectionEngine, 'reflect');
      const recordExperienceSpy = jest.spyOn(
        reflectionEngine,
        'recordExperience'
      );

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
        reflectionEngine,
        toolRegistry: {
          getRegisteredToolNames: jest
            .fn()
            .mockReturnValue(['file_read', 'web_search']),
          get: jest.fn().mockReturnValue(undefined),
          getAll: jest.fn().mockReturnValue([]),
        },
        permissionGuard: {
          check: jest.fn().mockReturnValue({
            allowed: true,
            missing: [],
            reason: undefined,
          }),
        } as any,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(reflectSpy).toHaveBeenCalledTimes(1);
      expect(reflectSpy).toHaveBeenCalledWith(
        'file_read',
        { path: '/wrong/path' },
        'File not found: /wrong/path',
        expect.objectContaining({
          traceId: expect.any(String),
          loopCount: expect.any(Number),
        })
      );

      expect(recordExperienceSpy).toHaveBeenCalledTimes(1);
      expect(recordExperienceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'file_read',
          rootCause: '路径错误',
          success: true,
        })
      );
    });

    it('无 reflectionEngine 时不应调用 reflect', async () => {
      const failPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '读取文件',
            toolName: 'file_read',
            toolParams: { path: '/wrong/path' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });

      const mockPlanner = { plan: jest.fn().mockResolvedValue(failPlan) };
      const mockExecutor = {
        execute: jest.fn().mockRejectedValue(new Error('File not found')),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest.fn().mockResolvedValue(createEvaluatorOutput()),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
      };

      const controller = new LoopController(deps);

      try {
        await controller.run(createInput(), []);
      } catch {
        // 执行失败可能抛出
      }

      expect(controller.getState()).toBe(LoopState.FAILED);
    });
  });

  describe('CHAIN-3: triggerDeepReflection 在 replan 且进度低时被调用', () => {
    it('评估建议 replan 且 goalProgress < 0.5 时应调用 deepReflect', async () => {
      const programmableLLM = createProgrammableLLM();
      const reflectionEngine = new ReflectionEngine(programmableLLM as any);

      const mockPlanner = { plan: jest.fn().mockResolvedValue(createPlan()) };
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(createExecutorOutput()),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest
          .fn()
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.2,
              suggestedAction: 'replan',
              reason: '需要重新规划',
            })
          )
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.95,
              suggestedAction: 'continue',
              reason: '完成',
            })
          ),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      programmableLLM.queueJSON({
        diagnosis: '搜索关键词不精确',
        rootCause: '关键词过于模糊',
        fixStrategy: '使用更精确的关键词',
        correctedPlan: [
          {
            stepDescription: '使用精确关键词搜索',
            toolName: 'web_search',
            args: { query: '精确关键词' },
          },
        ],
      });

      const deepReflectSpy = jest.spyOn(reflectionEngine, 'deepReflect');

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
        reflectionEngine,
        toolRegistry: {
          getRegisteredToolNames: jest.fn().mockReturnValue(['web_search']),
          get: jest.fn().mockReturnValue(undefined),
          getAll: jest.fn().mockReturnValue([]),
        },
        permissionGuard: {
          check: jest.fn().mockReturnValue({
            allowed: true,
            missing: [],
            reason: undefined,
          }),
        } as any,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(deepReflectSpy).toHaveBeenCalledTimes(1);
      expect(deepReflectSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          goalProgress: 0.2,
          suggestedAction: 'replan',
        })
      );
    });

    it('评估建议 replan 但 goalProgress >= 0.5 时不应调用 deepReflect', async () => {
      const programmableLLM = createProgrammableLLM();
      const reflectionEngine = new ReflectionEngine(programmableLLM as any);

      const mockPlanner = { plan: jest.fn().mockResolvedValue(createPlan()) };
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(createExecutorOutput()),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest
          .fn()
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.6,
              suggestedAction: 'replan',
              reason: '需要调整',
            })
          )
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.95,
              suggestedAction: 'continue',
              reason: '完成',
            })
          ),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      const deepReflectSpy = jest.spyOn(reflectionEngine, 'deepReflect');

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
        reflectionEngine,
        toolRegistry: {
          getRegisteredToolNames: jest.fn().mockReturnValue(['web_search']),
          get: jest.fn().mockReturnValue(undefined),
          getAll: jest.fn().mockReturnValue([]),
        },
        permissionGuard: {
          check: jest.fn().mockReturnValue({
            allowed: true,
            missing: [],
            reason: undefined,
          }),
        } as any,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(deepReflectSpy).not.toHaveBeenCalled();
    });
  });

  describe('CHAIN-4: 反思结论注入下一轮 Thought', () => {
    it('工具失败后反思结论应通过 buildThoughtPrompt 注入下一轮执行上下文', async () => {
      const programmableLLM = createProgrammableLLM();
      const reflectionEngine = new ReflectionEngine(programmableLLM as any);

      const failPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '搜索文件',
            toolName: 'file_read',
            toolParams: { path: '/wrong/path' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });

      const mockPlanner = { plan: jest.fn().mockResolvedValue(failPlan) };

      const failedExecutorOutput: ExecutorOutput = {
        messages: [
          { role: 'assistant', content: '尝试读取' },
          {
            role: 'tool',
            content: '错误: File not found',
            name: 'file_read',
          },
        ],
        toolCallsCount: 1,
        toolDuration: 100,
        completedNaturally: true,
      };

      const successExecutorOutput: ExecutorOutput = {
        messages: [{ role: 'assistant', content: '文件已读取' }],
        toolCallsCount: 0,
        toolDuration: 0,
        completedNaturally: true,
      };

      const capturedContexts: any[] = [];
      const mockExecutor = {
        execute: jest.fn().mockImplementation((_plan: any, ctx: any) => {
          capturedContexts.push({
            messages: ctx.messages
              ? ctx.messages.map((m: any) => ({
                  role: m.role,
                  content:
                    typeof m.content === 'string'
                      ? m.content.substring(0, 100)
                      : m.content,
                }))
              : [],
          });
          if (capturedContexts.length === 1)
            return Promise.resolve(failedExecutorOutput);
          return Promise.resolve(successExecutorOutput);
        }),
        shouldReplan: jest.fn().mockReturnValue({
          shouldReplan: false,
          reason: '执行质量正常',
        }),
      };
      const mockEvaluator = {
        evaluate: jest
          .fn()
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.3,
              suggestedAction: 'continue',
              reason: '继续',
            })
          )
          .mockResolvedValueOnce(
            createEvaluatorOutput({
              goalProgress: 0.95,
              suggestedAction: 'continue',
              reason: '完成',
            })
          ),
      };
      const mockReporter = {
        report: jest.fn().mockResolvedValue(createReporterOutput()),
      };
      const mockConstraintsService = {
        checkBudget: jest
          .fn()
          .mockReturnValue({ withinBudget: true, warnings: [] }),
        executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
      };

      programmableLLM.queueJSON({
        rootCause: '路径错误',
        correctedArgs: null,
        alternativeTool: null,
        shouldRetry: true,
      });

      const deps: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
        constraintsService: mockConstraintsService,
        reflectionEngine,
        toolRegistry: {
          getRegisteredToolNames: jest.fn().mockReturnValue(['file_read']),
          get: jest.fn().mockReturnValue(undefined),
          getAll: jest.fn().mockReturnValue([]),
        },
        permissionGuard: {
          check: jest.fn().mockReturnValue({
            allowed: true,
            missing: [],
            reason: undefined,
          }),
        } as any,
      };

      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);

      expect(capturedContexts.length).toBe(2);

      const secondContext = capturedContexts[1];
      const hasReflectionHint = secondContext.messages.some(
        (m: any) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          (m.content.includes('反思结论') || m.content.includes('根因分析'))
      );
      expect(hasReflectionHint).toBe(true);
    });
  });
});
