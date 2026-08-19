/**
 * MCP 工具桥接 - 将 MCP 服务器的工具动态注册到 ToolRegistry
 * 让 LLM 能通过 FC 循环自主调用 MCP 工具 (browser, cron 等)
 */

import { getActivePythonBridge } from '../../../ide/bridgeRegistry';
import { JiabaixingEventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import type { ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { ToolRegistry } from './ToolRegistry';

export class MCPToolBridge {
  private static instance: MCPToolBridge | null = null;
  private bridgedTools: Map<string, string> = new Map();
  private syncInterval: NodeJS.Timeout | null = null;
  private static readonly SYNC_INTERVAL_MS = 60000;

  private constructor() {}

  public static create(): MCPToolBridge {
    return new MCPToolBridge();
  }

  public static getInstance(): MCPToolBridge {
    if (!MCPToolBridge.instance) {
      MCPToolBridge.instance = new MCPToolBridge();
    }
    return MCPToolBridge.instance;
  }

  public async syncToRegistry(registry: ToolRegistry): Promise<number> {
    const bridge = getActivePythonBridge();
    if (!bridge) return 0;
    const runningServers = await bridge.getRunningMcpServers();
    let syncedCount = 0;

    for (const serverName of runningServers) {
      try {
        const tools = await bridge.listMcpTools(serverName);
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
            requiredPermissions: this.inferPermissions(serverName, tool.name),
            riskLevel: this.inferRiskLevel(serverName, tool.name),
            idempotent: false,
            timeout: 30000,
            requiresConfirmation: false,
          };

          const serverNameCapture = serverName;
          const toolNameCapture = tool.name;

          registry.register(definition, async (params) => {
            return this.executeMCPTool(
              serverNameCapture,
              toolNameCapture,
              params
            );
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

    Logger.info(`🌉 MCP工具桥接完成: ${syncedCount} 个新工具`, 'MCPToolBridge');
    return syncedCount;
  }

  private async executeMCPTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const bridge = getActivePythonBridge();
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

      const outputStr =
        typeof result === 'string' ? result : JSON.stringify(result);

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
      (inputSchema.properties as Record<string, Record<string, unknown>>) || {};
    const result: Record<string, import('../../types').ToolParameterDef> = {};

    const validTypes = [
      'string',
      'number',
      'boolean',
      'object',
      'array',
    ] as const;

    for (const [name, schema] of Object.entries(properties)) {
      const rawType = (schema.type as string) || 'string';
      const type = validTypes.includes(rawType as (typeof validTypes)[number])
        ? (rawType as (typeof validTypes)[number])
        : 'string';
      result[name] = {
        type,
        description: (schema.description as string) || name,
      };
    }

    return result;
  }

  private extractRequired(inputSchema?: Record<string, unknown>): string[] {
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
    if (toolName.includes('delete') || toolName.includes('remove'))
      return 'high';
    if (toolName.includes('write') || toolName.includes('create'))
      return 'medium';
    return 'low';
  }

  private inferPermissions(serverName: string, toolName: string): Permission[] {
    switch (serverName) {
      case 'browser':
        return [Permission.NETWORK_ACCESS];
      case 'filesystem':
        if (
          toolName.includes('write') ||
          toolName.includes('create') ||
          toolName.includes('delete')
        ) {
          return [Permission.FILE_WRITE];
        }
        return [Permission.FILE_READ];
      case 'cron':
        return [Permission.SYSTEM_ADMIN];
      case 'sqlite':
        return [Permission.MEMORY_READ, Permission.MEMORY_WRITE];
      default:
        if (toolName.includes('delete') || toolName.includes('admin')) {
          return [Permission.SYSTEM_ADMIN];
        }
        return [Permission.CODE_EXECUTE];
    }
  }

  /**
   * 将 MCP Resources 同步为工具（mcp_{server}_read_resource）
   */
  public async syncResourcesToRegistry(
    registry: ToolRegistry
  ): Promise<number> {
    const bridge = getActivePythonBridge();
    if (!bridge) return 0;
    const runningServers = await bridge.getRunningMcpServers();
    let syncedCount = 0;

    for (const serverName of runningServers) {
      try {
        const resources = await bridge.listMcpResources(serverName);
        const mcpResources = resources as Array<{
          uri: string;
          name?: string;
          description?: string;
          mimeType?: string;
        }>;

        if (mcpResources.length === 0) continue;

        const bridgedName = `mcp_${serverName}_read_resource`;

        if (this.bridgedTools.has(bridgedName)) continue;

        const resourceList = mcpResources
          .map(
            (r) => `- ${r.uri}: ${r.name || r.uri} (${r.mimeType || 'unknown'})`
          )
          .join('\n');

        const definition: ToolDefinition = {
          name: bridgedName,
          description: `[MCP/${serverName}] 读取资源。可用资源:\n${resourceList}`,
          category: ToolCategory.MEMORY,
          parameters: {
            uri: {
              type: 'string',
              description: '资源 URI',
            },
          },
          requiredParams: ['uri'],
          requiredPermissions: [Permission.MEMORY_READ],
          riskLevel: 'low',
          idempotent: true,
          timeout: 15000,
          requiresConfirmation: false,
        };

        const serverNameCapture = serverName;

        registry.register(definition, async (params) => {
          const startTime = Date.now();
          try {
            const result = await bridge.readMcpResource(
              serverNameCapture,
              params.uri as string
            );
            return {
              success: true,
              output:
                typeof result === 'string' ? result : JSON.stringify(result),
              duration: Date.now() - startTime,
              validated: false,
            };
          } catch (err) {
            return {
              success: false,
              output: null,
              error: `MCP资源读取失败: ${(err as Error).message}`,
              duration: Date.now() - startTime,
              validated: false,
            };
          }
        });

        this.bridgedTools.set(bridgedName, `${serverName}/resources`);
        syncedCount++;

        Logger.info(
          `🌉 MCP资源桥接: ${bridgedName} ← ${serverName} (${mcpResources.length} resources)`,
          'MCPToolBridge'
        );
      } catch (err) {
        Logger.warn(
          `⚠️ MCP服务器 ${serverName} 资源同步失败: ${(err as Error).message}`,
          'MCPToolBridge'
        );
      }
    }

    return syncedCount;
  }

  /**
   * 将 MCP Prompts 同步为工具（mcp_{server}_get_prompt）
   */
  public async syncPromptsToRegistry(registry: ToolRegistry): Promise<number> {
    const bridge = getActivePythonBridge();
    if (!bridge) return 0;
    const runningServers = await bridge.getRunningMcpServers();
    let syncedCount = 0;

    for (const serverName of runningServers) {
      try {
        const prompts = await bridge.listMcpPrompts(serverName);
        const mcpPrompts = prompts as Array<{
          name: string;
          description?: string;
          arguments?: Array<{
            name: string;
            description?: string;
            required?: boolean;
          }>;
        }>;

        if (mcpPrompts.length === 0) continue;

        const bridgedName = `mcp_${serverName}_get_prompt`;

        if (this.bridgedTools.has(bridgedName)) continue;

        const promptList = mcpPrompts
          .map((p) => `- ${p.name}: ${p.description || p.name}`)
          .join('\n');

        const definition: ToolDefinition = {
          name: bridgedName,
          description: `[MCP/${serverName}] 获取提示模板。可用模板:\n${promptList}`,
          category: ToolCategory.SYSTEM,
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
          requiredPermissions: [Permission.CODE_EXECUTE],
          riskLevel: 'low',
          idempotent: true,
          timeout: 15000,
          requiresConfirmation: false,
        };

        const serverNameCapture = serverName;

        registry.register(definition, async (params) => {
          const startTime = Date.now();
          try {
            const result = await bridge.getMcpPrompt(
              serverNameCapture,
              params.name as string,
              params.arguments as Record<string, string> | undefined
            );
            return {
              success: true,
              output:
                typeof result === 'string' ? result : JSON.stringify(result),
              duration: Date.now() - startTime,
              validated: false,
            };
          } catch (err) {
            return {
              success: false,
              output: null,
              error: `MCP提示模板获取失败: ${(err as Error).message}`,
              duration: Date.now() - startTime,
              validated: false,
            };
          }
        });

        this.bridgedTools.set(bridgedName, `${serverName}/prompts`);
        syncedCount++;

        Logger.info(
          `🌉 MCP提示模板桥接: ${bridgedName} ← ${serverName} (${mcpPrompts.length} prompts)`,
          'MCPToolBridge'
        );
      } catch (err) {
        Logger.warn(
          `⚠️ MCP服务器 ${serverName} 提示模板同步失败: ${(err as Error).message}`,
          'MCPToolBridge'
        );
      }
    }

    return syncedCount;
  }

  private _eventDrivenSyncEnabled: boolean = false;
  private _boundRegistry: ToolRegistry | null = null;

  public startAutoSync(registry: ToolRegistry): void {
    this._boundRegistry = registry;
    void this.syncToRegistry(registry);
    void this.syncResourcesToRegistry(registry);
    void this.syncPromptsToRegistry(registry);
    this.syncInterval = setInterval(() => {
      void this.syncToRegistry(registry);
      void this.syncResourcesToRegistry(registry);
      void this.syncPromptsToRegistry(registry);
    }, MCPToolBridge.SYNC_INTERVAL_MS);
    this._enableEventDrivenSync(registry);
    Logger.info(
      `🌉 MCP工具自动同步已启动 (间隔=${MCPToolBridge.SYNC_INTERVAL_MS / 1000}s, 事件驱动=on)`,
      'MCPToolBridge'
    );
  }

  private _enableEventDrivenSync(registry: ToolRegistry): void {
    if (this._eventDrivenSyncEnabled) return;
    this._eventDrivenSyncEnabled = true;
    try {
      const bus = JiabaixingEventBus.getInstance();
      bus.on('bridge:mcp_sync' as any, () => {
        Logger.info('MCP 按需同步触发 (bridge:mcp_sync 事件)', 'MCPToolBridge');
        void this.syncToRegistry(registry);
        void this.syncResourcesToRegistry(registry);
        void this.syncPromptsToRegistry(registry);
      });
    } catch {
      Logger.warn('MCP 事件驱动同步注册失败，仅使用定时同步', 'MCPToolBridge');
    }
  }

  public stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this._eventDrivenSyncEnabled = false;
  }

  public getBridgedTools(): Map<string, string> {
    return new Map(this.bridgedTools);
  }
}
