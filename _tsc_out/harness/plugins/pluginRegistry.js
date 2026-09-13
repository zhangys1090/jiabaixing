"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginRegistry = exports.PluginRegistry = void 0;
const Logger_1 = require("../../utils/Logger");
class PluginRegistry {
    plugins = new Map();
    toolMap = new Map();
    panelMap = new Map();
    pluginStorages = new Map();
    pluginSettings = new Map();
    searchPaths;
    constructor(searchPaths) {
        this.searchPaths = searchPaths || ['.jiabaixing/plugins', 'plugins'];
    }
    async loadPlugin(manifest, lifecycle) {
        if (this.plugins.has(manifest.id)) {
            Logger_1.Logger.warn(`插件 ${manifest.id} 已加载，跳过`, 'PluginRegistry');
            return false;
        }
        const storage = this.createPluginStorage(manifest.id);
        const settings = this.createPluginSettings(manifest.id, manifest);
        const logger = this.createPluginLogger(manifest.id);
        const api = this.createPluginAPI(manifest.id);
        const context = {
            pluginId: manifest.id,
            logger,
            storage,
            settings,
            api,
        };
        const hooks = {};
        if (lifecycle) {
            const hookMap = {
                onLoad: 'onLoad',
                onUnload: 'onUnload',
                onMessage: 'onMessage',
                onToolCall: 'onToolCall',
                onToolResult: 'onToolResult',
                onSessionStart: 'onSessionStart',
                onSessionEnd: 'onSessionEnd',
                onProjectSwitch: 'onProjectSwitch',
                onSettingsChange: 'onSettingsChange',
            };
            for (const [method, hookName] of Object.entries(hookMap)) {
                if (typeof lifecycle[method] === 'function') {
                    hooks[hookName] = lifecycle[method];
                }
            }
        }
        const instance = {
            manifest,
            context,
            status: 'loaded',
            hooks,
        };
        this.plugins.set(manifest.id, instance);
        try {
            if (hooks.onLoad) {
                await hooks.onLoad(context);
            }
            instance.status = 'active';
            instance.loadedAt = new Date().toISOString();
            Logger_1.Logger.info(`插件 ${manifest.id} (${manifest.name} v${manifest.version}) 加载成功`, 'PluginRegistry');
            return true;
        }
        catch (err) {
            instance.status = 'error';
            instance.error = err.message;
            Logger_1.Logger.error(`插件 ${manifest.id} 加载失败: ${err.message}`, err, 'PluginRegistry');
            return false;
        }
    }
    async unloadPlugin(pluginId) {
        const instance = this.plugins.get(pluginId);
        if (!instance)
            return false;
        try {
            if (instance.hooks.onUnload) {
                await instance.hooks.onUnload();
            }
            for (const [toolName, entry] of this.toolMap.entries()) {
                if (entry.pluginId === pluginId) {
                    this.toolMap.delete(toolName);
                }
            }
            for (const [panelId, entry] of this.panelMap.entries()) {
                if (entry.pluginId === pluginId) {
                    this.panelMap.delete(panelId);
                }
            }
            this.plugins.delete(pluginId);
            this.pluginStorages.delete(pluginId);
            this.pluginSettings.delete(pluginId);
            Logger_1.Logger.info(`插件 ${pluginId} 已卸载`, 'PluginRegistry');
            return true;
        }
        catch (err) {
            Logger_1.Logger.error(`插件 ${pluginId} 卸载失败: ${err.message}`, err, 'PluginRegistry');
            return false;
        }
    }
    async emitHook(hookName, ...args) {
        const promises = [];
        for (const instance of this.plugins.values()) {
            if (instance.status !== 'active')
                continue;
            const hook = instance.hooks[hookName];
            if (hook) {
                try {
                    const result = hook(...args);
                    if (result instanceof Promise) {
                        promises.push(result);
                    }
                }
                catch (err) {
                    Logger_1.Logger.error(`插件 ${instance.manifest.id} hook ${hookName} 执行失败: ${err.message}`, err, 'PluginRegistry');
                }
            }
        }
        await Promise.allSettled(promises);
    }
    getPlugin(pluginId) {
        return this.plugins.get(pluginId);
    }
    getAllPlugins() {
        return Array.from(this.plugins.values());
    }
    getActivePlugins() {
        return Array.from(this.plugins.values()).filter((p) => p.status === 'active');
    }
    getPluginTools() {
        return Array.from(this.toolMap.values());
    }
    getPluginPanels() {
        return Array.from(this.panelMap.values());
    }
    async executePluginTool(toolName, params) {
        const entry = this.toolMap.get(toolName);
        if (!entry) {
            throw new Error(`未找到插件工具: ${toolName}`);
        }
        const instance = this.plugins.get(entry.pluginId);
        if (!instance || instance.status !== 'active') {
            throw new Error(`插件 ${entry.pluginId} 未激活`);
        }
        return entry.definition.execute(params, instance.context);
    }
    createPluginStorage(pluginId) {
        if (!this.pluginStorages.has(pluginId)) {
            this.pluginStorages.set(pluginId, new Map());
        }
        const map = this.pluginStorages.get(pluginId);
        return {
            get: (key) => map.get(key),
            set: (key, value) => map.set(key, value),
            delete: (key) => map.delete(key),
            clear: () => map.clear(),
            keys: () => Array.from(map.keys()),
        };
    }
    createPluginSettings(pluginId, manifest) {
        const defaults = {};
        if (manifest.settings) {
            for (const setting of manifest.settings) {
                if (setting.default !== undefined) {
                    defaults[setting.key] = setting.default;
                }
            }
        }
        if (!this.pluginSettings.has(pluginId)) {
            this.pluginSettings.set(pluginId, defaults);
        }
        const settings = this.pluginSettings.get(pluginId);
        return {
            get: (key) => settings[key],
            set: (key, value) => {
                settings[key] = value;
            },
            getAll: () => ({ ...settings }),
        };
    }
    createPluginLogger(pluginId) {
        return {
            info: (message, ..._args) => Logger_1.Logger.info(`[${pluginId}] ${message}`, 'Plugin'),
            warn: (message, ..._args) => Logger_1.Logger.warn(`[${pluginId}] ${message}`, 'Plugin'),
            error: (message, ..._args) => Logger_1.Logger.error(`[${pluginId}] ${message}`, undefined, 'Plugin'),
            debug: (message, ..._args) => Logger_1.Logger.debug(`[${pluginId}] ${message}`, 'Plugin'),
        };
    }
    createPluginAPI(pluginId) {
        return {
            registerTool: (definition) => {
                if (this.toolMap.has(definition.name)) {
                    Logger_1.Logger.warn(`工具 ${definition.name} 已注册，跳过`, 'PluginRegistry');
                    return;
                }
                this.toolMap.set(definition.name, { pluginId, definition });
                Logger_1.Logger.info(`插件 ${pluginId} 注册工具: ${definition.name}`, 'PluginRegistry');
            },
            unregisterTool: (name) => {
                const entry = this.toolMap.get(name);
                if (entry && entry.pluginId === pluginId) {
                    this.toolMap.delete(name);
                }
            },
            callTool: async (name, params) => {
                return this.executePluginTool(name, params);
            },
            showNotification: (title, body) => {
                Logger_1.Logger.info(`[通知] ${title}: ${body}`, 'Plugin');
            },
            registerPanel: (panel) => {
                this.panelMap.set(panel.id, { pluginId, definition: panel });
                Logger_1.Logger.info(`插件 ${pluginId} 注册面板: ${panel.id}`, 'PluginRegistry');
            },
            unregisterPanel: (id) => {
                const entry = this.panelMap.get(id);
                if (entry && entry.pluginId === pluginId) {
                    this.panelMap.delete(id);
                }
            },
            getActiveProject: () => {
                return null;
            },
            getLocale: () => {
                return 'zh-CN';
            },
        };
    }
}
exports.PluginRegistry = PluginRegistry;
exports.pluginRegistry = new PluginRegistry();
