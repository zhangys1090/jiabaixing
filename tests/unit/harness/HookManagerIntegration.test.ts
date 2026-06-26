/**
 * HookManager ↔ ConstraintsService 集成测试
 *
 * 验证 ConstraintsService 在注入 HookManager 后，
 * registerHook/executeHooks 正确委托给 HookManager 统一管理，
 * 同时保持向后兼容（未注入时回退本地）。
 */
import { ConstraintsService } from '../../../src/harness/constraints/ConstraintsService';
import {
  HookManager,
  HookPriority,
} from '../../../src/harness/hooks/HookManager';
import { LifecycleEvent } from '../../../src/harness/types';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const fakePermissionGuard = {
  check: jest.fn().mockReturnValue({ allowed: true, missing: [] }),
};

describe('HookManager ↔ ConstraintsService 集成', () => {
  it('注入 HookManager 后 registerHook 委托给它', () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    const hook = jest.fn().mockResolvedValue({ proceed: true });
    service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook);

    expect(hookManager.getHooks('beforeToolCall')).toHaveLength(1);
  });

  it('executeHooks 通过 HookManager 执行并返回 proceed', async () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    const hook = jest.fn().mockResolvedValue({ proceed: true });
    service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook);

    const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, {
      event: LifecycleEvent.BEFORE_TOOL_CALL,
      toolName: 'file_write',
      params: { path: '/test' },
      metadata: {},
    });

    expect(result.proceed).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('钩子拦截时 executeHooks 返回 proceed=false', async () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => ({
      proceed: false,
      reason: '安全拦截',
    }));

    const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, {
      event: LifecycleEvent.BEFORE_TOOL_CALL,
      toolName: 'shell_exec',
      params: { command: 'rm -rf /' },
      metadata: {},
    });

    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('安全拦截');
  });

  it('beforeToolCall 钩子可修改参数', async () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async (ctx) => ({
      proceed: true,
      modifiedParams: { ...ctx.params, injected: true },
    }));

    const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, {
      event: LifecycleEvent.BEFORE_TOOL_CALL,
      toolName: 'file_write',
      params: { path: '/test' },
      metadata: {},
    });

    expect(result.proceed).toBe(true);
    expect(result.modifiedParams).toEqual({ path: '/test', injected: true });
  });

  it('afterToolCall 钩子可提供替代结果', async () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    service.registerHook(LifecycleEvent.AFTER_TOOL_CALL, async () => ({
      proceed: false,
      replacementResult: {
        success: true,
        output: '替代结果',
        duration: 0,
        validated: true,
      },
      reason: '钩子替换',
    }));

    const result = await service.executeHooks(LifecycleEvent.AFTER_TOOL_CALL, {
      event: LifecycleEvent.AFTER_TOOL_CALL,
      toolName: 'file_read',
      metadata: {},
    });

    expect(result.proceed).toBe(false);
    expect(result.replacementResult).toMatchObject({
      success: true,
      output: '替代结果',
    });
  });

  it('未注入 HookManager 时回退本地执行（向后兼容）', async () => {
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
    });

    const hook = jest.fn().mockResolvedValue({ proceed: true });
    service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook);

    const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, {
      event: LifecycleEvent.BEFORE_TOOL_CALL,
      toolName: 'file_read',
      params: {},
      metadata: {},
    });

    expect(result.proceed).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('onError 事件正确映射到 onToolError', async () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    const hook = jest.fn().mockResolvedValue({ proceed: true });
    service.registerHook(LifecycleEvent.ON_ERROR, hook);

    expect(hookManager.getHooks('onToolError')).toHaveLength(1);

    await service.executeHooks(LifecycleEvent.ON_ERROR, {
      event: LifecycleEvent.ON_ERROR,
      toolName: 'file_write',
      metadata: { error: '写入失败' },
    });

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('Gateway 钩子与 Lifecycle 钩子共存于同一 HookManager', async () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    const gatewayCalls: string[] = [];
    hookManager.register({
      id: 'gateway-logger',
      event: 'afterToolCall',
      handler: async (ctx) => {
        gatewayCalls.push(ctx.toolName ?? 'unknown');
        return { proceed: true };
      },
      priority: HookPriority.LOW,
      type: 'gateway',
    });

    const lifecycleCalls: string[] = [];
    service.registerHook(LifecycleEvent.AFTER_TOOL_CALL, async (ctx) => {
      lifecycleCalls.push(ctx.toolName ?? 'unknown');
      return { proceed: true };
    });

    await service.executeHooks(LifecycleEvent.AFTER_TOOL_CALL, {
      event: LifecycleEvent.AFTER_TOOL_CALL,
      toolName: 'web_search',
      metadata: {},
    });

    expect(gatewayCalls).toEqual(['web_search']);
    expect(lifecycleCalls).toEqual(['web_search']);
  });

  it('不可映射的事件（如 ON_PLAN_CREATED）回退本地执行', async () => {
    const hookManager = new HookManager();
    const service = new ConstraintsService({
      permissionGuard: fakePermissionGuard,
      hookManager,
    });

    const hook = jest.fn().mockResolvedValue({ proceed: true });
    service.registerHook(LifecycleEvent.ON_PLAN_CREATED, hook);

    const result = await service.executeHooks(LifecycleEvent.ON_PLAN_CREATED, {
      event: LifecycleEvent.ON_PLAN_CREATED,
      metadata: {},
    });

    expect(result.proceed).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hookManager.getHooks()).toHaveLength(0);
  });
});
