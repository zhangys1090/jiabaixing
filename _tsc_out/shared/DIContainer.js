"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DI_TAGS = exports.DI_TOKENS = exports.DIContainer = void 0;
const Logger_1 = require("../utils/Logger");
class DIContainer {
    static instance = null;
    registrations = new Map();
    resolving = new Set();
    scopes = new Map();
    activeScope = null;
    frozen = false;
    static getInstance() {
        if (!DIContainer.instance) {
            DIContainer.instance = new DIContainer();
        }
        return DIContainer.instance;
    }
    static resetInstance() {
        if (DIContainer.instance) {
            DIContainer.instance.clear();
            DIContainer.instance = null;
        }
    }
    static create() {
        return new DIContainer();
    }
    freeze() {
        this.frozen = true;
    }
    isFrozen() {
        return this.frozen;
    }
    register(token, factory, options) {
        if (this.frozen) {
            throw new Error(`DI: 容器已冻结，无法注册 "${String(token)}"`);
        }
        this.registrations.set(token, {
            factory,
            lifecycle: options?.lifecycle ?? 'singleton',
            initialized: false,
            tags: new Set(options?.tags ?? []),
            dependencies: options?.dependencies ?? [],
            onDispose: options?.onDispose,
        });
    }
    registerValue(token, value, options) {
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
    async resolve(token) {
        const registration = this.registrations.get(token);
        if (!registration) {
            throw new Error(`DI: 未注册的依赖 "${String(token)}"`);
        }
        if (this.resolving.has(token)) {
            const chain = Array.from(this.resolving)
                .map((t) => String(t))
                .join(' → ');
            throw new Error(`DI: 检测到循环依赖 "${String(token)}"，解析链: ${chain}`);
        }
        if (registration.lifecycle === 'singleton' && registration.initialized) {
            return registration.instance;
        }
        if (registration.lifecycle === 'scoped' && this.activeScope) {
            const scopeMap = this.scopes.get(this.activeScope);
            if (scopeMap?.has(token)) {
                return scopeMap.get(token);
            }
        }
        this.resolving.add(token);
        try {
            const instance = await registration.factory();
            if (registration.lifecycle === 'singleton') {
                registration.instance = instance;
                registration.initialized = true;
            }
            else if (registration.lifecycle === 'scoped' && this.activeScope) {
                let scopeMap = this.scopes.get(this.activeScope);
                if (!scopeMap) {
                    scopeMap = new Map();
                    this.scopes.set(this.activeScope, scopeMap);
                }
                scopeMap.set(token, instance);
            }
            return instance;
        }
        finally {
            this.resolving.delete(token);
        }
    }
    resolveSync(token) {
        const registration = this.registrations.get(token);
        if (!registration) {
            throw new Error(`DI: 未注册的依赖 "${String(token)}"`);
        }
        if (registration.lifecycle === 'singleton' && registration.initialized) {
            return registration.instance;
        }
        if (registration.lifecycle === 'scoped' && this.activeScope) {
            const scopeMap = this.scopes.get(this.activeScope);
            if (scopeMap?.has(token)) {
                return scopeMap.get(token);
            }
        }
        throw new Error(`DI: "${String(token)}" 尚未初始化，请使用 async resolve() 或确保已通过 registerValue() 注册`);
    }
    async resolveAllByTag(tag) {
        const results = [];
        for (const [token, reg] of this.registrations) {
            if (reg.tags.has(tag)) {
                results.push(await this.resolve(token));
            }
        }
        return results;
    }
    beginScope(scopeId) {
        if (this.scopes.has(scopeId)) {
            Logger_1.Logger.warn(`DI: 作用域 "${scopeId}" 已存在，将复用`, 'DIContainer');
        }
        if (!this.scopes.has(scopeId)) {
            this.scopes.set(scopeId, new Map());
        }
        this.activeScope = scopeId;
    }
    endScope(scopeId) {
        this.scopes.delete(scopeId);
        if (this.activeScope === scopeId) {
            this.activeScope = null;
        }
    }
    getActiveScope() {
        return this.activeScope;
    }
    has(token) {
        return this.registrations.has(token);
    }
    getByTag(tag) {
        const tokens = [];
        for (const [token, reg] of this.registrations) {
            if (reg.tags.has(tag)) {
                tokens.push(token);
            }
        }
        return tokens;
    }
    unregister(token) {
        const reg = this.registrations.get(token);
        if (reg) {
            reg.initialized = false;
            reg.instance = undefined;
        }
        return this.registrations.delete(token);
    }
    validate() {
        const errors = [];
        for (const [token, reg] of this.registrations) {
            for (const dep of reg.dependencies) {
                if (!this.registrations.has(dep)) {
                    errors.push(`"${String(token)}" 依赖未注册的 "${String(dep)}"`);
                }
            }
        }
        const cycleErrors = this.detectCycles();
        errors.push(...cycleErrors);
        return { valid: errors.length === 0, errors };
    }
    detectCycles() {
        const errors = [];
        const visited = new Set();
        const path = new Set();
        const dfs = (token) => {
            if (visited.has(token))
                return;
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
    async bootstrap(tokens) {
        const sorted = this.topologicalSort(tokens);
        for (const token of sorted) {
            await this.resolve(token);
        }
    }
    topologicalSort(tokens) {
        const visited = new Set();
        const result = [];
        const visiting = new Set();
        const visit = (token) => {
            if (visited.has(token))
                return;
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
    snapshot() {
        return Array.from(this.registrations.entries()).map(([token, reg]) => ({
            token,
            lifecycle: reg.lifecycle,
            initialized: reg.initialized,
            tags: Array.from(reg.tags),
            dependencies: reg.dependencies,
        }));
    }
    async dispose() {
        const disposeOrder = Array.from(this.registrations.entries()).reverse();
        for (const [, reg] of disposeOrder) {
            if (reg.initialized && reg.instance && reg.onDispose) {
                try {
                    await reg.onDispose(reg.instance);
                }
                catch (err) {
                    Logger_1.Logger.warn(`DI: dispose 失败: ${err.message}`, 'DIContainer');
                }
            }
        }
        this.clear();
    }
    clear() {
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
    tokens() {
        return Array.from(this.registrations.keys());
    }
    get size() {
        return this.registrations.size;
    }
}
exports.DIContainer = DIContainer;
exports.DI_TOKENS = {
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
};
exports.DI_TAGS = {
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
};
