/**
 * Executor 错误分类与重试逻辑测试
 *
 * classifyError 和 executeWithRetry 是私有方法，
 * 通过创建 TestableExecutor 子类暴露这些方法进行测试
 */

import {
  Executor,
  type ErrorType,
  type ExecutorDeps,
} from '../../src/harness/loop/Executor';
import { PermissionGuard } from '../../src/harness/tools/registry/PermissionGuard';
import { SchemaValidator } from '../../src/harness/tools/registry/SchemaValidator';
import { ToolRegistry } from '../../src/harness/tools/registry/ToolRegistry';
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/harness/types';
import { Permission, ToolCategory } from '../../src/harness/types';

class TestableExecutor extends Executor {
  public testClassifyError(error: string): ErrorType {
    return (
      this as unknown as { classifyError: (e: string) => ErrorType }
    ).classifyError.call(this, error);
  }

  public testRepairToolCallArguments(
    raw: string
  ): Record<string, unknown> | null {
    return (
      this as unknown as {
        repairToolCallArguments: (r: string) => Record<string, unknown> | null;
      }
    ).repairToolCallArguments.call(this, raw);
  }

  public async testExecuteWithRetry(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    maxRetries: number = 2
  ): Promise<ToolResult> {
    return (
      this as unknown as {
        executeWithRetry: (
          n: string,
          a: Record<string, unknown>,
          c: ToolContext,
          m: number
        ) => Promise<ToolResult>;
      }
    ).executeWithRetry.call(this, toolName, args, context, maxRetries);
  }
}

function createMockDeps(overrides?: Partial<ExecutorDeps>): ExecutorDeps {
  const mockToolRegistry = new ToolRegistry();
  const mockSchemaValidator = new SchemaValidator();
  const mockPermissionGuard = new PermissionGuard();

  return {
    llm: {
      chatWithTools: jest
        .fn()
        .mockResolvedValue({ content: 'test', toolCalls: [] }),
    },
    toolRegistry: mockToolRegistry,
    schemaValidator: mockSchemaValidator,
    permissionGuard: mockPermissionGuard,
    ...overrides,
  };
}

function createTestToolDef(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    category: ToolCategory.SYSTEM,
    parameters: {
      input: { type: 'string', description: 'Test input' },
    },
    requiredParams: ['input'],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
  };
}

const mockContext: ToolContext = {
  permissions: new Set<Permission>(),
  metadata: {},
};

describe('Executor 错误分类', () => {
  let executor: TestableExecutor;

  beforeEach(() => {
    executor = new TestableExecutor(createMockDeps());
  });

  describe('classifyError - 可重试错误', () => {
    it('应该将 timeout 错误分类为可重试', () => {
      expect(executor.testClassifyError('Connection timeout')).toBe(
        'retryable'
      );
    });

    it('应该将 network 错误分类为可重试', () => {
      expect(executor.testClassifyError('Network error occurred')).toBe(
        'retryable'
      );
    });

    it('应该将 ECONNREFUSED 错误分类为可重试', () => {
      expect(
        executor.testClassifyError('connect ECONNREFUSED 127.0.0.1:3000')
      ).toBe('retryable');
    });

    it('应该将 ETIMEDOUT 错误分类为可重试', () => {
      expect(executor.testClassifyError('connect ETIMEDOUT 10.0.0.1:443')).toBe(
        'retryable'
      );
    });

    it('应该将 503 错误分类为 overloaded（P0-1 扩展）', () => {
      expect(executor.testClassifyError('HTTP 503 Service Unavailable')).toBe(
        'overloaded'
      );
    });

    it('应该将 429 错误分类为 rate_limited', () => {
      expect(executor.testClassifyError('HTTP 429 Too Many Requests')).toBe(
        'rate_limited'
      );
    });

    it('应该对可重试错误不区分大小写', () => {
      expect(executor.testClassifyError('TIMEOUT')).toBe('retryable');
      expect(executor.testClassifyError('Network Error')).toBe('retryable');
    });
  });

  describe('classifyError - 不可重试错误', () => {
    it('应该将 permission 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Permission denied')).toBe(
        'non_retryable'
      );
    });

    it('应该将 auth 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Authentication failed')).toBe(
        'non_retryable'
      );
    });

    it('应该将 invalid param 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Invalid parameter value')).toBe(
        'non_retryable'
      );
    });

    it('应该将 not found 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Resource not found')).toBe(
        'non_retryable'
      );
    });

    it('应该将权限错误(中文)分类为不可重试', () => {
      expect(executor.testClassifyError('权限不足')).toBe('non_retryable');
    });

    it('应该将认证错误(中文)分类为不可重试', () => {
      expect(executor.testClassifyError('认证失败')).toBe('non_retryable');
    });

    it('应该将参数无效(中文)分类为不可重试', () => {
      expect(executor.testClassifyError('参数无效')).toBe('non_retryable');
    });

    it('应该将未找到(中文)分类为不可重试', () => {
      expect(executor.testClassifyError('未找到资源')).toBe('non_retryable');
    });
  });

  describe('classifyError - 未知错误', () => {
    it('应该将未知错误分类为不可重试', () => {
      expect(executor.testClassifyError('Something went wrong')).toBe(
        'non_retryable'
      );
    });

    it('应该将空字符串分类为不可重试', () => {
      expect(executor.testClassifyError('')).toBe('non_retryable');
    });
  });

  describe('classifyError - 优先级', () => {
    it('当错误同时包含可重试和不可重试关键词时，不可重试优先', () => {
      expect(executor.testClassifyError('Authentication timeout')).toBe(
        'non_retryable'
      );
    });

    it('当错误同时包含 permission 和 network 时，不可重试优先', () => {
      expect(
        executor.testClassifyError('permission denied for network resource')
      ).toBe('non_retryable');
    });
  });

  // P0-1: 新增错误分类测试
  describe('classifyError - P0-1 扩展分类', () => {
    it('应该将 context length 错误分类为 context_overflow', () => {
      expect(
        executor.testClassifyError('context length exceeded the maximum')
      ).toBe('context_overflow');
    });

    it('应该将 max tokens 错误分类为 context_overflow', () => {
      expect(
        executor.testClassifyError('Request too large: max tokens 8192')
      ).toBe('context_overflow');
    });

    it('应该将上下文超限(中文)分类为 context_overflow', () => {
      expect(executor.testClassifyError('上下文超出限制')).toBe(
        'context_overflow'
      );
    });

    it('应该将 content policy 错误分类为 content_policy', () => {
      expect(
        executor.testClassifyError('content policy violation detected')
      ).toBe('content_policy');
    });

    it('应该将内容过滤(中文)分类为 content_policy', () => {
      expect(executor.testClassifyError('触发内容过滤')).toBe('content_policy');
    });

    it('应该将 402 billing 错误分类为 billing', () => {
      expect(executor.testClassifyError('HTTP 402 Payment Required')).toBe(
        'billing'
      );
    });

    it('应该将余额不足(中文)分类为 billing', () => {
      expect(executor.testClassifyError('账户余额不足')).toBe('billing');
    });

    it('应该将 404 model not found 错误分类为 model_not_found', () => {
      expect(executor.testClassifyError('model gpt-5 not found')).toBe(
        'model_not_found'
      );
    });

    it('应该将模型未找到(中文)分类为 model_not_found', () => {
      expect(executor.testClassifyError('模型 gpt-5 未找到')).toBe(
        'model_not_found'
      );
    });

    it('应该将 overloaded 错误分类为 overloaded', () => {
      expect(
        executor.testClassifyError('service overloaded, try again later')
      ).toBe('overloaded');
    });

    it('应该将过载(中文)分类为 overloaded', () => {
      expect(executor.testClassifyError('服务过载')).toBe('overloaded');
    });
  });

  // P0-2: JSON 参数修复测试
  describe('repairToolCallArguments - P0-2 JSON 修复', () => {
    it('应该修复未闭合的大括号', () => {
      const result = executor.testRepairToolCallArguments(
        '{"path": "/tmp/test"'
      );
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应该修复尾随逗号', () => {
      const result = executor.testRepairToolCallArguments('{"path": "/tmp",}');
      expect(result).toEqual({ path: '/tmp' });
    });

    it('应该修复单引号', () => {
      const result = executor.testRepairToolCallArguments(
        "{'path': '/tmp/test'}"
      );
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应该修复未加引号的键名', () => {
      const result = executor.testRepairToolCallArguments(
        '{path: "/tmp/test"}'
      );
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应该剥离代码块标记', () => {
      const result = executor.testRepairToolCallArguments(
        '```json\n{"path": "/tmp/test"}\n```'
      );
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应该转义字符串内的换行符', () => {
      const result = executor.testRepairToolCallArguments(
        '{"text": "line1\nline2"}'
      );
      expect(result).toEqual({ text: 'line1\nline2' });
    });

    it('应该提取首个 JSON 对象（去除尾随文本）', () => {
      const result = executor.testRepairToolCallArguments(
        'Here is the args: {"path": "/tmp"} done'
      );
      expect(result).toEqual({ path: '/tmp' });
    });

    it('应该修复复合错误（单引号+尾随逗号+未闭合）', () => {
      const result = executor.testRepairToolCallArguments(
        "{'path': '/tmp', 'limit': 10"
      );
      expect(result).toEqual({ path: '/tmp', limit: 10 });
    });

    it('应该对空字符串返回 null', () => {
      expect(executor.testRepairToolCallArguments('')).toBeNull();
    });

    it('应该对非 JSON 字符串返回 null', () => {
      expect(
        executor.testRepairToolCallArguments('not a json at all')
      ).toBeNull();
    });

    it('应该对有效 JSON 原样解析', () => {
      const result = executor.testRepairToolCallArguments(
        '{"path": "/tmp/test", "limit": 10}'
      );
      expect(result).toEqual({ path: '/tmp/test', limit: 10 });
    });
  });
});

describe('Executor 重试逻辑', () => {
  let executor: TestableExecutor;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    const deps = createMockDeps({ toolRegistry });
    executor = new TestableExecutor(deps);
  });

  describe('executeWithRetry - 首次成功', () => {
    it('应该在首次执行成功时不重试', async () => {
      const executorFn = jest.fn().mockResolvedValue({
        success: true,
        output: 'ok',
        duration: 10,
        validated: true,
      });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('ok');
      expect(executorFn).toHaveBeenCalledTimes(1);
    });

    it('首次成功时不应包含 retryCount 元数据', async () => {
      const executorFn = jest.fn().mockResolvedValue({
        success: true,
        output: 'ok',
        duration: 10,
        validated: true,
      });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.metadata?.retryCount).toBeUndefined();
    });
  });

  describe('executeWithRetry - 可重试错误', () => {
    it('应该在遇到可重试错误时重试', async () => {
      const executorFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({
          success: true,
          output: 'recovered',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('recovered');
      expect(executorFn).toHaveBeenCalledTimes(2);
    });

    it('应该在重试成功后记录 retryCount', async () => {
      const executorFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue({
          success: true,
          output: 'recovered',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.metadata?.retryCount).toBe(1);
    });

    it('应该在达到最大重试次数后返回失败', async () => {
      const executorFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext,
        2
      );

      expect(result.success).toBe(false);
      expect(executorFn).toHaveBeenCalledTimes(3);
    });

    it('应该在重试次数耗尽时记录 retryCount', async () => {
      const executorFn = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext,
        2
      );

      expect(result.metadata?.retryCount).toBe(2);
    });

    it('应该支持自定义最大重试次数', async () => {
      const executorFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({
          success: true,
          output: 'finally ok',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext,
        3
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.retryCount).toBe(2);
      expect(executorFn).toHaveBeenCalledTimes(3);
    });

    it('应该处理工具返回失败结果（非异常）的可重试错误', async () => {
      const executorFn = jest
        .fn()
        .mockResolvedValueOnce({
          success: false,
          output: null,
          error: 'HTTP 503 Service Unavailable',
          duration: 100,
          validated: false,
        })
        .mockResolvedValue({
          success: true,
          output: 'ok after 503',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('ok after 503');
      expect(executorFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeWithRetry - 不可重试错误', () => {
    it('应该在遇到不可重试错误时立即返回', async () => {
      const executorFn = jest.fn().mockResolvedValue({
        success: false,
        output: null,
        error: 'Permission denied',
        duration: 10,
        validated: false,
      });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
      expect(executorFn).toHaveBeenCalledTimes(1);
    });

    it('应该在不可重试错误结果中记录 retryCount', async () => {
      const executorFn = jest.fn().mockResolvedValue({
        success: false,
        output: null,
        error: 'Authentication failed',
        duration: 10,
        validated: false,
      });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.metadata?.retryCount).toBe(0);
    });

    it('应该在异常为不可重试错误时立即返回', async () => {
      const executorFn = jest
        .fn()
        .mockRejectedValue(new Error('Invalid parameter'));
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(executorFn).toHaveBeenCalledTimes(1);
    });

    it('应该处理中文不可重试错误', async () => {
      const executorFn = jest.fn().mockResolvedValue({
        success: false,
        output: null,
        error: '权限不足',
        duration: 10,
        validated: false,
      });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(executorFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeWithRetry - retryCount 追踪', () => {
    it('应该在多次重试后正确追踪 retryCount', async () => {
      const executorFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue({
          success: true,
          output: 'ok',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext,
        3
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.retryCount).toBe(2);
    });

    it('应该在最终失败时正确追踪 retryCount', async () => {
      const executorFn = jest
        .fn()
        .mockResolvedValueOnce({
          success: false,
          output: null,
          error: 'HTTP 429 Too Many Requests',
          duration: 10,
          validated: false,
        })
        .mockResolvedValueOnce({
          success: false,
          output: null,
          error: 'HTTP 503 Service Unavailable',
          duration: 10,
          validated: false,
        })
        .mockResolvedValue({
          success: false,
          output: null,
          error: 'HTTP 503 Service Unavailable',
          duration: 10,
          validated: false,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry(
        'test_tool',
        { input: 'test' },
        mockContext,
        2
      );

      expect(result.success).toBe(false);
      expect(result.metadata?.retryCount).toBe(2);
    });
  });
});
