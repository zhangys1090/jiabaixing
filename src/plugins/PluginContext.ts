/**
 * PluginContext — 插件注册门面
 *
 * 在插件 index.ts 的 register(ctx) 中提供给插件使用。
 * ctx 提供注册工具/命令/钩子的方法，自动桥接到系统的各个注册表。
 */

import { ToolRegistry } from '../harness/tools/registry/ToolRegistry';
import { HookManager } from '../harness/hooks/HookManager';
import {
  SlashCommandRegistry,
  CommandHandler,
} from '../integration/SlashCommandRegistry';

/** 插件工具 schema（OpenAI Function Calling 格式） */
export interface PluginToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 插件工具 handler */
export type PluginToolHandler = (
  args: Record<string, unknown>
) => Promise<string> | string;

/** 插件工具定义（给 ctx.registerTool 用的简化版） */
export interface PluginToolRegistration {
  name: string;
  description: string;
  schema: PluginToolSchema;
  handler: PluginToolHandler;
  /** 所属工具集（默认 'plugin'） */
  toolset?: string;
}

/** 插件钩子定义 */
export interface PluginHookRegistration {
  event: string;
  handler: (ctx: Record<string, unknown>) => Promise<void> | void;
}

/** 插件命令定义（斜杠命令） */
export interface PluginCommandRegistration {
  name: string;
  description: string;
  handler: CommandHandler;
}

export class PluginContext {
  private tools: PluginToolRegistration[] = [];
  private hooks: PluginHookRegistration[] = [];
  private commands: PluginCommandRegistration[] = [];
  private toolRegistry: ToolRegistry | null = null;
  private hookManager: HookManager | null = null;
  private slashRegistry: SlashCommandRegistry | null = null;

  constructor(
    public readonly pluginName: string,
    public readonly pluginVersion: string
  ) {}

  /** 设置工具注册表引用 */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** 设置钩子管理器引用 */
  setHookManager(manager: HookManager): void {
    this.hookManager = manager;
  }

  /** 设置斜杠命令注册表引用 */
  setSlashRegistry(registry: SlashCommandRegistry): void {
    this.slashRegistry = registry;
  }

  // ==================== 注册方法 ====================

  /** 注册工具到 ToolRegistry */
  registerTool(tool: PluginToolRegistration): boolean {
    this.tools.push(tool);

    if (!this.toolRegistry) {
      return true;
    }

    // 构造 OpenAI Function Calling 格式
    const definition = {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema.parameters as Record<string, unknown>,
      },
    };

    try {
      (this.toolRegistry as any).register(
        tool.name,
        definition,
        async (args: Record<string, unknown>) => {
          const result = await tool.handler(args);
          return { success: true, output: result };
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 注册钩子到 HookManager */
  registerHook(hook: PluginHookRegistration): boolean {
    this.hooks.push(hook);

    if (this.hookManager) {
      try {
        (this.hookManager as any).register({
          id: `${this.pluginName}:${hook.event}`,
          event: hook.event,
          handler: hook.handler,
          priority: 5,
        });
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** 注册斜杠命令到 SlashCommandRegistry */
  registerCommand(cmd: PluginCommandRegistration): boolean {
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

  getRegisteredTools(): PluginToolRegistration[] {
    return [...this.tools];
  }

  getRegisteredHooks(): PluginHookRegistration[] {
    return [...this.hooks];
  }

  getRegisteredCommands(): PluginCommandRegistration[] {
    return [...this.commands];
  }
}
