"use strict";
/**
 * Harness Plugins — 插件市场
 *
 * Phase 4 核心模块：
 * - JiabaixingPluginSpec: 标准化插件描述符 + manifest 验证
 * - PluginManager: 插件生命周期管理 (install/list/remove/load/unload)
 * - PluginSandbox: 第三方插件沙箱执行 (权限隔离 + 资源限制)
 * - PluginRegistry: 已有插件注册表 (加载/卸载/钩子分发)
 * - pluginTypes: 插件类型定义
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginRegistry = exports.PluginRegistry = exports.PluginSandbox = exports.PluginManager = exports.JiabaixingPluginSpec = void 0;
var JiabaixingPluginSpec_1 = require("./JiabaixingPluginSpec");
Object.defineProperty(exports, "JiabaixingPluginSpec", { enumerable: true, get: function () { return JiabaixingPluginSpec_1.JiabaixingPluginSpec; } });
var PluginManager_1 = require("./PluginManager");
Object.defineProperty(exports, "PluginManager", { enumerable: true, get: function () { return PluginManager_1.PluginManager; } });
var PluginSandbox_1 = require("./PluginSandbox");
Object.defineProperty(exports, "PluginSandbox", { enumerable: true, get: function () { return PluginSandbox_1.PluginSandbox; } });
var pluginRegistry_1 = require("./pluginRegistry");
Object.defineProperty(exports, "PluginRegistry", { enumerable: true, get: function () { return pluginRegistry_1.PluginRegistry; } });
Object.defineProperty(exports, "pluginRegistry", { enumerable: true, get: function () { return pluginRegistry_1.pluginRegistry; } });
