"use strict";
/**
 * PluginContext — 插件注册门面
 *
 * 在插件 index.ts 的 register(ctx) 中提供给插件使用。
 * ctx 提供注册工具/命令/钩子的方法，自动桥接到系统的各个注册表。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginContext = void 0;
class PluginContext {
    pluginName;
    pluginVersion;
    tools = [];
    hooks = [];
    commands = [];
    toolRegistry = null;
    hookManager = null;
    slashRegistry = null;
    constructor(pluginName, pluginVersion) {
        this.pluginName = pluginName;
        this.pluginVersion = pluginVersion;
    }
    /** 设置工具注册表引用 */
    setToolRegistry(registry) {
        this.toolRegistry = registry;
    }
    /** 设置钩子管理器引用 */
    setHookManager(manager) {
        this.hookManager = manager;
    }
    /** 设置斜杠命令注册表引用 */
    setSlashRegistry(registry) {
        this.slashRegistry = registry;
    }
    // ==================== 注册方法 ====================
    /** 注册工具到 ToolRegistry */
    registerTool(tool) {
        this.tools.push(tool);
        if (!this.toolRegistry) {
            return true;
        }
        const definition = {
            name: tool.name,
            description: tool.description,
            category: 'plugin',
            parameters: tool.schema.parameters,
            requiredParams: tool.schema.required || [],
            requiredPermissions: [],
            riskLevel: 'low',
            idempotent: false,
            timeout: 30000,
        };
        try {
            this
                .toolRegistry.register(definition, async (args, _context) => {
                const startTime = Date.now();
                const result = await tool.handler(args);
                return {
                    success: true,
                    output: result,
                    duration: Date.now() - startTime,
                    validated: true,
                };
            });
            return true;
        }
        catch {
            return false;
        }
    }
    /** 注册钩子到 HookManager */
    registerHook(hook) {
        this.hooks.push(hook);
        if (this.hookManager) {
            try {
                this.hookManager.register({
                    id: `${this.pluginName}:${hook.event}`,
                    event: hook.event,
                    handler: hook.handler,
                    priority: 50,
                });
                return true;
            }
            catch {
                return false;
            }
        }
        return true;
    }
    /** 注册斜杠命令到 SlashCommandRegistry */
    registerCommand(cmd) {
        this.commands.push(cmd);
        if (this.slashRegistry) {
            return this.slashRegistry.register({
                name: cmd.name,
                description: cmd.description,
                handler: cmd.handler,
            });
        }
        return true;
    }
    // ==================== 查询 ====================
    getRegisteredTools() {
        return [...this.tools];
    }
    getRegisteredHooks() {
        return [...this.hooks];
    }
    getRegisteredCommands() {
        return [...this.commands];
    }
}
exports.PluginContext = PluginContext;
