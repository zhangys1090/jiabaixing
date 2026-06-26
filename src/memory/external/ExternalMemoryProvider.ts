/**
 * 外部记忆提供商接口与注册表
 *
 * 统一管理外部记忆后端（Honcho、Mem0、OpenViking 等）
 * 设计参考: Hermes Agent 记忆提供商系统
 */

import { Logger } from '../../utils/Logger';

/** 外部记忆提供商接口 */
export interface ExternalMemoryProvider {
  /** 提供商名称 */
  name: string;
  /** 存储记忆 */
  store: (
    key: string,
    value: string
  ) => Promise<{ success: boolean; error?: string }>;
  /** 检索记忆 */
  retrieve: (query: string, limit?: number) => Promise<string[]>;
  /** 删除记忆 */
  delete: (key: string) => Promise<{ success: boolean; error?: string }>;
}

/** 外部记忆提供商注册表 */
export class ExternalMemoryProviderRegistry {
  private providers: Map<string, ExternalMemoryProvider> = new Map();
  private activeProviderName: string | null = null;

  /**
   * 注册外部记忆提供商
   */
  register(provider: ExternalMemoryProvider): void {
    if (this.providers.has(provider.name)) {
      Logger.warn(
        `外部记忆提供商 ${provider.name} 已存在，将被覆盖`,
        'ExternalMemoryRegistry'
      );
    }

    this.providers.set(provider.name, provider);

    // 首个注册的提供商自动设为活跃
    if (this.providers.size === 1) {
      this.activeProviderName = provider.name;
    }

    Logger.info(
      `外部记忆提供商已注册: ${provider.name}`,
      'ExternalMemoryRegistry'
    );
  }

  /**
   * 注销外部记忆提供商
   */
  unregister(name: string): boolean {
    const removed = this.providers.delete(name);
    if (removed && this.activeProviderName === name) {
      // 切换到第一个可用的提供商
      const first = this.providers.keys().next().value;
      this.activeProviderName = first ?? null;
    }
    return removed;
  }

  /**
   * 获取指定提供商
   */
  getProvider(name?: string): ExternalMemoryProvider | undefined {
    const targetName = name || this.activeProviderName || '';
    return this.providers.get(targetName);
  }

  /**
   * 获取活跃提供商
   */
  getActiveProvider(): ExternalMemoryProvider | undefined {
    if (!this.activeProviderName) return undefined;
    return this.providers.get(this.activeProviderName);
  }

  /**
   * 设置活跃提供商
   */
  setActiveProvider(name: string): boolean {
    if (!this.providers.has(name)) return false;
    this.activeProviderName = name;
    Logger.info(`活跃记忆提供商切换为: ${name}`, 'ExternalMemoryRegistry');
    return true;
  }

  /**
   * 列出所有提供商
   */
  listProviders(): Array<{ name: string; isActive: boolean }> {
    return Array.from(this.providers.keys()).map((name) => ({
      name,
      isActive: name === this.activeProviderName,
    }));
  }

  /**
   * 通过活跃提供商存储记忆
   */
  async store(
    key: string,
    value: string
  ): Promise<{ success: boolean; error?: string }> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return { success: false, error: '无活跃的外部记忆提供商' };
    }

    try {
      return await provider.store(key, value);
    } catch (err) {
      Logger.error(
        `外部记忆存储失败: ${(err as Error).message}`,
        err as Error,
        'ExternalMemoryRegistry'
      );
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * 通过活跃提供商检索记忆
   */
  async retrieve(query: string, limit?: number): Promise<string[]> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return [];
    }

    try {
      return await provider.retrieve(query, limit);
    } catch (err) {
      Logger.error(
        `外部记忆检索失败: ${(err as Error).message}`,
        err as Error,
        'ExternalMemoryRegistry'
      );
      return [];
    }
  }

  /**
   * 通过活跃提供商删除记忆
   */
  async delete(key: string): Promise<{ success: boolean; error?: string }> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return { success: false, error: '无活跃的外部记忆提供商' };
    }

    try {
      return await provider.delete(key);
    } catch (err) {
      Logger.error(
        `外部记忆删除失败: ${(err as Error).message}`,
        err as Error,
        'ExternalMemoryRegistry'
      );
      return { success: false, error: (err as Error).message };
    }
  }
}
