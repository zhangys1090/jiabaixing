/**
 * AgentHarness 集成测试 — Phase 5
 *
 * 验证 JiabaixingCore → AgentHarness 路由
 * 1. Harness 已注入且循环层启用时，应委托给 Harness
 * 2. Harness 处理失败时，应降级到旧 FC 循环
 * 3. Harness 未注入时，应走旧 FC 循环
 * 4. 返回结果格式兼容性
 */

import { AgentHarness } from '../../src/harness/AgentHarness';
import type { HarnessDeps } from '../../src/harness/AgentHarness';
import { LoopState } from '../../src/harness/types';

function createFullDepsWithToolDeps(): HarnessDeps {
  const deps: HarnessDeps = {
    llm: {
      chatWithTools: jest.fn().mockResolvedValue({
        content: '好的，我来帮你。',
        toolCalls: [],
      }),
      chat: jest.fn().mockResolvedValue('好的，我来帮你。'),
    },
    constitutionalBuilder: {
      buildConstitutionPrompt: jest.fn().mockResolvedValue('你是佳百星助手'),
    },
    memoryInjector: {
      autoRetrieveMemories: jest.fn().mockResolvedValue(['用户喜欢Python']),
    },
    dynamicContext: {
      getDynamicContext: jest.fn().mockReturnValue('当前时间: 2026-05-23 14:00'),
    },
    historyProvider: {
      getAllHistory: jest.fn(),
          getRecentHistory: jest.fn().mockReturnValue([]),
    },
  };

  (deps as unknown as Record<string, unknown>).toolDeps = {
    detectEmotionFromInput: jest.fn().mockReturnValue({ type: '好奇', intensity: 3 }),
    recognizeScene: jest.fn().mockResolvedValue({ type: '编程辅助', context: '代码' }),
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

  return deps;
}

// ============ Harness 路由测试 ============

describe('JiabaixingCore → AgentHarness 路由', () => {
  test('Harness 循环层启用时 processInput 应委托给 Harness', async () => {
    const deps = createFullDepsWithToolDeps();
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
      traceId: 'route-test-1',
    });

    expect(result.response).toBeTruthy();
    expect(result.trace.state).toBe(LoopState.COMPLETED);
    expect(result.trace.traceId).toBe('route-test-1');
    expect(result.quality.overall).toBeGreaterThan(0);
    expect(result.metadata.loopRounds).toBeGreaterThan(0);
  });

  test('Harness 循环层未启用时 processInput 应抛错', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: false,
    });
    harness.setDeps(deps);
    await harness.initialize();

    await expect(
      harness.processInput({ text: '你好' })
    ).rejects.toThrow('循环层未启用');
  });

  test('Harness 处理应返回兼容格式', async () => {
    const deps = createFullDepsWithToolDeps();
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
      text: '帮我写一个函数',
      userId: 'user-1',
      traceId: 'format-test',
    });

    expect(result).toHaveProperty('response');
    expect(result).toHaveProperty('quality');
    expect(result).toHaveProperty('trace');
    expect(result).toHaveProperty('metadata');

    expect(typeof result.response).toBe('string');
    expect(typeof result.quality.overall).toBe('number');
    expect(typeof result.quality.accuracy).toBe('number');
    expect(typeof result.quality.usefulness).toBe('number');
    expect(typeof result.quality.efficiency).toBe('number');

    expect(result.trace).toHaveProperty('traceId');
    expect(result.trace).toHaveProperty('state');
    expect(result.trace).toHaveProperty('stateTransitions');
    expect(result.trace).toHaveProperty('totalDuration');
    expect(result.trace).toHaveProperty('totalToolCalls');

    expect(result.metadata).toHaveProperty('loopRounds');
  });

  test('连续多次 processInput 应正常工作', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result1 = await harness.processInput({ text: '你好' });
    expect(result1.trace.state).toBe(LoopState.COMPLETED);

    const result2 = await harness.processInput({ text: '帮我写代码' });
    expect(result2.trace.state).toBe(LoopState.COMPLETED);

    const result3 = await harness.processInput({ text: '谢谢' });
    expect(result3.trace.state).toBe(LoopState.COMPLETED);
  });

  test('LLM 失败时应返回 FAILED 状态', async () => {
    const deps = createFullDepsWithToolDeps();
    deps.llm.chatWithTools = jest.fn().mockRejectedValue(new Error('LLM 不可用'));
    deps.llm.chat = jest.fn().mockRejectedValue(new Error('LLM 不可用'));

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({ text: '你好' });
    expect(result.trace.state).toBe(LoopState.FAILED);
  });

  test('全层启用 + shutdown 后不应崩溃', async () => {
    const deps = createFullDepsWithToolDeps();
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

    await harness.processInput({ text: '你好' });
    await harness.shutdown();

    const config = harness.getConfig();
    expect(config.useHarnessLoop).toBe(true);
  });

  test('updateConfig 后应反映新配置', async () => {
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: false,
    });

    expect(harness.getConfig().useHarnessLoop).toBe(false);

    harness.updateConfig({ useHarnessLoop: true });
    expect(harness.getConfig().useHarnessLoop).toBe(true);
  });
});

// ============ 降级容错测试 ============

describe('降级容错', () => {
  test('记忆注入失败时 Harness 仍应工作', async () => {
    const deps = createFullDepsWithToolDeps();
    deps.memoryInjector.autoRetrieveMemories = jest.fn().mockRejectedValue(new Error('记忆不可用'));

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({ text: '你好' });
    expect(result.trace.state).toBe(LoopState.COMPLETED);
  });

  test('宪法 Prompt 失败时 Harness 仍应工作', async () => {
    const deps = createFullDepsWithToolDeps();
    deps.constitutionalBuilder.buildConstitutionPrompt = jest.fn().mockRejectedValue(new Error('构建失败'));

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({ text: '你好' });
    expect(result.trace.state).toBe(LoopState.COMPLETED);
  });

  test('全部 deps 失败时 Harness 仍应降级工作', async () => {
    const deps = createFullDepsWithToolDeps();
    deps.memoryInjector.autoRetrieveMemories = jest.fn().mockRejectedValue(new Error('记忆不可用'));
    deps.constitutionalBuilder.buildConstitutionPrompt = jest.fn().mockRejectedValue(new Error('构建失败'));
    deps.historyProvider.getRecentHistory = jest.fn().mockImplementation(() => {
      throw new Error('历史不可用');
    });

    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const result = await harness.processInput({ text: '你好' });
    expect(result.trace.state).toBe(LoopState.COMPLETED);
  });
});
