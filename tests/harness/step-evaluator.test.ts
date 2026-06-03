/**
 * StepEvaluator 单元测试
 */

import { StepEvaluator, StepEvaluationParams } from '../../src/harness/evaluation/StepEvaluator';
import { Evaluator } from '../../src/harness/loop/Evaluator';
import { LoopState } from '../../src/harness/types';
import type { LoopContext, StepResult } from '../../src/harness/types';

describe('StepEvaluator', () => {
  let stepEvaluator: StepEvaluator;

  beforeEach(() => {
    stepEvaluator = new StepEvaluator();
  });

  test('成功工具调用应该返回 passed=true, score=1.0', () => {
    const params: StepEvaluationParams = {
      stepId: 'step1',
      toolName: 'test_tool',
      args: { param1: 'value1' },
      result: {
        success: true,
        output: '操作成功完成',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.issues).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  test('失败工具调用应该返回 passed=false, score=0', () => {
    const params: StepEvaluationParams = {
      stepId: 'step2',
      toolName: 'test_tool',
      args: { param1: 'value1' },
      result: {
        success: false,
        error: '工具执行失败',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe('EXECUTION_FAILED');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  test('空输出应该返回 passed=false, score=0.2', () => {
    const params: StepEvaluationParams = {
      stepId: 'step3',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: '',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.2);
    expect(result.issues[0].type).toBe('EMPTY_OUTPUT');
  });

  test('仅空白字符的输出应该返回 passed=false, score=0.2', () => {
    const params: StepEvaluationParams = {
      stepId: 'step4',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: '   \n\t  ',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.2);
    expect(result.issues[0].type).toBe('EMPTY_OUTPUT');
  });

  test('包含手机号的输出应该返回 passed=false, score=0', () => {
    const params: StepEvaluationParams = {
      stepId: 'step5',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: '用户手机号是 13812345678，请核实',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues[0].type).toBe('SENSITIVE_INFO_LEAK');
  });

  test('包含身份证号的输出应该返回 passed=false, score=0', () => {
    const params: StepEvaluationParams = {
      stepId: 'step6',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: '身份证号: 110101199001011234',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues[0].type).toBe('SENSITIVE_INFO_LEAK');
  });

  test('包含 API 密钥的输出应该返回 passed=false, score=0', () => {
    const params: StepEvaluationParams = {
      stepId: 'step7',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: 'API Key: sk-1234567890abcdefghijklmnopqrstuv',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues[0].type).toBe('SENSITIVE_INFO_LEAK');
  });

  test('包含 GitHub Token 的输出应该返回 passed=false, score=0', () => {
    const params: StepEvaluationParams = {
      stepId: 'step8',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: 'Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues[0].type).toBe('SENSITIVE_INFO_LEAK');
  });

  test('包含错误堆栈的输出应该返回 passed=false, score=0.3', () => {
    const params: StepEvaluationParams = {
      stepId: 'step9',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: 'Error: Something went wrong\nat Function.test (test.ts:10:5)\nat Object.<anonymous> (index.ts:20:1)',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.3);
    expect(result.issues[0].type).toBe('ERROR_IN_OUTPUT');
  });

  test('包含 TypeError 的输出应该返回 passed=false, score=0.3', () => {
    const params: StepEvaluationParams = {
      stepId: 'step10',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: 'TypeError: Cannot read property "name" of undefined',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.3);
    expect(result.issues[0].type).toBe('ERROR_IN_OUTPUT');
  });

  test('包含 Traceback 的输出应该返回 passed=false, score=0.3', () => {
    const params: StepEvaluationParams = {
      stepId: 'step11',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: 'Traceback (most recent call last):\n  File "test.py", line 10, in test\n    raise ValueError("test")',
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.3);
    expect(result.issues[0].type).toBe('ERROR_IN_OUTPUT');
  });

  test('JSON 格式的成功输出应该正常评估', () => {
    const params: StepEvaluationParams = {
      stepId: 'step12',
      toolName: 'test_tool',
      args: {},
      result: {
        success: true,
        output: { data: 'result', count: 42 },
      },
      timestamp: Date.now(),
    };

    const result = stepEvaluator.evaluateStep(params);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });
});

describe('Evaluator 与 StepEvaluator 集成', () => {
  const createMockContext = (stepResults: Map<string, StepResult>, hasAssistantMsg: boolean = true): LoopContext => ({
    messages: hasAssistantMsg
      ? [
          { role: 'user' as const, content: '测试任务' },
          { role: 'assistant' as const, content: '任务已完成' },
        ]
      : [
          { role: 'user' as const, content: '测试任务' },
        ],
    plan: null,
    currentStepIndex: 0,
    stepResults,
    budget: {
      roundsUsed: 1,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 100,
      tokenWarningLimit: 4500,
      tokenHardLimit: 6000,
      startTime: Date.now(),
      maxDurationMs: 60000,
      toolCallsUsed: 2,
      maxToolCalls: 20,
    },
    trace: {
      traceId: 'test-trace',
      state: LoopState.EVALUATING,
      stateTransitions: [],
      trajectory: [],
      totalDuration: 1000,
      totalToolCalls: 2,
      budgetState: {
        roundsUsed: 1,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 100,
        tokenWarningLimit: 4500,
        tokenHardLimit: 6000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: 2,
        maxToolCalls: 20,
      },
    },
    metadata: {},
  });

  test('有最终回复时应该返回 goalProgress=1.0', async () => {
    const stepResults = new Map<string, StepResult>([
      ['step1', { stepId: 'step1', success: true, output: '结果1', duration: 100, toolName: 'tool1' }],
      ['step2', { stepId: 'step2', success: true, output: '结果2', duration: 100, toolName: 'tool2' }],
      ['step3', { stepId: 'step3', success: true, output: '结果3', duration: 100, toolName: 'tool3' }],
    ]);

    const evaluator = new Evaluator({});
    const result = await evaluator.evaluate(
      { text: '测试任务' },
      createMockContext(stepResults, true)
    );

    expect(result.goalProgress).toBe(1.0);
    expect(result.suggestedAction).toBe('continue');
  });

  test('多步骤部分失败应该返回 goalProgress=0.5', async () => {
    const stepResults = new Map<string, StepResult>([
      ['step1', { stepId: 'step1', success: true, output: '结果1', duration: 100, toolName: 'tool1' }],
      ['step2', { stepId: 'step2', success: false, output: '错误', duration: 100, toolName: 'tool2', error: '执行失败' }],
      ['step3', { stepId: 'step3', success: true, output: '结果3', duration: 100, toolName: 'tool3' }],
    ]);

    const evaluator = new Evaluator({});
    const result = await evaluator.evaluate(
      { text: '测试任务' },
      createMockContext(stepResults, false)
    );

    expect(result.goalProgress).toBe(0.5);
    expect(result.suggestedAction).toBe('replan');
  });

  test('多步骤超过50%失败应该返回 goalProgress=0', async () => {
    const stepResults = new Map<string, StepResult>([
      ['step1', { stepId: 'step1', success: false, output: '错误', duration: 100, toolName: 'tool1', error: '失败' }],
      ['step2', { stepId: 'step2', success: false, output: '错误', duration: 100, toolName: 'tool2', error: '失败' }],
      ['step3', { stepId: 'step3', success: true, output: '结果3', duration: 100, toolName: 'tool3' }],
    ]);

    const evaluator = new Evaluator({});
    const result = await evaluator.evaluate(
      { text: '测试任务' },
      createMockContext(stepResults, false)
    );

    expect(result.goalProgress).toBe(0);
    expect(result.suggestedAction).toBe('abort');
  });

  test('步骤评估始终生效，失败步骤应降低 goalProgress', async () => {
    const stepResults = new Map<string, StepResult>([
      ['step1', { stepId: 'step1', success: false, output: '错误', duration: 100, toolName: 'tool1', error: '失败' }],
    ]);

    const evaluator = new Evaluator({});
    const result = await evaluator.evaluate(
      { text: '测试任务' },
      createMockContext(stepResults, false)
    );

    expect(result.goalProgress).toBe(0);
    expect(result.suggestedAction).toBe('abort');
  });

  test('空步骤结果应该使用默认评估逻辑', async () => {
    const stepResults = new Map<string, StepResult>();

    const evaluator = new Evaluator({});
    const result = await evaluator.evaluate(
      { text: '测试任务' },
      createMockContext(stepResults, false)
    );

    expect(result.goalProgress).toBeLessThanOrEqual(0.5);
    expect(result.suggestedAction).toBeTruthy();
  });

  test('每次evaluate独立——replanCount不跨调用泄漏 (C6 fix)', async () => {
    // Arrange: partial failures → should return 'replan' (within MAX_REPLAN)
    const stepResults = new Map<string, StepResult>([
      ['step1', { stepId: 'step1', success: false, output: '错误', duration: 100, toolName: 'tool1', error: '失败' }],
      ['step2', { stepId: 'step2', success: true, output: '结果2', duration: 100, toolName: 'tool2' }],
    ]);

    const evaluator = new Evaluator({});

    // First call: 2 steps, 1 failed → replan (replanCount=0<MAX_REPLAN=1)
    const result1 = await evaluator.evaluate(
      { text: '测试任务' },
      createMockContext(new Map(stepResults), false)
    );
    expect(result1.suggestedAction).toBe('replan');

    // Second call with SAME evaluator: should STILL return 'replan' because
    // C6 fix resets replanCount per invocation (no cross-call state leak)
    const result2 = await evaluator.evaluate(
      { text: '测试任务' },
      createMockContext(new Map(stepResults), false)
    );
    expect(result2.suggestedAction).toBe('replan');
    expect(result2.reason).toContain('部分工具调用失败');
  });
});
