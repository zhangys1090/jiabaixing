"use strict";
/**
 * MCP 工具桥接 - 将 MCP 服务器的工具动态注册到 ToolRegistry
 * 让 LLM 能通过 FC 循环自主调用 MCP 工具 (browser, cron 等)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPToolBridge = void 0;
const bridgeRegistry_1 = require("../../../ide/bridgeRegistry");
const Logger_1 = require("../../../utils/Logger");
const EventBus_1 = require("../../../shared/EventBus");
const types_1 = require("../../types");
class MCPToolBridge {
    constructor() {
        this.bridgedTools = new Map();
        this.MAX_BRIDGED_TOOLS = 500;
        this.syncInterval = null;
        this._eventDrivenSyncEnabled = false;
        this._boundRegistry = null;
    }
    static getInstance() {
        if (!MCPToolBridge.instance) {
            MCPToolBridge.instance = new MCPToolBridge();
        }
        return MCPToolBridge.instance;
    }
    async syncToRegistry(registry) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (!bridge)
            return 0;
        const runningServers = await bridge.getRunningMcpServers();
        let syncedCount = 0;
        for (const serverName of runningServers) {
            try {
                const tools = await bridge.listMcpTools(serverName);
                const mcpTools = tools;
                for (const tool of mcpTools) {
                    const bridgedName = `mcp_${serverName}_${tool.name}`;
                    if (this.bridgedTools.has(bridgedName))
                        continue;
                    const definition = {
                        name: bridgedName,
                        description: `[MCP/${serverName}] ${tool.description || tool.name}`,
                        category: this.inferCategory(serverName),
                        parameters: this.convertSchema(tool.inputSchema),
                        requiredParams: this.extractRequired(tool.inputSchema),
                        requiredPermissions: this.inferPermissions(serverName, tool.name),
                        riskLevel: this.inferRiskLevel(serverName, tool.name),
                        idempotent: false,
                        timeout: 30000,
                        requiresConfirmation: false,
                    };
                    const serverNameCapture = serverName;
                    const toolNameCapture = tool.name;
                    registry.register(definition, async (params) => {
                        return this.executeMCPTool(serverNameCapture, toolNameCapture, params);
                    });
                    this.bridgedTools.set(bridgedName, `${serverName}/${tool.name}`);
                    if (this.bridgedTools.size > this.MAX_BRIDGED_TOOLS) {
                        const oldestKey = this.bridgedTools.keys().next().value;
                        this.bridgedTools.delete(oldestKey);
                    }
                    syncedCount++;
                    Logger_1.Logger.info(`🌉 MCP工具桥接: ${bridgedName} ← ${serverName}/${tool.name}`, 'MCPToolBridge');
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`⚠️ MCP服务器 ${serverName} 工具同步失败: ${err.message}`, 'MCPToolBridge');
            }
        }
        Logger_1.Logger.info(`🌉 MCP工具桥接完成: ${syncedCount} 个新工具`, 'MCPToolBridge');
        return syncedCount;
    }
    async executeMCPTool(serverName, toolName, params) {
        const startTime = Date.now();
        try {
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (!bridge) {
                return {
                    success: false,
                    output: null,
                    error: `MCP 后端未连接 [${serverName}/${toolName}]`,
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            const result = await bridge.callMcpTool(serverName, toolName, params);
            const outputStr = typeof result === 'string' ? result : JSON.stringify(result);
            return {
                success: true,
                output: outputStr.substring(0, 4000),
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `MCP工具调用失败 [${serverName}/${toolName}]: ${err.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    }
    convertSchema(inputSchema) {
        if (!inputSchema)
            return {};
        const properties = inputSchema.properties || {};
        const result = {};
        const validTypes = [
            'string',
            'number',
            'boolean',
            'object',
            'array',
        ];
        for (const [name, schema] of Object.entries(properties)) {
            const rawType = schema.type || 'string';
            const type = validTypes.includes(rawType)
                ? rawType
                : 'string';
            result[name] = {
                type,
                description: schema.description || name,
            };
        }
        return result;
    }
    extractRequired(inputSchema) {
        if (!inputSchema)
            return [];
        return inputSchema.required || [];
    }
    inferCategory(serverName) {
        switch (serverName) {
            case 'browser':
                return types_1.ToolCategory.NETWORK;
            case 'cron':
                return types_1.ToolCategory.SYSTEM;
            case 'filesystem':
                return types_1.ToolCategory.FILE;
            case 'sqlite':
                return types_1.ToolCategory.MEMORY;
            default:
                return types_1.ToolCategory.SYSTEM;
        }
    }
    inferRiskLevel(serverName, toolName) {
        if (serverName === 'browser')
            return 'medium';
        if (serverName === 'filesystem')
            return 'high';
        if (serverName === 'cron')
            return 'medium';
        if (toolName.includes('delete') || toolName.includes('remove'))
            return 'high';
        if (toolName.includes('write') || toolName.includes('create'))
            return 'medium';
        return 'low';
    }
    inferPermissions(serverName, toolName) {
        switch (serverName) {
            case 'browser':
                return [types_1.Permission.NETWORK_ACCESS];
            case 'filesystem':
                if (toolName.includes('write') ||
                    toolName.includes('create') ||
                    toolName.includes('delete')) {
                    return [types_1.Permission.FILE_WRITE];
                }
                return [types_1.Permission.FILE_READ];
            case 'cron':
                return [types_1.Permission.SYSTEM_ADMIN];
            case 'sqlite':
                return [types_1.Permission.MEMORY_READ, types_1.Permission.MEMORY_WRITE];
            default:
                if (toolName.includes('delete') || toolName.includes('admin')) {
                    return [types_1.Permission.SYSTEM_ADMIN];
                }
                return [types_1.Permission.CODE_EXECUTE];
        }
    }
    /**
     * 将 MCP Resources 同步为工具（mcp_{server}_read_resource）
     */
    async syncResourcesToRegistry(registry) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (!bridge)
            return 0;
        const runningServers = await bridge.getRunningMcpServers();
        let syncedCount = 0;
        for (const serverName of runningServers) {
            try {
                const resources = await bridge.listMcpResources(serverName);
                const mcpResources = resources;
                if (mcpResources.length === 0)
                    continue;
                const bridgedName = `mcp_${serverName}_read_resource`;
                if (this.bridgedTools.has(bridgedName))
                    continue;
                const resourceList = mcpResources
                    .map((r) => `- ${r.uri}: ${r.name || r.uri} (${r.mimeType || 'unknown'})`)
                    .join('\n');
                const definition = {
                    name: bridgedName,
                    description: `[MCP/${serverName}] 读取资源。可用资源:\n${resourceList}`,
                    category: types_1.ToolCategory.MEMORY,
                    parameters: {
                        uri: {
                            type: 'string',
                            description: '资源 URI',
                        },
                    },
                    requiredParams: ['uri'],
                    requiredPermissions: [types_1.Permission.MEMORY_READ],
                    riskLevel: 'low',
                    idempotent: true,
                    timeout: 15000,
                    requiresConfirmation: false,
                };
                const serverNameCapture = serverName;
                registry.register(definition, async (params) => {
                    const startTime = Date.now();
                    try {
                        const result = await bridge.readMcpResource(serverNameCapture, params.uri);
                        return {
                            success: true,
                            output: typeof result === 'string' ? result : JSON.stringify(result),
                            duration: Date.now() - startTime,
                            validated: false,
                        };
                    }
                    catch (err) {
                        return {
                            success: false,
                            output: null,
                            error: `MCP资源读取失败: ${err.message}`,
                            duration: Date.now() - startTime,
                            validated: false,
                        };
                    }
                });
                this.bridgedTools.set(bridgedName, `${serverName}/resources`);
                if (this.bridgedTools.size > this.MAX_BRIDGED_TOOLS) {
                    const oldestKey = this.bridgedTools.keys().next().value;
                    this.bridgedTools.delete(oldestKey);
                }
                syncedCount++;
                Logger_1.Logger.info(`🌉 MCP资源桥接: ${bridgedName} ← ${serverName} (${mcpResources.length} resources)`, 'MCPToolBridge');
            }
            catch (err) {
                Logger_1.Logger.warn(`⚠️ MCP服务器 ${serverName} 资源同步失败: ${err.message}`, 'MCPToolBridge');
            }
        }
        return syncedCount;
    }
    /**
     * 将 MCP Prompts 同步为工具（mcp_{server}_get_prompt）
     */
    async syncPromptsToRegistry(registry) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (!bridge)
            return 0;
        const runningServers = await bridge.getRunningMcpServers();
        let syncedCount = 0;
        for (const serverName of runningServers) {
            try {
                const prompts = await bridge.listMcpPrompts(serverName);
                const mcpPrompts = prompts;
                if (mcpPrompts.length === 0)
                    continue;
                const bridgedName = `mcp_${serverName}_get_prompt`;
                if (this.bridgedTools.has(bridgedName))
                    continue;
                const promptList = mcpPrompts
                    .map((p) => `- ${p.name}: ${p.description || p.name}`)
                    .join('\n');
                const definition = {
                    name: bridgedName,
                    description: `[MCP/${serverName}] 获取提示模板。可用模板:\n${promptList}`,
                    category: types_1.ToolCategory.SYSTEM,
                    parameters: {
                        name: {
                            type: 'string',
                            description: '提示模板名称',
                        },
                        arguments: {
                            type: 'object',
                            description: '提示模板参数',
                        },
                    },
                    requiredParams: ['name'],
                    requiredPermissions: [types_1.Permission.CODE_EXECUTE],
                    riskLevel: 'low',
                    idempotent: true,
                    timeout: 15000,
                    requiresConfirmation: false,
                };
                const serverNameCapture = serverName;
                registry.register(definition, async (params) => {
                    const startTime = Date.now();
                    try {
                        const result = await bridge.getMcpPrompt(serverNameCapture, params.name, params.arguments);
                        return {
                            success: true,
                            output: typeof result === 'string' ? result : JSON.stringify(result),
                            duration: Date.now() - startTime,
                            validated: false,
                        };
                    }
                    catch (err) {
                        return {
                            success: false,
                            output: null,
                            error: `MCP提示模板获取失败: ${err.message}`,
                            duration: Date.now() - startTime,
                            validated: false,
                        };
                    }
                });
                this.bridgedTools.set(bridgedName, `${serverName}/prompts`);
                if (this.bridgedTools.size > this.MAX_BRIDGED_TOOLS) {
                    const oldestKey = this.bridgedTools.keys().next().value;
                    this.bridgedTools.delete(oldestKey);
                }
                syncedCount++;
                Logger_1.Logger.info(`🌉 MCP提示模板桥接: ${bridgedName} ← ${serverName} (${mcpPrompts.length} prompts)`, 'MCPToolBridge');
            }
            catch (err) {
                Logger_1.Logger.warn(`⚠️ MCP服务器 ${serverName} 提示模板同步失败: ${err.message}`, 'MCPToolBridge');
            }
        }
        return syncedCount;
    }
    startAutoSync(registry) {
        this._boundRegistry = registry;
        void this.syncToRegistry(registry);
        void this.syncResourcesToRegistry(registry);
        void this.syncPromptsToRegistry(registry);
        this.syncInterval = setInterval(() => {
            void this.syncToRegistry(registry);
            void this.syncResourcesToRegistry(registry);
            void this.syncPromptsToRegistry(registry);
        }, MCPToolBridge.SYNC_INTERVAL_MS);
        if (this.syncInterval.unref)
            this.syncInterval.unref();
        this._enableEventDrivenSync(registry);
        Logger_1.Logger.info(`🌉 MCP工具自动同步已启动 (间隔=${MCPToolBridge.SYNC_INTERVAL_MS / 1000}s, 事件驱动=on)`, 'MCPToolBridge');
    }
    _enableEventDrivenSync(registry) {
        if (this._eventDrivenSyncEnabled)
            return;
        this._eventDrivenSyncEnabled = true;
        try {
            const bus = EventBus_1.JiabaixingEventBus.getInstance();
            bus.on('bridge:mcp_sync', () => {
                Logger_1.Logger.info('MCP 按需同步触发 (bridge:mcp_sync 事件)', 'MCPToolBridge');
                void this.syncToRegistry(registry);
                void this.syncResourcesToRegistry(registry);
                void this.syncPromptsToRegistry(registry);
            });
        }
        catch {
            Logger_1.Logger.warn('MCP 事件驱动同步注册失败，仅使用定时同步', 'MCPToolBridge');
        }
    }
    stopAutoSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        this._eventDrivenSyncEnabled = false;
    }
    getBridgedTools() {
        return new Map(this.bridgedTools);
    }
}
exports.MCPToolBridge = MCPToolBridge;
MCPToolBridge.instance = null;
MCPToolBridge.SYNC_INTERVAL_MS = 60000;
