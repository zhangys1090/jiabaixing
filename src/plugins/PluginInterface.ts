/**
 * 插件接口定义
 *
 * 三种插件类型：通用插件、记忆提供商、上下文引擎
 * 设计参考: Hermes Agent 插件系统
 */

/** 插件类型枚举 */
export enum PluginType {
  /** 通用插件：工具 + 钩子 */
  GENERAL = 'general',
  /** 记忆提供商：跨会话知识 */
  MEMORY_PROVIDER = 'memory_provider',
  /** 上下文引擎：替代上下文管理 */
  CONTEXT_ENGINE = 'context_engine',
}

/** 插件工具定义 */
export interface PluginTool {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  execute: (
    args: Record<string, unknown>,
    context?: unknown
  ) => Promise<{
    success: boolean;
    output: unknown;
    error?: string;
  }>;
}

/** 插件钩子定义 */
export interface PluginHook {
  event: string;
  handler: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** 外部记忆提供商接口 */
export interface ExternalMemoryProvider {
  name: string;
  store: (
    key: string,
    value: string
  ) => Promise<{ success: boolean; error?: string }>;
  retrieve: (query: string, limit?: number) => Promise<string[]>;
  delete: (key: string) => Promise<{ success: boolean; error?: string }>;
}

/** 上下文引擎接口 */
export interface ContextEngine {
  name: string;
  buildContext: (
    input: string,
    history: Array<{ role: string; content: string }>
  ) => Promise<string>;
  refresh: () => Promise<void>;
}

/** 插件定义 */
export interface PluginDefinition {
  /** 插件唯一名称 */
  name: string;
  /** 版本号 */
  version: string;
  /** 插件类型 */
  type: PluginType;
  /** 插件描述 */
  description?: string;
  /** 提供的工具列表 */
  tools?: PluginTool[];
  /** 提供的钩子列表 */
  hooks?: PluginHook[];
  /** 记忆提供商（仅 MEMORY_PROVIDER 类型） */
  memoryProvider?: ExternalMemoryProvider;
  /** 上下文引擎（仅 CONTEXT_ENGINE 类型） */
  contextEngine?: ContextEngine;
  /** 初始化函数 */
  initialize?: () => Promise<void>;
  /** 销毁函数 */
  destroy?: () => Promise<void>;
}
