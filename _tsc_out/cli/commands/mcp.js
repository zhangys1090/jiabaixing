"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMcpCommandCLI = handleMcpCommandCLI;
const Logger_1 = require("../../utils/Logger");
const ipc_1 = require("../ipc");
/**
 * 处理 mcp 子命令 — MCP服务器管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleMcpCommandCLI(subArgs, options) {
    const action = subArgs[0] || 'servers';
    switch (action) {
        case 'servers':
        case 'list': {
            try {
                const data = await (0, ipc_1.requestWithFallback)('mcp.servers', {}, { path: '/api/mcp/servers' });
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    const servers = data?.servers || [];
                    process.stdout.write(`MCP服务器 (${servers.length}):\n`);
                    for (const s of servers) {
                        const name = s.name || s.id || JSON.stringify(s);
                        const status = s.status === 'connected'
                            ? '✅'
                            : '❌';
                        process.stdout.write(`  ${status} ${name}\n`);
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取MCP服务器列表失败', err, 'McpCommand');
                process.stderr.write(`获取MCP服务器列表失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'status': {
            try {
                const data = await (0, ipc_1.requestWithFallback)('mcp.servers', {}, { path: '/api/mcp/servers' });
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    process.stdout.write(`MCP服务器状态: ${JSON.stringify(data, null, 2)}\n`);
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取MCP状态失败', err, 'McpCommand');
                process.stderr.write(`获取MCP状态失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        default:
            process.stderr.write(`未知 mcp 子命令: ${action}。可用: list, servers, status\n`);
            process.exit(1);
    }
}
