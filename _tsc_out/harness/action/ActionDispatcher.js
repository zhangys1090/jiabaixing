"use strict";
/**
 * ActionDispatcher —— 统一动作调度器（编排层单一入口）
 *
 * 归并 harness 工具 / 桌面 / MCP 三通道为一个调度接口：
 *   编排层 → dispatch({ channel, ... }) → 对应 ActionChannel → ActionResult
 *
 * 同时提供 verifyDesktopAction(...) 便捷封装，供桌面动作在执行后接回
 * Python ActionVerifier（闭环）。各通道后端对象经 use* 方法注入，启动时装配。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionDispatcher = void 0;
exports.getActionDispatcher = getActionDispatcher;
exports.configureActionDispatcher = configureActionDispatcher;
const Logger_1 = require("../../utils/Logger");
const DesktopChannel_1 = require("./channels/DesktopChannel");
const McpChannel_1 = require("./channels/McpChannel");
const ToolChannel_1 = require("./channels/ToolChannel");
const VerificationBridge_1 = require("./verify/VerificationBridge");
class ActionDispatcher {
    channels = new Map();
    toolRegistry = null;
    verifier = (0, VerificationBridge_1.getActionVerificationBridge)();
    constructor() {
        this.ensureChannels();
    }
    ensureChannels() {
        if (!this.channels.has('mcp')) {
            this.channels.set('mcp', new McpChannel_1.McpChannel());
        }
        if (!this.channels.has('desktop')) {
            this.channels.set('desktop', new DesktopChannel_1.DesktopChannel(this.verifier));
        }
    }
    /** 注入真实工具注册表（启动时由 AgentHarness 装配） */
    useToolRegistry(registry) {
        this.toolRegistry = registry;
        this.channels.set('tool', new ToolChannel_1.ToolChannel(registry));
        return this;
    }
    /** 切换验证桥（默认 Python 优先，可降级为 Local） */
    useVerifier(verifier) {
        this.verifier = verifier;
        this.channels.set('desktop', new DesktopChannel_1.DesktopChannel(verifier));
        return this;
    }
    /** 注册自定义通道（扩展点） */
    registerChannel(channel) {
        this.channels.set(channel.kind, channel);
        return this;
    }
    getChannel(kind) {
        return this.channels.get(kind);
    }
    /** 编排层单一入口：经统一接口调度三类动作，结果归一为 ActionResult */
    async dispatch(request) {
        const channel = this.channels.get(request.channel);
        if (!channel) {
            Logger_1.Logger.warn(`ActionDispatcher 未注册通道: ${request.channel}`, 'ActionDispatcher');
            return {
                channel: request.channel,
                success: false,
                output: null,
                error: `未注册的动作通道: ${request.channel}`,
                durationMs: 0,
            };
        }
        return channel.dispatch(request);
    }
    /** 桌面动作接回 action_verifier 的便捷封装（验证核心在 Python 端） */
    async verifyDesktopAction(description, prePath, postPath, opts = {}) {
        return this.verifier.verify({
            description,
            prePath,
            postPath,
            strategy: opts.strategy ?? 'auto',
            question: opts.question ?? '',
        });
    }
}
exports.ActionDispatcher = ActionDispatcher;
let _dispatcher = null;
/** 获取全局单例调度器 */
function getActionDispatcher() {
    if (!_dispatcher)
        _dispatcher = new ActionDispatcher();
    return _dispatcher;
}
/** 启动装配：注入真实工具注册表 / 验证桥 */
function configureActionDispatcher(opts) {
    const d = getActionDispatcher();
    if (opts.toolRegistry)
        d.useToolRegistry(opts.toolRegistry);
    if (opts.verifier)
        d.useVerifier(opts.verifier);
    return d;
}
