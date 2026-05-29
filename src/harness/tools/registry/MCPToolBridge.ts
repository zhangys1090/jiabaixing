/**
 * MCP 工具桥接 - 将 MCP 服务器的工具动态注册到 ToolRegistry
 * 让 LLM 能通过 FC 循环自主调用 MCP 工具 (browser, cron 等)
 */

import { MCPServerManager } from '../../../mcp/MCPServerManager';
import { ToolRegistry } from './ToolRegistry';
import type { ToolDefinition, ToolResult, ToolContext } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export class MCPToolBridge {
  private static instance: MCPToolBridge | null = null;
  private bridgedTools: Map<string, string> = new Map();
  private syncInterval: NodeJS.Timeout | null = null;
  private static readonly SYNC_INTERVAL_MS = 60000;

  private constructor() {}

  public static getInstance(): MCPToolBridge {
    if (!MCPToolBridge.instance) {
      MCPToolBridge.instance = new MCPToolBridge();
    }
    return MCPToolBridge.instance;
  }

  public async syncToRegistry(registry: ToolRegistry): Promise<number> {
    const mcpManager = MCPServerManager.getInstance();
    const runningServers = mcpManager.getRunningServers();
    let syncedCount = 0;

    for (const serverName of runningServers) {
      try {
        const tools = await mcpManager.listTools(serverName);
        const mcpTools = tools as Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;

        for (const tool of mcpTools) {
          const bridgedName = `mcp_${serverName}_${tool.name}`;

          if (this.bridgedTools.has(bridgedName)) continue;

          const definition: ToolDefinition = {
            name: bridgedName,
            description: `[MCP/${serverName}] ${tool.description || tool.name}`,
            category: this.inferCategory(serverName),
            parameters: this.convertSchema(tool.inputSchema),
            requiredParams: this.extractRequired(tool.inputSchema),
            requiredPermissions: [Permission.SYSTEM_ADMIN],
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
          syncedCount++;

          Logger.info(
            `🌉 MCP工具桥接: ${bridgedName} ← ${serverName}/${tool.name}`,
            'MCPToolBridge'
          );
        }
      } catch (err) {
        Logger.warn(
          `⚠️ MCP服务器 ${serverName} 工具同步失败: ${(err as Error).message}`,
          'MCPToolBridge'
        );
      }
    }

    Logger.info(
      `🌉 MCP工具桥接完成: ${syncedCount} 个新工具`,
      'MCPToolBridge'
    );
    return syncedCount;
  }

  private async executeMCPTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const mcpManager = MCPServerManager.getInstance();
      const result = await mcpManager.callTool(serverName, toolName, params);

      const outputStr =
        typeof result === 'string'
          ? result
          : JSON.stringify(result);

      return {
        success: true,
        output: outputStr.substring(0, 4000),
        duration: Date.now() - startTime,
        validated: false,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `MCP工具调用失败 [${serverName}/${toolName}]: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  }

  private convertSchema(
    inputSchema?: Record<string, unknown>
  ): Record<string, import('../../types').ToolParameterDef> {
    if (!inputSchema) return {};

    const properties =
      inputSchema.properties as Record<string, Record<string, unknown>> || {};
    const result: Record<string, import('../../types').ToolParameterDef> = {};

    const validTypes = ['string', 'number', 'boolean', 'object', 'array'] as const;

    for (const [name, schema] of Object.entries(properties)) {
      const rawType = (schema.type as string) || 'string';
      const type = validTypes.includes(rawType as typeof validTypes[number])
        ? rawType as typeof validTypes[number]
        : 'string';
      result[name] = {
        type,
        description: (schema.description as string) || name,
      };
    }

    return result;
  }

  private extractRequired(
    inputSchema?: Record<string, unknown>
  ): string[] {
    if (!inputSchema) return [];
    return (inputSchema.required as string[]) || [];
  }

  private inferCategory(serverName: string): ToolCategory {
    switch (serverName) {
      case 'browser':
        return ToolCategory.NETWORK;
      case 'cron':
        return ToolCategory.SYSTEM;
      case 'filesystem':
        return ToolCategory.FILE;
      case 'sqlite':
        return ToolCategory.MEMORY;
      default:
        return ToolCategory.SYSTEM;
    }
  }

  private inferRiskLevel(
    serverName: string,
    toolName: string
  ): 'low' | 'medium' | 'high' {
    if (serverName === 'browser') return 'medium';
    if (serverName === 'filesystem') return 'high';
    if (serverName === 'cron') return 'medium';
    if (toolName.includes('delete') || toolName.includes('remove')) return 'high';
    if (toolName.includes('write') || toolName.includes('create')) return 'medium';
    return 'low';
  }

  public startAutoSync(registry: ToolRegistry): void {
    this.syncToRegistry(registry);
    this.syncInterval = setInterval(
      () => this.syncToRegistry(registry),
      MCPToolBridge.SYNC_INTERVAL_MS
    );
    Logger.info(
      `🌉 MCP工具自动同步已启动 (间隔=${MCPToolBridge.SYNC_INTERVAL_MS / 1000}s)`,
      'MCPToolBridge'
    );
  }

  public stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  public getBridgedTools(): Map<string, string> {
    return new Map(this.bridgedTools);
  }
}
