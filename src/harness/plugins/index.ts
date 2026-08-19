/**
 * Harness Plugins — 插件市场
 *
 * Phase 4 核心模块：
 * - JiabaixingPluginSpec: 标准化插件描述符 + manifest 验证
 * - PluginManager: 插件生命周期管理 (install/list/remove/load/unload)
 * - PluginSandbox: 第三方插件沙箱执行 (权限隔离 + 资源限制)
 * - PluginRegistry: 已有插件注册表 (加载/卸载/钩子分发)
 * - pluginTypes: 插件类型定义
 */

export {
    JiabaixingPluginSpec,
    type JiabaixingPluginDescriptor, type ManifestValidationResult, type PluginSource,
    type PluginStatus
} from './JiabaixingPluginSpec';

export {
    PluginManager,
    type InstalledPlugin,
    type InstallOptions,
    type InstallResult,
    type PluginListFilter
} from './PluginManager';

export {
    PluginSandbox, type SandboxCallContext, type SandboxConfig, type SandboxResourceUsage, type SandboxViolation
} from './PluginSandbox';

export { PluginRegistry, pluginRegistry } from './pluginRegistry';

export type {
    PluginAPI, PluginContext, PluginHook, PluginInstance,
    PluginLifecycle, PluginLogger, PluginManifest, PluginPanelDefinition, PluginPermission, PluginSettingDefinition, PluginSettings, PluginStorage, PluginToolDefinition,
    PluginToolParam,
    PluginToolResult
} from './pluginTypes';
