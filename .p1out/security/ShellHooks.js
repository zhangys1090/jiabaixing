"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shellHooks = exports.ShellHooks = void 0;
exports.registerBuiltinShellHooks = registerBuiltinShellHooks;
const Logger_1 = require("../utils/Logger");
class ShellHooks {
    constructor() {
        this.hooks = [];
        this.executionLog = [];
    }
    static getInstance() {
        if (!ShellHooks.instance) {
            ShellHooks.instance = new ShellHooks();
        }
        return ShellHooks.instance;
    }
    register(name, phase, fn, priority = 50) {
        const existing = this.hooks.findIndex((h) => h.name === name && h.phase === phase);
        if (existing >= 0) {
            this.hooks[existing] = { name, phase, priority, enabled: true, fn };
            Logger_1.Logger.info(`🔄 Shell钩子已更新: ${name} (${phase})`, 'ShellHooks');
        }
        else {
            this.hooks.push({ name, phase, priority, enabled: true, fn });
            Logger_1.Logger.info(`✅ Shell钩子已注册: ${name} (${phase})`, 'ShellHooks');
        }
        this.hooks.sort((a, b) => a.priority - b.priority);
    }
    unregister(name, phase) {
        this.hooks = this.hooks.filter((h) => !(h.name === name && (phase === undefined || h.phase === phase)));
        Logger_1.Logger.info(`🗑️ Shell钩子已移除: ${name}`, 'ShellHooks');
    }
    enable(name) {
        const hook = this.hooks.find((h) => h.name === name);
        if (hook) {
            hook.enabled = true;
        }
    }
    disable(name) {
        const hook = this.hooks.find((h) => h.name === name);
        if (hook) {
            hook.enabled = false;
        }
    }
    async runPreHooks(context) {
        let currentCommand = context.command;
        const preHooks = this.hooks.filter((h) => h.phase === 'pre' && h.enabled);
        for (const hook of preHooks) {
            try {
                const hookContext = {
                    ...context,
                    command: currentCommand,
                };
                const result = await hook.fn(hookContext);
                this.logExecution(hook.name, context.command, result);
                if (!result.proceed) {
                    Logger_1.Logger.warn(`🚫 Shell钩子 ${hook.name} 拦截命令: ${result.reason || '未提供原因'}`, 'ShellHooks');
                    return result;
                }
                if (result.modifiedCommand) {
                    currentCommand = result.modifiedCommand;
                }
            }
            catch (err) {
                Logger_1.Logger.error(`Shell钩子 ${hook.name} 执行失败`, err, 'ShellHooks');
            }
        }
        return {
            proceed: true,
            modifiedCommand: currentCommand !== context.command ? currentCommand : undefined,
        };
    }
    async runPostHooks(context, exitCode, stdout, stderr) {
        const postHooks = this.hooks.filter((h) => h.phase === 'post' && h.enabled);
        for (const hook of postHooks) {
            try {
                const result = await hook.fn({
                    ...context,
                    metadata: { exitCode, stdout, stderr },
                });
                this.logExecution(hook.name, context.command, result);
                if (!result.proceed) {
                    Logger_1.Logger.warn(`⚠️ Shell钩子 ${hook.name} 后置检查异常: ${result.reason || ''}`, 'ShellHooks');
                }
            }
            catch (err) {
                Logger_1.Logger.error(`Shell钩子 ${hook.name} 后置执行失败`, err, 'ShellHooks');
            }
        }
    }
    getRegisteredHooks() {
        return this.hooks.map((h) => ({
            name: h.name,
            phase: h.phase,
            priority: h.priority,
            enabled: h.enabled,
        }));
    }
    getExecutionLog(limit = 50) {
        return this.executionLog.slice(-limit);
    }
    logExecution(hookName, command, result) {
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
exports.ShellHooks = ShellHooks;
ShellHooks.instance = null;
function registerBuiltinShellHooks() {
    const hooks = ShellHooks.getInstance();
    hooks.register('dangerous-command-guard', 'pre', (context) => {
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
    }, 10);
    hooks.register('path-traversal-guard', 'pre', (context) => {
        if (/\.\.[\\/]/.test(context.command) ||
            /\.\.\\"/.test(context.command)) {
            return { proceed: false, reason: '路径遍历攻击拦截' };
        }
        return { proceed: true };
    }, 20);
    hooks.register('environment-injection-guard', 'pre', (context) => {
        const envInjection = /\$\{[^}]*\}|\$\([^)]*\)/;
        if (envInjection.test(context.command)) {
            const knownSafe = /\$\{?\w+\}?/;
            if (!knownSafe.test(context.command)) {
                return { proceed: false, reason: '可疑的环境变量注入' };
            }
        }
        return { proceed: true };
    }, 30);
    hooks.register('execution-logger', 'post', (context) => {
        const meta = context.metadata || {};
        const exitCode = meta.exitCode ?? -1;
        if (exitCode !== 0) {
            Logger_1.Logger.debug(`命令执行失败: exit=${exitCode} cmd=${context.command.substring(0, 100)}`, 'ShellHooks');
        }
        return { proceed: true };
    }, 90);
    Logger_1.Logger.info('✅ 内置Shell钩子已注册', 'ShellHooks');
}
exports.shellHooks = ShellHooks.getInstance();
