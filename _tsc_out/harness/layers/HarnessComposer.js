"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HarnessComposer = void 0;
const Logger_1 = require("../../utils/Logger");
const EventStore_1 = require("../persistence/EventStore");
const EventStoreBridge_1 = require("../persistence/EventStoreBridge");
const SessionReplay_1 = require("../persistence/SessionReplay");
const ToolRegistry_1 = require("../tools/registry/ToolRegistry");
const HarnessConfigManager_1 = require("./HarnessConfigManager");
class HarnessComposer {
    configManager;
    deps;
    layers = new Map();
    factories = new Map();
    initialized = false;
    constructor(deps = {}, configPath) {
        this.deps = deps;
        this.configManager = new HarnessConfigManager_1.HarnessConfigManager(configPath);
        this.registerBuiltinFactories();
    }
    registerBuiltinFactories() {
        this.factories.set('tools:builtin', async (config, deps) => {
            return this.createBuiltinToolLayer(config, deps);
        });
        this.factories.set('persistence:event-sourcing', async (config, deps) => {
            return this.createEventSourcingPersistenceLayer(config, deps);
        });
        this.factories.set('persistence:legacy', async (config, deps) => {
            return this.createLegacyPersistenceLayer(config, deps);
        });
        this.factories.set('context:unified-pipeline', async (_config, _deps) => {
            const layer = {
                layerName: 'context',
                initialized: false,
                async initialize() {
                    this.initialized = true;
                },
                async shutdown() {
                    this.initialized = false;
                },
            };
            return layer;
        });
        this.factories.set('verification:builtin', async (_config, _deps) => {
            const layer = {
                layerName: 'verification',
                initialized: false,
                async initialize() {
                    this.initialized = true;
                },
                async shutdown() {
                    this.initialized = false;
                },
            };
            return layer;
        });
        this.factories.set('constraints:builtin', async (_config, _deps) => {
            const layer = {
                layerName: 'constraints',
                initialized: false,
                async initialize() {
                    this.initialized = true;
                },
                async shutdown() {
                    this.initialized = false;
                },
            };
            return layer;
        });
        this.factories.set('loop:python-backend', async (_config, _deps) => {
            const layer = {
                layerName: 'loop',
                initialized: false,
                async initialize() {
                    this.initialized = true;
                },
                async shutdown() {
                    this.initialized = false;
                },
            };
            return layer;
        });
        this.factories.set('loop:local', async (_config, _deps) => {
            const layer = {
                layerName: 'loop',
                initialized: false,
                async initialize() {
                    this.initialized = true;
                },
                async shutdown() {
                    this.initialized = false;
                },
            };
            return layer;
        });
    }
    registerFactory(layerName, implementation, factory) {
        this.factories.set(`${layerName}:${implementation}`, factory);
        Logger_1.Logger.info(`HarnessComposer: 注册层工厂 ${layerName}:${implementation}`, 'HarnessComposer');
    }
    async compose(configPath) {
        const config = this.configManager.load(configPath);
        Logger_1.Logger.info('🏗️ HarnessComposer: 开始组装层...', 'HarnessComposer');
        for (const [layerName, layerConfig] of Object.entries(config.layers)) {
            if (!layerConfig)
                continue;
            if (!layerConfig.enabled) {
                Logger_1.Logger.info(`  ⏭️ ${layerName}: 已禁用`, 'HarnessComposer');
                continue;
            }
            try {
                const instance = await this.createLayer(layerName, layerConfig);
                this.layers.set(layerName, {
                    name: layerName,
                    implementation: layerConfig.implementation,
                    instance,
                    initialized: true,
                    initializedAt: Date.now(),
                });
                Logger_1.Logger.info(`  ✅ ${layerName}: ${layerConfig.implementation}`, 'HarnessComposer');
            }
            catch (error) {
                Logger_1.Logger.error(`  ❌ ${layerName}: ${layerConfig.implementation} 初始化失败 - ${error.message}`, error, 'HarnessComposer');
                await this.tryFallback(layerName, layerConfig);
            }
        }
        this.initialized = true;
        Logger_1.Logger.info(`🏗️ HarnessComposer: 组装完成 (${this.layers.size} 层)`, 'HarnessComposer');
        return this.layers;
    }
    async switchLayer(layerName, implementation, config) {
        const currentLayer = this.layers.get(layerName);
        if (currentLayer?.instance &&
            typeof currentLayer.instance.shutdown === 'function') {
            try {
                await currentLayer.instance.shutdown();
            }
            catch (error) {
                Logger_1.Logger.warn(`HarnessComposer: 关闭旧层 ${layerName} 失败: ${error.message}`, 'HarnessComposer');
            }
        }
        const layerConfig = {
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
            Logger_1.Logger.info(`HarnessComposer: 层切换 ${layerName} → ${implementation}`, 'HarnessComposer');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error(`HarnessComposer: 层切换 ${layerName} → ${implementation} 失败`, error, 'HarnessComposer');
            return false;
        }
    }
    getLayer(layerName) {
        return this.layers.get(layerName)?.instance ?? null;
    }
    getLayerInfo(layerName) {
        return this.layers.get(layerName) ?? null;
    }
    listLayers() {
        return Array.from(this.layers.entries()).map(([name, instance]) => ({
            name,
            implementation: instance.implementation,
            initialized: instance.initialized,
        }));
    }
    getConfig() {
        return this.configManager.getConfig();
    }
    getConfigManager() {
        return this.configManager;
    }
    async shutdown() {
        for (const [name, layer] of this.layers) {
            if (layer.instance &&
                typeof layer.instance.shutdown === 'function') {
                try {
                    await layer.instance.shutdown();
                }
                catch (error) {
                    Logger_1.Logger.warn(`HarnessComposer: 关闭层 ${name} 失败: ${error.message}`, 'HarnessComposer');
                }
            }
        }
        this.layers.clear();
        this.initialized = false;
        this.configManager.destroy();
        Logger_1.Logger.info('HarnessComposer: 已关闭所有层', 'HarnessComposer');
    }
    async createLayer(layerName, config) {
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
    async createPluginLayer(layerName, _config) {
        const pluginName = _config.implementation.replace('plugin:', '');
        Logger_1.Logger.info(`HarnessComposer: 尝试加载插件层 ${pluginName} (Phase 4 功能)`, 'HarnessComposer');
        const layer = {
            layerName,
            initialized: false,
            async initialize() {
                this.initialized = true;
            },
            async shutdown() {
                this.initialized = false;
            },
        };
        return layer;
    }
    async tryFallback(layerName, failedConfig) {
        const fallbacks = {
            tools: 'builtin',
            context: 'unified-pipeline',
            persistence: 'legacy',
            verification: 'builtin',
            constraints: 'builtin',
            loop: 'python-backend',
        };
        const fallbackImpl = fallbacks[layerName];
        if (!fallbackImpl || fallbackImpl === failedConfig.implementation) {
            Logger_1.Logger.warn(`HarnessComposer: ${layerName} 无可用回退实现`, 'HarnessComposer');
            return;
        }
        Logger_1.Logger.info(`HarnessComposer: ${layerName} 回退到 ${fallbackImpl}`, 'HarnessComposer');
        try {
            const fallbackConfig = {
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
        }
        catch (error) {
            Logger_1.Logger.error(`HarnessComposer: ${layerName} 回退实现 ${fallbackImpl} 也失败了`, error, 'HarnessComposer');
        }
    }
    async createBuiltinToolLayer(_config, _deps) {
        const toolRegistry = new ToolRegistry_1.ToolRegistry();
        return {
            layerName: 'tools',
            async initialize(_layerDeps) {
                Logger_1.Logger.info('BuiltinToolLayer: 初始化', 'HarnessComposer');
            },
            getRegistry() {
                return toolRegistry;
            },
            async shutdown() {
                Logger_1.Logger.info('BuiltinToolLayer: 关闭', 'HarnessComposer');
            },
        };
    }
    async createEventSourcingPersistenceLayer(config, deps) {
        const eventStore = new EventStore_1.EventStore({
            dbPath: config.config.dbPath,
            snapshotInterval: config.config.snapshotInterval,
        });
        eventStore.initialize();
        let sessionReplay = null;
        let bridge = null;
        if (deps.eventBus) {
            sessionReplay = new SessionReplay_1.SessionReplay(eventStore);
            bridge = new EventStoreBridge_1.EventStoreBridge(deps.eventBus, eventStore, {
                sessionId: `session_${Date.now()}`,
            });
            bridge.start();
        }
        return {
            layerName: 'persistence',
            async initialize() { },
            getEventStore() {
                return eventStore;
            },
            getSessionReplay() {
                return sessionReplay;
            },
            async shutdown() {
                bridge?.stop();
                eventStore.destroy();
            },
        };
    }
    async createLegacyPersistenceLayer(_config, _deps) {
        return {
            layerName: 'persistence',
            async initialize() { },
            getEventStore() {
                return null;
            },
            getSessionReplay() {
                return null;
            },
            async shutdown() { },
        };
    }
}
exports.HarnessComposer = HarnessComposer;
