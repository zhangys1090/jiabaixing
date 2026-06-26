/**
 * Harness 工具层单元测试
 */

import {
  PermissionGuard,
  registerHarnessTools,
  SchemaValidator,
  ToolRegistry,
} from '../../src/harness';
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/harness/types';
import { Permission, ToolCategory } from '../../src/harness/types';

// ============ ToolRegistry 测试 ============

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  const mockToolDef: ToolDefinition = {
    name: 'test_tool',
    description: 'A test tool',
    category: ToolCategory.SYSTEM,
    parameters: {
      input: {
        type: 'string',
        description: 'Test input',
      },
    },
    requiredParams: ['input'],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
  };

  const mockExecutor = async (
    params: Record<string, unknown>
  ): Promise<ToolResult> => {
    return {
      success: true,
      output: `processed: ${params.input}`,
      duration: 10,
      validated: true,
    };
  };

  const mockContext: ToolContext = {
    permissions: new Set<Permission>(),
    metadata: {},
  };

  test('应该注册工具', () => {
    registry.register(mockToolDef, mockExecutor);
    expect(registry.has('test_tool')).toBe(true);
    expect(registry.size).toBe(1);
  });

  test('应该跳过重复注册', () => {
    registry.register(mockToolDef, mockExecutor);
    registry.register(mockToolDef, mockExecutor);
    expect(registry.size).toBe(1);
  });

  test('应该注销工具', () => {
    registry.register(mockToolDef, mockExecutor);
    expect(registry.unregister('test_tool')).toBe(true);
    expect(registry.has('test_tool')).toBe(false);
    expect(registry.size).toBe(0);
  });

  test('应该获取工具', () => {
    registry.register(mockToolDef, mockExecutor);
    const tool = registry.get('test_tool');
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe('test_tool');
  });

  test('应该按分类获取工具', () => {
    registry.register(mockToolDef, mockExecutor);
    const tools = registry.getByCategory(ToolCategory.SYSTEM);
    expect(tools.length).toBe(1);
    expect(tools[0].definition.name).toBe('test_tool');
  });

  test('应该执行工具', async () => {
    registry.register(mockToolDef, mockExecutor);
    const result = await registry.execute(
      'test_tool',
      { input: 'hello' },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe('processed: hello');
  });

  test('应该处理不存在的工具', async () => {
    const result = await registry.execute('nonexistent', {}, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('工具不存在');
  });

  test('应该转换为 OpenAI 工具格式', () => {
    registry.register(mockToolDef, mockExecutor);
    const openaiTools = registry.toOpenAITools();
    expect(openaiTools.length).toBe(1);
    expect(openaiTools[0].type).toBe('function');
    expect(openaiTools[0].function.name).toBe('test_tool');
    expect(openaiTools[0].function.parameters.type).toBe('object');
  });

  test('应该缓存 OpenAI 工具格式', () => {
    registry.register(mockToolDef, mockExecutor);
    const first = registry.toOpenAITools();
    const second = registry.toOpenAITools();
    expect(first).toBe(second); // 同一引用
  });

  test('注册/注销后应该清除缓存', () => {
    registry.register(mockToolDef, mockExecutor);
    const first = registry.toOpenAITools();
    registry.unregister('test_tool');
    registry.register(mockToolDef, mockExecutor);
    const second = registry.toOpenAITools();
    expect(first).not.toBe(second);
  });
});

// ============ SchemaValidator 测试 ============

describe('SchemaValidator', () => {
  let validator: SchemaValidator;

  beforeEach(() => {
    validator = new SchemaValidator();
  });

  test('应该验证合法参数', () => {
    const result = validator.validate(
      { name: 'test', age: 25 },
      {
        name: { type: 'string', description: 'Name' },
        age: { type: 'number', description: 'Age' },
      },
      ['name']
    );
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.sanitizedParams.name).toBe('test');
  });

  test('应该检测缺少必填参数', () => {
    const result = validator.validate(
      {},
      {
        name: { type: 'string', description: 'Name' },
      },
      ['name']
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('缺少必填参数: name');
  });

  test('应该使用默认值', () => {
    const result = validator.validate(
      {},
      {
        limit: { type: 'number', description: 'Limit', default: 10 },
      },
      []
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedParams.limit).toBe(10);
  });

  test('应该检测类型错误', () => {
    const result = validator.validate(
      { count: 'not_a_number' },
      {
        count: { type: 'number', description: 'Count' },
      },
      ['count']
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('类型错误'))).toBe(true);
  });

  test('应该允许字符串数字转换为 number', () => {
    const result = validator.validate(
      { count: '42' },
      {
        count: { type: 'number', description: 'Count' },
      },
      ['count']
    );
    expect(result.valid).toBe(true);
  });

  test('应该验证枚举值', () => {
    const result = validator.validate(
      { status: 'invalid' },
      {
        status: {
          type: 'string',
          description: 'Status',
          enum: ['active', 'inactive'],
        },
      },
      ['status']
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(true);
  });

  test('应该允许合法枚举值', () => {
    const result = validator.validate(
      { status: 'active' },
      {
        status: {
          type: 'string',
          description: 'Status',
          enum: ['active', 'inactive'],
        },
      },
      ['status']
    );
    expect(result.valid).toBe(true);
  });
});

// ============ PermissionGuard 测试 ============

describe('PermissionGuard', () => {
  let guard: PermissionGuard;

  beforeEach(() => {
    guard = new PermissionGuard();
  });

  test('应该允许有权限的操作', () => {
    const result = guard.check(
      'memory_recall',
      [Permission.MEMORY_READ],
      'low',
      { permissions: new Set([Permission.MEMORY_READ]), metadata: {} }
    );
    expect(result.allowed).toBe(true);
    expect(result.missing.length).toBe(0);
  });

  test('应该拒绝缺少权限的操作', () => {
    const result = guard.check(
      'desktop_automate',
      [Permission.DESKTOP_CONTROL],
      'high',
      { permissions: new Set([Permission.MEMORY_READ]), metadata: {} }
    );
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain(Permission.DESKTOP_CONTROL);
  });

  test('应该授予和撤销权限', () => {
    guard.grantPermission('user1', Permission.DESKTOP_CONTROL);
    const perms = guard.getUserPermissions('user1');
    expect(perms.has(Permission.DESKTOP_CONTROL)).toBe(true);

    guard.revokePermission('user1', Permission.DESKTOP_CONTROL);
    const updatedPerms = guard.getUserPermissions('user1');
    expect(updatedPerms.has(Permission.DESKTOP_CONTROL)).toBe(false);
  });

  test('应该设置管理员权限', () => {
    guard.setAdmin('admin1');
    const perms = guard.getUserPermissions('admin1');
    expect(perms.has(Permission.SYSTEM_ADMIN)).toBe(true);
    expect(perms.has(Permission.DESKTOP_CONTROL)).toBe(true);
  });
});

// ============ registerHarnessTools 集成测试 ============

describe('registerHarnessTools', () => {
  test('应该注册 25 个工具', () => {
    const mockDeps = {
      detectEmotionFromInput: jest.fn().mockReturnValue({
        type: '平静',
        intensity: 2,
      }),
      recognizeScene: jest.fn().mockResolvedValue({
        type: '日常对话',
        context: '日常',
      }),
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
    };

    const result = registerHarnessTools(
      mockDeps as unknown as import('../../src/harness/tools/registerHarnessTools').HarnessToolDeps
    );
    expect(result.registeredCount).toBe(51);
    expect(result.toolRegistry.size).toBe(51);
  });

  test('所有工具应该能转换为 OpenAI 格式', () => {
    const mockDeps = {
      detectEmotionFromInput: jest.fn().mockReturnValue({
        type: '平静',
        intensity: 2,
      }),
      recognizeScene: jest.fn().mockResolvedValue({
        type: '日常对话',
        context: '日常',
      }),
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
    };

    const result = registerHarnessTools(
      mockDeps as unknown as import('../../src/harness/tools/registerHarnessTools').HarnessToolDeps
    );
    const openaiTools = result.toolRegistry.toOpenAITools();
    expect(openaiTools.length).toBe(51);

    for (const tool of openaiTools) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
    }
  });
});
