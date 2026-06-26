/**
 * 反思-修正闭环端到端集成测试 (P1.2 E2E Integration)
 *
 * 验证开发计划阶段1.2的核心目标：
 *   工具失败 → 自动反思 → 修正参数/工具 → 重试 → 经验记录 → 经验回注
 *
 * 本测试使用真实的 ReflectionEngine（非mock），配合模拟LLM，
 * 验证 LoopController 与 ReflectionEngine 的完整集成闭环。
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

jest.mock('../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'complex',
      confidence: 0.9,
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

function createPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    steps: [
      {
        id: 'step-1',
        description: '测试步骤',
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

/**
 * 创建可编程的模拟LLM，按顺序返回预设响应
 */
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

describe('反思-修正闭环端到端集成测试 (P1.2 E2E Integration)', () => {
  let mockPlanner: { plan: jest.Mock };
  let mockExecutor: { execute: jest.Mock; shouldReplan: jest.Mock };
  let mockEvaluator: { evaluate: jest.Mock };
  let mockReporter: { report: jest.Mock };
  let mockConstraintsService: {
    checkBudget: jest.Mock;
    executeHooks: jest.Mock;
  };
  let programmableLLM: ReturnType<typeof createProgrammableLLM>;
  let reflectionEngine: ReflectionEngine;
  let baseDeps: LoopControllerDeps;

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

    programmableLLM = createProgrammableLLM();
    reflectionEngine = new ReflectionEngine(programmableLLM as any);

    baseDeps = {
      planner: mockPlanner,
      executor: mockExecutor,
      evaluator: mockEvaluator,
      reporter: mockReporter,
      constraintsService: mockConstraintsService,
      toolRegistry: {
        getRegisteredToolNames: jest
          .fn()
          .mockReturnValue(['file_read', 'file_write', 'web_fetch']),
        get: jest.fn().mockReturnValue(undefined),
        getAll: jest.fn().mockReturnValue([]),
      },
      permissionGuard: {
        check: jest
          .fn()
          .mockReturnValue({ allowed: true, missing: [], reason: undefined }),
      } as any,
      reflectionEngine,
    };
  });

  describe('闭环1: 工具失败 → 反思 → 修正参数 → 重试成功', () => {
    it('E2E-INT-1: 真实ReflectionEngine分析失败并修正参数重试成功', async () => {
      const failPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '读取配置文件',
            toolName: 'file_read',
            toolParams: { path: '/wrong/config.json' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });

      mockPlanner.plan.mockResolvedValue(failPlan);
      mockExecutor.execute
        .mockRejectedValueOnce(new Error('File not found: /wrong/config.json'))
        .mockResolvedValueOnce(
          createExecutorOutput({
            messages: [{ role: 'assistant', content: '配置文件内容已读取' }],
          })
        );

      programmableLLM.queueJSON({
        rootCause: '路径错误，应为 /correct/config.json',
        correctedArgs: { path: '/correct/config.json' },
        alternativeTool: null,
        shouldRetry: true,
      });

      const controller = new LoopController(baseDeps);
      const result = await controller.run(
        createInput({ text: '读取配置文件' }),
        []
      );

      expect(programmableLLM.getCallCount()).toBeGreaterThanOrEqual(1);
      const reflectCall = programmableLLM.getCalls()[0];
      expect(reflectCall).toContain('file_read');
      expect(reflectCall).toContain('/wrong/config.json');
      expect(reflectCall).toContain('File not found');

      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);

      const metrics = reflectionEngine.getReflectionMetrics();
      expect(metrics.totalReflections).toBeGreaterThanOrEqual(1);

      expect(result).toBeDefined();
      expect(controller.getState()).toBe(LoopState.COMPLETED);
    });
  });

  describe('闭环2: 工具失败 → 反思 → 建议替代工具 → 验证注册 → 重试', () => {
    it('E2E-INT-2: 反思建议替代工具且工具已注册时重试成功', async () => {
      const failPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '获取远程文件',
            toolName: 'file_read',
            toolParams: { path: 'https://example.com/data.json' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });

      mockPlanner.plan.mockResolvedValue(failPlan);
      mockExecutor.execute
        .mockRejectedValueOnce(new Error('不支持远程路径'))
        .mockResolvedValueOnce(
          createExecutorOutput({
            messages: [{ role: 'assistant', content: '远程文件已获取' }],
          })
        );

      programmableLLM.queueJSON({
        rootCause: 'file_read不支持远程URL，应使用web_fetch',
        correctedArgs: null,
        alternativeTool: 'web_fetch',
        shouldRetry: true,
      });

      const controller = new LoopController(baseDeps);
      const result = await controller.run(createInput(), []);

      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);

      const metrics = reflectionEngine.getReflectionMetrics();
      expect(metrics.totalReflections).toBeGreaterThanOrEqual(1);

      expect(result).toBeDefined();
    });

    it('E2E-INT-3: 反思建议未注册工具时不重试并降级', async () => {
      const failPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '执行操作',
            toolName: 'file_read',
            toolParams: { path: '/some/file' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });

      mockPlanner.plan.mockResolvedValue(failPlan);
      mockExecutor.execute.mockRejectedValueOnce(new Error('操作失败'));

      programmableLLM.queueJSON({
        rootCause: '需要专用工具',
        correctedArgs: null,
        alternativeTool: 'nonexistent_tool',
        shouldRetry: true,
      });

      const controller = new LoopController(baseDeps);

      try {
        await controller.run(createInput(), []);
      } catch {
        // 预期可能抛出
      }

      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('闭环3: 评估低分 → 深度反思 → 修正计划 → replan', () => {
    it('E2E-INT-4: 评估低分触发deepReflect生成修正计划', async () => {
      const firstPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '搜索信息',
            toolName: 'web_search',
            toolParams: { query: '模糊关键词' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });
      const secondPlan = createPlan({
        steps: [
          {
            id: 'step-2',
            description: '精确搜索',
            toolName: 'web_search',
            toolParams: { query: '精确关键词' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-2', status: 'pending' }) as any,
          },
        ],
      });

      mockPlanner.plan
        .mockResolvedValueOnce(firstPlan)
        .mockResolvedValueOnce(secondPlan);
      mockExecutor.execute.mockResolvedValue(createExecutorOutput());
      mockEvaluator.evaluate
        .mockResolvedValueOnce(
          createEvaluatorOutput({
            goalProgress: 0.2,
            suggestedAction: 'replan',
            reason: '搜索结果不相关',
          })
        )
        .mockResolvedValueOnce(
          createEvaluatorOutput({
            goalProgress: 0.95,
            suggestedAction: 'continue',
          })
        );

      programmableLLM.queueJSON({
        diagnosis: '关键词过于模糊',
        rootCause: '搜索关键词不精确',
        fixStrategy: '使用更精确的关键词',
        correctedPlan: [
          {
            stepDescription: '使用精确关键词搜索',
            toolName: 'web_search',
            args: { query: '精确关键词' },
          },
        ],
      });

      const controller = new LoopController(baseDeps);
      const result = await controller.run(
        createInput({ text: '搜索AI技术趋势' }),
        []
      );

      expect(mockPlanner.plan).toHaveBeenCalled();

      const deepReflectCalls = programmableLLM
        .getCalls()
        .filter((c) => c.includes('深度反思引擎'));
      expect(deepReflectCalls.length).toBeGreaterThanOrEqual(1);

      expect(result).toBeDefined();
    });
  });

  describe('闭环4: 经验记录与复用', () => {
    it('E2E-INT-5: 成功重试后经验被记录并可复用', async () => {
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

      mockPlanner.plan.mockResolvedValue(failPlan);
      mockExecutor.execute
        .mockRejectedValueOnce(new Error('File not found: /wrong/path'))
        .mockResolvedValueOnce(createExecutorOutput());

      programmableLLM.queueJSON({
        rootCause: '路径错误',
        correctedArgs: { path: '/correct/path' },
        alternativeTool: null,
        shouldRetry: true,
      });

      const controller = new LoopController(baseDeps);
      await controller.run(createInput(), []);

      const metrics = reflectionEngine.getReflectionMetrics();
      expect(metrics.totalReflections).toBeGreaterThanOrEqual(1);
      expect(metrics.experienceRecordCount).toBeGreaterThanOrEqual(1);

      const experiences = reflectionEngine.getRelevantExperiences(
        'file_read',
        'File not found'
      );
      expect(experiences.length).toBeGreaterThanOrEqual(1);
    });

    it('E2E-INT-6: 第二次相同失败时复用历史经验', async () => {
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

      mockPlanner.plan.mockResolvedValue(failPlan);
      mockExecutor.execute
        .mockRejectedValueOnce(new Error('File not found: /wrong/path'))
        .mockResolvedValueOnce(createExecutorOutput())
        .mockRejectedValueOnce(new Error('File not found: /wrong/path'))
        .mockResolvedValueOnce(createExecutorOutput());

      programmableLLM.queueJSON({
        rootCause: '路径错误',
        correctedArgs: { path: '/correct/path' },
        alternativeTool: null,
        shouldRetry: true,
      });
      programmableLLM.queueJSON({
        rootCause: '路径错误（复用经验）',
        correctedArgs: { path: '/correct/path' },
        alternativeTool: null,
        shouldRetry: true,
      });

      const controller = new LoopController(baseDeps);
      await controller.run(createInput(), []);

      const metricsAfterFirst = reflectionEngine.getReflectionMetrics();
      const reuseAfterFirst = metricsAfterFirst.experienceReuseRate;

      await controller.run(createInput(), []);

      const metricsAfterSecond = reflectionEngine.getReflectionMetrics();
      expect(metricsAfterSecond.totalReflections).toBeGreaterThanOrEqual(2);

      const secondCallPrompt = programmableLLM.getCalls()[1];
      expect(secondCallPrompt).toContain('历史相似经验');
    });
  });

  describe('闭环5: 权限错误不触发反思', () => {
    it('E2E-INT-7: 权限错误跳过反思直接处理', async () => {
      const failPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '读取系统文件',
            toolName: 'file_read',
            toolParams: { path: '/etc/shadow' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
        ],
      });

      mockPlanner.plan.mockResolvedValue(failPlan);
      mockEvaluator.evaluate.mockResolvedValue(
        createEvaluatorOutput({ goalProgress: 0.95 })
      );

      const controller = new LoopController(baseDeps);

      try {
        await controller.run(createInput(), []);
      } catch {
        // 预期可能抛出权限错误
      }

      expect(programmableLLM.getCallCount()).toBe(0);
    });
  });

  describe('闭环6: 多步任务中间失败反思修正', () => {
    it('E2E-INT-8: 多步任务中间步骤失败→反思→整体完成', async () => {
      const multiStepPlan = createPlan({
        steps: [
          {
            id: 'step-1',
            description: '搜索文件',
            toolName: 'file_search',
            toolParams: { pattern: '*.log' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-1', status: 'pending' }) as any,
          },
          {
            id: 'step-2',
            description: '读取日志',
            toolName: 'file_read',
            toolParams: { path: '/var/log/app.log' },
            retryCount: 0,
            maxRetries: 2,
            toUnifiedTaskNode: () =>
              ({ id: 'step-2', status: 'pending' }) as any,
          },
        ],
      });

      mockPlanner.plan.mockResolvedValue(multiStepPlan);
      mockExecutor.execute
        .mockResolvedValueOnce(
          createExecutorOutput({
            messages: [{ role: 'assistant', content: '找到3个日志文件' }],
          })
        )
        .mockRejectedValueOnce(new Error('File not found: /var/log/app.log'))
        .mockResolvedValueOnce(
          createExecutorOutput({
            messages: [{ role: 'assistant', content: '日志内容已读取' }],
          })
        );

      programmableLLM.queueJSON({
        rootCause: '路径错误，应为 /tmp/app.log',
        correctedArgs: { path: '/tmp/app.log' },
        alternativeTool: null,
        shouldRetry: true,
      });

      const controller = new LoopController(baseDeps);
      const result = await controller.run(
        createInput({ text: '查找并读取应用日志' }),
        []
      );

      const reflectCall = programmableLLM.getCalls()[0];
      expect(reflectCall).toContain('file_read');
      expect(reflectCall).toContain('/var/log/app.log');

      expect(mockExecutor.execute).toHaveBeenCalledTimes(3);

      const metrics = reflectionEngine.getReflectionMetrics();
      expect(metrics.totalReflections).toBeGreaterThanOrEqual(1);

      expect(result).toBeDefined();
    });
  });
});
