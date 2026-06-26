import type { ShellHookContext } from '../ShellHooks';
import { ShellHooks, registerBuiltinShellHooks } from '../ShellHooks';

describe('ShellHooks - Shell命令钩子系统', () => {
  let hooks: ShellHooks;

  beforeEach(() => {
    hooks = ShellHooks.getInstance();
    hooks['hooks'] = [];
    hooks['executionLog'] = [];
  });

  afterEach(() => {
    hooks['hooks'] = [];
    hooks['executionLog'] = [];
  });

  describe('钩子注册与管理', () => {
    test('应该成功注册前置钩子', () => {
      hooks.register('test-hook', 'pre', () => ({ proceed: true }));
      const registered = hooks.getRegisteredHooks();
      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe('test-hook');
      expect(registered[0].phase).toBe('pre');
      expect(registered[0].enabled).toBe(true);
    });

    test('应该成功注册后置钩子', () => {
      hooks.register('post-hook', 'post', () => ({ proceed: true }));
      const registered = hooks.getRegisteredHooks();
      expect(registered).toHaveLength(1);
      expect(registered[0].phase).toBe('post');
    });

    test('应该按优先级排序', () => {
      hooks.register('low-priority', 'pre', () => ({ proceed: true }), 90);
      hooks.register('high-priority', 'pre', () => ({ proceed: true }), 10);
      const registered = hooks.getRegisteredHooks();
      expect(registered[0].name).toBe('high-priority');
      expect(registered[1].name).toBe('low-priority');
    });

    test('应该支持更新同名钩子', () => {
      hooks.register('my-hook', 'pre', () => ({ proceed: true }));
      hooks.register('my-hook', 'pre', () => ({
        proceed: false,
        reason: 'updated',
      }));
      const registered = hooks.getRegisteredHooks();
      expect(registered).toHaveLength(1);
    });

    test('应该支持移除钩子', () => {
      hooks.register('to-remove', 'pre', () => ({ proceed: true }));
      hooks.unregister('to-remove');
      expect(hooks.getRegisteredHooks()).toHaveLength(0);
    });

    test('应该支持禁用/启用钩子', () => {
      hooks.register('toggle-hook', 'pre', () => ({ proceed: true }));
      hooks.disable('toggle-hook');
      expect(hooks.getRegisteredHooks()[0].enabled).toBe(false);
      hooks.enable('toggle-hook');
      expect(hooks.getRegisteredHooks()[0].enabled).toBe(true);
    });
  });

  describe('前置钩子执行', () => {
    test('所有钩子放行时应返回proceed=true', async () => {
      hooks.register('hook1', 'pre', () => ({ proceed: true }), 10);
      hooks.register('hook2', 'pre', () => ({ proceed: true }), 20);

      const context: ShellHookContext = {
        command: 'ls -la',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(true);
    });

    test('任一钩子拦截时应返回proceed=false', async () => {
      hooks.register('allow', 'pre', () => ({ proceed: true }), 10);
      hooks.register(
        'block',
        'pre',
        () => ({ proceed: false, reason: '危险命令' }),
        20
      );

      const context: ShellHookContext = {
        command: 'rm -rf /',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(false);
      expect(result.reason).toBe('危险命令');
    });

    test('应该支持修改命令', async () => {
      hooks.register('modifier', 'pre', (ctx) => ({
        proceed: true,
        modifiedCommand: ctx.command.replace(/rm/g, 'echo rm'),
      }));

      const context: ShellHookContext = {
        command: 'rm -rf /tmp/test',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(true);
      expect(result.modifiedCommand).toBe('echo rm -rf /tmp/test');
    });

    test('被禁用的钩子不应执行', async () => {
      hooks.register(
        'blocker',
        'pre',
        () => ({ proceed: false, reason: 'blocked' }),
        10
      );
      hooks.disable('blocker');

      const context: ShellHookContext = {
        command: 'ls',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(true);
    });

    test('钩子异常不应阻塞执行', async () => {
      hooks.register('error-hook', 'pre', () => {
        throw new Error('hook error');
      });

      const context: ShellHookContext = {
        command: 'ls',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(true);
    });
  });

  describe('后置钩子执行', () => {
    test('应该执行所有后置钩子', async () => {
      let postExecuted = false;
      hooks.register('post-logger', 'post', () => {
        postExecuted = true;
        return { proceed: true };
      });

      const context: ShellHookContext = {
        command: 'ls',
        backend: 'local',
        timestamp: Date.now(),
      };

      await hooks.runPostHooks(context, 0, 'output', '');
      expect(postExecuted).toBe(true);
    });
  });

  describe('内置钩子', () => {
    test('registerBuiltinShellHooks 应注册内置钩子', () => {
      registerBuiltinShellHooks();
      const registered = hooks.getRegisteredHooks();
      expect(registered.length).toBeGreaterThanOrEqual(3);

      const hookNames = registered.map((h) => h.name);
      expect(hookNames).toContain('dangerous-command-guard');
      expect(hookNames).toContain('path-traversal-guard');
      expect(hookNames).toContain('environment-injection-guard');
    });

    test('dangerous-command-guard 应拦截危险命令', async () => {
      registerBuiltinShellHooks();

      const context: ShellHookContext = {
        command: 'rm -rf /',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(false);
      expect(result.reason).toContain('危险命令拦截');
    });

    test('path-traversal-guard 应拦截路径遍历', async () => {
      registerBuiltinShellHooks();

      const context: ShellHookContext = {
        command: 'cat ../../../etc/passwd',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(false);
      expect(result.reason).toContain('路径遍历');
    });

    test('正常命令应通过所有内置钩子', async () => {
      registerBuiltinShellHooks();

      const context: ShellHookContext = {
        command: 'ls -la /workspace',
        backend: 'local',
        timestamp: Date.now(),
      };

      const result = await hooks.runPreHooks(context);
      expect(result.proceed).toBe(true);
    });
  });

  describe('执行日志', () => {
    test('应该记录钩子执行日志', async () => {
      hooks.register('logged-hook', 'pre', () => ({ proceed: true }));

      const context: ShellHookContext = {
        command: 'echo test',
        backend: 'local',
        timestamp: Date.now(),
      };

      await hooks.runPreHooks(context);
      const log = hooks.getExecutionLog();
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0].hookName).toBe('logged-hook');
    });
  });
});
