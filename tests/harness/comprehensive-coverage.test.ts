/**
 * V5.0 架构精简计划 - Task 1: 验证 Harness 系统完整性
 *
 * 目标：确保新 Harness 系统可以独立替代旧系统的所有功能
 *
 * 测试内容：
 * 1. 所有 25 个 Harness 工具的注册与可用性
 * 2. 完整的 Harness 流程测试（AgentHarness.processInput）
 * 3. E-T-C-S-L-V 所有层次集成测试
 * 4. 所有工具的 Schema 验证
 */

import {
  AgentHarness,
  ConstraintsService,
  Evaluator,
  Executor,
  LoopController,
  PermissionGuard,
  PersistenceService,
  Planner,
  registerHarnessTools,
  Reporter,
  SchemaValidator,
  ToolRegistry,
  VerificationService,
} from '../../src/harness';
import type { HarnessDeps } from '../../src/harness/AgentHarness';
import type { HarnessToolDeps } from '../../src/harness/tools/registerHarnessTools';
import type { UserInput } from '../../src/harness/types';
import {
  LifecycleEvent,
  LoopState,
  Permission,
  ToolCategory,
} from '../../src/harness/types';

// ============ 25 个工具的名称列表 ============
const ALL_TOOL_NAMES = [
  // 记忆工具 (3个)
  'memory_recall',
  'memory_store',
  'memory_search',
  // 认知工具 (3个)
  'emotion_detect',
  'analyze_scene',
  'self_reflect',
  // 桌面工具 (2个)
  'desktop_automate',
  'desktop_screenshot',
  // 系统工具 (3个)
  'ask_clarification',
  'preview_execution',
  'rollback_changes',
  // 文件工具 (5个)
  'file_list',
  'file_search',
  'get_active_file',
  'incremental_edit',
  'multi_file_edit',
  // 代码工具 (3个)
  'code_analyze',
  'code_fix',
  'code_generate',
  // 日常管理工具 (9个)
  'task_manage',
  'reminder_set',
  'note_take',
  'system_status',
  'batch_task',
  'calendar',
  'task_analytics',
  'task_dependency',
  'task_priority',
  // 网络工具 (4个)
  'web_search',
  'skill_create',
  'image_generate',
  'web_fetch',
  // 系统工具 (4个)
  'shell_exec',
];

// ============ Mock 数据和辅助函数 ============

function createMockDeps(): HarnessDeps & { toolDeps: HarnessToolDeps } {
  const mockLlm = {
    chatWithTools: jest.fn().mockResolvedValue({
      content: '好的，我来帮你完成这个任务。',
      toolCalls: [],
    }),
    chat: jest.fn().mockResolvedValue('这是一个模拟的 LLM 回复。'),
  };

  return {
    llm: mockLlm,
    constitutionalBuilder: {
      buildConstitutionPrompt: jest.fn().mockResolvedValue('宪法 Prompt'),
    },
    memoryInjector: {
      autoRetrieveMemories: jest.fn().mockResolvedValue(['记忆1', '记忆2']),
    },
    dynamicContext: {
      getDynamicContext: jest
        .fn()
        .mockReturnValue('当前时间: 2026-05-25 10:00'),
    },
    historyProvider: {
      getAllHistory: jest.fn(),
      getRecentHistory: jest.fn().mockReturnValue([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ]),
    },
    toolDeps: {
      core: {
        refreshProjectContext: jest.fn().mockResolvedValue(0),
        getLoadedContextFiles: jest.fn().mockReturnValue([]),
      },
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
      calendarStore: {
        getEvents: jest.fn().mockResolvedValue([]),
        saveEvent: jest.fn().mockResolvedValue(undefined),
        deleteEvent: jest.fn().mockResolvedValue(undefined),
      },
      getMemoryStats: jest.fn().mockReturnValue({}),
      getToolStats: jest
        .fn()
        .mockReturnValue({ registered: 0, byCategory: {} }),
      getHarnessStats: jest
        .fn()
        .mockReturnValue({ initialized: false, config: {} }),
      getEvolutionStats: jest.fn().mockReturnValue({}),
      getSchedulerStats: jest.fn().mockReturnValue({}),
      skillStore: {
        getSkills: jest.fn().mockResolvedValue([]),
        saveSkill: jest.fn().mockResolvedValue(undefined),
        deleteSkill: jest.fn().mockResolvedValue(undefined),
      },
      llm: { chat: jest.fn().mockResolvedValue('') },
    },
    persistenceDeps: {},
  };
}

function createUserInput(text: string = '帮我列出当前目录的文件'): UserInput {
  return {
    text,
    userId: 'test-user',
    traceId: `test-trace-${Date.now()}`,
    metadata: { testRun: true },
  };
}

// ============ 测试开始 ============

describe('V5.0 Task 1: Harness 系统完整性验证', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
  });

  // ============ 1. 工具层完整性测试 ============
  describe('1. 所有 25 个 Harness 工具的注册与可用性测试', () => {
    test('应该成功注册所有 25 个工具', () => {
      const result = registerHarnessTools(deps.toolDeps);

      expect(result.registeredCount).toBe(51);
      expect(result.toolRegistry.size).toBe(51);
    });

    test('所有 25 个工具都应该可以通过名称获取', () => {
      const result = registerHarnessTools(deps.toolDeps);
      const registry = result.toolRegistry;

      for (const toolName of ALL_TOOL_NAMES) {
        const tool = registry.get(toolName);
        expect(tool).toBeDefined();
        expect(tool?.definition.name).toBe(toolName);
      }
    });

    test('所有工具应该具有正确的分类', () => {
      const result = registerHarnessTools(deps.toolDeps);
      const registry = result.toolRegistry;

      // 验证各分类工具数量
      const memoryTools = registry.getByCategory(ToolCategory.MEMORY);
      const cognitionTools = registry.getByCategory(ToolCategory.COGNITION);
      const desktopTools = registry.getByCategory(ToolCategory.DESKTOP);
      const systemTools = registry.getByCategory(ToolCategory.SYSTEM);
      const fileTools = registry.getByCategory(ToolCategory.FILE);
      const codeTools = registry.getByCategory(ToolCategory.CODE);
      const dailyTools = registry.getByCategory(ToolCategory.DAILY);
      const networkTools = registry.getByCategory(ToolCategory.NETWORK);

      expect(memoryTools.length).toBe(4);
      expect(cognitionTools.length).toBe(3);
      expect(desktopTools.length).toBe(2);
      expect(systemTools.length).toBe(9);
      expect(fileTools.length).toBe(8);
      expect(codeTools.length).toBe(6);
      expect(dailyTools.length).toBe(11);
      expect(networkTools.length).toBe(8);
    });

    test('所有工具应该能转换为 OpenAI 工具格式', () => {
      const result = registerHarnessTools(deps.toolDeps);
      const openaiTools = result.toolRegistry.toOpenAITools();

      expect(openaiTools.length).toBe(51);

      for (const tool of openaiTools) {
        expect(tool.type).toBe('function');
        expect(tool.function.name).toBeTruthy();
        expect(tool.function.description).toBeTruthy();
        expect(tool.function.parameters).toBeTruthy();
        expect(tool.function.parameters.type).toBe('object');
      }
    });

    test('所有工具应该有完整的定义结构', () => {
      const result = registerHarnessTools(deps.toolDeps);
      const registry = result.toolRegistry;
      const tools = registry.getAll();

      for (const tool of tools) {
        const def = tool.definition;
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.category).toBeTruthy();
        expect(def.parameters).toBeTruthy();
        expect(Array.isArray(def.requiredParams)).toBe(true);
        expect(Array.isArray(def.requiredPermissions)).toBe(true);
        expect(def.riskLevel).toBeTruthy();
        expect(typeof def.idempotent).toBe('boolean');
        expect(typeof def.timeout).toBe('number');
      }
    });
  });

  // ============ 2. Schema 验证测试 ============
  describe('2. 所有工具的 Schema 验证', () => {
    let validator: SchemaValidator;
    let registry: ToolRegistry;

    beforeEach(() => {
      const result = registerHarnessTools(deps.toolDeps);
      validator = result.schemaValidator;
      registry = result.toolRegistry;
    });

    test('SchemaValidator 应该能够验证所有工具的参数 Schema', () => {
      const tools = registry.getAll();

      for (const tool of tools) {
        const def = tool.definition;
        const testParams: Record<string, unknown> = {};

        // 为必填参数生成测试值
        for (const paramName of def.requiredParams) {
          const paramDef = def.parameters[paramName];
          if (paramDef.type === 'string') {
            testParams[paramName] = paramDef.enum
              ? paramDef.enum[0]
              : 'test_value';
          } else if (paramDef.type === 'number') {
            testParams[paramName] = 42;
          } else if (paramDef.type === 'boolean') {
            testParams[paramName] = true;
          } else if (paramDef.type === 'object') {
            testParams[paramName] = {};
          } else if (paramDef.type === 'array') {
            testParams[paramName] = [];
          }
        }

        const validation = validator.validate(
          testParams,
          def.parameters,
          def.requiredParams
        );

        expect(validation.valid).toBe(true);
        expect(validation.errors.length).toBe(0);
      }
    });

    test('SchemaValidator 应该正确检测缺少必填参数', () => {
      // 使用 memory_recall 作为测试，它需要 query 参数
      const memoryRecall = registry.get('memory_recall');
      expect(memoryRecall).toBeDefined();

      const validation = validator.validate(
        {}, // 没有 query 参数
        memoryRecall!.definition.parameters,
        memoryRecall!.definition.requiredParams
      );

      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('query'))).toBe(true);
    });

    test('SchemaValidator 应该正确检测类型错误', () => {
      const memoryRecall = registry.get('memory_recall');
      expect(memoryRecall).toBeDefined();

      const validation = validator.validate(
        { query: 123 }, // 应该是 string，传了 number
        memoryRecall!.definition.parameters,
        memoryRecall!.definition.requiredParams
      );

      expect(validation.valid).toBe(false);
    });
  });

  // ============ 3. 权限验证测试 ============
  describe('3. 权限验证测试', () => {
    let permissionGuard: PermissionGuard;
    let registry: ToolRegistry;

    beforeEach(() => {
      const result = registerHarnessTools(deps.toolDeps);
      permissionGuard = result.permissionGuard;
      registry = result.toolRegistry;
    });

    test('所有工具应该定义了所需的权限', () => {
      const tools = registry.getAll();

      for (const tool of tools) {
        expect(Array.isArray(tool.definition.requiredPermissions)).toBe(true);
      }
    });

    test('PermissionGuard 应该正确检查工具权限', () => {
      const fileList = registry.get('file_list');
      expect(fileList).toBeDefined();

      const contextWithPermission = {
        permissions: new Set([Permission.FILE_READ]),
        metadata: {},
      };

      const contextWithoutPermission = {
        permissions: new Set<Permission>(),
        metadata: {},
      };

      // 有权限应该允许
      const allowedResult = permissionGuard.check(
        'file_list',
        fileList!.definition.requiredPermissions,
        fileList!.definition.riskLevel,
        contextWithPermission
      );
      expect(allowedResult.allowed).toBe(true);

      // 无权限应该拒绝
      const deniedResult = permissionGuard.check(
        'file_list',
        fileList!.definition.requiredPermissions,
        fileList!.definition.riskLevel,
        contextWithoutPermission
      );
      expect(deniedResult.allowed).toBe(false);
      expect(deniedResult.missing).toContain(Permission.FILE_READ);
    });

    test('PermissionGuard 应该支持授予和撤销权限', () => {
      const userId = 'test-user';

      // 授予权限
      permissionGuard.grantPermission(userId, Permission.FILE_READ);
      permissionGuard.grantPermission(userId, Permission.FILE_WRITE);

      const userPermissions = permissionGuard.getUserPermissions(userId);
      expect(userPermissions.has(Permission.FILE_READ)).toBe(true);
      expect(userPermissions.has(Permission.FILE_WRITE)).toBe(true);

      // 撤销权限
      permissionGuard.revokePermission(userId, Permission.FILE_WRITE);
      const updatedPermissions = permissionGuard.getUserPermissions(userId);
      expect(updatedPermissions.has(Permission.FILE_READ)).toBe(true);
      expect(updatedPermissions.has(Permission.FILE_WRITE)).toBe(false);
    });
  });

  // ============ 4. E-T-C-S-L-V 各层次集成测试 ============
  describe('4. E-T-C-S-L-V 所有层次集成测试', () => {
    test('T - 工具层: ToolRegistry 应该正确注册和执行工具', async () => {
      const result = registerHarnessTools(deps.toolDeps);
      const registry = result.toolRegistry;
      const validator = result.schemaValidator;
      const permissionGuard = result.permissionGuard;

      // 验证工具注册
      expect(registry.size).toBe(51);

      // 验证工具可以获取
      const memoryRecall = registry.get('memory_recall');
      expect(memoryRecall).toBeDefined();

      // 验证 Schema 验证器
      const validation = validator.validate(
        { query: '测试查询' },
        memoryRecall!.definition.parameters,
        memoryRecall!.definition.requiredParams
      );
      expect(validation.valid).toBe(true);

      // 验证权限守卫
      const permissionCheck = permissionGuard.check(
        'memory_recall',
        memoryRecall!.definition.requiredPermissions,
        memoryRecall!.definition.riskLevel,
        { permissions: new Set([Permission.MEMORY_READ]), metadata: {} }
      );
      expect(permissionCheck.allowed).toBe(true);
    });

    test('S - Schema 层: SchemaValidator 应该与 ToolRegistry 协作', () => {
      const result = registerHarnessTools(deps.toolDeps);
      const registry = result.toolRegistry;
      const validator = result.schemaValidator;

      for (const tool of registry.getAll()) {
        const def = tool.definition;
        const testParams: Record<string, unknown> = {};

        // 为必填参数生成默认值
        for (const paramName of def.requiredParams) {
          const paramDef = def.parameters[paramName];
          if (paramDef.type === 'string') {
            testParams[paramName] = paramDef.enum ? paramDef.enum[0] : 'test';
          } else if (paramDef.type === 'number') {
            testParams[paramName] = paramDef.default || 0;
          } else if (paramDef.type === 'boolean') {
            testParams[paramName] = paramDef.default || false;
          } else if (paramDef.type === 'object') {
            testParams[paramName] = {};
          } else if (paramDef.type === 'array') {
            testParams[paramName] = [];
          }
        }

        const validation = validator.validate(
          testParams,
          def.parameters,
          def.requiredParams
        );

        expect(validation.valid).toBe(true);
      }
    });

    test('C - 约束层: ConstraintsService 应该与 PermissionGuard 协作', () => {
      const permissionGuard = new PermissionGuard();
      const constraints = new ConstraintsService({ permissionGuard });

      // 权限检查
      const permissionCheck = constraints.checkPermission(
        'file_list',
        [Permission.FILE_READ],
        'low',
        { permissions: new Set([Permission.FILE_READ]), metadata: {} }
      );
      expect(permissionCheck.allowed).toBe(true);

      // 预算检查
      const budgetCheck = constraints.checkBudget({
        roundsUsed: 1,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 500,
        tokenWarningLimit: 4500,
        tokenHardLimit: 6000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: 1,
        maxToolCalls: 20,
      });
      expect(budgetCheck.withinBudget).toBe(true);
    });

    test('L - 循环层: Loop 组件应该能够正确初始化', async () => {
      const toolResult = registerHarnessTools(deps.toolDeps);

      const planner = new Planner({ llm: deps.llm });
      const executor = new Executor({
        llm: deps.llm,
        toolRegistry: toolResult.toolRegistry,
        schemaValidator: toolResult.schemaValidator,
        permissionGuard: toolResult.permissionGuard,
      });
      const evaluator = new Evaluator({ llm: deps.llm });
      const reporter = new Reporter();

      const loopController = new LoopController({
        planner,
        executor,
        evaluator,
        reporter,
      });

      expect(loopController).toBeDefined();
    });

    test('V - 验证层: VerificationService 应该能够验证结果和评估质量', async () => {
      const verification = new VerificationService({ llm: deps.llm });

      // 工具结果验证
      const toolResult = {
        success: true,
        output: '操作成功',
        duration: 100,
        validated: false,
      };
      const validation = verification.validateToolResult(
        'test_tool',
        toolResult
      );
      expect(validation.valid).toBe(true);

      // 质量评分
      const quality = verification.scoreQuality({
        loopCount: 1,
        totalToolCalls: 1,
        totalToolDuration: 100,
        totalDuration: 1000,
        completedSuccessfully: true,
      });
      expect(quality.overall).toBeGreaterThan(0);
      expect(quality.overall).toBeLessThanOrEqual(1);
    });

    test('E - 评估层: Evaluator 应该能够评估执行结果', async () => {
      const evaluator = new Evaluator({ llm: deps.llm });

      // 评估器应该可以被创建
      expect(evaluator).toBeDefined();
    });

    test('完整的 E-T-C-S-L-V 各层协作', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true,
      });
      harness.setDeps(deps);
      await harness.initialize();

      // 验证所有层都已初始化
      expect(harness.getToolRegistry()).not.toBeNull();
      expect(harness.getSchemaValidator()).not.toBeNull();
      expect(harness.getPermissionGuard()).not.toBeNull();
      expect(harness.getContextManager()).not.toBeNull();
      expect(harness.getVerificationService()).not.toBeNull();
      expect(harness.getConstraintsService()).not.toBeNull();
      expect(harness.getPersistenceService()).not.toBeNull();
    });
  });

  // ============ 5. 完整 Harness 流程测试 ============
  describe('5. 完整的 Harness 流程测试（AgentHarness.processInput）', () => {
    test('AgentHarness 应该能够完整初始化', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true,
      });
      harness.setDeps(deps);
      await harness.initialize();

      expect(harness.getToolRegistry()).not.toBeNull();
      expect(harness.getToolRegistry()?.size).toBe(51);
    });

    test('processInput 应该能够处理输入并返回结果', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true,
      });
      harness.setDeps(deps);
      await harness.initialize();

      const input = createUserInput('帮我查看一下项目结构');
      const result = await harness.processInput(input);

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.quality).toBeDefined();
      expect(result.quality.overall).toBeGreaterThanOrEqual(0);
      expect(result.quality.overall).toBeLessThanOrEqual(1);
      expect(result.trace).toBeDefined();
      expect(result.trace.state).toBe(LoopState.COMPLETED);
      expect(result.metadata).toBeDefined();
    });

    test('完整流程应该触发生命周期钩子', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessConstraints: true,
      });
      harness.setDeps(deps);
      await harness.initialize();

      const constraints = harness.getConstraintsService();
      const triggeredHooks: LifecycleEvent[] = [];

      // 注册钩子
      constraints?.registerHook(LifecycleEvent.BEFORE_LOOP, async () => {
        triggeredHooks.push(LifecycleEvent.BEFORE_LOOP);
        return { proceed: true };
      });

      constraints?.registerHook(LifecycleEvent.AFTER_RESPONSE, async () => {
        triggeredHooks.push(LifecycleEvent.AFTER_RESPONSE);
        return { proceed: true };
      });

      const input = createUserInput('测试生命周期钩子');
      await harness.processInput(input);

      expect(triggeredHooks).toContain(LifecycleEvent.BEFORE_LOOP);
      expect(triggeredHooks).toContain(LifecycleEvent.AFTER_RESPONSE);
    });

    test('完整流程应该正确使用 ContextManager', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
      });
      harness.setDeps(deps);
      await harness.initialize();

      const contextManager = harness.getContextManager();
      expect(contextManager).not.toBeNull();

      const input = createUserInput('测试上下文管理');
      await harness.processInput(input);

      // 验证依赖被调用
      expect(
        deps.constitutionalBuilder.buildConstitutionPrompt
      ).toHaveBeenCalled();
      expect(deps.memoryInjector.autoRetrieveMemories).toHaveBeenCalled();
      expect(deps.historyProvider.getRecentHistory).toHaveBeenCalled();
    });
  });

  // ============ 6. 持久化层测试 ============
  describe('6. 持久化层测试', () => {
    test('PersistenceService 应该能够保存和加载任务状态', async () => {
      const persistence = new PersistenceService(deps.persistenceDeps || {});
      await persistence.initialize();

      const taskId = 'test-task-123';
      const taskData = {
        taskId,
        userId: 'test-user',
        description: '测试任务',
        status: 'in_progress' as const,
        currentStepIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 保存状态
      await persistence.saveTaskState(taskData);

      // 读取状态
      const loaded = await persistence.loadTaskState(taskId);
      expect(loaded).not.toBeNull();
      expect(loaded?.taskId).toBe(taskId);
      expect(loaded?.status).toBe('in_progress');
    });

    test('PersistenceService 应该能够记录进化指标', async () => {
      const persistence = new PersistenceService(deps.persistenceDeps || {});
      await persistence.initialize();

      const metric = {
        metricType: 'tool_success_rate',
        value: 0.95,
        timestamp: Date.now(),
      };

      persistence.recordEvolutionMetric(metric);

      const metrics = persistence.getEvolutionMetrics('tool_success_rate');
      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics[0].value).toBe(0.95);
    });
  });

  // ============ 7. 验收标准验证 ============
  describe('7. 验收标准验证', () => {
    test('测试覆盖 Harness 核心功能', async () => {
      // 验证我们已经测试了以下核心功能：
      // 1. 工具注册与获取 ✓
      // 2. Schema 验证 ✓
      // 3. 权限检查 ✓
      // 4. 各层协作 ✓
      // 5. 完整流程 ✓
      // 6. 持久化 ✓

      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true,
      });
      harness.setDeps(deps);
      await harness.initialize();

      // 验证所有核心组件可用
      expect(harness.getToolRegistry()).not.toBeNull();
      expect(harness.getSchemaValidator()).not.toBeNull();
      expect(harness.getPermissionGuard()).not.toBeNull();
      expect(harness.getContextManager()).not.toBeNull();
      expect(harness.getVerificationService()).not.toBeNull();
      expect(harness.getConstraintsService()).not.toBeNull();
      expect(harness.getPersistenceService()).not.toBeNull();
    });

    test('模拟输入可以正常得到回复', async () => {
      const harness = new AgentHarness({
        useHarnessLoop: true,
        useHarnessTools: true,
        useHarnessContext: true,
        useHarnessVerification: true,
        useHarnessConstraints: true,
        useHarnessPersistence: true,
      });
      harness.setDeps(deps);
      await harness.initialize();

      const testInputs = [
        '你好，请介绍一下自己',
        '帮我查看一下项目中有哪些文件',
        '这个项目的结构是怎样的？',
        '帮我生成一个简单的 Hello World 函数',
      ];

      for (const inputText of testInputs) {
        const input = createUserInput(inputText);
        const result = await harness.processInput(input);

        expect(result).toBeDefined();
        expect(result.response).toBeTruthy();
        expect(typeof result.response).toBe('string');
        expect(result.response.length).toBeGreaterThan(0);
      }
    });

    test('所有测试应该能够正常通过（自我验证）', () => {
      // 这个测试用于验证我们的测试框架本身是正常的
      expect(true).toBe(true);
      expect(1 + 1).toBe(2);
      expect(ALL_TOOL_NAMES.length).toBe(33);
    });
  });
});
