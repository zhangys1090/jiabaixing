/**
 * Executor 错误分类与重试逻辑测试
 *
 * classifyError 和 executeWithRetry 是私有方法，
 * 通过创建 TestableExecutor 子类暴露这些方法进行测试
 */

import { Executor, type ExecutorDeps } from '../../src/harness/loop/Executor';
import { ToolRegistry } from '../../src/harness/tools/registry/ToolRegistry';
import { SchemaValidator } from '../../src/harness/tools/registry/SchemaValidator';
import { PermissionGuard } from '../../src/harness/tools/registry/PermissionGuard';
import type { ToolContext, ToolDefinition, ToolResult } from '../../src/harness/types';
import { Permission, ToolCategory } from '../../src/harness/types';

class TestableExecutor extends Executor {
  public testClassifyError(error: string): 'retryable' | 'non_retryable' {
    return (this as unknown as { classifyError: (e: string) => 'retryable' | 'non_retryable' }).classifyError.call(this, error);
  }

  public async testExecuteWithRetry(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    maxRetries: number = 2
  ): Promise<ToolResult> {
    return (this as unknown as { executeWithRetry: (n: string, a: Record<string, unknown>, c: ToolContext, m: number) => Promise<ToolResult> }).executeWithRetry.call(this, toolName, args, context, maxRetries);
  }
}

function createMockDeps(overrides?: Partial<ExecutorDeps>): ExecutorDeps {
  const mockToolRegistry = new ToolRegistry();
  const mockSchemaValidator = new SchemaValidator();
  const mockPermissionGuard = new PermissionGuard();

  return {
    llm: {
      chatWithTools: jest.fn().mockResolvedValue({ content: 'test', toolCalls: [] }),
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
      expect(executor.testClassifyError('Connection timeout')).toBe('retryable');
    });

    it('应该将 network 错误分类为可重试', () => {
      expect(executor.testClassifyError('Network error occurred')).toBe('retryable');
    });

    it('应该将 ECONNREFUSED 错误分类为可重试', () => {
      expect(executor.testClassifyError('connect ECONNREFUSED 127.0.0.1:3000')).toBe('retryable');
    });

    it('应该将 ETIMEDOUT 错误分类为可重试', () => {
      expect(executor.testClassifyError('connect ETIMEDOUT 10.0.0.1:443')).toBe('retryable');
    });

    it('应该将 503 错误分类为可重试', () => {
      expect(executor.testClassifyError('HTTP 503 Service Unavailable')).toBe('retryable');
    });

    it('应该将 429 错误分类为可重试', () => {
      expect(executor.testClassifyError('HTTP 429 Too Many Requests')).toBe('retryable');
    });

    it('应该对可重试错误不区分大小写', () => {
      expect(executor.testClassifyError('TIMEOUT')).toBe('retryable');
      expect(executor.testClassifyError('Network Error')).toBe('retryable');
    });
  });

  describe('classifyError - 不可重试错误', () => {
    it('应该将 permission 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Permission denied')).toBe('non_retryable');
    });

    it('应该将 auth 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Authentication failed')).toBe('non_retryable');
    });

    it('应该将 invalid param 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Invalid parameter value')).toBe('non_retryable');
    });

    it('应该将 not found 错误分类为不可重试', () => {
      expect(executor.testClassifyError('Resource not found')).toBe('non_retryable');
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
      expect(executor.testClassifyError('Something went wrong')).toBe('non_retryable');
    });

    it('应该将空字符串分类为不可重试', () => {
      expect(executor.testClassifyError('')).toBe('non_retryable');
    });
  });

  describe('classifyError - 优先级', () => {
    it('当错误同时包含可重试和不可重试关键词时，不可重试优先', () => {
      expect(executor.testClassifyError('Authentication timeout')).toBe('non_retryable');
    });

    it('当错误同时包含 permission 和 network 时，不可重试优先', () => {
      expect(executor.testClassifyError('permission denied for network resource')).toBe('non_retryable');
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

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

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

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

      expect(result.metadata?.retryCount).toBeUndefined();
    });
  });

  describe('executeWithRetry - 可重试错误', () => {
    it('应该在遇到可重试错误时重试', async () => {
      const executorFn = jest.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({
          success: true,
          output: 'recovered',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.output).toBe('recovered');
      expect(executorFn).toHaveBeenCalledTimes(2);
    });

    it('应该在重试成功后记录 retryCount', async () => {
      const executorFn = jest.fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue({
          success: true,
          output: 'recovered',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

      expect(result.metadata?.retryCount).toBe(1);
    });

    it('应该在达到最大重试次数后返回失败', async () => {
      const executorFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext, 2);

      expect(result.success).toBe(false);
      expect(executorFn).toHaveBeenCalledTimes(3);
    });

    it('应该在重试次数耗尽时记录 retryCount', async () => {
      const executorFn = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext, 2);

      expect(result.metadata?.retryCount).toBe(2);
    });

    it('应该支持自定义最大重试次数', async () => {
      const executorFn = jest.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({
          success: true,
          output: 'finally ok',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext, 3);

      expect(result.success).toBe(true);
      expect(result.metadata?.retryCount).toBe(2);
      expect(executorFn).toHaveBeenCalledTimes(3);
    });

    it('应该处理工具返回失败结果（非异常）的可重试错误', async () => {
      const executorFn = jest.fn()
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

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

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

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

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

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

      expect(result.metadata?.retryCount).toBe(0);
    });

    it('应该在异常为不可重试错误时立即返回', async () => {
      const executorFn = jest.fn().mockRejectedValue(new Error('Invalid parameter'));
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

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

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext);

      expect(result.success).toBe(false);
      expect(executorFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeWithRetry - retryCount 追踪', () => {
    it('应该在多次重试后正确追踪 retryCount', async () => {
      const executorFn = jest.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue({
          success: true,
          output: 'ok',
          duration: 10,
          validated: true,
        });
      toolRegistry.register(createTestToolDef('test_tool'), executorFn);

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext, 3);

      expect(result.success).toBe(true);
      expect(result.metadata?.retryCount).toBe(2);
    });

    it('应该在最终失败时正确追踪 retryCount', async () => {
      const executorFn = jest.fn()
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

      const result = await executor.testExecuteWithRetry('test_tool', { input: 'test' }, mockContext, 2);

      expect(result.success).toBe(false);
      expect(result.metadata?.retryCount).toBe(2);
    });
  });
});
