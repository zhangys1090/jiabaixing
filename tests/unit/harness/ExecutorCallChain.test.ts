/**
 * Executor 集成调用链测试 — 验证方法在正确时机被调用
 *
 * 核心问题：ToolResilience.test.ts 只验证方法返回值正确性，
 * 但没验证 attemptRuleBasedParamFix / TOOL_ALTERNATIVES 在 executeWithRetry 中被调用。
 * 本测试验证：方法不仅返回值正确，而且在正确的时机被调用。
 *
 * 关键发现：
 * - L2 attemptRuleBasedParamFix 只在 retryable 错误的重试路径中被调用
 * - L4 降级替代在 non_retryable 错误时也会被调用（在返回路径中）
 * - L1 classifyError/calculateBackoff 只在 retryable 错误的重试路径中被调用
 */

import { Executor } from '../../../src/harness/loop/Executor';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function createMockToolRegistry(
  responses: Array<{
    success: boolean;
    output?: string | null;
    error?: string;
    duration?: number;
  }>
) {
  let callIndex = 0;
  return {
    execute: jest.fn().mockImplementation(() => {
      const resp = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return Promise.resolve({
        success: resp.success,
        output: resp.output ?? (resp.success ? 'ok' : null),
        error: resp.error ?? '',
        duration: resp.duration ?? 100,
        validated: false,
      });
    }),
    get: jest.fn(),
    getRegisteredToolNames: jest.fn().mockReturnValue([]),
    getReliabilityTracker: jest.fn().mockReturnValue({
      getUnreliableTools: jest.fn().mockReturnValue([]),
    }),
  };
}

describe('Executor 集成调用链', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CHAIN-1: L2 attemptRuleBasedParamFix 在 retryable 错误的重试路径中被调用', () => {
    it('retryable 错误重试时应调用 attemptRuleBasedParamFix 尝试修正参数', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT timeout reading file' },
        { success: true, output: '文件内容' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'attemptRuleBasedParamFix');

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'file_read',
        { path: '/test/file.txt' },
        'ETIMEDOUT timeout reading file'
      );

      expect(registry.execute).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    it('工具成功时不应调用 attemptRuleBasedParamFix', async () => {
      const registry = createMockToolRegistry([
        { success: true, output: '成功' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'attemptRuleBasedParamFix');

      await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(spy).not.toHaveBeenCalled();
    });

    it('non_retryable 错误不应调用 attemptRuleBasedParamFix（直接走 L4 降级）', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'attemptRuleBasedParamFix');

      await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(spy).not.toHaveBeenCalled();
    });

    it('retryable 错误但 attemptRuleBasedParamFix 返回 null 时参数不变', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT' },
        { success: true, output: '成功' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'attemptRuleBasedParamFix');

      await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(spy).toHaveBeenCalled();

      const secondCallArgs = registry.execute.mock.calls[1][1];
      expect(secondCallArgs.path).toBe('/test/file.txt');
    });
  });

  describe('CHAIN-2: L4 TOOL_ALTERNATIVES 在 non_retryable 或重试耗尽后被调用', () => {
    it('non_retryable 错误应直接尝试 TOOL_ALTERNATIVES 中的替代工具', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
        { success: true, output: '通过 file_search 找到文件' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(registry.execute).toHaveBeenCalledTimes(2);

      const secondCallArgs = registry.execute.mock.calls[1];
      expect(secondCallArgs[0]).toBe('file_search');

      expect(result.success).toBe(true);
      expect(result.metadata.fallbackFrom).toBe('file_read');
      expect(result.metadata.fallbackReason).toBeDefined();
    });

    it('第一个替代工具失败时应尝试第二个替代工具', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
        { success: false, error: 'not found' },
        { success: true, output: '通过 shell_exec cat 读取文件' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(registry.execute).toHaveBeenCalledTimes(3);

      const calls = registry.execute.mock.calls;
      expect(calls[0][0]).toBe('file_read');
      expect(calls[1][0]).toBe('file_search');
      expect(calls[2][0]).toBe('shell_exec');

      expect(result.success).toBe(true);
      expect(result.metadata.fallbackFrom).toBe('file_read');
    });

    it('所有替代工具也失败时应返回失败结果', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
        { success: false, error: 'not found' },
        { success: false, error: 'not found' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(result.success).toBe(false);
    });

    it('无替代工具映射的工具不应尝试降级', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      await (executor as any).executeWithRetry(
        'custom_tool_no_alternatives',
        { param: 'value' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(registry.execute).toHaveBeenCalledTimes(1);
    });

    it('retryable 错误重试耗尽后也应尝试 TOOL_ALTERNATIVES', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT' },
        { success: false, error: 'ETIMEDOUT' },
        { success: true, output: '通过 file_search 找到' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        1
      );

      expect(registry.execute).toHaveBeenCalledTimes(3);

      const calls = registry.execute.mock.calls;
      expect(calls[0][0]).toBe('file_read');
      expect(calls[1][0]).toBe('file_read');
      expect(calls[2][0]).toBe('file_search');

      expect(result.success).toBe(true);
      expect(result.metadata.fallbackFrom).toBe('file_read');
    });
  });

  describe('CHAIN-3: L1 classifyError/calculateBackoff 在 retryable 错误的重试路径中被调用', () => {
    it('retryable 错误时应调用 classifyError 和 calculateBackoff', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT connection timeout' },
        { success: true, output: '成功' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const classifySpy = jest.spyOn(executor as any, 'classifyError');
      const backoffSpy = jest.spyOn(executor as any, 'calculateBackoff');

      await (executor as any).executeWithRetry(
        'web_fetch',
        { url: 'https://example.com' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(classifySpy).toHaveBeenCalledWith('ETIMEDOUT connection timeout');
      expect(backoffSpy).toHaveBeenCalledWith('retryable', 1);
    });

    it('rate_limited 错误应使用 rate_limited 退避策略', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: '429 Too Many Requests' },
        { success: true, output: '成功' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const backoffSpy = jest.spyOn(executor as any, 'calculateBackoff');

      await (executor as any).executeWithRetry(
        'web_search',
        { query: 'test' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(backoffSpy).toHaveBeenCalledWith('rate_limited', 1);
    });

    it('non_retryable 错误不应调用 calculateBackoff', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const backoffSpy = jest.spyOn(executor as any, 'calculateBackoff');

      await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(backoffSpy).not.toHaveBeenCalled();
    });
  });

  describe('CHAIN-4: StrategyAdjuster.recordSignal 在工具执行时被调用', () => {
    it('工具成功时 recordSignal 应被调用（signalType=positive）', async () => {
      const mockStrategyAdjuster = {
        recordSignal: jest.fn(),
        getAdjustedToolPriority: jest.fn().mockReturnValue([]),
        getAdjustedReflectionConfig: jest.fn().mockReturnValue({
          enableDeepReflection: true,
          maxRetries: 2,
        }),
      };

      const registry = createMockToolRegistry([
        { success: true, output: '成功' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
        strategyAdjuster: mockStrategyAdjuster as any,
      });

      await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(mockStrategyAdjuster.recordSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          signalType: 'positive',
          toolName: 'file_read',
        })
      );
    });

    it('工具失败且不可重试时 recordSignal 应被调用（signalType=negative）', async () => {
      const mockStrategyAdjuster = {
        recordSignal: jest.fn(),
        getAdjustedToolPriority: jest.fn().mockReturnValue([]),
        getAdjustedReflectionConfig: jest.fn().mockReturnValue({
          enableDeepReflection: true,
          maxRetries: 2,
        }),
      };

      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
        strategyAdjuster: mockStrategyAdjuster as any,
      });

      await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(mockStrategyAdjuster.recordSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          signalType: 'negative',
          toolName: 'file_read',
        })
      );
    });
  });

  describe('CHAIN-5: L1-L4 完整韧性金字塔调用链', () => {
    it('L1退避→L2参数修正→重试成功：retryable错误+路径修正', async () => {
      const registry = createMockToolRegistry([
        {
          success: false,
          error: 'ETIMEDOUT reading C:\\Users\\test\\file.txt',
        },
        { success: true, output: '文件内容' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const classifySpy = jest.spyOn(executor as any, 'classifyError');
      const paramFixSpy = jest.spyOn(
        executor as any,
        'attemptRuleBasedParamFix'
      );
      const backoffSpy = jest.spyOn(executor as any, 'calculateBackoff');

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: 'C:\\Users\\test\\file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(classifySpy).toHaveBeenCalled();
      expect(paramFixSpy).toHaveBeenCalled();
      expect(backoffSpy).toHaveBeenCalled();

      expect(result.success).toBe(true);

      const secondCallArgs = registry.execute.mock.calls[1][1];
      expect(secondCallArgs.path).toBe('C:/Users/test/file.txt');
    });

    it('L1退避→L2修正失败→L4降级成功：retryable错误+无匹配规则+替代工具', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT' },
        { success: false, error: 'ETIMEDOUT' },
        { success: true, output: '通过 file_search 找到文件' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const classifySpy = jest.spyOn(executor as any, 'classifyError');
      const paramFixSpy = jest.spyOn(
        executor as any,
        'attemptRuleBasedParamFix'
      );

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        1
      );

      expect(classifySpy).toHaveBeenCalled();
      expect(paramFixSpy).toHaveBeenCalled();

      expect(registry.execute.mock.calls[2][0]).toBe('file_search');

      expect(result.success).toBe(true);
      expect(result.metadata.fallbackFrom).toBe('file_read');
    });

    it('non_retryable→L4降级：跳过L1/L2直接走降级路径', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'permission denied' },
        { success: true, output: '通过 file_search 找到文件' },
      ]);

      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const classifySpy = jest.spyOn(executor as any, 'classifyError');
      const paramFixSpy = jest.spyOn(
        executor as any,
        'attemptRuleBasedParamFix'
      );
      const backoffSpy = jest.spyOn(executor as any, 'calculateBackoff');

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 },
        0
      );

      expect(classifySpy).toHaveBeenCalled();
      expect(paramFixSpy).not.toHaveBeenCalled();
      expect(backoffSpy).not.toHaveBeenCalled();

      expect(registry.execute.mock.calls[1][0]).toBe('file_search');

      expect(result.success).toBe(true);
      expect(result.metadata.fallbackFrom).toBe('file_read');
    });
  });

  describe('CHAIN-6: L3 attemptLLMParamFix 在 L2 修正失败后被调用', () => {
    it('L2修正失败+LLM可用时应调用 attemptLLMParamFix', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT timeout reading file' },
        { success: true, output: '文件内容' },
      ]);

      const mockLLM = {
        chatWithTools: jest.fn().mockResolvedValue({
          content: '{"path": "/corrected/path.txt"}',
        }),
      };

      const executor = new Executor({
        llm: mockLLM,
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const llmFixSpy = jest.spyOn(executor as any, 'attemptLLMParamFix');
      const ruleFixSpy = jest.spyOn(
        executor as any,
        'attemptRuleBasedParamFix'
      );

      const result = await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(ruleFixSpy).toHaveBeenCalledTimes(1);
      expect(llmFixSpy).toHaveBeenCalledTimes(1);
      expect(llmFixSpy).toHaveBeenCalledWith(
        'file_read',
        { path: '/test/file.txt' },
        'ETIMEDOUT timeout reading file',
        'retryable'
      );

      expect(result.success).toBe(true);
    });

    it('L2修正成功时不应调用 attemptLLMParamFix', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT reading C:\\Users\\file.txt' },
        { success: true, output: '文件内容' },
      ]);

      const mockLLM = {
        chatWithTools: jest.fn().mockResolvedValue({
          content: '{"path": "/corrected/path.txt"}',
        }),
      };

      const executor = new Executor({
        llm: mockLLM,
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const llmFixSpy = jest.spyOn(executor as any, 'attemptLLMParamFix');

      await (executor as any).executeWithRetry(
        'file_read',
        { path: 'C:\\Users\\file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(llmFixSpy).not.toHaveBeenCalled();
    });

    it('LLM不可用时不应调用 attemptLLMParamFix', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'ETIMEDOUT timeout' },
        { success: true, output: '文件内容' },
      ]);

      const executor = new Executor({
        llm: undefined as any,
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const llmFixSpy = jest.spyOn(executor as any, 'attemptLLMParamFix');

      await (executor as any).executeWithRetry(
        'file_read',
        { path: '/test/file.txt' },
        { traceId: 'test', loopCount: 0 }
      );

      expect(llmFixSpy).not.toHaveBeenCalled();
    });

    it('L3 LLM修正成功后应使用修正参数重试', async () => {
      const registry = createMockToolRegistry([
        { success: false, error: 'invalid parameter: depth must be positive' },
        { success: true, output: '搜索结果' },
      ]);

      const mockLLM = {
        chatWithTools: jest.fn().mockResolvedValue({
          content: '{"depth": 3}',
        }),
      };

      const executor = new Executor({
        llm: mockLLM,
        toolRegistry: registry as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const result = await (executor as any).attemptLLMParamFix(
        'file_search',
        { pattern: '*.log', depth: -1 },
        'invalid parameter: depth must be positive',
        'retryable'
      );

      expect(result).not.toBeNull();
      expect(result).toEqual({ depth: 3 });
      expect(mockLLM.chatWithTools).toHaveBeenCalledTimes(1);
    });
  });

  describe('CHAIN-7: suggestStepAdjustment 在 shouldReplan 中被调用', () => {
    it('轮次耗尽时 shouldReplan 应调用 suggestStepAdjustment', () => {
      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: createMockToolRegistry([]) as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'suggestStepAdjustment');

      const result = executor.shouldReplan(
        [{ score: 0.3, isSufficient: false }],
        8
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({
        stepResult: { success: false },
        remainingSteps: [],
        loopCount: 8,
      });
      expect(result.shouldReplan).toBe(true);
      expect(result.adjustmentHint).toBeDefined();
    });

    it('最近一步失败时 shouldReplan 应调用 suggestStepAdjustment', () => {
      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: createMockToolRegistry([]) as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'suggestStepAdjustment');

      const result = executor.shouldReplan(
        [{ score: 0, isSufficient: false }],
        2
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.shouldReplan).toBe(true);
      expect(result.adjustmentHint).toBeDefined();
    });

    it('连续低质量时 shouldReplan 应调用 suggestStepAdjustment', () => {
      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: createMockToolRegistry([]) as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'suggestStepAdjustment');

      const result = executor.shouldReplan(
        [
          { score: 0.2, isSufficient: false },
          { score: 0.3, isSufficient: false },
          { score: 0.1, isSufficient: false },
        ],
        3
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.shouldReplan).toBe(true);
      expect(result.adjustmentHint).toBeDefined();
    });

    it('执行正常时 shouldReplan 不应调用 suggestStepAdjustment', () => {
      const executor = new Executor({
        llm: { chatWithTools: jest.fn() },
        toolRegistry: createMockToolRegistry([]) as any,
        schemaValidator: {} as any,
        permissionGuard: {} as any,
      });

      const spy = jest.spyOn(executor as any, 'suggestStepAdjustment');

      const result = executor.shouldReplan(
        [{ score: 0.9, isSufficient: true }],
        2
      );

      expect(spy).not.toHaveBeenCalled();
      expect(result.shouldReplan).toBe(false);
    });
  });
});
