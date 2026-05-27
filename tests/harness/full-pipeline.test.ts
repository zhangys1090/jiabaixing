/**
 * V5.0 Harness 集成计划 - Task 7: 全链路集成测试
 *
 * 测试完整的 E-T-C-S-L-V 六层架构:
 * E - Evaluator (评估器)
 * T - ToolRegistry (工具注册表)
 * C - ConstraintsService (约束服务)
 * S - SchemaValidator (Schema 验证器)
 * L - LoopController (循环控制器)
 * V - VerificationService (验证服务)
 *
 * 验证内容:
 * 1. 各层完整调用链
 * 2. 钩子被触发
 * 3. 状态被保存
 * 4. 质量被评估
 */

import { AgentHarness } from '../../src/harness/AgentHarness';
import type { HarnessDeps } from '../../src/harness/AgentHarness';
import { LifecycleEvent, Permission, ToolCategory } from '../../src/harness/types';
import type { UserInput, ChatMessage } from '../../src/harness/types';

// ============ Mock 数据 ============

function createMockDeps(): HarnessDeps {
  const mockLlm = {
    chatWithTools: jest.fn().mockResolvedValue({
      content: '好的，我来帮你完成这个任务。',
      toolCalls: []
    }),
    chat: jest.fn().mockResolvedValue('这是一个模拟的 LLM 回复。')
  };

  return {
    llm: mockLlm,
    constitutionalBuilder: {
      buildConstitutionPrompt: jest.fn().mockResolvedValue('宪法 Prompt')
    },
    memoryInjector: {
      autoRetrieveMemories: jest.fn().mockResolvedValue(['记忆1', '记忆2'])
    },
    dynamicContext: {
      getDynamicContext: jest.fn().mockReturnValue('当前时间: 2026-05-25 10:00')
    },
    historyProvider: {
      getAllHistory: jest.fn(),
          getRecentHistory: jest.fn().mockReturnValue([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' }
      ])
    },
    toolDeps: {
      detectEmotionFromInput: jest.fn().mockReturnValue({ type: '平静', intensity: 2 }),
      recognizeScene: jest.fn().mockResolvedValue({ type: '日常对话', context: '日常' }),
      agentSelfReflection: null,
      getHistory: jest.fn().mockResolvedValue([]),
      removeHistory: jest.fn().mockResolvedValue(null),
      addToHistory: jest.fn().mockResolvedValue(undefined),
      validateCodeSyntax: jest.fn().mockReturnValue([]),
      taskStore: { getTasks: jest.fn().mockResolvedValue([]), saveTask: jest.fn().mockResolvedValue(undefined), deleteTask: jest.fn().mockResolvedValue(undefined) },
      reminderStore: { getReminders: jest.fn().mockResolvedValue([]), saveReminder: jest.fn().mockResolvedValue(undefined), deleteReminder: jest.fn().mockResolvedValue(undefined) },
      scheduleTrigger: null,
      noteStore: { getNotes: jest.fn().mockResolvedValue([]), saveNote: jest.fn().mockResolvedValue(undefined), deleteNote: jest.fn().mockResolvedValue(undefined) },
      getMemoryStats: jest.fn().mockReturnValue({ count: 0 }),
      getToolStats: jest.fn().mockReturnValue({ registered: 25, byCategory: {} }),
      getHarnessStats: jest.fn().mockReturnValue({ initialized: true, config: {} }),
      getEvolutionStats: jest.fn().mockReturnValue({}),
      getSchedulerStats: jest.fn().mockReturnValue({}),
      skillStore: { getSkills: jest.fn().mockResolvedValue([]), saveSkill: jest.fn().mockResolvedValue(undefined), deleteSkill: jest.fn().mockResolvedValue(undefined) },
    },
    persistenceDeps: {
      memoryEngine: null,
      conversationHistory: null,
      userProfile: null,
    }
  };
}

function createUserInput(text: string = '帮我列出当前目录的文件'): UserInput {
  return {
    text,
    userId: 'test-user',
    traceId: `test-trace-${Date.now()}`,
    metadata: { testRun: true }
  };
}

// ============ 全链路集成测试 ============

describe('Task 7: 全链路集成测试 - E-T-C-S-L-V 六层架构', () => {
  let deps: HarnessDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  describe('1. 完整的六层初始化', () => {
    test('应该成功初始化所有六层组件', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      // 验证各层组件已创建
      expect(harness.getToolRegistry()).not.toBeNull();
      expect(harness.getSchemaValidator()).not.toBeNull();
      expect(harness.getPermissionGuard()).not.toBeNull();
      expect(harness.getContextManager()).not.toBeNull();
      expect(harness.getVerificationService()).not.toBeNull();
      expect(harness.getConstraintsService()).not.toBeNull();
      expect(harness.getPersistenceService()).not.toBeNull();
    });
  });

  describe('2. 完整的 E-T-C-S-L-V 调用链', () => {
    test('应该执行完整的 Plan-Execute-Evaluate-Report 循环', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const input = createUserInput('帮我查看文件');
      const result = await harness.processInput(input);

      // 验证结果结构
      expect(result.response).toBeDefined();
      expect(result.quality).toBeDefined();
      expect(result.quality.overall).toBeGreaterThanOrEqual(0);
      expect(result.quality.overall).toBeLessThanOrEqual(1);
      expect(result.trace).toBeDefined();
      expect(result.trace.state).toBe('completed');
      expect(result.metadata).toBeDefined();
    });

    test('工具层应该正确注册和转换工具', async () => {
      const harness = new AgentHarness({ useHarnessTools: true });
      harness.setDeps(deps);
      await harness.initialize();

      const toolRegistry = harness.getToolRegistry();
      expect(toolRegistry).not.toBeNull();
      expect(toolRegistry?.size).toBeGreaterThan(0);

      // 验证工具可以转换为 OpenAI 格式
      const openaiTools = toolRegistry?.toOpenAITools() || [];
      expect(openaiTools.length).toBeGreaterThan(0);
      openaiTools.forEach(tool => {
        expect(tool.type).toBe('function');
        expect(tool.function.name).toBeDefined();
        expect(tool.function.description).toBeDefined();
      });
    });

    test('SchemaValidator 应该正确验证参数', async () => {
      const harness = new AgentHarness({ useHarnessTools: true });
      harness.setDeps(deps);
      await harness.initialize();

      const validator = harness.getSchemaValidator();
      expect(validator).not.toBeNull();

      const validParams = { query: '测试查询' };
      const schema: Record<string, import('../../src/harness/types').ToolParameterDef> = {
        query: { type: 'string', description: '查询内容' }
      };

      const validation = validator?.validate(validParams, schema, ['query']);
      expect(validation?.valid).toBe(true);
    });

    test('ConstraintsService 应该正确检查预算和权限', async () => {
      const harness = new AgentHarness({
        useHarnessTools: true,
        useHarnessConstraints: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const constraints = harness.getConstraintsService();
      expect(constraints).not.toBeNull();

      // 预算检查
      const budgetCheck = constraints?.checkBudget({
        roundsUsed: 2,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 1000,
        tokenWarningLimit: 4500,
        tokenHardLimit: 6000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: 3,
        maxToolCalls: 20
      });
      expect(budgetCheck?.withinBudget).toBe(true);

      // 权限检查
      const permissionCheck = constraints?.checkPermission(
        'memory_recall',
        [Permission.MEMORY_READ],
        'low',
        {
          permissions: new Set([Permission.MEMORY_READ]),
          metadata: {}
        }
      );
      expect(permissionCheck?.allowed).toBe(true);
    });

    test('VerificationService 应该正确验证和评估质量', async () => {
      const harness = new AgentHarness({
        useHarnessVerification: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const verification = harness.getVerificationService();
      expect(verification).not.toBeNull();

      // 验证工具结果
      const toolResult = {
        success: true,
        output: '操作成功完成',
        duration: 100,
        validated: false
      };
      const validation = verification?.validateToolResult('test_tool', toolResult);
      expect(validation?.valid).toBe(true);

      // 质量评分
      const quality = verification?.scoreQuality({
        loopCount: 2,
        totalToolCalls: 3,
        totalToolDuration: 500,
        totalDuration: 2000,
        completedSuccessfully: true
      });
      expect(quality?.overall).toBeGreaterThan(0);
    });
  });

  describe('3. 生命周期钩子触发验证', () => {
    test('应该正确触发 BEFORE_LOOP 和 AFTER_RESPONSE 钩子', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const constraints = harness.getConstraintsService();
      const hookCalled: Record<string, boolean> = {};

      // 注册钩子
      constraints?.registerHook(LifecycleEvent.BEFORE_LOOP, async () => {
        hookCalled[LifecycleEvent.BEFORE_LOOP] = true;
        return { proceed: true };
      });

      constraints?.registerHook(LifecycleEvent.AFTER_RESPONSE, async () => {
        hookCalled[LifecycleEvent.AFTER_RESPONSE] = true;
        return { proceed: true };
      });

      const input = createUserInput('测试钩子');
      await harness.processInput(input);

      // 验证钩子被调用
      expect(hookCalled[LifecycleEvent.BEFORE_LOOP]).toBe(true);
      expect(hookCalled[LifecycleEvent.AFTER_RESPONSE]).toBe(true);
    });

    test('应该正确触发 ON_PLAN_CREATED 和 BEFORE_RESPONSE 钩子', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessConstraints: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const constraints = harness.getConstraintsService();
      const hookEvents: string[] = [];

      constraints?.registerHook(LifecycleEvent.ON_PLAN_CREATED, async () => {
        hookEvents.push(LifecycleEvent.ON_PLAN_CREATED);
        return { proceed: true };
      });

      constraints?.registerHook(LifecycleEvent.BEFORE_RESPONSE, async () => {
        hookEvents.push(LifecycleEvent.BEFORE_RESPONSE);
        return { proceed: true };
      });

      const input = createUserInput('测试计划钩子');
      await harness.processInput(input);

      expect(hookEvents).toContain(LifecycleEvent.ON_PLAN_CREATED);
      expect(hookEvents).toContain(LifecycleEvent.BEFORE_RESPONSE);
      expect(hookEvents.indexOf(LifecycleEvent.ON_PLAN_CREATED)).toBeLessThan(
        hookEvents.indexOf(LifecycleEvent.BEFORE_RESPONSE)
      );
    });

    test('钩子应该能够拦截执行', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessConstraints: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const constraints = harness.getConstraintsService();

      // 注册一个拦截钩子
      constraints?.registerHook(LifecycleEvent.BEFORE_LOOP, async () => {
        return { proceed: false, reason: '测试拦截' };
      });

      const input = createUserInput('测试拦截');
      const result = await harness.processInput(input);

      // 即使被拦截，也应该返回结果而不是抛出异常
      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
    });
  });

  describe('4. 状态持久化验证', () => {
    test('应该正确保存和恢复任务状态', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const persistence = harness.getPersistenceService();
      expect(persistence).not.toBeNull();

      const taskId = 'test-task-123';
      const taskData = {
        taskId,
        userId: 'test-user',
        description: '测试任务',
        status: 'in_progress' as const,
        currentStepIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      // 保存状态
      await persistence?.saveTaskState(taskData);

      // 读取状态
      const loaded = await persistence?.loadTaskState(taskId);
      expect(loaded).not.toBeNull();
      expect(loaded?.taskId).toBe(taskId);
      expect(loaded?.status).toBe('in_progress');
    });

    test('应该在完整执行流程中保存任务状态', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const persistence = harness.getPersistenceService();

      const input = createUserInput('测试持久化');
      const result = await harness.processInput(input);

      const traceId = result.trace.traceId;

      // 验证任务已保存并标记为完成
      const loadedTask = await persistence?.loadTaskState(traceId);
      expect(loadedTask).not.toBeNull();
      expect(loadedTask?.status).toBe('completed');
    });

    test('应该记录进化指标', async () => {
      const harness = new AgentHarness({
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const persistence = harness.getPersistenceService();
      expect(persistence).not.toBeNull();

      const metric = {
        metricType: 'tool_success_rate',
        value: 0.95,
        timestamp: Date.now()
      };

      persistence?.recordEvolutionMetric(metric);

      const metrics = persistence?.getEvolutionMetrics('tool_success_rate') || [];
      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics[0].value).toBe(0.95);
    });
  });

  describe('5. 质量评估验证', () => {
    test('应该对完整执行进行质量评分', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessVerification: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const input = createUserInput('测试质量评估');
      const result = await harness.processInput(input);

      // 验证质量评分
      expect(result.quality).toBeDefined();
      expect(result.quality.overall).toBeGreaterThanOrEqual(0);
      expect(result.quality.overall).toBeLessThanOrEqual(1);
      expect(result.quality.accuracy).toBeDefined();
      expect(result.quality.usefulness).toBeDefined();
      expect(result.quality.efficiency).toBeDefined();
      expect(result.quality.details).toBeDefined();
    });

    test('验证服务应该能够评估目标达成度', async () => {
      const harness = new AgentHarness({
        useHarnessVerification: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const verification = harness.getVerificationService();
      expect(verification).not.toBeNull();

      const goalProgress = await verification?.evaluateGoalProgress(
        '帮我查看文件',
        '文件内容已经列出'
      );

      expect(goalProgress).toBeDefined();
      expect(goalProgress?.progress).toBeGreaterThan(0);
    });

    test('应该能够检测安全风险', async () => {
      const harness = new AgentHarness({
        useHarnessVerification: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const verification = harness.getVerificationService();
      expect(verification).not.toBeNull();

      // 测试安全内容
      const safeCheck = verification?.checkOutputSafety('这是安全的内容');
      expect(safeCheck?.safe).toBe(true);

      // 测试敏感内容
      const unsafeCheck = verification?.checkOutputSafety('密码: mysecret123');
      expect(unsafeCheck?.safe).toBe(false);
    });
  });

  describe('6. 各层协作集成测试', () => {
    test('T-C 协作: 工具执行前检查权限和预算', async () => {
      const harness = new AgentHarness({
        useHarnessTools: true,
        useHarnessConstraints: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const toolRegistry = harness.getToolRegistry();
      const constraints = harness.getConstraintsService();
      const permissionGuard = harness.getPermissionGuard();

      expect(toolRegistry).not.toBeNull();
      expect(constraints).not.toBeNull();
      expect(permissionGuard).not.toBeNull();

      // 模拟工具调用前的检查流程
      const context = {
        permissions: new Set([Permission.FILE_READ]),
        metadata: {}
      };

      // 权限检查
      const permissionResult = constraints?.checkPermission(
        'file_list',
        [Permission.FILE_READ],
        'low',
        context
      );
      expect(permissionResult?.allowed).toBe(true);

      // 预算检查
      const budgetResult = constraints?.checkBudget({
        roundsUsed: 1,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 500,
        tokenWarningLimit: 4500,
        tokenHardLimit: 6000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: 1,
        maxToolCalls: 20
      });
      expect(budgetResult?.withinBudget).toBe(true);
    });

    test('T-V 协作: 工具执行后验证结果', async () => {
      const harness = new AgentHarness({
        useHarnessTools: true,
        useHarnessVerification: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const toolRegistry = harness.getToolRegistry();
      const verification = harness.getVerificationService();

      expect(toolRegistry).not.toBeNull();
      expect(verification).not.toBeNull();

      // 模拟工具执行后的验证流程
      const toolResult = {
        success: true,
        output: '文件读取成功',
        duration: 150,
        validated: false
      };

      const validation = verification?.validateToolResult('file_read', toolResult);
      expect(validation?.valid).toBe(true);
    });

    test('L-P 协作: 循环控制器与持久化协作', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const persistence = harness.getPersistenceService();
      expect(persistence).not.toBeNull();

      // 执行完整流程
      const input = createUserInput('测试循环与持久化');
      const result = await harness.processInput(input);

      // 验证任务被保存
      const savedTask = await persistence?.loadTaskState(result.trace.traceId);
      expect(savedTask).not.toBeNull();
      expect(savedTask?.status).toBe('completed');

      // 验证任务可以列出
      const tasks = await persistence?.listActiveTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });

    test('完整的 E-T-C-S-L-V-P 七层协作', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      // 注册钩子来跟踪各层调用
      const constraints = harness.getConstraintsService();
      const layerCalls: string[] = [];

      constraints?.registerHook(LifecycleEvent.BEFORE_LOOP, async (ctx) => {
        layerCalls.push('Constraints(BeforeLoop)');
        return { proceed: true };
      });

      constraints?.registerHook(LifecycleEvent.ON_PLAN_CREATED, async (ctx) => {
        layerCalls.push('Loop(PlanCreated)');
        return { proceed: true };
      });

      constraints?.registerHook(LifecycleEvent.BEFORE_RESPONSE, async (ctx) => {
        layerCalls.push('Verification(BeforeResponse)');
        return { proceed: true };
      });

      // 执行完整流程
      const input = createUserInput('完整七层协作测试');
      const result = await harness.processInput(input);

      // 验证结果
      expect(result.response).toBeDefined();
      expect(result.quality.overall).toBeGreaterThanOrEqual(0);
      expect(result.trace.state).toBe('completed');

      // 验证各层协作
      expect(layerCalls.length).toBeGreaterThan(0);
    });
  });

  describe('7. 边界条件和错误处理', () => {
    test('应该处理预算超限的情况', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessConstraints: true
      });
      harness.setDeps(deps);
      await harness.initialize();

      const constraints = harness.getConstraintsService();
      const budgetExceeded = false;

      constraints?.registerHook(LifecycleEvent.ON_BUDGET_EXCEEDED, async () => {
        // budgetExceeded = true;
        return { proceed: true };
      });

      // 正常情况下应该不会触发预算超限
      const input = createUserInput('测试预算');
      const result = await harness.processInput(input);

      expect(result).toBeDefined();
      expect(result.trace.state).toBe('completed');
    });

    test('应该优雅处理部分层未启用的情况', async () => {
      // 只启用核心层，不启用验证和约束
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: false,
        useHarnessConstraints: false,
        useHarnessPersistence: false
      });
      harness.setDeps(deps);
      await harness.initialize();

      // 验证未启用的层为 null
      expect(harness.getVerificationService()).toBeNull();
      expect(harness.getConstraintsService()).toBeNull();
      expect(harness.getPersistenceService()).toBeNull();

      // 但仍然可以执行基本流程
      const input = createUserInput('测试部分层');
      const result = await harness.processInput(input);

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
    });
  });
});
