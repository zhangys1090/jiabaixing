/**
 * StepEvaluator 单元测试
 */

import {
  StepEvaluationParams,
  StepEvaluator,
} from '../../src/harness/evaluation/StepEvaluator';

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
        output:
          'Error: Something went wrong\nat Function.test (test.ts:10:5)\nat Object.<anonymous> (index.ts:20:1)',
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
        output:
          'Traceback (most recent call last):\n  File "test.py", line 10, in test\n    raise ValueError("test")',
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
