/**
 * AgentHarness 集成测试 — Phase 2
 *
 * 验证:
 * 1. 循环层（LoopController）Plan-Execute-Evaluate 完整流程
 * 2. 上下文层（ContextManager）构建上下文消息
 * 3. 循环层+上下文层+工具层协作
 * 4. processInput 端到端流程
 */

import { AgentHarness } from '../../src/harness/AgentHarness';
import type { HarnessDeps } from '../../src/harness/AgentHarness';
import { LoopState, Permission, ToolCategory } from '../../src/harness/types';
import type { ChatMessage, ToolContext } from '../../src/harness/types';

function createFullMockDeps(): HarnessDeps {
  return {
    llm: {
      chatWithTools: jest.fn().mockResolvedValue({
        content: '你好！有什么可以帮你的？',
        toolCalls: [],
      }),
      chat: jest.fn().mockResolvedValue('你好！有什么可以帮你的？'),
    },
    constitutionalBuilder: {
      buildConstitutionPrompt: jest.fn().mockResolvedValue('你是佳百星，一个智能助手。'),
    },
    memoryInjector: {
      autoRetrieveMemories: jest.fn().mockResolvedValue(['用户喜欢编程', '用户是程序员']),
    },
    dynamicContext: {
      getDynamicContext: jest.fn().mockReturnValue('当前时间: 2026-05-23 10:00，时段: 上午'),
    },
    historyProvider: {
      getAllHistory: jest.fn(),
          getRecentHistory: jest.fn().mockReturnValue([
        { role: 'user' as const, content: '你好' },
        { role: 'assistant' as const, content: '你好！' },
      ]),
    },
  };
}

function createMockToolDeps(): Record<string, unknown> {
  return {
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
  };
}

function createDepsWithToolDeps(): HarnessDeps {
  const deps = createFullMockDeps();
  (deps as unknown as Record<string, unknown>).toolDeps = createMockToolDeps();
  return deps;
}

// ============ 上下文层集成测试 ============

describe('上下文层集成', () => {
  test('应构建完整上下文消息', async () => {
    const deps = createDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager();
    expect(contextManager).not.toBeNull();

    const messages = await contextManager!.buildContext({
      text: '帮我写一个函数',
      userId: 'user-1',
    });

    expect(messages.length).toBeGreaterThan(0);

    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThan(0);

    const userMessages = messages.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThan(0);
  });

  test('应包含宪法 Prompt', async () => {
    const deps = createDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const messages = await contextManager.buildContext({ text: '你好' });

    const hasConstitutional = messages.some(
      (m) => m.role === 'system' && m.content?.includes('佳百星')
    );
    expect(hasConstitutional).toBe(true);
  });

  test('应包含动态上下文', async () => {
    const deps = createDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const messages = await contextManager.buildContext({ text: '你好' });

    const hasDynamic = messages.some(
      (m) => m.role === 'system' && m.content?.includes('当前时间')
    );
    expect(hasDynamic).toBe(true);
  });

  test('应包含记忆注入', async () => {
    const deps = createDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const messages = await contextManager.buildContext({ text: '你好' });

    const hasMemory = messages.some(
      (m) => m.role === 'system' && m.content?.includes('记忆')
    );
    expect(hasMemory).toBe(true);
  });

  test('应包含对话历史', async () => {
    const deps = createDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const messages = await contextManager.buildContext({ text: '你好' });

    const hasHistory = messages.some(
      (m) => m.role === 'user' && m.content === '你好'
    );
    expect(hasHistory).toBe(true);
  });

  test('应返回上下文条目', async () => {
    const deps = createDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    await contextManager.buildContext({ text: '你好' });

    const entries = contextManager.getEntries();
    expect(entries.length).toBeGreaterThan(0);

    const types = entries.map((e) => e.type);
    expect(types).toContain('system');
  });

  test('应返回 Token 预算分配', async () => {
    const deps = createDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const allocation = contextManager.getAllocation();

    expect(allocation.systemPrompt).toBeGreaterThan(0);
    expect(allocation.memory).toBeGreaterThan(0);
    expect(allocation.history).toBeGreaterThan(0);
    expect(allocation.reserve).toBeGreaterThan(0);
  });
});

// ============ 循环层+上下文层协作测试 ============

describe('循环层+上下文层协作', () => {
  test('全层启用后 processInput 应完成完整循环', async () => {
    const deps = createDepsWithToolDeps();

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
      useHarnessVerification: true,
      useHarnessConstraints: true,
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({
      text: '你好',
      traceId: 'test-phase2',
    });

    expect(result.response).toBeTruthy();
    expect(result.quality).toBeDefined();
    expect(result.quality.overall).toBeGreaterThan(0);
    expect(result.trace).toBeDefined();
    expect(result.trace.traceId).toBe('test-phase2');
    expect(result.trace.state).toBe(LoopState.COMPLETED);
  });

  test('简单问候应快速完成', async () => {
    const deps = createDepsWithToolDeps();

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({
      text: '你好',
    });

    expect(result.response).toBeTruthy();
    expect(result.trace.totalToolCalls).toBe(0);
  });

  test('循环应包含完整的状态转换', async () => {
    const deps = createDepsWithToolDeps();

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({
      text: '你好',
      traceId: 'state-test',
    });

    const states = result.trace.stateTransitions.map((s) => s.state);
    expect(states).toContain(LoopState.PLANNING);
    expect(states).toContain(LoopState.EXECUTING);
    expect(states).toContain(LoopState.EVALUATING);
    expect(states).toContain(LoopState.REPORTING);
    expect(states).toContain(LoopState.COMPLETED);
  });

  test('循环应记录持续时间', async () => {
    const deps = createDepsWithToolDeps();

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({
      text: '你好',
    });

    expect(result.trace.totalDuration).toBeGreaterThanOrEqual(0);
    expect(result.metadata.loopRounds).toBeGreaterThan(0);
  });
});

// ============ 上下文降级测试 ============

describe('上下文降级', () => {
  test('宪法 Prompt 构建失败时应降级', async () => {
    const deps = createDepsWithToolDeps();
    deps.constitutionalBuilder.buildConstitutionPrompt = jest.fn().mockRejectedValue(new Error('构建失败'));

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const messages = await contextManager.buildContext({ text: '你好' });

    expect(messages.length).toBeGreaterThan(0);
  });

  test('记忆注入失败时应降级', async () => {
    const deps = createDepsWithToolDeps();
    deps.memoryInjector.autoRetrieveMemories = jest.fn().mockRejectedValue(new Error('记忆不可用'));

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const messages = await contextManager.buildContext({ text: '你好' });

    expect(messages.length).toBeGreaterThan(0);
  });

  test('历史加载失败时应降级', async () => {
    const deps = createDepsWithToolDeps();
    deps.historyProvider.getRecentHistory = jest.fn().mockImplementation(() => {
      throw new Error('历史不可用');
    });

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const contextManager = harness.getContextManager()!;
    const messages = await contextManager.buildContext({ text: '你好' });

    expect(messages.length).toBeGreaterThan(0);
  });
});

// ============ 循环层错误处理测试 ============

describe('循环层错误处理', () => {
  test('LLM 不可用时应返回错误响应', async () => {
    const deps = createDepsWithToolDeps();
    deps.llm.chatWithTools = jest.fn().mockRejectedValue(new Error('LLM 不可用'));
    deps.llm.chat = jest.fn().mockRejectedValue(new Error('LLM 不可用'));

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({
      text: '你好',
    });

    expect(result.response).toBeTruthy();
    expect(result.trace.state).toBe(LoopState.FAILED);
  });
});
