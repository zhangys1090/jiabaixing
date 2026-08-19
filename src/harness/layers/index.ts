/**
 * Harness Layers — 配置驱动组合层
 *
 * Phase 2 核心模块：
 * - interfaces: 各层标准化接口
 * - HarnessConfigManager: 配置文件解析与管理
 * - HarnessComposer: 运行时层组合器
 */

export type {
    IConstraintsLayer,
    IConstraintsLayerDeps,
    IConstraintsResultPort, IContextInputPort, IContextLayer,
    IContextLayerDeps, IContextOutputPort, IEventBusPort, IEventQueryPort, IEventStoreEventPort, IEventStorePort, IHistoryProviderPort, ILayerPort,
    ILayerRegistry, ILLMPort, ILoopInputPort, ILoopLayer,
    ILoopLayerDeps, ILoopResultPort, IMemoryEnginePort, IParamDefPort, IPermissionGuardPort, IPersistenceLayer,
    IPersistenceLayerDeps, IPersonaCorePort, ISchemaValidatorPort, ISessionReplayPort, IToolContextPort, IToolDefinitionPort, IToolEntryPort, IToolExecutorPort, IToolLayer,
    IToolLayerDeps,
    IToolRegistry, IToolResultPort, IVerificationLayer,
    IVerificationLayerDeps,
    IVerificationResultPort, LayerName
} from './interfaces';

export {
    HarnessConfigManager, type HarnessConfigFile, type LayerConfig,
    type LayerImplementation,
    type PluginConfig
} from './HarnessConfigManager';

export {
    HarnessComposer, type ComposerDeps, type LayerInstance
} from './HarnessComposer';
