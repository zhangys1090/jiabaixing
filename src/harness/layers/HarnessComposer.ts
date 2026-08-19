/**
 * HarnessComposer — 运行时层组合器
 *
 * Phase 2: 配置驱动组合的核心引擎
 * 根据 HarnessConfigManager 的配置，动态组装各层实现。
 * 支持运行时层切换（热替换），无需重启 Agent。
 *
 * 设计理念（参考 DeepSeek Harness / Cordis）：
 * - 配置驱动：层实现由配置文件声明，而非硬编码
 * - 运行时切换：可以在运行中替换某一层的实现
 * - 插件扩展：第三方实现通过 plugin:xxx 前缀引用
 * - 优雅降级：如果指定实现不可用，回退到默认实现
 */

import { Logger } from '../../utils/Logger';
import { EventStore } from '../persistence/EventStore';
import { EventStoreBridge } from '../persistence/EventStoreBridge';
import { SessionReplay } from '../persistence/SessionReplay';
import { ToolRegistry } from '../tools/registry/ToolRegistry';
import {
    HarnessConfigManager,
    type HarnessConfigFile,
    type LayerConfig,
} from './HarnessConfigManager';
import type {
    ILayerPort,
    IPersistenceLayer,
    IToolLayer,
    LayerName
} from './interfaces';

export interface LayerInstance {
  name: LayerName;
  implementation: string;
  instance: ILayerPort | unknown;
  initialized: boolean;
  initializedAt: number;
}

export interface ComposerDeps {
  eventBus?: EventBus;
  dataDir?: string;
}

type LayerFactory = (config: LayerConfig, deps: ComposerDeps) => Promise<ILayerPort | unknown>;

export class HarnessComposer {
  private configManager: HarnessConfigManager;
  private deps: ComposerDeps;
  private layers: Map<LayerName, LayerInstance> = new Map();
  private factories: Map<string, LayerFactory> = new Map();
  private initialized = false;

  constructor(deps: ComposerDeps = {}, configPath?: string) {
    this.deps = deps;
    this.configManager = new HarnessConfigManager(configPath);
    this.registerBuiltinFactories();
  }

  private registerBuiltinFactories(): void {
    this.factories.set('tools:builtin', async (config, deps) => {
      return this.createBuiltinToolLayer(config, deps);
    });

    this.factories.set('persistence:event-sourcing', async (config, deps) => {
      return this.createEventSourcingPersistenceLayer(config, deps);
    });

    this.factories.set('persistence:legacy', async (config, deps) => {
      return this.createLegacyPersistenceLayer(config, deps);
    });

    this.factories.set('context:unified-pipeline', async (config, _deps) => {
      return {
        layerName: 'context' as const,
        initialized: false,
        async initialize() { this.initialized = true; },
        async shutdown() { this.initialized = false; },
      };
    });

    this.factories.set('verification:builtin', async (config, _deps) => {
      return {
        layerName: 'verification' as const,
        initialized: false,
        async initialize() { this.initialized = true; },
        async shutdown() { this.initialized = false; },
      };
    });

    this.factories.set('constraints:builtin', async (config, _deps) => {
      return {
        layerName: 'constraints' as const,
        initialized: false,
        async initialize() { this.initialized = true; },
        async shutdown() { this.initialized = false; },
      };
    });

    this.factories.set('loop:python-backend', async (config, _deps) => {
      return {
        layerName: 'loop' as const,
        initialized: false,
        async initialize() { this.initialized = true; },
        async shutdown() { this.initialized = false; },
      };
    });

    this.factories.set('loop:local', async (config, _deps) => {
      return {
        layerName: 'loop' as const,
        initialized: false,
        async initialize() { this.initialized = true; },
        async shutdown() { this.initialized = false; },
      };
    });
  }

  registerFactory(layerName: LayerName, implementation: string, factory: LayerFactory): void {
    this.factories.set(`${layerName}:${implementation}`, factory);
    Logger.info(
      `HarnessComposer: 注册层工厂 ${layerName}:${implementation}`,
      'HarnessComposer'
    );
  }

  async compose(configPath?: string): Promise<Map<LayerName, LayerInstance>> {
    const config = this.configManager.load(configPath);

    Logger.info('🏗️ HarnessComposer: 开始组装层...', 'HarnessComposer');

    for (const [layerName, layerConfig] of Object.entries(config.layers)) {
      if (!layerConfig) continue;

      if (!layerConfig.enabled) {
        Logger.info(
          `  ⏭️ ${layerName}: 已禁用`,
          'HarnessComposer'
        );
        continue;
      }

      try {
        const instance = await this.createLayer(
          layerName as LayerName,
          layerConfig
        );

        this.layers.set(layerName as LayerName, {
          name: layerName as LayerName,
          implementation: layerConfig.implementation,
          instance,
          initialized: true,
          initializedAt: Date.now(),
        });

        Logger.info(
          `  ✅ ${layerName}: ${layerConfig.implementation}`,
          'HarnessComposer'
        );
      } catch (error) {
        Logger.error(
          `  ❌ ${layerName}: ${layerConfig.implementation} 初始化失败 - ${(error as Error).message}`,
          error as Error,
          'HarnessComposer'
        );

        await this.tryFallback(layerName as LayerName, layerConfig);
      }
    }

    this.initialized = true;
    Logger.info(
      `🏗️ HarnessComposer: 组装完成 (${this.layers.size} 层)`,
      'HarnessComposer'
    );

    return this.layers;
  }

  async switchLayer(layerName: LayerName, implementation: string, config?: Record<string, unknown>): Promise<boolean> {
    const currentLayer = this.layers.get(layerName);

    if (currentLayer?.instance && typeof (currentLayer.instance as ILayerPort).shutdown === 'function') {
      try {
        await (currentLayer.instance as ILayerPort).shutdown();
      } catch (error) {
        Logger.warn(
          `HarnessComposer: 关闭旧层 ${layerName} 失败: ${(error as Error).message}`,
          'HarnessComposer'
        );
      }
    }

    const layerConfig: LayerConfig = {
      implementation,
      enabled: true,
      config: config ?? {},
    };

    try {
      const instance = await this.createLayer(layerName, layerConfig);

      this.layers.set(layerName, {
        name: layerName,
        implementation,
        instance,
        initialized: true,
        initializedAt: Date.now(),
      });

      this.configManager.setLayerConfig(layerName, layerConfig);

      Logger.info(
        `HarnessComposer: 层切换 ${layerName} → ${implementation}`,
        'HarnessComposer'
      );

      return true;
    } catch (error) {
      Logger.error(
        `HarnessComposer: 层切换 ${layerName} → ${implementation} 失败`,
        error as Error,
        'HarnessComposer'
      );
      return false;
    }
  }

  getLayer<T = unknown>(layerName: LayerName): T | null {
    return (this.layers.get(layerName)?.instance as T) ?? null;
  }

  getLayerInfo(layerName: LayerName): LayerInstance | null {
    return this.layers.get(layerName) ?? null;
  }

  listLayers(): Array<{ name: LayerName; implementation: string; initialized: boolean }> {
    return Array.from(this.layers.entries()).map(([name, instance]) => ({
      name,
      implementation: instance.implementation,
      initialized: instance.initialized,
    }));
  }

  getConfig(): HarnessConfigFile {
    return this.configManager.getConfig();
  }

  getConfigManager(): HarnessConfigManager {
    return this.configManager;
  }

  async shutdown(): Promise<void> {
    for (const [name, layer] of this.layers) {
      if (layer.instance && typeof (layer.instance as ILayerPort).shutdown === 'function') {
        try {
          await (layer.instance as ILayerPort).shutdown();
        } catch (error) {
          Logger.warn(
            `HarnessComposer: 关闭层 ${name} 失败: ${(error as Error).message}`,
            'HarnessComposer'
          );
        }
      }
    }

    this.layers.clear();
    this.initialized = false;
    this.configManager.destroy();
    Logger.info('HarnessComposer: 已关闭所有层', 'HarnessComposer');
  }

  private async createLayer(layerName: LayerName, config: LayerConfig): Promise<ILayerPort | unknown> {
    const factoryKey = `${layerName}:${config.implementation}`;
    const factory = this.factories.get(factoryKey);

    if (!factory) {
      if (config.implementation.startsWith('plugin:')) {
        return this.createPluginLayer(layerName, config);
      }
      throw new Error(`未注册的层实现: ${factoryKey}`);
    }

    return factory(config, this.deps);
  }

  private async createPluginLayer(layerName: LayerName, config: LayerConfig): Promise<ILayerPort> {
    const pluginName = config.implementation.replace('plugin:', '');
    Logger.info(
      `HarnessComposer: 尝试加载插件层 ${pluginName} (Phase 4 功能)`,
      'HarnessComposer'
    );

    return {
      layerName,
      initialized: false,
      async initialize() { this.initialized = true; },
      async shutdown() { this.initialized = false; },
    };
  }

  private async tryFallback(layerName: LayerName, failedConfig: LayerConfig): Promise<void> {
    const fallbacks: Partial<Record<LayerName, string>> = {
      tools: 'builtin',
      context: 'unified-pipeline',
      persistence: 'legacy',
      verification: 'builtin',
      constraints: 'builtin',
      loop: 'python-backend',
    };

    const fallbackImpl = fallbacks[layerName];
    if (!fallbackImpl || fallbackImpl === failedConfig.implementation) {
      Logger.warn(
        `HarnessComposer: ${layerName} 无可用回退实现`,
        'HarnessComposer'
      );
      return;
    }

    Logger.info(
      `HarnessComposer: ${layerName} 回退到 ${fallbackImpl}`,
      'HarnessComposer'
    );

    try {
      const fallbackConfig: LayerConfig = {
        implementation: fallbackImpl,
        enabled: true,
        config: {},
      };

      const instance = await this.createLayer(layerName, fallbackConfig);

      this.layers.set(layerName, {
        name: layerName,
        implementation: fallbackImpl,
        instance,
        initialized: true,
        initializedAt: Date.now(),
      });
    } catch (error) {
      Logger.error(
        `HarnessComposer: ${layerName} 回退实现 ${fallbackImpl} 也失败了`,
        error as Error,
        'HarnessComposer'
      );
    }
  }

  private async createBuiltinToolLayer(config: LayerConfig, deps: ComposerDeps): Promise<IToolLayer> {
    const toolRegistry = new ToolRegistry();

    return {
      layerName: 'tools',
      async initialize(layerDeps) {
        Logger.info('BuiltinToolLayer: 初始化', 'HarnessComposer');
      },
      getRegistry() {
        return toolRegistry as unknown as IToolLayer['getRegistry'] extends () => infer R ? R : never;
      },
      async shutdown() {
        Logger.info('BuiltinToolLayer: 关闭', 'HarnessComposer');
      },
    };
  }

  private async createEventSourcingPersistenceLayer(config: LayerConfig, deps: ComposerDeps): Promise<IPersistenceLayer> {
    const eventStore = new EventStore({
      dbPath: config.config.dbPath as string | undefined,
      snapshotInterval: config.config.snapshotInterval as number | undefined,
    });
    eventStore.initialize();

    let sessionReplay: SessionReplay | null = null;
    let bridge: EventStoreBridge | null = null;

    if (deps.eventBus) {
      sessionReplay = new SessionReplay(eventStore);
      bridge = new EventStoreBridge(deps.eventBus, eventStore, {
        sessionId: `session_${Date.now()}`,
      });
      bridge.start();
    }

    return {
      layerName: 'persistence',
      async initialize() {},
      getEventStore() {
        return eventStore as unknown as IPersistenceLayer['getEventStore'] extends () => infer R ? R : never;
      },
      getSessionReplay() {
        return sessionReplay as unknown as IPersistenceLayer['getSessionReplay'] extends () => infer R ? R : never;
      },
      async shutdown() {
        bridge?.stop();
        eventStore.destroy();
      },
    };
  }

  private async createLegacyPersistenceLayer(config: LayerConfig, deps: ComposerDeps): Promise<IPersistenceLayer> {
    return {
      layerName: 'persistence',
      async initialize() {},
      getEventStore() { return null; },
      getSessionReplay() { return null; },
      async shutdown() {},
    };
  }
}
