import { Logger } from '../../utils/Logger';
import type {
  PluginAPI,
  PluginContext,
  PluginHook,
  PluginInstance,
  PluginLifecycle,
  PluginLogger,
  PluginManifest,
  PluginPanelDefinition,
  PluginSettings,
  PluginStorage,
  PluginToolDefinition,
} from './pluginTypes';

export class PluginRegistry {
  private plugins: Map<string, PluginInstance> = new Map();
  private toolMap: Map<
    string,
    { pluginId: string; definition: PluginToolDefinition }
  > = new Map();
  private panelMap: Map<
    string,
    { pluginId: string; definition: PluginPanelDefinition }
  > = new Map();
  private pluginStorages: Map<string, Map<string, unknown>> = new Map();
  private pluginSettings: Map<string, Record<string, unknown>> = new Map();
  private searchPaths: string[];

  constructor(searchPaths?: string[]) {
    this.searchPaths = searchPaths || ['.jiabaixing/plugins', 'plugins'];
  }

  async loadPlugin(
    manifest: PluginManifest,
    lifecycle?: PluginLifecycle
  ): Promise<boolean> {
    if (this.plugins.has(manifest.id)) {
      Logger.warn(`插件 ${manifest.id} 已加载，跳过`, 'PluginRegistry');
      return false;
    }

    const storage = this.createPluginStorage(manifest.id);
    const settings = this.createPluginSettings(manifest.id, manifest);
    const logger = this.createPluginLogger(manifest.id);
    const api = this.createPluginAPI(manifest.id);

    const context: PluginContext = {
      pluginId: manifest.id,
      logger,
      storage,
      settings,
      api,
    };

    const hooks: PluginInstance['hooks'] = {};
    if (lifecycle) {
      const hookMap: Record<string, PluginHook> = {
        onLoad: 'onLoad',
        onUnload: 'onUnload',
        onMessage: 'onMessage',
        onToolCall: 'onToolCall',
        onToolResult: 'onToolResult',
        onSessionStart: 'onSessionStart',
        onSessionEnd: 'onSessionEnd',
        onProjectSwitch: 'onProjectSwitch',
        onSettingsChange: 'onSettingsChange',
      };
      for (const [method, hookName] of Object.entries(hookMap)) {
        if (
          typeof (lifecycle as Record<string, unknown>)[method] === 'function'
        ) {
          hooks[hookName] = (
            lifecycle as Record<string, (...args: unknown[]) => unknown>
          )[method];
        }
      }
    }

    const instance: PluginInstance = {
      manifest,
      context,
      status: 'loaded',
      hooks,
    };

    this.plugins.set(manifest.id, instance);

    try {
      if (hooks.onLoad) {
        await hooks.onLoad(context);
      }
      instance.status = 'active';
      instance.loadedAt = new Date().toISOString();
      Logger.info(
        `插件 ${manifest.id} (${manifest.name} v${manifest.version}) 加载成功`,
        'PluginRegistry'
      );
      return true;
    } catch (err) {
      instance.status = 'error';
      instance.error = (err as Error).message;
      Logger.error(
        `插件 ${manifest.id} 加载失败: ${(err as Error).message}`,
        err as Error,
        'PluginRegistry'
      );
      return false;
    }
  }

  async unloadPlugin(pluginId: string): Promise<boolean> {
    const instance = this.plugins.get(pluginId);
    if (!instance) return false;

    try {
      if (instance.hooks.onUnload) {
        await instance.hooks.onUnload();
      }

      for (const [toolName, entry] of this.toolMap.entries()) {
        if (entry.pluginId === pluginId) {
          this.toolMap.delete(toolName);
        }
      }

      for (const [panelId, entry] of this.panelMap.entries()) {
        if (entry.pluginId === pluginId) {
          this.panelMap.delete(panelId);
        }
      }

      this.plugins.delete(pluginId);
      this.pluginStorages.delete(pluginId);
      this.pluginSettings.delete(pluginId);

      Logger.info(`插件 ${pluginId} 已卸载`, 'PluginRegistry');
      return true;
    } catch (err) {
      Logger.error(
        `插件 ${pluginId} 卸载失败: ${(err as Error).message}`,
        err as Error,
        'PluginRegistry'
      );
      return false;
    }
  }

  async emitHook(hookName: PluginHook, ...args: unknown[]): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const instance of this.plugins.values()) {
      if (instance.status !== 'active') continue;
      const hook = instance.hooks[hookName];
      if (hook) {
        try {
          const result = hook(...args);
          if (result instanceof Promise) {
            promises.push(result);
          }
        } catch (err) {
          Logger.error(
            `插件 ${instance.manifest.id} hook ${hookName} 执行失败: ${(err as Error).message}`,
            err as Error,
            'PluginRegistry'
          );
        }
      }
    }
    await Promise.allSettled(promises);
  }

  getPlugin(pluginId: string): PluginInstance | undefined {
    return this.plugins.get(pluginId);
  }

  getAllPlugins(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  getActivePlugins(): PluginInstance[] {
    return Array.from(this.plugins.values()).filter(
      (p) => p.status === 'active'
    );
  }

  getPluginTools(): Array<{
    pluginId: string;
    definition: PluginToolDefinition;
  }> {
    return Array.from(this.toolMap.values());
  }

  getPluginPanels(): Array<{
    pluginId: string;
    definition: PluginPanelDefinition;
  }> {
    return Array.from(this.panelMap.values());
  }

  async executePluginTool(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const entry = this.toolMap.get(toolName);
    if (!entry) {
      throw new Error(`未找到插件工具: ${toolName}`);
    }

    const instance = this.plugins.get(entry.pluginId);
    if (!instance || instance.status !== 'active') {
      throw new Error(`插件 ${entry.pluginId} 未激活`);
    }

    return entry.definition.execute(params, instance.context);
  }

  private createPluginStorage(pluginId: string): PluginStorage {
    if (!this.pluginStorages.has(pluginId)) {
      this.pluginStorages.set(pluginId, new Map());
    }
    const map = this.pluginStorages.get(pluginId)!;

    return {
      get: <T = unknown>(key: string) => map.get(key) as T | undefined,
      set: (key: string, value: unknown) => map.set(key, value),
      delete: (key: string) => map.delete(key),
      clear: () => map.clear(),
      keys: () => Array.from(map.keys()),
    };
  }

  private createPluginSettings(
    pluginId: string,
    manifest: PluginManifest
  ): PluginSettings {
    const defaults: Record<string, unknown> = {};
    if (manifest.settings) {
      for (const setting of manifest.settings) {
        if (setting.default !== undefined) {
          defaults[setting.key] = setting.default;
        }
      }
    }

    if (!this.pluginSettings.has(pluginId)) {
      this.pluginSettings.set(pluginId, defaults);
    }

    const settings = this.pluginSettings.get(pluginId)!;

    return {
      get: <T = unknown>(key: string) => settings[key] as T | undefined,
      set: (key: string, value: unknown) => {
        settings[key] = value;
      },
      getAll: () => ({ ...settings }),
    };
  }

  private createPluginLogger(pluginId: string): PluginLogger {
    return {
      info: (message, ..._args) =>
        Logger.info(`[${pluginId}] ${message}`, 'Plugin'),
      warn: (message, ..._args) =>
        Logger.warn(`[${pluginId}] ${message}`, 'Plugin'),
      error: (message, ..._args) =>
        Logger.error(`[${pluginId}] ${message}`, undefined, 'Plugin'),
      debug: (message, ..._args) =>
        Logger.debug(`[${pluginId}] ${message}`, 'Plugin'),
    };
  }

  private createPluginAPI(pluginId: string): PluginAPI {
    return {
      registerTool: (definition: PluginToolDefinition) => {
        if (this.toolMap.has(definition.name)) {
          Logger.warn(`工具 ${definition.name} 已注册，跳过`, 'PluginRegistry');
          return;
        }
        this.toolMap.set(definition.name, { pluginId, definition });
        Logger.info(
          `插件 ${pluginId} 注册工具: ${definition.name}`,
          'PluginRegistry'
        );
      },

      unregisterTool: (name: string) => {
        const entry = this.toolMap.get(name);
        if (entry && entry.pluginId === pluginId) {
          this.toolMap.delete(name);
        }
      },

      callTool: async (name: string, params: Record<string, unknown>) => {
        return this.executePluginTool(name, params);
      },

      showNotification: (title: string, body: string) => {
        Logger.info(`[通知] ${title}: ${body}`, 'Plugin');
      },

      registerPanel: (panel: PluginPanelDefinition) => {
        this.panelMap.set(panel.id, { pluginId, definition: panel });
        Logger.info(`插件 ${pluginId} 注册面板: ${panel.id}`, 'PluginRegistry');
      },

      unregisterPanel: (id: string) => {
        const entry = this.panelMap.get(id);
        if (entry && entry.pluginId === pluginId) {
          this.panelMap.delete(id);
        }
      },

      getActiveProject: () => {
        return null;
      },

      getLocale: () => {
        return 'zh-CN';
      },
    };
  }
}

export const pluginRegistry = new PluginRegistry();
