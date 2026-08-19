/**
 * MCP 服务器配置类型（契约）
 *
 * 迁移说明：MCPServerManager 的 TS 实现已删除（核心逻辑归属 Python
 * agent.mcp）。此接口仅作为 TS 侧桥接契约保留（符合 AGENTS.md §0.1：
 * TS 可声明类型契约用于桥接，但不得实现核心逻辑）。
 */

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  description?: string;
  enabled?: boolean;
  auto_start?: boolean;
  transport?: 'stdio' | 'http+sse';
  url?: string;
  tool_filtering?: boolean;
  allowed_tools?: string[];
  denied_tools?: string[];
}
