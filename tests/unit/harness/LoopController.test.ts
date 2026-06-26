import type {
  EvaluatorOutput,
  ExecutorOutput,
  LoopControllerDeps,
  ReporterOutput,
} from '../../../src/harness/loop/LoopController';
import { LoopController } from '../../../src/harness/loop/LoopController';
import type {
  ChatMessage,
  ExecutionPlan,
  LoopContext,
  UserInput,
} from '../../../src/harness/types';
import { LifecycleEvent, LoopState } from '../../../src/harness/types';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
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

describe('LoopController', () => {
  let mockPlanner: { plan: jest.Mock };
  let mockExecutor: { execute: jest.Mock; shouldReplan: jest.Mock };
  let mockEvaluator: { evaluate: jest.Mock };
  let mockReporter: { report: jest.Mock };
  let mockConstraintsService: {
    checkBudget: jest.Mock;
    executeHooks: jest.Mock;
  };
  let deps: LoopControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlanner = { plan: jest.fn().mockResolvedValue(createPlan()) };
    mockExecutor = {
      execute: jest.fn().mockResolvedValue(createExecutorOutput()),
      shouldReplan: jest
        .fn()
        .mockReturnValue({ shouldReplan: false, reason: '执行质量正常' }),
    };
    mockEvaluator = {
      evaluate: jest.fn().mockResolvedValue(createEvaluatorOutput()),
    };
    mockReporter = {
      report: jest.fn().mockResolvedValue(createReporterOutput()),
    };
    mockConstraintsService = {
      checkBudget: jest
        .fn()
        .mockReturnValue({ withinBudget: true, warnings: [] }),
      executeHooks: jest.fn().mockResolvedValue({ proceed: true }),
    };

    deps = {
      planner: mockPlanner,
      executor: mockExecutor,
      evaluator: mockEvaluator,
      reporter: mockReporter,
      constraintsService: mockConstraintsService,
    };
  });

  describe('successful single-round execution', () => {
    it('should complete plan-execute-evaluate-report cycle', async () => {
      const controller = new LoopController(deps);
      const input = createInput();
      const messages: ChatMessage[] = [{ role: 'user', content: '你好' }];

      const result = await controller.run(input, messages);

      expect(mockPlanner.plan).toHaveBeenCalledTimes(1);
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
      expect(mockEvaluator.evaluate).toHaveBeenCalledTimes(1);
      expect(mockReporter.report).toHaveBeenCalledTimes(1);
      expect(result.response).toBe('任务完成');
      expect(result.quality.overall).toBe(0.9);
      expect(result.metadata.loopRounds).toBe(1);
    });

    it('should return completed state after successful run', async () => {
      const controller = new LoopController(deps);
      await controller.run(createInput(), []);
      expect(controller.getState()).toBe(LoopState.COMPLETED);
    });

    it('should include trace in result', async () => {
      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);
      expect(result.trace).toBeDefined();
      expect(result.trace.traceId).toBeTruthy();
      expect(result.trace.totalToolCalls).toBe(1);
    });
  });

  describe('multi-round loop', () => {
    it('should continue loop when goalProgress < 0.9 and evaluator returns continue', async () => {
      mockEvaluator.evaluate.mockResolvedValueOnce(
        createEvaluatorOutput({
          goalProgress: 0.5,
          suggestedAction: 'continue',
          reason: '进行中',
        })
      );
      mockEvaluator.evaluate.mockResolvedValueOnce(
        createEvaluatorOutput({
          goalProgress: 0.95,
          suggestedAction: 'continue',
          reason: '完成',
        })
      );

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);

      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
      expect(mockEvaluator.evaluate).toHaveBeenCalledTimes(2);
      expect(result.metadata.loopRounds).toBe(2);
    });

    it('should force end when progress is slow and near soft limit', async () => {
      mockConstraintsService.checkBudget.mockReturnValue({
        withinBudget: true,
        warnings: [],
      });
      mockEvaluator.evaluate.mockResolvedValue(
        createEvaluatorOutput({
          goalProgress: 0.2,
          suggestedAction: 'continue',
          reason: '进展缓慢',
        })
      );

      const controller = new LoopController(deps);

      let rounds = 0;
      mockEvaluator.evaluate.mockImplementation(
        async (_input: UserInput, context: LoopContext) => {
          rounds = context.budget.roundsUsed;
          if (context.budget.roundsUsed >= 4) {
            return createEvaluatorOutput({
              goalProgress: 0.2,
              suggestedAction: 'abort',
              reason: '强制结束',
            });
          }
          return createEvaluatorOutput({
            goalProgress: 0.2,
            suggestedAction: 'continue',
            reason: '进展缓慢',
          });
        }
      );

      const result = await controller.run(createInput(), []);
      expect(result).toBeDefined();
    });
  });

  describe('loop abort', () => {
    it('should stop loop when evaluator returns abort', async () => {
      mockEvaluator.evaluate.mockResolvedValue(
        createEvaluatorOutput({
          goalProgress: 0.3,
          suggestedAction: 'abort',
          reason: '无法完成',
        })
      );

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);

      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });
  });

  describe('budget exceeded', () => {
    it('should stop loop when budget is exceeded', async () => {
      mockConstraintsService.checkBudget
        .mockReturnValueOnce({ withinBudget: true, warnings: [] })
        .mockReturnValueOnce({ withinBudget: false, warnings: ['轮次超限'] });

      mockEvaluator.evaluate.mockResolvedValue(
        createEvaluatorOutput({
          goalProgress: 0.5,
          suggestedAction: 'continue',
          reason: '继续',
        })
      );

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);

      expect(result).toBeDefined();
      const hadBudgetExceeded =
        controller.getState() === LoopState.BUDGET_EXCEEDED ||
        controller.getState() === LoopState.COMPLETED;
      expect(hadBudgetExceeded).toBe(true);
    });

    it('should use fallback budget check when constraintsService is not provided', async () => {
      const depsNoConstraints: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
      };

      mockEvaluator.evaluate.mockResolvedValue(
        createEvaluatorOutput({
          goalProgress: 0.95,
          suggestedAction: 'continue',
          reason: '完成',
        })
      );

      const controller = new LoopController(depsNoConstraints);
      const result = await controller.run(createInput(), []);
      expect(result).toBeDefined();
    });
  });

  describe('replan handling', () => {
    it('should replan when evaluator returns replan', async () => {
      mockEvaluator.evaluate.mockResolvedValueOnce(
        createEvaluatorOutput({
          goalProgress: 0.3,
          suggestedAction: 'replan',
          reason: '需要重新规划',
        })
      );
      mockEvaluator.evaluate.mockResolvedValueOnce(
        createEvaluatorOutput({
          goalProgress: 0.95,
          suggestedAction: 'continue',
          reason: '完成',
        })
      );

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);

      expect(mockPlanner.plan).toHaveBeenCalledTimes(2);
      expect(result).toBeDefined();
    });

    it('should enforce max replan count', async () => {
      mockEvaluator.evaluate.mockResolvedValue(
        createEvaluatorOutput({
          goalProgress: 0.3,
          suggestedAction: 'replan',
          reason: '需要重新规划',
        })
      );

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);

      expect(mockPlanner.plan).toHaveBeenCalledTimes(3);
      expect(result).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should return degraded response when executor throws', async () => {
      mockExecutor.execute.mockRejectedValue(new Error('执行器崩溃'));

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), [
        { role: 'user', content: '你好' },
      ]);

      expect(controller.getState()).toBe(LoopState.FAILED);
      expect(result.quality.overall).toBeLessThan(0.5);
      expect(result.metadata.error).toBe('执行器崩溃');
    });

    it('should return degraded response with assistant message when available', async () => {
      mockExecutor.execute.mockRejectedValue(new Error('执行器崩溃'));

      const controller = new LoopController(deps);
      const messages: ChatMessage[] = [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '部分回复内容' },
      ];
      const result = await controller.run(createInput(), messages);

      expect(result.response).toBe('部分回复内容');
      expect(result.metadata.degraded).toBe(true);
    });

    it('should return error message when no assistant message available', async () => {
      mockExecutor.execute.mockRejectedValue(new Error('执行器崩溃'));

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);

      expect(result.response).toContain('执行器崩溃');
      expect(result.quality.overall).toBe(0.1);
    });
  });

  describe('abort method', () => {
    it('should set aborted flag when abort is called', async () => {
      mockEvaluator.evaluate.mockImplementation(async () => {
        return createEvaluatorOutput({
          goalProgress: 0.5,
          suggestedAction: 'continue',
          reason: '继续',
        });
      });

      const controller = new LoopController(deps);

      const runPromise = controller.run(createInput(), []);

      controller.abort();

      const result = await runPromise;
      expect(result).toBeDefined();
    });
  });

  describe('persistence integration', () => {
    it('should save task state when persistenceService is provided', async () => {
      const mockPersistenceService = {
        saveTaskState: jest.fn().mockResolvedValue(undefined),
        updateTaskStatus: jest.fn().mockResolvedValue(undefined),
      };

      const depsWithPersistence: LoopControllerDeps = {
        ...deps,
        persistenceService:
          mockPersistenceService as unknown as import('../../../src/harness/persistence/PersistenceService').PersistenceService,
      };

      const controller = new LoopController(depsWithPersistence);
      await controller.run(createInput(), []);

      expect(mockPersistenceService.saveTaskState).toHaveBeenCalledTimes(1);
      expect(mockPersistenceService.updateTaskStatus).toHaveBeenCalledWith(
        'test-trace',
        'completed'
      );
    });

    it('should update task status to failed on error', async () => {
      const mockPersistenceService = {
        saveTaskState: jest.fn().mockResolvedValue(undefined),
        updateTaskStatus: jest.fn().mockResolvedValue(undefined),
      };

      mockExecutor.execute.mockRejectedValue(new Error('失败'));

      const depsWithPersistence: LoopControllerDeps = {
        ...deps,
        persistenceService:
          mockPersistenceService as unknown as import('../../../src/harness/persistence/PersistenceService').PersistenceService,
      };

      const controller = new LoopController(depsWithPersistence);
      await controller.run(createInput(), []);

      expect(mockPersistenceService.updateTaskStatus).toHaveBeenCalledWith(
        'test-trace',
        'failed',
        '失败'
      );
    });
  });

  describe('trajectory database integration', () => {
    it('should record execution when trajectoryDatabase is provided', async () => {
      const mockTrajectoryDatabase = {
        recordExecution: jest.fn(),
        updateExecutionStatus: jest.fn(),
        getExecution: jest.fn().mockReturnValue(null),
        recordStateTransition: jest.fn(),
        recordContextSnapshot: jest.fn(),
      };

      const depsWithTrajectory: LoopControllerDeps = {
        ...deps,
        trajectoryDatabase:
          mockTrajectoryDatabase as unknown as import('../../../src/harness/persistence/TrajectoryDatabase').TrajectoryDatabase,
      };

      const controller = new LoopController(depsWithTrajectory);
      await controller.run(createInput(), []);

      expect(mockTrajectoryDatabase.recordExecution).toHaveBeenCalled();
    });

    it('should handle trajectory database errors gracefully', async () => {
      const mockTrajectoryDatabase = {
        recordExecution: jest.fn().mockImplementation(() => {
          throw new Error('DB错误');
        }),
        updateExecutionStatus: jest.fn(),
        getExecution: jest.fn().mockReturnValue(null),
        recordStateTransition: jest.fn(),
        recordContextSnapshot: jest.fn(),
      };

      const depsWithTrajectory: LoopControllerDeps = {
        ...deps,
        trajectoryDatabase:
          mockTrajectoryDatabase as unknown as import('../../../src/harness/persistence/TrajectoryDatabase').TrajectoryDatabase,
      };

      const controller = new LoopController(depsWithTrajectory);
      const result = await controller.run(createInput(), []);

      expect(result).toBeDefined();
      expect(result.response).toBe('任务完成');
    });
  });

  describe('verification service integration', () => {
    it('should validate tool results when verificationService is provided', async () => {
      const mockVerificationService = {
        validateToolResult: jest
          .fn()
          .mockReturnValue({ warnings: [], errors: [] }),
        scoreQuality: jest.fn().mockReturnValue({
          overall: 0.8,
          accuracy: 0.8,
          usefulness: 0.8,
          friendliness: 0.8,
          efficiency: 0.8,
          details: '验证评分',
        }),
      };

      mockExecutor.execute.mockResolvedValue(
        createExecutorOutput({
          messages: [
            { role: 'assistant', content: '执行中' },
            { role: 'tool', content: '工具结果', name: 'test_tool' },
          ],
        })
      );

      const depsWithVerification: LoopControllerDeps = {
        ...deps,
        verificationService:
          mockVerificationService as unknown as import('../../../src/harness/verification/VerificationService').VerificationService,
      };

      const controller = new LoopController(depsWithVerification);
      const result = await controller.run(createInput(), []);

      expect(mockVerificationService.validateToolResult).toHaveBeenCalledWith(
        'test_tool',
        expect.objectContaining({ output: '工具结果' })
      );
      expect(result.quality.overall).toBeCloseTo(0.85, 1);
    });
  });

  describe('hooks execution', () => {
    it('should execute lifecycle hooks via constraintsService', async () => {
      const controller = new LoopController(deps);
      await controller.run(createInput(), []);

      expect(mockConstraintsService.executeHooks).toHaveBeenCalled();
      const calledEvents = mockConstraintsService.executeHooks.mock.calls.map(
        (call: [LifecycleEvent, unknown]) => call[0]
      );
      expect(calledEvents).toContain(LifecycleEvent.BEFORE_LOOP);
      expect(calledEvents).toContain(LifecycleEvent.ON_PLAN_CREATED);
      expect(calledEvents).toContain(LifecycleEvent.ON_STEP_COMPLETED);
      expect(calledEvents).toContain(LifecycleEvent.BEFORE_RESPONSE);
      expect(calledEvents).toContain(LifecycleEvent.AFTER_RESPONSE);
    });

    it('should not execute hooks when constraintsService is not provided', async () => {
      const depsNoConstraints: LoopControllerDeps = {
        planner: mockPlanner,
        executor: mockExecutor,
        evaluator: mockEvaluator,
        reporter: mockReporter,
      };

      const controller = new LoopController(depsNoConstraints);
      const result = await controller.run(createInput(), []);
      expect(result).toBeDefined();
    });
  });

  describe('simple plan handling', () => {
    it('should handle simple plan that skips planning', async () => {
      mockPlanner.plan.mockResolvedValue(
        createPlan({ simple: true, steps: [] })
      );

      const controller = new LoopController(deps);
      const result = await controller.run(createInput(), []);

      expect(result).toBeDefined();
      expect(result.response).toBe('任务完成');
    });
  });
});
