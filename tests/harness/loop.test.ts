/**
 * Harness 循环层 + 上下文层 单元测试
 */

import {
  LoopController,
  Planner,
  Executor,
  Evaluator,
  Reporter,
  ContextManager,
  TokenBudgetAllocator,
  ToolRegistry,
  SchemaValidator,
  PermissionGuard,
} from '../../src/harness';
import { LoopState, Permission } from '../../src/harness/types';
import type {
  ChatMessage,
  UserInput,
  LoopContext,
  ExecutionPlan,
  QualityScore,
} from '../../src/harness/types';
import type { ExecutorOutput, EvaluatorOutput, ReporterOutput } from '../../src/harness/loop/LoopController';

// ============ Planner 测试 ============

describe('Planner', () => {
  const mockLlm = {
    chat: jest.fn().mockResolvedValue('NO'),
  };

  test('简单问候应该跳过规划', async () => {
    const planner = new Planner({ llm: mockLlm });
    const plan = await planner.plan(
      { text: '你好' },
      { messages: [], plan: null, currentStepIndex: 0, stepResults: new Map(), budget: { roundsUsed: 0, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: 0, maxDurationMs: 60000, toolCallsUsed: 0, maxToolCalls: 20 }, trace: { traceId: 'test', state: LoopState.PLANNING, stateTransitions: [], trajectory: [], totalDuration: 0, totalToolCalls: 0, budgetState: { roundsUsed: 0, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: 0, maxDurationMs: 60000, toolCallsUsed: 0, maxToolCalls: 20 } }, metadata: {} }
    );
    expect(plan.simple).toBe(true);
    expect(plan.steps.length).toBe(1);
  });

  test('复杂任务应该生成计划', async () => {
    // isComplexTask 会匹配"重构"，直接进入 generatePlan
    // generatePlan 内部调用 LLM 生成计划
    mockLlm.chat.mockResolvedValueOnce(`{
      "steps": [
        {"id": "step1", "description": "分析代码结构"},
        {"id": "step2", "description": "修改文件"}
      ],
      "dependencies": {"step2": ["step1"]},
      "estimatedRounds": 3
    }`);

    const planner = new Planner({ llm: mockLlm });
    const plan = await planner.plan(
      { text: '重构这个项目的代码结构' },
      { messages: [], plan: null, currentStepIndex: 0, stepResults: new Map(), budget: { roundsUsed: 0, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: 0, maxDurationMs: 60000, toolCallsUsed: 0, maxToolCalls: 20 }, trace: { traceId: 'test', state: LoopState.PLANNING, stateTransitions: [], trajectory: [], totalDuration: 0, totalToolCalls: 0, budgetState: { roundsUsed: 0, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: 0, maxDurationMs: 60000, toolCallsUsed: 0, maxToolCalls: 20 } }, metadata: {} }
    );
    expect(plan.steps.length).toBe(2);
    expect(plan.dependencies.has('step2')).toBe(true);
  });

  test('LLM 不可用时应降级为简单任务', async () => {
    const failingLlm = {
      chat: jest.fn().mockRejectedValue(new Error('LLM 不可用')),
    };
    const planner = new Planner({ llm: failingLlm });
    const plan = await planner.plan(
      { text: '帮我分析一下' },
      { messages: [], plan: null, currentStepIndex: 0, stepResults: new Map(), budget: { roundsUsed: 0, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: 0, maxDurationMs: 60000, toolCallsUsed: 0, maxToolCalls: 20 }, trace: { traceId: 'test', state: LoopState.PLANNING, stateTransitions: [], trajectory: [], totalDuration: 0, totalToolCalls: 0, budgetState: { roundsUsed: 0, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: 0, maxDurationMs: 60000, toolCallsUsed: 0, maxToolCalls: 20 } }, metadata: {} }
    );
    expect(plan.simple).toBe(true);
  });
});

// ============ Evaluator 测试 ============

describe('Evaluator', () => {
  test('LLM 已回复时应该标记完成', async () => {
    const evaluator = new Evaluator({});
    const result = await evaluator.evaluate(
      { text: '你好' },
      {
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好！有什么可以帮你的？' },
        ],
        plan: null,
        currentStepIndex: 0,
        stepResults: new Map(),
        budget: { roundsUsed: 1, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now(), maxDurationMs: 60000, toolCallsUsed: 2, maxToolCalls: 20 },
        trace: { traceId: 'test', state: LoopState.EVALUATING, stateTransitions: [], trajectory: [], totalDuration: 0, totalToolCalls: 2, budgetState: { roundsUsed: 1, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now(), maxDurationMs: 60000, toolCallsUsed: 2, maxToolCalls: 20 } },
        metadata: {},
      }
    );
    expect(result.goalProgress).toBe(1.0);
    expect(result.suggestedAction).toBe('continue');
  });

  test('预算超限时应建议中止', async () => {
    const evaluator = new Evaluator({});
    const result = await evaluator.evaluate(
      { text: '复杂任务' },
      {
        messages: [{ role: 'user', content: '复杂任务' }],
        plan: null,
        currentStepIndex: 0,
        stepResults: new Map(),
        budget: { roundsUsed: 8, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now(), maxDurationMs: 60000, toolCallsUsed: 20, maxToolCalls: 20 },
        trace: { traceId: 'test', state: LoopState.EVALUATING, stateTransitions: [], trajectory: [], totalDuration: 0, totalToolCalls: 20, budgetState: { roundsUsed: 8, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now(), maxDurationMs: 60000, toolCallsUsed: 20, maxToolCalls: 20 } },
        metadata: {},
      }
    );
    expect(result.suggestedAction).toBe('abort');
  });
});

// ============ Reporter 测试 ============

describe('Reporter', () => {
  test('应该提取最后一条 assistant 消息', async () => {
    const reporter = new Reporter();
    const result = await reporter.report({
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
      plan: null,
      currentStepIndex: 0,
      stepResults: new Map(),
      budget: { roundsUsed: 1, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now() - 1000, maxDurationMs: 60000, toolCallsUsed: 1, maxToolCalls: 20 },
      trace: { traceId: 'test', state: LoopState.REPORTING, stateTransitions: [], trajectory: [], totalDuration: 0, totalToolCalls: 1, budgetState: { roundsUsed: 1, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now() - 1000, maxDurationMs: 60000, toolCallsUsed: 1, maxToolCalls: 20 } },
      metadata: {},
    });
    expect(result.response).toBe('你好！');
    expect(result.quality.overall).toBeGreaterThan(0);
  });

  test('没有 assistant 消息时应返回降级响应', async () => {
    const reporter = new Reporter();
    const result = await reporter.report({
      messages: [{ role: 'user', content: '你好' }],
      plan: null,
      currentStepIndex: 0,
      stepResults: new Map(),
      budget: { roundsUsed: 1, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now() - 1000, maxDurationMs: 60000, toolCallsUsed: 1, maxToolCalls: 20 },
      trace: { traceId: 'test', state: LoopState.REPORTING, stateTransitions: [], trajectory: [], totalDuration: 0, totalToolCalls: 1, budgetState: { roundsUsed: 1, softRoundLimit: 4, hardRoundLimit: 8, tokensUsed: 0, tokenWarningLimit: 4500, tokenHardLimit: 6000, startTime: Date.now() - 1000, maxDurationMs: 60000, toolCallsUsed: 1, maxToolCalls: 20 } },
      metadata: {},
    });
    expect(result.response).toBeTruthy();
  });
});

// ============ TokenBudgetAllocator 测试 ============

describe('TokenBudgetAllocator', () => {
  test('应该按比例分配预算', () => {
    const allocator = new TokenBudgetAllocator(8000);
    const allocation = allocator.allocate();
    expect(allocation.systemPrompt).toBe(2400); // 30%
    expect(allocation.memory).toBe(1200); // 15%
    expect(allocation.history).toBe(2000); // 25%
    expect(allocation.reserve).toBe(800); // 10%
  });

  test('应该估算 Token 数', () => {
    const allocator = new TokenBudgetAllocator();
    const tokens = allocator.estimateTokens('Hello World');
    expect(tokens).toBe(6); // 11 chars / 2
  });

  test('应该按预算截断文本', () => {
    const allocator = new TokenBudgetAllocator();
    const longText = 'a'.repeat(1000);
    const truncated = allocator.truncateToBudget(longText, 100);
    expect(truncated.length).toBeLessThan(1000);
    expect(truncated).toContain('截断');
  });
});

// ============ LoopController 集成测试 ============

describe('LoopController', () => {
  test('应该完成 Plan-Execute-Evaluate 循环', async () => {
    const mockPlan: ExecutionPlan = {
      steps: [{ id: 'step1', description: '回答问题', retryCount: 0, maxRetries: 0 }],
      dependencies: new Map(),
      estimatedBudget: { maxRounds: 4, maxToolCalls: 5, maxTokens: 3000, maxDurationMs: 30000 },
      simple: true,
      toolCallMode: 'auto',
      recommendedTools: [],
    };

    const controller = new LoopController({
      planner: {
        plan: jest.fn().mockResolvedValue(mockPlan),
      },
      executor: {
        execute: jest.fn().mockResolvedValue({
          messages: [
            { role: 'system', content: '系统提示' },
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好！有什么可以帮你的？' },
          ],
          toolCallsCount: 0,
          toolDuration: 0,
          completedNaturally: true,
        } as ExecutorOutput),
      },
      evaluator: {
        evaluate: jest.fn().mockResolvedValue({
          goalProgress: 1.0,
          suggestedAction: 'continue',
          reason: 'LLM 已回复',
        } as EvaluatorOutput),
      },
      reporter: {
        report: jest.fn().mockResolvedValue({
          response: '你好！有什么可以帮你的？',
          quality: { overall: 0.9, accuracy: 0.9, usefulness: 0.9, friendliness: 0.9, efficiency: 1.0, details: '测试' },
        } as ReporterOutput),
      },
    });

    const result = await controller.run(
      { text: '你好', traceId: 'test-loop' },
      [{ role: 'system', content: '系统提示' }, { role: 'user', content: '你好' }]
    );

    expect(result.response).toBe('你好！有什么可以帮你的？');
    expect(result.quality.overall).toBe(0.9);
    expect(result.trace.traceId).toBe('test-loop');
  });
});
