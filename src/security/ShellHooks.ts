import { Logger } from '../utils/Logger';

export interface ShellHookContext {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  userId?: string;
  backend: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ShellHookResult {
  proceed: boolean;
  modifiedCommand?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type ShellHookFn = (
  context: ShellHookContext
) => ShellHookResult | Promise<ShellHookResult>;

export interface ShellHookEntry {
  name: string;
  phase: 'pre' | 'post';
  priority: number;
  enabled: boolean;
  fn: ShellHookFn;
}

export class ShellHooks {
  private static instance: ShellHooks | null = null;
  private hooks: ShellHookEntry[] = [];
  private executionLog: Array<{
    hookName: string;
    command: string;
    result: ShellHookResult;
    timestamp: number;
  }> = [];

  public static getInstance(): ShellHooks {
    if (!ShellHooks.instance) {
      ShellHooks.instance = new ShellHooks();
    }
    return ShellHooks.instance;
  }

  public register(
    name: string,
    phase: 'pre' | 'post',
    fn: ShellHookFn,
    priority: number = 50
  ): void {
    const existing = this.hooks.findIndex(
      (h) => h.name === name && h.phase === phase
    );
    if (existing >= 0) {
      this.hooks[existing] = { name, phase, priority, enabled: true, fn };
      Logger.info(`🔄 Shell钩子已更新: ${name} (${phase})`, 'ShellHooks');
    } else {
      this.hooks.push({ name, phase, priority, enabled: true, fn });
      Logger.info(`✅ Shell钩子已注册: ${name} (${phase})`, 'ShellHooks');
    }

    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  public unregister(name: string, phase?: 'pre' | 'post'): void {
    this.hooks = this.hooks.filter(
      (h) => !(h.name === name && (phase === undefined || h.phase === phase))
    );
    Logger.info(`🗑️ Shell钩子已移除: ${name}`, 'ShellHooks');
  }

  public enable(name: string): void {
    const hook = this.hooks.find((h) => h.name === name);
    if (hook) {
      hook.enabled = true;
    }
  }

  public disable(name: string): void {
    const hook = this.hooks.find((h) => h.name === name);
    if (hook) {
      hook.enabled = false;
    }
  }

  public async runPreHooks(
    context: ShellHookContext
  ): Promise<ShellHookResult> {
    let currentCommand = context.command;
    const preHooks = this.hooks.filter((h) => h.phase === 'pre' && h.enabled);

    for (const hook of preHooks) {
      try {
        const hookContext: ShellHookContext = {
          ...context,
          command: currentCommand,
        };
        const result = await hook.fn(hookContext);

        this.logExecution(hook.name, context.command, result);

        if (!result.proceed) {
          Logger.warn(
            `🚫 Shell钩子 ${hook.name} 拦截命令: ${result.reason || '未提供原因'}`,
            'ShellHooks'
          );
          return result;
        }

        if (result.modifiedCommand) {
          currentCommand = result.modifiedCommand;
        }
      } catch (err) {
        Logger.error(
          `Shell钩子 ${hook.name} 执行失败`,
          err as Error,
          'ShellHooks'
        );
      }
    }

    return {
      proceed: true,
      modifiedCommand:
        currentCommand !== context.command ? currentCommand : undefined,
    };
  }

  public async runPostHooks(
    context: ShellHookContext,
    exitCode: number,
    stdout: string,
    stderr: string
  ): Promise<void> {
    const postHooks = this.hooks.filter((h) => h.phase === 'post' && h.enabled);

    for (const hook of postHooks) {
      try {
        const result = await hook.fn({
          ...context,
          metadata: { exitCode, stdout, stderr },
        });

        this.logExecution(hook.name, context.command, result);

        if (!result.proceed) {
          Logger.warn(
            `⚠️ Shell钩子 ${hook.name} 后置检查异常: ${result.reason || ''}`,
            'ShellHooks'
          );
        }
      } catch (err) {
        Logger.error(
          `Shell钩子 ${hook.name} 后置执行失败`,
          err as Error,
          'ShellHooks'
        );
      }
    }
  }

  public getRegisteredHooks(): Array<{
    name: string;
    phase: 'pre' | 'post';
    priority: number;
    enabled: boolean;
  }> {
    return this.hooks.map((h) => ({
      name: h.name,
      phase: h.phase,
      priority: h.priority,
      enabled: h.enabled,
    }));
  }

  public getExecutionLog(limit: number = 50): typeof this.executionLog {
    return this.executionLog.slice(-limit);
  }

  private logExecution(
    hookName: string,
    command: string,
    result: ShellHookResult
  ): void {
    this.executionLog.push({
      hookName,
      command,
      result,
      timestamp: Date.now(),
    });

    if (this.executionLog.length > 500) {
      this.executionLog = this.executionLog.slice(-250);
    }
  }
}

export function registerBuiltinShellHooks(): void {
  const hooks = ShellHooks.getInstance();

  hooks.register(
    'dangerous-command-guard',
    'pre',
    (context) => {
      const dangerousPatterns = [
        { pattern: /\brm\s+-rf\s+\//i, reason: '递归删除根目录' },
        { pattern: /\bdel\s+\/[sf]\s+/i, reason: '强制删除文件' },
        { pattern: /\bformat\s+[A-Za-z]:/i, reason: '格式化磁盘' },
        { pattern: /\bshutdown\b/i, reason: '关机命令' },
        { pattern: /\b(?:mkfs|fdisk|dd)\b/i, reason: '磁盘操作命令' },
        { pattern: /:()\s*{\s*:\s*|\s*};\s*:/i, reason: 'Fork炸弹' },
      ];

      for (const { pattern, reason } of dangerousPatterns) {
        if (pattern.test(context.command)) {
          return { proceed: false, reason: `危险命令拦截: ${reason}` };
        }
      }

      return { proceed: true };
    },
    10
  );

  hooks.register(
    'path-traversal-guard',
    'pre',
    (context) => {
      if (
        /\.\.[\\/]/.test(context.command) ||
        /\.\.\\"/.test(context.command)
      ) {
        return { proceed: false, reason: '路径遍历攻击拦截' };
      }
      return { proceed: true };
    },
    20
  );

  hooks.register(
    'environment-injection-guard',
    'pre',
    (context) => {
      const envInjection = /\$\{[^}]*\}|\$\([^)]*\)/;
      if (envInjection.test(context.command)) {
        const knownSafe = /\$\{?\w+\}?/;
        if (!knownSafe.test(context.command)) {
          return { proceed: false, reason: '可疑的环境变量注入' };
        }
      }
      return { proceed: true };
    },
    30
  );

  hooks.register(
    'execution-logger',
    'post',
    (context) => {
      const meta = context.metadata || {};
      const exitCode = (meta.exitCode as number) ?? -1;
      if (exitCode !== 0) {
        Logger.debug(
          `命令执行失败: exit=${exitCode} cmd=${context.command.substring(0, 100)}`,
          'ShellHooks'
        );
      }
      return { proceed: true };
    },
    90
  );

  Logger.info('✅ 内置Shell钩子已注册', 'ShellHooks');
}

export const shellHooks = ShellHooks.getInstance();
