"use strict";
/**
 * McpChannel —— MCP 工具通道适配器
 *
 * 经 PythonAgentBridge.callMcpTool(...) 调用远端 MCP 服务器工具，归一为
 * ActionChannel 契约。兼容 mcp_{server}_{tool} 与 {server}/{tool} 两种命名。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpChannel = void 0;
const bridgeRegistry_1 = require("../../../ide/bridgeRegistry");
const Logger_1 = require("../../../utils/Logger");
class McpChannel {
    constructor() {
        this.kind = 'mcp';
    }
    async dispatch(request) {
        const start = Date.now();
        const tool = request.tool;
        if (!tool) {
            return {
                channel: 'mcp',
                success: false,
                output: null,
                error: 'McpChannel 需要 request.tool (MCP 工具名)',
                durationMs: Date.now() - start,
            };
        }
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (!bridge) {
            return {
                channel: 'mcp',
                success: false,
                output: null,
                error: 'MCP 后端未连接',
                durationMs: Date.now() - start,
            };
        }
        try {
            const { server, name } = this.parseTool(tool);
            const callTimeout = request.timeoutMs || 30000;
            const result = await Promise.race([
                bridge.callMcpTool(server, name, request.params ?? {}),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP工具调用超时 [${server}/${name}] (${callTimeout}ms)`)), callTimeout)),
            ]);
            const output = typeof result === 'string' ? result : JSON.stringify(result);
            return {
                channel: 'mcp',
                success: true,
                output,
                durationMs: Date.now() - start,
                raw: result,
            };
        }
        catch (err) {
            Logger_1.Logger.error(`McpChannel 调用失败: ${tool}`, err, 'McpChannel');
            return {
                channel: 'mcp',
                success: false,
                output: null,
                error: `MCP工具调用失败 [${tool}]: ${err.message}`,
                durationMs: Date.now() - start,
            };
        }
    }
    parseTool(tool) {
        if (tool.startsWith('mcp_')) {
            const rest = tool.slice(4);
            const idx = rest.indexOf('_');
            if (idx > 0) {
                return { server: rest.slice(0, idx), name: rest.slice(idx + 1) };
            }
        }
        const slash = tool.indexOf('/');
        if (slash > 0) {
            return { server: tool.slice(0, slash), name: tool.slice(slash + 1) };
        }
        return { server: tool, name: tool };
    }
}
exports.McpChannel = McpChannel;
