/**
 * AgentHarness 集成测试 — Phase 3 & 4
 *
 * 验证层+约束层+持久化层深度集成测试
 * 1. 验证层：工具结果验证 + 安全检查 + 质量评分 + 目标评估
 * 2. 约束层：预算控制 + 权限检查 + 安全边界 + 生命周期钩子
 * 3. 持久化层：记忆 CRUD + 对话历史 + 任务状态 + 进化指标
 * 4. 全层端到端：processInput 完整流程中各层协作
 */

import { AgentHarness } from '../../src/harness/AgentHarness';
import type { HarnessDeps } from '../../src/harness/AgentHarness';
import {
  LoopState,
  Permission,
  LifecycleEvent,
} from '../../src/harness/types';
import type { ToolContext, ToolResult } from '../../src/harness/types';

function createFullDeps(): HarnessDeps {
  return {
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
}

function createFullDepsWithToolDeps(): HarnessDeps {
  const deps = createFullDeps();
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

// ============ 验证层深度测试 ============

describe('验证层深度集成', () => {
  test('应验证成功的工具结果', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;

    const successResult: ToolResult = {
      success: true,
      output: '文件已创建',
      duration: 150,
      validated: false,
    };
    const valid = verification.validateToolResult('file_write', successResult);
    expect(valid.valid).toBe(true);
    expect(valid.sanitizedOutput).toBe('文件已创建');
    expect(valid.errors).toHaveLength(0);
  });

  test('应拒绝失败的工具结果', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;

    const failResult: ToolResult = {
      success: false,
      output: '',
      error: '权限不足',
      duration: 50,
      validated: false,
    };
    const invalid = verification.validateToolResult('file_write', failResult);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  test('应截断过长输出', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;

    const longResult: ToolResult = {
      success: true,
      output: 'x'.repeat(5000),
      duration: 100,
      validated: false,
    };
    const truncated = verification.validateToolResult('test', longResult);
    expect(truncated.valid).toBe(true);
    expect(truncated.autoFixed).toBe(true);
    expect(truncated.sanitizedOutput.length).toBeLessThan(5000);
  });

  test('应检测银行卡号泄露', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;
    const result = verification.checkOutputSafety('卡号: 6222021234567890123');
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('银行卡号 (风险: high)');
    expect(result.sanitizedOutput).toContain('[银行卡-已脱敏]');
  });

  test('应检测密码泄露', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;
    const result = verification.checkOutputSafety('密码: mysecret123');
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('密码泄露 (风险: critical)');
  });

  test('应评分质量', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;

    const highQuality = verification.scoreQuality({
      loopCount: 1,
      totalToolCalls: 1,
      totalToolDuration: 200,
      totalDuration: 500,
      completedSuccessfully: true,
    });
    expect(highQuality.overall).toBeGreaterThan(0.8);
    expect(highQuality.efficiency).toBeGreaterThan(0.8);

    const lowQuality = verification.scoreQuality({
      loopCount: 8,
      totalToolCalls: 15,
      totalToolDuration: 50000,
      totalDuration: 35000,
      completedSuccessfully: false,
    });
    expect(lowQuality.overall).toBeLessThan(highQuality.overall);
  });

  test('应评估目标达成度', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;

    const goodProgress = await verification.evaluateGoalProgress(
      '帮我写一个函数',
      '好的，这是你需要的函数：function add(a, b) { return a + b; }'
    );
    expect(goodProgress.achieved).toBe(true);
    expect(goodProgress.progress).toBeGreaterThan(0.5);

    const badProgress = await verification.evaluateGoalProgress(
      '帮我写一个函数',
      '抱歉，无法完成'
    );
    expect(badProgress.achieved).toBe(false);
  });

  test('空输出应评估为低进度', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessVerification: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const verification = harness.getVerificationService()!;
    const result = await verification.evaluateGoalProgress('帮我写代码', '');
    expect(result.achieved).toBe(false);
    expect(result.progress).toBeLessThan(0.5);
  });
});

// ============ 约束层深度测试 ============

describe('约束层深度集成', () => {
  test('预算耗尽时应发出警告', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;

    const exhausted = constraints.checkBudget({
      roundsUsed: 8,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 5500,
      tokenWarningLimit: 4500,
      tokenHardLimit: 6000,
      startTime: Date.now() - 65000,
      maxDurationMs: 60000,
      toolCallsUsed: 20,
      maxToolCalls: 20,
    });
    expect(exhausted.withinBudget).toBe(false);
    expect(exhausted.warnings.length).toBeGreaterThanOrEqual(3);
    expect(exhausted.remaining.rounds).toBe(0);
    expect(exhausted.remaining.toolCalls).toBe(0);
  });

  test('剩余预算应正确计算', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;

    const result = constraints.checkBudget({
      roundsUsed: 2,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 2000,
      tokenWarningLimit: 4500,
      tokenHardLimit: 6000,
      startTime: Date.now() - 10000,
      maxDurationMs: 60000,
      toolCallsUsed: 5,
      maxToolCalls: 20,
    });
    expect(result.withinBudget).toBe(true);
    expect(result.remaining.rounds).toBe(6);
    expect(result.remaining.tokens).toBe(4000);
    expect(result.remaining.toolCalls).toBe(15);
  });

  test('多个生命周期钩子应按序执行', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;
    const order: number[] = [];

    constraints.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => {
      order.push(1);
      return { proceed: true };
    });
    constraints.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => {
      order.push(2);
      return { proceed: true };
    });
    constraints.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => {
      order.push(3);
      return { proceed: true };
    });

    const result = await constraints.executeHooks(
      LifecycleEvent.BEFORE_TOOL_CALL,
      { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} }
    );
    expect(result.proceed).toBe(true);
    expect(order).toEqual([1, 2, 3]);
  });

  test('钩子拦截应中断后续执行', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;
    const order: number[] = [];

    constraints.registerHook(LifecycleEvent.AFTER_TOOL_CALL, async () => {
      order.push(1);
      return { proceed: false, reason: '安全拦截' };
    });
    constraints.registerHook(LifecycleEvent.AFTER_TOOL_CALL, async () => {
      order.push(2);
      return { proceed: true };
    });

    const result = await constraints.executeHooks(
      LifecycleEvent.AFTER_TOOL_CALL,
      { event: LifecycleEvent.AFTER_TOOL_CALL, metadata: {} }
    );
    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('安全拦截');
    expect(order).toEqual([1]);
  });

  test('行为约束检查应工作', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;

    const compliant = constraints.enforceBehaviorConstraint('no-unbounded-recursion', {});
    expect(compliant.compliant).toBe(true);

    const unknown = constraints.enforceBehaviorConstraint('unknown-constraint', {});
    expect(unknown.compliant).toBe(true);
  });

  test('安全边界应阻止多种危险操作', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;

    expect(constraints.checkSafetyBoundary('test', 'rm -rf /').allowed).toBe(false);
    expect(constraints.checkSafetyBoundary('test', 'del /f C:\\').allowed).toBe(false);
    expect(constraints.checkSafetyBoundary('test', 'DROP TABLE users').allowed).toBe(false);
    expect(constraints.checkSafetyBoundary('test', 'shutdown /s').allowed).toBe(false);
    expect(constraints.checkSafetyBoundary('test', 'echo hello').allowed).toBe(true);
  });

  test('输入过长应被拒绝', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;
    const result = constraints.checkSafetyBoundary('x'.repeat(10001), 'safe_action');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('注入');
  });
});

// ============ 持久化层深度测试 ============

describe('持久化层深度集成', () => {
  test('任务状态完整生命周期', async () => {
    const deps = createFullDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;

    await persistence.saveTaskState({
      taskId: 'lifecycle-1',
      userId: 'user-1',
      description: '代码生成任务',
      status: 'pending',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let task = await persistence.loadTaskState('lifecycle-1');
    expect(task!.status).toBe('pending');

    await persistence.updateTaskStatus('lifecycle-1', 'in_progress');
    task = await persistence.loadTaskState('lifecycle-1');
    expect(task!.status).toBe('in_progress');

    await persistence.updateTaskStatus('lifecycle-1', 'completed');
    task = await persistence.loadTaskState('lifecycle-1');
    expect(task!.status).toBe('completed');

    const active = await persistence.listActiveTasks();
    expect(active.find((t) => t.taskId === 'lifecycle-1')).toBeUndefined();

    const deleted = await persistence.deleteTask('lifecycle-1');
    expect(deleted).toBe(true);

    task = await persistence.loadTaskState('lifecycle-1');
    expect(task).toBeNull();
  });

  test('任务恢复上下文', async () => {
    const deps = createFullDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;

    await persistence.saveTaskState({
      taskId: 'resume-1',
      userId: 'user-1',
      description: '长时间任务',
      status: 'in_progress',
      currentStepIndex: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await persistence.updateTaskStatus('resume-1', 'paused', '在第3步暂停，需要用户确认');

    const task = await persistence.loadTaskState('resume-1');
    expect(task!.status).toBe('paused');
    expect(task!.resumeContext).toBe('在第3步暂停，需要用户确认');
  });

  test('进化指标记录和查询', async () => {
    const deps = createFullDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;

    const existingToolMetrics = persistence.getEvolutionMetrics('tool_success_rate').length;
    const existingAllMetrics = persistence.getEvolutionMetrics().length;

    for (let i = 0; i < 5; i++) {
      persistence.recordEvolutionMetric({
        metricType: 'tool_success_rate',
        value: 0.9 + i * 0.02,
        timestamp: Date.now() + i * 1000,
      });
    }

    persistence.recordEvolutionMetric({
      metricType: 'response_quality',
      value: 0.85,
      timestamp: Date.now(),
    });

    const toolMetrics = persistence.getEvolutionMetrics('tool_success_rate');
    expect(toolMetrics).toHaveLength(existingToolMetrics + 5);

    const allMetrics = persistence.getEvolutionMetrics();
    expect(allMetrics).toHaveLength(existingAllMetrics + 6);

    const limitedMetrics = persistence.getEvolutionMetrics(undefined, 3);
    expect(limitedMetrics).toHaveLength(3);
  });

  test('对话历史管理', async () => {
    const conversationMessages: Array<{ role: string; content: string }> = [];

    const deps = createFullDeps();
    (deps as unknown as Record<string, unknown>).persistenceDeps = {
      conversationHistory: {
        addUserMessage: (content: string) => conversationMessages.push({ role: 'user', content }),
        addAssistantMessage: (content: string) => conversationMessages.push({ role: 'assistant', content }),
        getRecent: (count?: number) => conversationMessages.slice(-(count || 20)),
        formatForLLM: () => conversationMessages,
        saveState: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
      },
    };

    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;

    persistence.saveConversationMessage('user', '你好');
    persistence.saveConversationMessage('assistant', '你好！有什么可以帮你的？');
    persistence.saveConversationMessage('user', '帮我写代码');

    const history = persistence.getConversationHistory();
    expect(history).toHaveLength(3);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
    expect(history[2].content).toBe('帮我写代码');
  });

  test('不存在的任务应返回 null', async () => {
    const deps = createFullDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;
    const task = await persistence.loadTaskState('nonexistent');
    expect(task).toBeNull();
  });

  test('更新不存在的任务应返回 false', async () => {
    const deps = createFullDeps();
    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const persistence = harness.getPersistenceService()!;
    const result = await persistence.updateTaskStatus('nonexistent', 'completed');
    expect(result).toBe(false);
  });
});

// ============ 全层端到端测试 ============

describe('全层端到端', () => {
  test('processInput 应经过验证+约束+持久化完整流程', async () => {
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
      text: '你好，帮我写一个Python函数',
      traceId: 'e2e-full-test',
    });

    expect(result.response).toBeTruthy();
    expect(result.quality.overall).toBeGreaterThan(0);
    expect(result.trace.state).toBe(LoopState.COMPLETED);
    expect(result.trace.traceId).toBe('e2e-full-test');

    expect(result.trace.stateTransitions.length).toBeGreaterThan(0);
    const states = result.trace.stateTransitions.map((s) => s.state);
    expect(states).toContain(LoopState.PLANNING);
    expect(states).toContain(LoopState.EXECUTING);
    expect(states).toContain(LoopState.EVALUATING);
  });

  test('全层启用后 shutdown 应正常关闭', async () => {
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
    await expect(harness.shutdown()).resolves.not.toThrow();
  });

  test('约束层应在 processInput 中生效', async () => {
    const deps = createFullDepsWithToolDeps();
    const harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
      useHarnessConstraints: true,
    });
    harness.setDeps(deps);
    await harness.initialize();

    const constraints = harness.getConstraintsService()!;
    let hookFired = false;
    constraints.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => {
      hookFired = true;
      return { proceed: true };
    });

    const processResult = await harness.processInput({ text: '你好' });

    expect(processResult.trace.state).toBe(LoopState.COMPLETED);
  });
});
