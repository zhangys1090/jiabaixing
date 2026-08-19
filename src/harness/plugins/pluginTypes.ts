export type PluginHook =
  | 'onLoad'
  | 'onUnload'
  | 'onMessage'
  | 'onToolCall'
  | 'onToolResult'
  | 'onSessionStart'
  | 'onSessionEnd'
  | 'onProjectSwitch'
  | 'onSettingsChange';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  main: string;
  icon?: string;
  permissions?: PluginPermission[];
  hooks?: PluginHook[];
  settings?: PluginSettingDefinition[];
}

export interface PluginSettingDefinition {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  default?: unknown;
  options?: Array<{ label: string; value: string }>;
  description?: string;
}

export type PluginPermission =
  | 'file:read'
  | 'file:write'
  | 'network:request'
  | 'system:exec'
  | 'memory:read'
  | 'memory:write'
  | 'tool:register'
  | 'tool:call'
  | 'ui:panel'
  | 'ui:notification';

export interface PluginContext {
  pluginId: string;
  logger: PluginLogger;
  storage: PluginStorage;
  settings: PluginSettings;
  api: PluginAPI;
}

export interface PluginLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
}

export interface PluginStorage {
  get: <T = unknown>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
  clear: () => void;
  keys: () => string[];
}

export interface PluginSettings {
  get: <T = unknown>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
  getAll: () => Record<string, unknown>;
}

export interface PluginAPI {
  registerTool: (definition: PluginToolDefinition) => void;
  unregisterTool: (name: string) => void;
  callTool: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  showNotification: (title: string, body: string) => void;
  registerPanel: (panel: PluginPanelDefinition) => void;
  unregisterPanel: (id: string) => void;
  getActiveProject: () => { id: string; name: string; path: string } | null;
  getLocale: () => string;
}

export interface PluginToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, PluginToolParam>;
  execute: (
    params: Record<string, unknown>,
    context: PluginContext
  ) => Promise<PluginToolResult>;
}

export interface PluginToolParam {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
}

export interface PluginToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PluginPanelDefinition {
  id: string;
  label: string;
  icon?: string;
  component: string;
  position?: 'sidebar' | 'main' | 'bottom';
  order?: number;
}

export interface PluginInstance {
  manifest: PluginManifest;
  context: PluginContext;
  status: 'loaded' | 'active' | 'error' | 'disabled';
  loadedAt?: string;
  error?: string;
  hooks: Partial<
    Record<PluginHook, (...args: unknown[]) => unknown | Promise<unknown>>
  >;
}

export interface PluginLifecycle {
  onLoad?: (context: PluginContext) => void | Promise<void>;
  onUnload?: () => void | Promise<void>;
  onMessage?: (message: unknown) => unknown | Promise<unknown>;
  onToolCall?: (
    toolName: string,
    params: Record<string, unknown>
  ) => unknown | Promise<unknown>;
  onToolResult?: (toolName: string, result: unknown) => void | Promise<void>;
  onSessionStart?: (sessionId: string) => void | Promise<void>;
  onSessionEnd?: (sessionId: string) => void | Promise<void>;
  onProjectSwitch?: (projectId: string) => void | Promise<void>;
  onSettingsChange?: (
    settings: Record<string, unknown>
  ) => void | Promise<void>;
}
