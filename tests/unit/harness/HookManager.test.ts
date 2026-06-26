import {
  HookManager,
  HookPriority,
} from '../../../src/harness/hooks/HookManager';
import type {
  HookDefinition,
  HookContext,
  HookResult,
} from '../../../src/harness/hooks/HookManager';

describe('HookManager', () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
  });

  afterEach(() => {
    manager.clear();
  });

  it('应注册和执行 beforeToolCall 钩子', async () => {
    const hook: HookDefinition = {
      id: 'test-hook',
      event: 'beforeToolCall',
      handler: async (ctx: HookContext) => {
        return {
          proceed: true,
          modifiedParams: { ...ctx.params, injected: true },
        };
      },
      priority: HookPriority.NORMAL,
    };
    manager.register(hook);

    const result = await manager.execute('beforeToolCall', {
      toolName: 'file_read',
      params: { path: '/test' },
      traceId: 'test-trace',
      loopCount: 1,
    });

    expect(result.proceed).toBe(true);
    expect(result.modifiedParams).toEqual({ path: '/test', injected: true });
  });

  it('应按优先级执行钩子（高优先级先执行）', async () => {
    const executionOrder: string[] = [];

    manager.register({
      id: 'low-hook',
      event: 'beforeToolCall',
      handler: async () => {
        executionOrder.push('low');
        return { proceed: true };
      },
      priority: HookPriority.LOW,
    });
    manager.register({
      id: 'high-hook',
      event: 'beforeToolCall',
      handler: async () => {
        executionOrder.push('high');
        return { proceed: true };
      },
      priority: HookPriority.HIGH,
    });
    manager.register({
      id: 'critical-hook',
      event: 'beforeToolCall',
      handler: async () => {
        executionOrder.push('critical');
        return { proceed: true };
      },
      priority: HookPriority.CRITICAL,
    });

    await manager.execute('beforeToolCall', {
      toolName: 'test',
      params: {},
      traceId: 't',
      loopCount: 0,
    });

    expect(executionOrder).toEqual(['critical', 'high', 'low']);
  });

  it('应支持钩子拦截（proceed: false）', async () => {
    manager.register({
      id: 'block-hook',
      event: 'beforeToolCall',
      handler: async () => ({ proceed: false, reason: '安全拦截' }),
      priority: HookPriority.CRITICAL,
    });

    const result = await manager.execute('beforeToolCall', {
      toolName: 'shell_exec',
      params: { command: 'rm -rf /' },
      traceId: 't',
      loopCount: 0,
    });

    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('安全拦截');
  });

  it('应支持 afterToolCall 钩子修改结果', async () => {
    manager.register({
      id: 'log-hook',
      event: 'afterToolCall',
      handler: async (ctx: HookContext) => ({
        proceed: true,
        modifiedResult: {
          ...(ctx.result as Record<string, unknown>),
          logged: true,
        },
      }),
      priority: HookPriority.NORMAL,
    });

    const result = await manager.execute('afterToolCall', {
      toolName: 'file_read',
      params: {},
      result: { success: true, output: 'content' },
      traceId: 't',
      loopCount: 0,
    });

    expect((result.modifiedResult as Record<string, unknown>).logged).toBe(
      true
    );
  });

  it('应支持注销钩子', async () => {
    manager.register({
      id: 'temp-hook',
      event: 'beforeToolCall',
      handler: async () => ({ proceed: false }),
      priority: HookPriority.NORMAL,
    });

    manager.unregister('temp-hook');

    const result = await manager.execute('beforeToolCall', {
      toolName: 'test',
      params: {},
      traceId: 't',
      loopCount: 0,
    });

    expect(result.proceed).toBe(true);
  });

  it('应支持 Gateway hook（日志/告警/webhook）', async () => {
    const logEntries: string[] = [];

    manager.register({
      id: 'gateway-logger',
      event: 'afterToolCall',
      handler: async (ctx: HookContext) => {
        logEntries.push(`[${ctx.toolName}] executed`);
        return { proceed: true };
      },
      priority: HookPriority.LOW,
      type: 'gateway',
    });

    await manager.execute('afterToolCall', {
      toolName: 'web_search',
      params: {},
      result: { success: true },
      traceId: 't',
      loopCount: 0,
    });

    expect(logEntries).toEqual(['[web_search] executed']);
  });

  it('无钩子时应返回 proceed: true', async () => {
    const result = await manager.execute('beforeToolCall', {
      toolName: 'test',
      params: {},
      traceId: 't',
      loopCount: 0,
    });

    expect(result.proceed).toBe(true);
  });

  it('应支持启用/禁用钩子', async () => {
    manager.register({
      id: 'disabled-hook',
      event: 'beforeToolCall',
      handler: async () => ({ proceed: false, reason: 'disabled' }),
      priority: HookPriority.CRITICAL,
    });

    manager.setEnabled('disabled-hook', false);

    const result = await manager.execute('beforeToolCall', {
      toolName: 'test',
      params: {},
      traceId: 't',
      loopCount: 0,
    });

    expect(result.proceed).toBe(true);
  });

  it('钩子执行失败不应阻断流程', async () => {
    const sideEffect: string[] = [];

    manager.register({
      id: 'failing-hook',
      event: 'beforeToolCall',
      handler: async () => {
        throw new Error('hook error');
      },
      priority: HookPriority.HIGH,
    });
    manager.register({
      id: 'normal-hook',
      event: 'beforeToolCall',
      handler: async () => {
        sideEffect.push('executed');
        return { proceed: true };
      },
      priority: HookPriority.LOW,
    });

    const result = await manager.execute('beforeToolCall', {
      toolName: 'test',
      params: {},
      traceId: 't',
      loopCount: 0,
    });

    // failing hook throws but doesn't block, normal hook still executes
    expect(result.proceed).toBe(true);
    expect(sideEffect).toContain('executed');
  });
});
