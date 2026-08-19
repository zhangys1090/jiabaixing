import { Logger } from '../utils/Logger';

export type Factory<T> = () => T | Promise<T>;
export type Token = string | symbol;

export type Lifecycle = 'singleton' | 'transient' | 'scoped';

interface Registration<T = unknown> {
  factory: Factory<T>;
  lifecycle: Lifecycle;
  instance?: T;
  initialized: boolean;
  tags: Set<string>;
  dependencies: Token[];
  onDispose?: (instance: T) => void | Promise<void>;
}

export interface RegistrationOptions {
  lifecycle?: Lifecycle;
  tags?: string[];
  dependencies?: Token[];
  onDispose?: (instance: unknown) => void | Promise<void>;
}

export interface ContainerSnapshot {
  token: Token;
  lifecycle: Lifecycle;
  initialized: boolean;
  tags: string[];
  dependencies: Token[];
}

export class DIContainer {
  private static instance: DIContainer | null = null;
  private registrations: Map<Token, Registration> = new Map();
  private resolving: Set<Token> = new Set();
  private scopes: Map<string, Map<Token, unknown>> = new Map();
  private activeScope: string | null = null;
  private frozen = false;

  static getInstance(): DIContainer {
    if (!DIContainer.instance) {
      DIContainer.instance = new DIContainer();
    }
    return DIContainer.instance;
  }

  static resetInstance(): void {
    if (DIContainer.instance) {
      DIContainer.instance.clear();
      DIContainer.instance = null;
    }
  }

  static create(): DIContainer {
    return new DIContainer();
  }

  freeze(): void {
    this.frozen = true;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  register<T>(
    token: Token,
    factory: Factory<T>,
    options?: RegistrationOptions
  ): void {
    if (this.frozen) {
      throw new Error(`DI: 容器已冻结，无法注册 "${String(token)}"`);
    }
    this.registrations.set(token, {
      factory,
      lifecycle: options?.lifecycle ?? 'singleton',
      initialized: false,
      tags: new Set(options?.tags ?? []),
      dependencies: options?.dependencies ?? [],
      onDispose: options?.onDispose as Registration<T>['onDispose'],
    });
  }

  registerValue<T>(token: Token, value: T, options?: { tags?: string[] }): void {
    if (this.frozen) {
      throw new Error(`DI: 容器已冻结，无法注册 "${String(token)}"`);
    }
    this.registrations.set(token, {
      factory: () => value,
      lifecycle: 'singleton',
      instance: value,
      initialized: true,
      tags: new Set(options?.tags ?? []),
      dependencies: [],
    });
  }

  async resolve<T>(token: Token): Promise<T> {
    const registration = this.registrations.get(token);
    if (!registration) {
      throw new Error(`DI: 未注册的依赖 "${String(token)}"`);
    }

    if (this.resolving.has(token)) {
      const chain = Array.from(this.resolving).map(t => String(t)).join(' → ');
      throw new Error(`DI: 检测到循环依赖 "${String(token)}"，解析链: ${chain}`);
    }

    if (registration.lifecycle === 'singleton' && registration.initialized) {
      return registration.instance as T;
    }

    if (registration.lifecycle === 'scoped' && this.activeScope) {
      const scopeMap = this.scopes.get(this.activeScope);
      if (scopeMap?.has(token)) {
        return scopeMap.get(token) as T;
      }
    }

    this.resolving.add(token);
    try {
      const instance = await registration.factory();
      if (registration.lifecycle === 'singleton') {
        registration.instance = instance;
        registration.initialized = true;
      } else if (registration.lifecycle === 'scoped' && this.activeScope) {
        let scopeMap = this.scopes.get(this.activeScope);
        if (!scopeMap) {
          scopeMap = new Map();
          this.scopes.set(this.activeScope, scopeMap);
        }
        scopeMap.set(token, instance);
      }
      return instance as T;
    } finally {
      this.resolving.delete(token);
    }
  }

  resolveSync<T>(token: Token): T {
    const registration = this.registrations.get(token);
    if (!registration) {
      throw new Error(`DI: 未注册的依赖 "${String(token)}"`);
    }

    if (registration.lifecycle === 'singleton' && registration.initialized) {
      return registration.instance as T;
    }

    if (registration.lifecycle === 'scoped' && this.activeScope) {
      const scopeMap = this.scopes.get(this.activeScope);
      if (scopeMap?.has(token)) {
        return scopeMap.get(token) as T;
      }
    }

    throw new Error(
      `DI: "${String(token)}" 尚未初始化，请使用 async resolve() 或确保已通过 registerValue() 注册`
    );
  }

  async resolveAllByTag<T>(tag: string): Promise<T[]> {
    const results: T[] = [];
    for (const [token, reg] of this.registrations) {
      if (reg.tags.has(tag)) {
        results.push(await this.resolve<T>(token));
      }
    }
    return results;
  }

  beginScope(scopeId: string): void {
    if (this.scopes.has(scopeId)) {
      Logger.warn(`DI: 作用域 "${scopeId}" 已存在，将复用`, 'DIContainer');
    }
    if (!this.scopes.has(scopeId)) {
      this.scopes.set(scopeId, new Map());
    }
    this.activeScope = scopeId;
  }

  endScope(scopeId: string): void {
    this.scopes.delete(scopeId);
    if (this.activeScope === scopeId) {
      this.activeScope = null;
    }
  }

  getActiveScope(): string | null {
    return this.activeScope;
  }

  has(token: Token): boolean {
    return this.registrations.has(token);
  }

  getByTag(tag: string): Token[] {
    const tokens: Token[] = [];
    for (const [token, reg] of this.registrations) {
      if (reg.tags.has(tag)) {
        tokens.push(token);
      }
    }
    return tokens;
  }

  unregister(token: Token): boolean {
    const reg = this.registrations.get(token);
    if (reg) {
      reg.initialized = false;
      reg.instance = undefined;
    }
    return this.registrations.delete(token);
  }

  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const [token, reg] of this.registrations) {
      for (const dep of reg.dependencies) {
        if (!this.registrations.has(dep)) {
          errors.push(
            `"${String(token)}" 依赖未注册的 "${String(dep)}"`
          );
        }
      }
    }
    const cycleErrors = this.detectCycles();
    errors.push(...cycleErrors);
    return { valid: errors.length === 0, errors };
  }

  private detectCycles(): string[] {
    const errors: string[] = [];
    const visited = new Set<Token>();
    const path = new Set<Token>();

    const dfs = (token: Token): void => {
      if (visited.has(token)) return;
      if (path.has(token)) {
        errors.push(`循环依赖检测: "${String(token)}" 参与循环引用`);
        return;
      }
      path.add(token);
      const reg = this.registrations.get(token);
      if (reg) {
        for (const dep of reg.dependencies) {
          dfs(dep);
        }
      }
      path.delete(token);
      visited.add(token);
    };

    for (const token of this.registrations.keys()) {
      dfs(token);
    }
    return errors;
  }

  async bootstrap(tokens: Token[]): Promise<void> {
    const sorted = this.topologicalSort(tokens);
    for (const token of sorted) {
      await this.resolve(token);
    }
  }

  private topologicalSort(tokens: Token[]): Token[] {
    const visited = new Set<Token>();
    const result: Token[] = [];
    const visiting = new Set<Token>();

    const visit = (token: Token): void => {
      if (visited.has(token)) return;
      if (visiting.has(token)) {
        throw new Error(`DI: 拓扑排序检测到循环依赖 "${String(token)}"`);
      }
      visiting.add(token);
      const reg = this.registrations.get(token);
      if (reg) {
        for (const dep of reg.dependencies) {
          if (tokens.includes(dep)) {
            visit(dep);
          }
        }
      }
      visiting.delete(token);
      visited.add(token);
      result.push(token);
    };

    for (const token of tokens) {
      visit(token);
    }
    return result;
  }

  snapshot(): ContainerSnapshot[] {
    return Array.from(this.registrations.entries()).map(([token, reg]) => ({
      token,
      lifecycle: reg.lifecycle,
      initialized: reg.initialized,
      tags: Array.from(reg.tags),
      dependencies: reg.dependencies,
    }));
  }

  async dispose(): Promise<void> {
    const disposeOrder = Array.from(this.registrations.entries()).reverse();
    for (const [, reg] of disposeOrder) {
      if (reg.initialized && reg.instance && reg.onDispose) {
        try {
          await reg.onDispose(reg.instance);
        } catch (err) {
          Logger.warn(`DI: dispose 失败: ${(err as Error).message}`, 'DIContainer');
        }
      }
    }
    this.clear();
  }

  clear(): void {
    for (const [, reg] of this.registrations) {
      reg.instance = undefined;
      reg.initialized = false;
    }
    this.registrations.clear();
    this.resolving.clear();
    this.scopes.clear();
    this.activeScope = null;
    this.frozen = false;
  }

  tokens(): Token[] {
    return Array.from(this.registrations.keys());
  }

  get size(): number {
    return this.registrations.size;
  }
}

export const DI_TOKENS = {
  LLM_PROVIDER: Symbol('LLMProvider'),
  EVENT_BUS: Symbol('EventBus'),
  MEMORY_LEAK_GUARD: Symbol('MemoryLeakGuard'),
  SESSION_TOKEN_QUOTA: Symbol('SessionTokenQuotaManager'),
  CONVERSATION_STORE: Symbol('ConversationStore'),
  TOOL_REGISTRY: Symbol('ToolRegistry'),
  CONSTRAINTS_SERVICE: Symbol('ConstraintsService'),
  VERIFICATION_SERVICE: Symbol('VerificationService'),
  PERSISTENCE_SERVICE: Symbol('PersistenceService'),
  TRAJECTORY_DATABASE: Symbol('TrajectoryDatabase'),
  CONTEXT_MANAGER: Symbol('ContextManager'),
  CONTEXT_PIPELINE: Symbol('ContextPipeline'),
  PERSONA_CORE: Symbol('PersonaCore'),
  SECURITY_AUDITOR: Symbol('SecurityAuditor'),
  SECURITY_GUARD: Symbol('SecurityGuard'),
  SECURITY_POLICY_ENGINE: Symbol('SecurityPolicyEngine'),
  URL_SAFETY_CHECKER: Symbol('UrlSafetyChecker'),
  SHELL_HOOKS: Symbol('ShellHooks'),
  PERFORMANCE_MONITOR: Symbol('PerformanceMonitor'),
  EVOLUTION_ENGINE: Symbol('EvolutionEngine'),
  CRON_SCHEDULER: Symbol('CronJobScheduler'),
  SESSION_STORE: Symbol('SessionStore'),
  SKILL_REGISTRY: Symbol('SkillRegistry'),
  EVENT_STORE: Symbol('EventStore'),
  SESSION_REPLAY: Symbol('SessionReplay'),
  EVENT_STORE_BRIDGE: Symbol('EventStoreBridge'),
  HARNESS_COMPOSER: Symbol('HarnessComposer'),
  HARNESS_CONFIG_MANAGER: Symbol('HarnessConfigManager'),
  TOOL_METADATA_ENHANCER: Symbol('ToolMetadataEnhancer'),
  DISTILLATION_PIPELINE: Symbol('DistillationPipeline'),
  QUALITY_ANNOTATOR: Symbol('QualityAnnotator'),
  PLUGIN_MANAGER: Symbol('PluginManager'),
  PLUGIN_SANDBOX: Symbol('PluginSandbox'),
  PLUGIN_REGISTRY: Symbol('PluginRegistry'),
  CONFIG_LOADER: Symbol('ConfigLoader'),
  MODEL_MANAGER: Symbol('ModelManager'),
  MODEL_SELECTOR: Symbol('ModelSelector'),
  MESSAGE_SANITIZER: Symbol('MessageSanitizer'),
  PREFERENCE_MANAGER: Symbol('PreferenceManager'),
  FILE_SYSTEM: Symbol('FileSystem'),
  MCP_TOOL_BRIDGE: Symbol('MCPToolBridge'),
  LSP_CLIENT_MANAGER: Symbol('LspClientManager'),
  UNIFIED_CONTEXT_BUILDER: Symbol('UnifiedContextBuilder'),
  ACP_ACTIVITY_TRACKER: Symbol('ACPActivityTracker'),
  IMPLICIT_FEEDBACK_COLLECTOR: Symbol('ImplicitFeedbackCollector'),
  OPTIMIZATION_RESULT_DISPATCHER: Symbol('OptimizationResultDispatcher'),
  OPTIMIZATION_ADVISOR: Symbol('OptimizationAdvisor'),
  DEVICE_DISCOVERY: Symbol('DeviceDiscovery'),
  DESKTOP_ACTION_EXECUTOR: Symbol('DesktopActionExecutor'),
  DESKTOP_MCP_SERVER: Symbol('DesktopMCPServer'),
  WINDOW_MANAGER: Symbol('WindowManager'),
  SYSTEM_INPUT: Symbol('SystemInput'),
  UI_ELEMENT_PARSER: Symbol('UIElementParser'),
  SCREEN_CAPTURE: Symbol('ScreenCapture'),
  NORMALIZED_COORDINATES: Symbol('NormalizedCoordinates'),
  DESKTOP_SKILL_REGISTRY: Symbol('DesktopSkillRegistry'),
  TIMER_MANAGER: Symbol('TimerManager'),
  ENVIRONMENT_MANAGER: Symbol('EnvironmentManager'),
  PROFILE_TREND_ANALYZER: Symbol('ProfileTrendAnalyzer'),
  MESSAGE_PROCESSOR: Symbol('MessageProcessor'),
  I18N_MANAGER: Symbol('I18nManager'),
  SYSTEM_INIT_STATE: Symbol('SystemInitState'),
  PYTHON_AGENT_BRIDGE: Symbol('PythonAgentBridge'),
  AGENT_HARNESS: Symbol('AgentHarness'),
  ORCHESTRATOR_AGENT: Symbol('OrchestratorAgent'),
  AGENT_REGISTRY: Symbol('AgentRegistry'),
  FEEDBACK_LOOPS: Symbol('FeedbackLoops'),
  OUTPUT_GUARDRAIL_ENGINE: Symbol('OutputGuardrailEngine'),
  EVALUATION_PIPELINE: Symbol('EvaluationPipeline'),
  INDEPENDENT_EVALUATION_SERVICE: Symbol('IndependentEvaluationService'),
  TRAJECTORY_FLYWHEEL: Symbol('TrajectoryFlywheel'),
} as const;

export const DI_TAGS = {
  CORE: 'core',
  HARNESS: 'harness',
  SECURITY: 'security',
  EVOLUTION: 'evolution',
  MEMORY: 'memory',
  DESKTOP: 'desktop',
  PERSISTENCE: 'persistence',
  VERIFICATION: 'verification',
  CONSTRAINTS: 'constraints',
  TOOL: 'tool',
  AGENT: 'agent',
  MODEL: 'model',
  UI: 'ui',
  INFRASTRUCTURE: 'infrastructure',
} as const;
