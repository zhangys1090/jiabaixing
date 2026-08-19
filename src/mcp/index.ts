/**
 * MCP模块统一导出
 *
 * 迁移说明：MCPServerManager 的 TS 实现已删除（核心逻辑归属 Python
 * agent.mcp，经 PythonAgentBridge 代理）。此处仅导出 TS 侧桥接契约类型。
 */

export { MCPServerConfig } from './types';
