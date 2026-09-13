"use strict";
/**
 * 插件接口定义
 *
 * 三种插件类型：通用插件、记忆提供商、上下文引擎
 * 设计参考: Hermes Agent 插件系统
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginType = void 0;
/** 插件类型枚举 */
var PluginType;
(function (PluginType) {
    /** 通用插件：工具 + 钩子 */
    PluginType["GENERAL"] = "general";
    /** 记忆提供商：跨会话知识 */
    PluginType["MEMORY_PROVIDER"] = "memory_provider";
    /** 上下文引擎：替代上下文管理 */
    PluginType["CONTEXT_ENGINE"] = "context_engine";
})(PluginType || (exports.PluginType = PluginType = {}));
