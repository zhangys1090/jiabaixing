import { Logger } from '../utils/Logger';
import { DIContainer, DI_TAGS, DI_TOKENS, type RegistrationOptions } from './DIContainer';

export interface SingletonMigrationEntry {
  className: string;
  token: symbol;
  module: string;
  tags: string[];
  dependencies?: symbol[];
  priority: number;
  migrated: boolean;
}

const SINGLETON_MIGRATION_MAP: SingletonMigrationEntry[] = [
  { className: 'TimerManager', token: DI_TOKENS.TIMER_MANAGER, module: '../utils/TimerManager', tags: [DI_TAGS.INFRASTRUCTURE], priority: 0, migrated: true },
  { className: 'MemoryLeakGuard', token: DI_TOKENS.MEMORY_LEAK_GUARD, module: '../utils/MemoryLeakGuard', tags: [DI_TAGS.INFRASTRUCTURE], dependencies: [DI_TOKENS.TIMER_MANAGER], priority: 1, migrated: true },
  { className: 'EnvironmentManager', token: DI_TOKENS.ENVIRONMENT_MANAGER, module: '../utils/EnvironmentManager', tags: [DI_TAGS.INFRASTRUCTURE], priority: 0, migrated: true },
  { className: 'ConfigLoader', token: DI_TOKENS.CONFIG_LOADER, module: '../config/ConfigLoader', tags: [DI_TAGS.INFRASTRUCTURE], priority: 0, migrated: true },
  { className: 'EventBus', token: DI_TOKENS.EVENT_BUS, module: '../shared/EventBus', tags: [DI_TAGS.CORE], priority: 0, migrated: true },
  { className: 'SessionTokenQuotaManager', token: DI_TOKENS.SESSION_TOKEN_QUOTA, module: '../harness/constraints/SessionTokenQuota', tags: [DI_TAGS.CONSTRAINTS], priority: 2, migrated: true },
  { className: 'SecurityPolicyEngine', token: DI_TOKENS.SECURITY_POLICY_ENGINE, module: '../security/SecurityPolicyEngine', tags: [DI_TAGS.SECURITY], priority: 1, migrated: true },
  { className: 'SecurityGuard', token: DI_TOKENS.SECURITY_GUARD, module: '../security/SecurityGuard', tags: [DI_TAGS.SECURITY], dependencies: [DI_TOKENS.SECURITY_POLICY_ENGINE], priority: 2, migrated: true },
  { className: 'UrlSafetyChecker', token: DI_TOKENS.URL_SAFETY_CHECKER, module: '../security/UrlSafetyChecker', tags: [DI_TAGS.SECURITY], priority: 1, migrated: true },
  { className: 'ShellHooks', token: DI_TOKENS.SHELL_HOOKS, module: '../security/ShellHooks', tags: [DI_TAGS.SECURITY], priority: 1, migrated: true },
  { className: 'ModelManager', token: DI_TOKENS.MODEL_MANAGER, module: '../models/ModelManager', tags: [DI_TAGS.MODEL], priority: 1, migrated: true },
  { className: 'ModelSelector', token: DI_TOKENS.MODEL_SELECTOR, module: '../models/ModelSelector', tags: [DI_TAGS.MODEL], priority: 1, migrated: true },
  { className: 'MessageSanitizer', token: DI_TOKENS.MESSAGE_SANITIZER, module: '../models/MessageSanitizer', tags: [DI_TAGS.MODEL], priority: 1, migrated: true },
  { className: 'PreferenceManager', token: DI_TOKENS.PREFERENCE_MANAGER, module: '../memory/PreferenceManager', tags: [DI_TAGS.MEMORY], priority: 1, migrated: true },
  { className: 'FileSystem', token: DI_TOKENS.FILE_SYSTEM, module: '../io/FileSystem', tags: [DI_TAGS.INFRASTRUCTURE], priority: 0, migrated: true },
  { className: 'MCPToolBridge', token: DI_TOKENS.MCP_TOOL_BRIDGE, module: '../harness/tools/registry/MCPToolBridge', tags: [DI_TAGS.TOOL], priority: 2, migrated: true },
  { className: 'LspClientManager', token: DI_TOKENS.LSP_CLIENT_MANAGER, module: '../harness/lsp/LspClientManager', tags: [DI_TAGS.TOOL], priority: 2, migrated: true },
  { className: 'UnifiedContextBuilder', token: DI_TOKENS.UNIFIED_CONTEXT_BUILDER, module: '../harness/context/UnifiedContextBuilder', tags: [DI_TAGS.HARNESS], priority: 2, migrated: true },
  { className: 'SkillRegistry', token: DI_TOKENS.SKILL_REGISTRY, module: '../skills/SkillRegistry', tags: [DI_TAGS.HARNESS], priority: 2, migrated: true },
  { className: 'ACPActivityTracker', token: DI_TOKENS.ACP_ACTIVITY_TRACKER, module: '../ide/ACPActivityTracker', tags: [DI_TAGS.CORE], priority: 1, migrated: true },
  { className: 'EvolutionOrchestrator', token: DI_TOKENS.EVOLUTION_ENGINE, module: '../evolution/EvolutionOrchestrator', tags: [DI_TAGS.EVOLUTION], priority: 3, migrated: true },
  { className: 'ImplicitFeedbackCollector', token: DI_TOKENS.IMPLICIT_FEEDBACK_COLLECTOR, module: '../evolution/ImplicitFeedbackCollector', tags: [DI_TAGS.EVOLUTION], priority: 3, migrated: true },
  { className: 'OptimizationResultDispatcher', token: DI_TOKENS.OPTIMIZATION_RESULT_DISPATCHER, module: '../evolution/OptimizationResultDispatcher', tags: [DI_TAGS.EVOLUTION], priority: 3, migrated: true },
  { className: 'OptimizationAdvisor', token: DI_TOKENS.OPTIMIZATION_ADVISOR, module: '../evolution/decision/OptimizationAdvisor', tags: [DI_TAGS.EVOLUTION], priority: 3, migrated: true },
  { className: 'CronJobScheduler', token: DI_TOKENS.CRON_SCHEDULER, module: '../cron/CronJobScheduler', tags: [DI_TAGS.CORE], priority: 2, migrated: true },
  { className: 'ProfileTrendAnalyzer', token: DI_TOKENS.PROFILE_TREND_ANALYZER, module: '../user/ProfileTrendAnalyzer', tags: [DI_TAGS.CORE], priority: 2, migrated: true },
  { className: 'MessageProcessor', token: DI_TOKENS.MESSAGE_PROCESSOR, module: '../shared/MessageProcessor', tags: [DI_TAGS.CORE], priority: 1, migrated: true },
  { className: 'I18nManager', token: DI_TOKENS.I18N_MANAGER, module: '../shared/I18nManager', tags: [DI_TAGS.CORE], priority: 1, migrated: true },
  { className: 'SystemInitState', token: DI_TOKENS.SYSTEM_INIT_STATE, module: '../server/SystemInitState', tags: [DI_TAGS.INFRASTRUCTURE], priority: 0, migrated: true },
  { className: 'DeviceDiscovery', token: DI_TOKENS.DEVICE_DISCOVERY, module: '../hardware/DeviceDiscovery', tags: [DI_TAGS.DESKTOP], priority: 2, migrated: true },
  { className: 'DesktopActionExecutor', token: DI_TOKENS.DESKTOP_ACTION_EXECUTOR, module: '../desktop/DesktopActionExecutor', tags: [DI_TAGS.DESKTOP], priority: 3, migrated: true },
  { className: 'DesktopMCPServer', token: DI_TOKENS.DESKTOP_MCP_SERVER, module: '../desktop/DesktopMCPServer', tags: [DI_TAGS.DESKTOP], priority: 3, migrated: true },
  { className: 'WindowManager', token: DI_TOKENS.WINDOW_MANAGER, module: '../desktop/WindowManager', tags: [DI_TAGS.DESKTOP], priority: 2, migrated: true },
  { className: 'SystemInput', token: DI_TOKENS.SYSTEM_INPUT, module: '../desktop/SystemInput', tags: [DI_TAGS.DESKTOP], priority: 2, migrated: true },
  { className: 'UIElementParser', token: DI_TOKENS.UI_ELEMENT_PARSER, module: '../desktop/ui/UIElementParser', tags: [DI_TAGS.DESKTOP], priority: 2, migrated: true },
  { className: 'ScreenCapture', token: DI_TOKENS.SCREEN_CAPTURE, module: '../desktop/ScreenCapture', tags: [DI_TAGS.DESKTOP], priority: 2, migrated: true },
  { className: 'NormalizedCoordinateSystem', token: DI_TOKENS.NORMALIZED_COORDINATES, module: '../desktop/NormalizedCoordinates', tags: [DI_TAGS.DESKTOP], priority: 2, migrated: true },
  { className: 'DesktopSkillRegistry', token: DI_TOKENS.DESKTOP_SKILL_REGISTRY, module: '../desktop/DesktopSkillRegistry', tags: [DI_TAGS.DESKTOP], priority: 3, migrated: true },
];

export function getMigrationMap(): SingletonMigrationEntry[] {
  return [...SINGLETON_MIGRATION_MAP];
}

export function getMigrationStats(): { total: number; migrated: number; pending: number; byTag: Record<string, { total: number; migrated: number }> } {
  const total = SINGLETON_MIGRATION_MAP.length;
  const migrated = SINGLETON_MIGRATION_MAP.filter(e => e.migrated).length;
  const byTag: Record<string, { total: number; migrated: number }> = {};
  for (const entry of SINGLETON_MIGRATION_MAP) {
    for (const tag of entry.tags) {
      if (!byTag[tag]) byTag[tag] = { total: 0, migrated: 0 };
      byTag[tag].total++;
      if (entry.migrated) byTag[tag].migrated++;
    }
  }
  return { total, migrated, pending: total - migrated, byTag };
}

export async function registerCoreDependencies(): Promise<void> {
  const container = DIContainer.getInstance();

  if (!container.has(DI_TOKENS.TIMER_MANAGER)) {
    const { TimerManager } = await import('../utils/TimerManager');
    container.register(
      DI_TOKENS.TIMER_MANAGER,
      () => TimerManager.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.INFRASTRUCTURE] }
    );
  }

  if (!container.has(DI_TOKENS.MEMORY_LEAK_GUARD)) {
    const { MemoryLeakGuard } = await import('../utils/MemoryLeakGuard');
    container.register(
      DI_TOKENS.MEMORY_LEAK_GUARD,
      async () => {
        const tm = await container.resolve(DI_TOKENS.TIMER_MANAGER);
        return MemoryLeakGuard.create(tm as import('../utils/TimerManager').TimerManager);
      },
      { lifecycle: 'singleton', tags: [DI_TAGS.INFRASTRUCTURE], dependencies: [DI_TOKENS.TIMER_MANAGER] }
    );
  }

  if (!container.has(DI_TOKENS.ENVIRONMENT_MANAGER)) {
    const { EnvironmentManager } = await import('../utils/EnvironmentManager');
    container.register(
      DI_TOKENS.ENVIRONMENT_MANAGER,
      () => EnvironmentManager.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.INFRASTRUCTURE] }
    );
  }

  if (!container.has(DI_TOKENS.CONFIG_LOADER)) {
    const { ConfigLoader } = await import('../config/ConfigLoader');
    container.register(
      DI_TOKENS.CONFIG_LOADER,
      () => ConfigLoader.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.INFRASTRUCTURE] }
    );
  }

  if (!container.has(DI_TOKENS.EVENT_BUS)) {
    const { JiabaixingEventBus } = await import('./EventBus');
    container.register(
      DI_TOKENS.EVENT_BUS,
      () => JiabaixingEventBus.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.CORE] }
    );
  }

  if (!container.has(DI_TOKENS.SYSTEM_INIT_STATE)) {
    const { SystemInitState } = await import('../server/SystemInitState');
    container.register(
      DI_TOKENS.SYSTEM_INIT_STATE,
      () => SystemInitState.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.INFRASTRUCTURE] }
    );
  }

  if (!container.has(DI_TOKENS.SESSION_TOKEN_QUOTA)) {
    const { SessionTokenQuotaManager } = await import('../harness/constraints/SessionTokenQuota');
    container.register(
      DI_TOKENS.SESSION_TOKEN_QUOTA,
      () => SessionTokenQuotaManager.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.CONSTRAINTS] }
    );
  }

  if (!container.has(DI_TOKENS.SECURITY_POLICY_ENGINE)) {
    const { SecurityPolicyEngine } = await import('../security/SecurityPolicyEngine');
    container.register(
      DI_TOKENS.SECURITY_POLICY_ENGINE,
      () => SecurityPolicyEngine.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.SECURITY] }
    );
  }

  if (!container.has(DI_TOKENS.SECURITY_GUARD)) {
    const { SecurityGuard } = await import('../security/SecurityGuard');
    container.register(
      DI_TOKENS.SECURITY_GUARD,
      () => SecurityGuard.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.SECURITY], dependencies: [DI_TOKENS.SECURITY_POLICY_ENGINE] }
    );
  }

  if (!container.has(DI_TOKENS.URL_SAFETY_CHECKER)) {
    const { UrlSafetyChecker } = await import('../security/UrlSafetyChecker');
    container.register(
      DI_TOKENS.URL_SAFETY_CHECKER,
      () => UrlSafetyChecker.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.SECURITY] }
    );
  }

  if (!container.has(DI_TOKENS.SHELL_HOOKS)) {
    const { ShellHooks } = await import('../security/ShellHooks');
    container.register(
      DI_TOKENS.SHELL_HOOKS,
      () => ShellHooks.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.SECURITY] }
    );
  }

  if (!container.has(DI_TOKENS.MODEL_SELECTOR)) {
    const { ModelSelector } = await import('../models/ModelSelector');
    container.register(
      DI_TOKENS.MODEL_SELECTOR,
      () => ModelSelector.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.MODEL] }
    );
  }

  if (!container.has(DI_TOKENS.MESSAGE_SANITIZER)) {
    const { MessageSanitizer } = await import('../models/MessageSanitizer');
    container.register(
      DI_TOKENS.MESSAGE_SANITIZER,
      () => MessageSanitizer.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.MODEL] }
    );
  }

  if (!container.has(DI_TOKENS.PREFERENCE_MANAGER)) {
    const { PreferenceManager } = await import('../memory/PreferenceManager');
    container.register(
      DI_TOKENS.PREFERENCE_MANAGER,
      () => PreferenceManager.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.MEMORY] }
    );
  }

  if (!container.has(DI_TOKENS.FILE_SYSTEM)) {
    const { FileSystem } = await import('../io/FileSystem');
    container.register(
      DI_TOKENS.FILE_SYSTEM,
      () => FileSystem.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.INFRASTRUCTURE] }
    );
  }

  if (!container.has(DI_TOKENS.MESSAGE_PROCESSOR)) {
    const { MessageProcessor } = await import('../shared/MessageProcessor');
    container.register(
      DI_TOKENS.MESSAGE_PROCESSOR,
      () => MessageProcessor.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.CORE] }
    );
  }

  if (!container.has(DI_TOKENS.I18N_MANAGER)) {
    const { I18nManager } = await import('../shared/I18nManager');
    container.register(
      DI_TOKENS.I18N_MANAGER,
      () => I18nManager.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.CORE] }
    );
  }

  if (!container.has(DI_TOKENS.ACP_ACTIVITY_TRACKER)) {
    const { ACPActivityTracker } = await import('../ide/ACPActivityTracker');
    container.register(
      DI_TOKENS.ACP_ACTIVITY_TRACKER,
      () => ACPActivityTracker.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.CORE] }
    );
  }

  if (!container.has(DI_TOKENS.MCP_TOOL_BRIDGE)) {
    const { MCPToolBridge } = await import('../harness/tools/registry/MCPToolBridge');
    container.register(
      DI_TOKENS.MCP_TOOL_BRIDGE,
      () => MCPToolBridge.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.TOOL] }
    );
  }

  if (!container.has(DI_TOKENS.LSP_CLIENT_MANAGER)) {
    const { LspClientManager } = await import('../harness/lsp/LspClientManager');
    container.register(
      DI_TOKENS.LSP_CLIENT_MANAGER,
      () => LspClientManager.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.TOOL] }
    );
  }

  if (!container.has(DI_TOKENS.UNIFIED_CONTEXT_BUILDER)) {
    const { UnifiedContextBuilder } = await import('../harness/context/UnifiedContextBuilder');
    container.register(
      DI_TOKENS.UNIFIED_CONTEXT_BUILDER,
      () => UnifiedContextBuilder.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.HARNESS] }
    );
  }

  if (!container.has(DI_TOKENS.SKILL_REGISTRY)) {
    const { SkillRegistry } = await import('../skills/SkillRegistry');
    container.register(
      DI_TOKENS.SKILL_REGISTRY,
      () => SkillRegistry.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.HARNESS] }
    );
  }

  if (!container.has(DI_TOKENS.CRON_SCHEDULER)) {
    const { CronJobScheduler } = await import('../cron/CronJobScheduler');
    container.register(
      DI_TOKENS.CRON_SCHEDULER,
      () => CronJobScheduler.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.CORE] }
    );
  }

  if (!container.has(DI_TOKENS.PROFILE_TREND_ANALYZER)) {
    const { ProfileTrendAnalyzer } = await import('../user/ProfileTrendAnalyzer');
    container.register(
      DI_TOKENS.PROFILE_TREND_ANALYZER,
      () => ProfileTrendAnalyzer.create(),
      { lifecycle: 'singleton', tags: [DI_TAGS.CORE] }
    );
  }

  Logger.info(`DI: 核心依赖已注册 (${container.size} 项)`, 'DependencyRegistry');
}

export function registerLLMProvider(llm: unknown): void {
  const container = DIContainer.getInstance();
  container.registerValue(DI_TOKENS.LLM_PROVIDER, llm, { tags: [DI_TAGS.MODEL] });
}

export function registerEventBus(eventBus: unknown): void {
  const container = DIContainer.getInstance();
  container.registerValue(DI_TOKENS.EVENT_BUS, eventBus, { tags: [DI_TAGS.CORE] });
}

export function registerSingleton<T>(
  token: symbol,
  getInstance: () => T,
  options?: RegistrationOptions
): void {
  const container = DIContainer.getInstance();
  if (!container.has(token)) {
    container.register(token, getInstance, { lifecycle: 'singleton', ...options });
  }
}

export async function resolveMemoryLeakGuard<T>(): Promise<T> {
  return DIContainer.getInstance().resolve<T>(DI_TOKENS.MEMORY_LEAK_GUARD);
}

export async function resolveSessionTokenQuota<T>(): Promise<T> {
  return DIContainer.getInstance().resolve<T>(DI_TOKENS.SESSION_TOKEN_QUOTA);
}

export function getContainer(): DIContainer {
  return DIContainer.getInstance();
}

export function createTestContainer(): DIContainer {
  return DIContainer.create();
}

export async function bootstrapContainer(container: DIContainer, tokens: symbol[]): Promise<void> {
  const validation = container.validate();
  if (!validation.valid) {
    Logger.warn(`DI: 依赖校验发现问题:\n${validation.errors.join('\n')}`, 'DependencyRegistry');
  }
  await container.bootstrap(tokens);
  container.freeze();
  Logger.info(`DI: 容器已引导并冻结 (${container.size} 项)`, 'DependencyRegistry');
}
