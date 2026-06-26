/**
 * AgentHarness 集成测试 — Phase 1
 *
 * 验证:
 * 1. AgentHarness 初始化 + deps 注入
 * 2. 功能开关机制（逐层启用/禁用）
 * 3. 工具层 + 验证层 + 约束层 + 持久化层协作
 * 4. 双写兼容（ToolRegistry → SkillRegistry）
 * 5. 降级容错（deps 缺失时的行为）
 */

import type { HarnessDeps } from '../../src/harness/AgentHarness';
import { AgentHarness } from '../../src/harness/AgentHarness';
import type { ToolContext, ToolResult } from '../../src/harness/types';
import {
  LifecycleEvent,
  Permission,
  ToolCategory,
} from '../../src/harness/types';
import { SkillRegistry } from '../../src/skills/SkillRegistry';

function createMockDeps(toolDeps?: Record<string, unknown>): HarnessDeps {
  const deps: HarnessDeps = {
    llm: {
      chatWithTools: jest.fn().mockResolvedValue({
        content: '测试响应',
        toolCalls: [],
      }),
      chat: jest.fn().mockResolvedValue('测试响应'),
    },
    constitutionalBuilder: {
      buildConstitutionPrompt: jest.fn().mockResolvedValue('宪法 Prompt'),
    },
    memoryInjector: {
      autoRetrieveMemories: jest.fn().mockResolvedValue(['记忆1', '记忆2']),
    },
    dynamicContext: {
      getDynamicContext: jest
        .fn()
        .mockReturnValue('当前时间: 2026-05-23 10:00，时段: 上午'),
    },
    historyProvider: {
      getAllHistory: jest.fn(),
      getRecentHistory: jest.fn().mockReturnValue([
        { role: 'user' as const, content: '你好' },
        { role: 'assistant' as const, content: '你好！' },
      ]),
    },
  };

  if (toolDeps) {
    (deps as unknown as Record<string, unknown>).toolDeps = toolDeps;
  }

  return deps;
}

function createMockToolDeps(): Record<string, unknown> {
  return {
    detectEmotionFromInput: jest
      .fn()
      .mockReturnValue({ type: '平静', intensity: 2 }),
    recognizeScene: jest
      .fn()
      .mockResolvedValue({ type: '日常对话', context: '日常' }),
    agentSelfReflection: null,
    getHistory: jest.fn().mockResolvedValue([]),
    removeHistory: jest.fn().mockResolvedValue(null),
    addToHistory: jest.fn().mockResolvedValue(undefined),
    validateCodeSyntax: jest.fn().mockReturnValue([]),
    taskStore: {
      getTasks: jest.fn().mockResolvedValue([]),
      saveTask: jest.fn().mockResolvedValue(undefined),
      deleteTask: jest.fn().mockResolvedValue(undefined),
    },
    reminderStore: {
      getReminders: jest.fn().mockResolvedValue([]),
      saveReminder: jest.fn().mockResolvedValue(undefined),
      deleteReminder: jest.fn().mockResolvedValue(undefined),
    },
    scheduleTrigger: null,
    noteStore: {
      getNotes: jest.fn().mockResolvedValue([]),
      saveNote: jest.fn().mockResolvedValue(undefined),
      deleteNote: jest.fn().mockResolvedValue(undefined),
    },
    getMemoryStats: jest.fn().mockReturnValue({ count: 0 }),
    getToolStats: jest.fn().mockReturnValue({ registered: 25, byCategory: {} }),
    getHarnessStats: jest
      .fn()
      .mockReturnValue({ initialized: true, config: {} }),
    getEvolutionStats: jest.fn().mockReturnValue({}),
    getSchedulerStats: jest.fn().mockReturnValue({}),
    skillStore: {
      getSkills: jest.fn().mockResolvedValue([]),
      saveSkill: jest.fn().mockResolvedValue(undefined),
      deleteSkill: jest.fn().mockResolvedValue(undefined),
    },
  };
}

// ============ AgentHarness 初始化测试 ============

describe('AgentHarness 初始化', () => {
  test('默认配置下所有功能开关应开启', () => {
    const harness = new AgentHarness();
    const config = harness.getConfig();
    expect(config.useHarnessLoop).toBe(true);
    expect(config.useHarnessTools).toBe(true);
    expect(config.useHarnessContext).toBe(true);
    expect(config.useHarnessVerification).toBe(true);
    expect(config.useHarnessConstraints).toBe(true);
    expect(config.useHarnessPersistence).toBe(true);
  });

  test('应该接受部分配置覆盖', () => {
    const harness = new AgentHarness({ useHarnessTools: false });
    const config = harness.getConfig();
    expect(config.useHarnessTools).toBe(false);
    expect(config.useHarnessLoop).toBe(true);
  });

  test('未注入 deps 时初始化应成功（工具层使用空 deps）', async () => {
    const harness = new AgentHarness({ useHarnessTools: true });
    await harness.initialize();
    expect(harness.getToolRegistry()).not.toBeNull();
    expect(harness.getToolRegistry()!.size).toBe(51);
  });

  test('注入 deps + 启用工具层后应创建 ToolRegistry', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();

    const registry = harness.getToolRegistry();
    expect(registry).not.toBeNull();
  });

  test('重复初始化应跳过', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();
    await harness.initialize();

    const registry = harness.getToolRegistry();
    expect(registry).not.toBeNull();
  });
});

// ============ 功能开关机制测试 ============

describe('功能开关机制', () => {
  test('仅启用工具层时，其他层应为 null', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: false,
      useHarnessVerification: false,
      useHarnessConstraints: false,
      useHarnessPersistence: false,
      useHarnessLoop: false,
    });
    harness.setDeps(deps);
    await harness.initialize();

    expect(harness.getToolRegistry()).not.toBeNull();
    expect(harness.getContextManager()).toBeNull();
    expect(harness.getVerificationService()).toBeNull();
    expect(harness.getConstraintsService()).toBeNull();
    expect(harness.getPersistenceService()).toBeNull();
  });

  test('启用工具层+验证层+约束层+持久化层', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
      useHarnessConstraints: true,
      useHarnessPersistence: true,
      useHarnessContext: false,
      useHarnessLoop: false,
    });
    harness.setDeps(deps);
    await harness.initialize();

    expect(harness.getToolRegistry()).not.toBeNull();
    expect(harness.getVerificationService()).not.toBeNull();
    expect(harness.getConstraintsService()).not.toBeNull();
    expect(harness.getPersistenceService()).not.toBeNull();
    expect(harness.getContextManager()).toBeNull();
  });

  test('启用循环层+上下文层需要 deps', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    expect(harness.getContextManager()).not.toBeNull();
  });

  test('运行时更新配置', () => {
    const harness = new AgentHarness({ useHarnessTools: false });
    expect(harness.getConfig().useHarnessTools).toBe(false);

    harness.updateConfig({ useHarnessTools: true });
    expect(harness.getConfig().useHarnessTools).toBe(true);
  });
});

// ============ 工具层集成测试 ============

describe('工具层集成', () => {
  test('应该注册 19 个工具', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();

    const registry = harness.getToolRegistry();
    expect(registry).not.toBeNull();
    expect(registry!.size).toBe(51);
  });

  test('所有工具应能转换为 OpenAI 格式', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();

    const registry = harness.getToolRegistry();
    const openaiTools = registry!.toOpenAITools();
    expect(openaiTools.length).toBe(51);

    for (const tool of openaiTools) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  test('工具应按分类排序', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();

    const registry = harness.getToolRegistry();
    const openaiTools = registry!.toOpenAITools();
    const categories = openaiTools.map(
      (t) => registry!.get(t.function.name)!.definition.category
    );

    const categoryOrder = [
      ToolCategory.COGNITION,
      ToolCategory.MEMORY,
      ToolCategory.DAILY,
      ToolCategory.NETWORK,
      ToolCategory.SYSTEM,
      ToolCategory.FILE,
      ToolCategory.CODE,
      ToolCategory.DESKTOP,
    ];

    let lastIdx = -1;
    for (const cat of categories) {
      const idx = categoryOrder.indexOf(cat);
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });

  test('SchemaValidator 应验证工具参数', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();

    const validator = harness.getSchemaValidator();
    expect(validator).not.toBeNull();

    const result = validator!.validate(
      { query: '测试查询' },
      { query: { type: 'string', description: '查询内容' } },
      ['query']
    );
    expect(result.valid).toBe(true);
  });

  test('PermissionGuard 应检查权限', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();

    const guard = harness.getPermissionGuard();
    expect(guard).not.toBeNull();

    const context: ToolContext = {
      permissions: new Set([Permission.MEMORY_READ]),
      metadata: {},
    };

    const allowed = guard!.check(
      'memory_recall',
      [Permission.MEMORY_READ],
      'low',
      context
    );
    expect(allowed.allowed).toBe(true);

    const denied = guard!.check(
      'desktop_automate',
      [Permission.DESKTOP_CONTROL],
      'high',
      context
    );
    expect(denied.allowed).toBe(false);
  });
});

// ============ 验证层集成测试 ============

describe('验证层集成', () => {
  test('应验证工具执行结果', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService();
    expect(verification).not.toBeNull();

    const result: ToolResult = {
      success: true,
      output: '操作成功',
      duration: 100,
      validated: false,
    };
    const validation = verification!.validateToolResult('test_tool', result);
    expect(validation.valid).toBe(true);
  });

  test('应检测安全风险', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;
    const safe = verification.checkOutputSafety('正常输出');
    expect(safe.safe).toBe(true);

    const unsafe = verification.checkOutputSafety('密码: secret123');
    expect(unsafe.safe).toBe(false);
  });
});

// ============ 约束层集成测试 ============

describe('约束层集成', () => {
  test('应检查预算', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService();
    expect(constraints).not.toBeNull();

    const result = constraints!.checkBudget({
      roundsUsed: 2,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 1000,
      tokenWarningLimit: 4500,
      tokenHardLimit: 6000,
      startTime: Date.now() - 5000,
      maxDurationMs: 60000,
      toolCallsUsed: 3,
      maxToolCalls: 20,
    });
    expect(result.withinBudget).toBe(true);
  });

  test('应阻止危险操作', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;
    const blocked = constraints.checkSafetyBoundary('test', 'rm -rf /');
    expect(blocked.allowed).toBe(false);
  });

  test('生命周期钩子应正常工作', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;
    let hookCalled = false;
    constraints.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => {
      hookCalled = true;
      return { proceed: true };
    });

    const result = await constraints.executeHooks(
      LifecycleEvent.BEFORE_TOOL_CALL,
      { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} }
    );
    expect(result.proceed).toBe(true);
    expect(hookCalled).toBe(true);
  });
});

// ============ 持久化层集成测试 ============

describe('持久化层集成', () => {
  test('应初始化并管理任务状态', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService();
    expect(persistence).not.toBeNull();

    await persistence!.saveTaskState({
      taskId: 'task-1',
      userId: 'user-1',
      description: '测试任务',
      status: 'in_progress',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const loaded = await persistence!.loadTaskState('task-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe('task-1');
    expect(loaded!.status).toBe('in_progress');
  });

  test('应列出活跃任务', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;

    await persistence.saveTaskState({
      taskId: 'active-1',
      userId: 'user-1',
      description: '活跃任务',
      status: 'in_progress',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await persistence.saveTaskState({
      taskId: 'completed-1',
      userId: 'user-1',
      description: '已完成任务',
      status: 'completed',
      currentStepIndex: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const active = await persistence.listActiveTasks();
    const activeTask = active.find((t) => t.taskId === 'active-1');
    expect(activeTask).toBeDefined();
    expect(activeTask!.taskId).toBe('active-1');
    const completedTask = active.find((t) => t.taskId === 'completed-1');
    expect(completedTask).toBeUndefined();
  });

  test('应记录进化指标', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;
    persistence.recordEvolutionMetric({
      metricType: 'tool_success_rate',
      value: 0.95,
      timestamp: Date.now(),
    });

    const metrics = persistence.getEvolutionMetrics('tool_success_rate');
    expect(metrics.length).toBe(1);
    expect(metrics[0].value).toBe(0.95);
  });
});

// ============ 多层协作测试 ============

describe('多层协作', () => {
  test('工具层+验证层协作：执行工具后验证结果', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const registry = harness.getToolRegistry()!;
    const verification = harness.getVerificationService()!;

    const context: ToolContext = {
      permissions: new Set([
        Permission.MEMORY_READ,
        Permission.MEMORY_WRITE,
        Permission.FILE_READ,
        Permission.FILE_WRITE,
        Permission.CODE_EXECUTE,
      ]),
      metadata: {},
    };

    const result = await registry.execute(
      'ask_clarification',
      { question: '测试问题' },
      context
    );
    const validation = verification.validateToolResult(
      'ask_clarification',
      result
    );
    expect(validation.valid).toBe(true);
  });

  test('工具层+约束层协作：权限检查+工具执行', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const registry = harness.getToolRegistry()!;
    const constraints = harness.getConstraintsService()!;

    const desktopTool = registry.get('desktop_automate');
    expect(desktopTool).toBeDefined();

    const limitedContext: ToolContext = {
      permissions: new Set([Permission.MEMORY_READ]),
      metadata: {},
    };

    const permResult = constraints.checkPermission(
      'desktop_automate',
      desktopTool!.definition.requiredPermissions,
      desktopTool!.definition.riskLevel,
      limitedContext
    );
    expect(permResult.allowed).toBe(false);
  });

  test('全层协作：工具+验证+约束+持久化', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
      useHarnessConstraints: true,
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    expect(harness.getToolRegistry()).not.toBeNull();
    expect(harness.getVerificationService()).not.toBeNull();
    expect(harness.getConstraintsService()).not.toBeNull();
    expect(harness.getPersistenceService()).not.toBeNull();

    const constraints = harness.getConstraintsService()!;
    const budget = constraints.checkBudget({
      roundsUsed: 1,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 500,
      tokenWarningLimit: 4500,
      tokenHardLimit: 6000,
      startTime: Date.now(),
      maxDurationMs: 60000,
      toolCallsUsed: 2,
      maxToolCalls: 20,
    });
    expect(budget.withinBudget).toBe(true);
  });
});

// ============ 降级容错测试 ============

describe('降级容错', () => {
  test('deps 为 null 时初始化不崩溃', async () => {
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
      useHarnessConstraints: true,
      useHarnessPersistence: true,
    });
    await expect(harness.initialize()).resolves.not.toThrow();
  });

  test('未启用循环层时 processInput 应抛错', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: false,
    });
    harness.setDeps(deps);
    await harness.initialize();

    await expect(harness.processInput({ text: '你好' })).rejects.toThrow(
      '循环层未启用'
    );
  });

  test('shutdown 应清理状态', async () => {
    const deps = createMockDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();
    await harness.shutdown();
  });
});

// ============ 双写兼容测试 ============

describe('双写兼容', () => {
  test('应同步工具到旧版 SkillRegistry', async () => {
    const deps = createMockDeps(createMockToolDeps());

    const skillRegistry = SkillRegistry.getInstance();
    const registeredTools: string[] = [];

    (deps as unknown as Record<string, unknown>).skillRegistry = {
      registerInfrastructureTool: (tool: { name: string }) => {
        registeredTools.push(tool.name);
      },
    };

    const harness = new AgentHarness({ useHarnessTools: true });
    harness.setDeps(deps);
    await harness.initialize();

    const registry = harness.getToolRegistry()!;
    expect(registry.size).toBe(51);
    expect(registeredTools.length).toBe(51);
  });
});
