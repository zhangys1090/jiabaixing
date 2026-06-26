/**
 * 统一插件管理器
 *
 * 管理三种类型插件的注册、注销和生命周期
 * 设计参考: Hermes Agent 插件管理
 */

import { Logger } from '../utils/Logger';
import {
  PluginType,
  PluginDefinition,
  PluginTool,
  ExternalMemoryProvider,
  ContextEngine,
} from './PluginInterface';

export class PluginManager {
  private plugins: Map<string, PluginDefinition> = new Map();
  private initialized: Set<string> = new Set();

  /**
   * 注册插件
   * @param plugin - 插件定义
   * @throws {Error} 当插件定义无效时抛出错误
   */
  register(plugin: PluginDefinition): void {
    if (this.plugins.has(plugin.name)) {
      Logger.warn(`插件 ${plugin.name} 已存在，将被覆盖`, 'PluginManager');
    }

    // 验证插件定义
    this.validatePlugin(plugin);

    this.plugins.set(plugin.name, plugin);
    Logger.info(
      `插件已注册: ${plugin.name} v${plugin.version} [${plugin.type}]`,
      'PluginManager'
    );
  }

  /**
   * 注销插件
   * @param pluginName - 插件名称
   */
  async unregister(pluginName: string): Promise<void> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return;

    // 调用销毁函数
    if (plugin.destroy && this.initialized.has(pluginName)) {
      try {
        await plugin.destroy();
      } catch (err) {
        Logger.error(
          `插件 ${pluginName} 销毁失败: ${(err as Error).message}`,
          err as Error,
          'PluginManager'
        );
      }
    }

    this.plugins.delete(pluginName);
    this.initialized.delete(pluginName);
    Logger.info(`插件已注销: ${pluginName}`, 'PluginManager');
  }

  /**
   * 初始化所有插件
   */
  async initializeAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      if (this.initialized.has(name)) continue;

      if (plugin.initialize) {
        try {
          await plugin.initialize();
          this.initialized.add(name);
          Logger.info(`插件已初始化: ${name}`, 'PluginManager');
        } catch (err) {
          Logger.error(
            `插件 ${name} 初始化失败: ${(err as Error).message}`,
            err as Error,
            'PluginManager'
          );
        }
      } else {
        this.initialized.add(name);
      }
    }
  }

  /**
   * 获取指定插件
   * @param name - 插件名称
   * @returns 插件定义，不存在则返回 undefined
   */
  getPlugin(name: string): PluginDefinition | undefined {
    return this.plugins.get(name);
  }

  /**
   * 获取所有插件
   * @returns 插件定义数组
   */
  getAllPlugins(): PluginDefinition[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 获取所有记忆提供商
   * @returns 记忆提供商数组
   */
  getMemoryProviders(): Array<{
    pluginName: string;
    provider: ExternalMemoryProvider;
  }> {
    const result: Array<{
      pluginName: string;
      provider: ExternalMemoryProvider;
    }> = [];

    for (const [name, plugin] of this.plugins) {
      if (plugin.type === PluginType.MEMORY_PROVIDER && plugin.memoryProvider) {
        result.push({ pluginName: name, provider: plugin.memoryProvider });
      }
    }

    return result;
  }

  /**
   * 获取所有上下文引擎
   * @returns 上下文引擎数组
   */
  getContextEngines(): Array<{ pluginName: string; engine: ContextEngine }> {
    const result: Array<{ pluginName: string; engine: ContextEngine }> = [];

    for (const [name, plugin] of this.plugins) {
      if (plugin.type === PluginType.CONTEXT_ENGINE && plugin.contextEngine) {
        result.push({ pluginName: name, engine: plugin.contextEngine });
      }
    }

    return result;
  }

  /**
   * 获取所有插件工具
   * @returns 插件工具数组
   */
  getAllTools(): PluginTool[] {
    const tools: PluginTool[] = [];

    for (const plugin of this.plugins.values()) {
      if (plugin.tools) {
        tools.push(...plugin.tools);
      }
    }

    return tools;
  }

  /**
   * 列出已注册插件
   * @returns 插件信息数组
   */
  listPlugins(): Array<{
    name: string;
    version: string;
    type: PluginType;
    description?: string;
    initialized: boolean;
  }> {
    return Array.from(this.plugins.entries()).map(([name, plugin]) => ({
      name,
      version: plugin.version,
      type: plugin.type,
      description: plugin.description,
      initialized: this.initialized.has(name),
    }));
  }

  /**
   * 验证插件定义
   * @param plugin - 插件定义
   * @throws {Error} 当插件定义无效时抛出错误
   */
  private validatePlugin(plugin: PluginDefinition): void {
    if (!plugin.name) {
      throw new Error('插件名称不能为空');
    }
    if (!plugin.version) {
      throw new Error('插件版本不能为空');
    }

    if (plugin.type === PluginType.MEMORY_PROVIDER && !plugin.memoryProvider) {
      throw new Error('记忆提供商插件必须提供 memoryProvider');
    }

    if (plugin.type === PluginType.CONTEXT_ENGINE && !plugin.contextEngine) {
      throw new Error('上下文引擎插件必须提供 contextEngine');
    }
  }
}
