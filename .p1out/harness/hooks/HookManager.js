"use strict";
/**
 * 统一钩子管理器
 *
 * 合并 ConstraintsService.hooks 和 Executor.ToolCallHooks 为统一管理
 * 支持：Gateway hook（日志/告警/webhook）、Plugin hook（工具拦截/指标/护栏）
 * 设计参考: Hermes Agent 事件 Hook 系统
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HookManager = exports.HookPriority = void 0;
const Logger_1 = require("../../utils/Logger");
/** 钩子优先级 */
var HookPriority;
(function (HookPriority) {
    HookPriority[HookPriority["LOW"] = 0] = "LOW";
    HookPriority[HookPriority["NORMAL"] = 50] = "NORMAL";
    HookPriority[HookPriority["HIGH"] = 100] = "HIGH";
    HookPriority[HookPriority["CRITICAL"] = 200] = "CRITICAL";
})(HookPriority || (exports.HookPriority = HookPriority = {}));
class HookManager {
    constructor() {
        this.hooks = new Map();
        this.hookIndex = new Map();
    }
    /**
     * 注册钩子
     * @param hook - 钩子定义
     */
    register(hook) {
        const existing = this.hookIndex.get(hook.id);
        if (existing) {
            Logger_1.Logger.warn(`钩子 ${hook.id} 已存在，将被覆盖`, 'HookManager');
            this.unregister(hook.id);
        }
        if (!this.hooks.has(hook.event)) {
            this.hooks.set(hook.event, []);
        }
        const list = this.hooks.get(hook.event);
        list.push(hook);
        // 按优先级降序排列（高优先级先执行）
        list.sort((a, b) => b.priority - a.priority);
        this.hookIndex.set(hook.id, hook);
        Logger_1.Logger.debug(`注册钩子: ${hook.id} [${hook.event}] 优先级=${hook.priority}`, 'HookManager');
    }
    /**
     * 注销钩子
     * @param hookId - 钩子唯一标识
     * @returns 是否成功注销
     */
    unregister(hookId) {
        const hook = this.hookIndex.get(hookId);
        if (!hook)
            return false;
        const list = this.hooks.get(hook.event);
        if (list) {
            const idx = list.findIndex((h) => h.id === hookId);
            if (idx >= 0)
                list.splice(idx, 1);
        }
        this.hookIndex.delete(hookId);
        return true;
    }
    /**
     * 执行指定事件的所有钩子
     * @param event - 事件类型
     * @param ctx - 钩子上下文
     * @returns 钩子执行结果
     */
    async execute(event, ctx) {
        const hooks = this.hooks.get(event);
        if (!hooks || hooks.length === 0) {
            return { proceed: true };
        }
        let currentParams = ctx.params;
        let currentResult = ctx.result;
        let proceed = true;
        for (const hook of hooks) {
            if (hook.enabled === false)
                continue;
            try {
                const enrichedCtx = {
                    ...ctx,
                    params: currentParams,
                    result: currentResult,
                };
                const result = await hook.handler(enrichedCtx);
                if (result.modifiedParams) {
                    currentParams = result.modifiedParams;
                }
                if (result.modifiedResult) {
                    currentResult = result.modifiedResult;
                }
                if (result.replacementResult) {
                    return {
                        proceed: false,
                        replacementResult: result.replacementResult,
                        reason: result.reason ?? `钩子 ${hook.id} 提供了替代结果`,
                    };
                }
                if (!result.proceed) {
                    return {
                        proceed: false,
                        modifiedParams: currentParams,
                        reason: result.reason ?? `钩子 ${hook.id} 拦截了执行`,
                    };
                }
            }
            catch (err) {
                Logger_1.Logger.error(`钩子 ${hook.id} 执行失败: ${err.message}`, err, 'HookManager');
                if (hook.priority >= HookPriority.CRITICAL) {
                    return {
                        proceed: false,
                        reason: `关键钩子 ${hook.id} 执行失败: ${err.message}`,
                    };
                }
            }
        }
        return {
            proceed,
            modifiedParams: currentParams,
            modifiedResult: currentResult,
        };
    }
    /**
     * 获取指定事件的钩子列表
     * @param event - 事件类型（可选，不传则返回所有钩子）
     * @returns 钩子定义列表
     */
    getHooks(event) {
        if (event) {
            return this.hooks.get(event) ?? [];
        }
        return Array.from(this.hookIndex.values());
    }
    /**
     * 兼容方法：注册钩子（简化签名，供 ConstraintsService 委托）
     */
    registerHook(event, hook, priority = HookPriority.NORMAL) {
        const id = `hook-${event}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.register({
            id,
            event: event,
            handler: hook,
            priority,
            enabled: true,
        });
    }
    /**
     * 兼容方法：执行钩子（简化签名，供 ConstraintsService 委托）
     */
    async executeHooks(event, context) {
        return this.execute(event, context);
    }
    /**
     * 启用/禁用钩子
     * @param hookId - 钩子唯一标识
     * @param enabled - 是否启用
     */
    setEnabled(hookId, enabled) {
        const hook = this.hookIndex.get(hookId);
        if (hook) {
            hook.enabled = enabled;
        }
    }
    /**
     * 清除所有钩子
     */
    clear() {
        this.hooks.clear();
        this.hookIndex.clear();
    }
}
exports.HookManager = HookManager;
