"use strict";
/**
 * Harness Agent Framework - Agent Harness 入口
 *
 * 六层架构组装点，协调 Loop/Tools/Context/Persistence/Verification/Constraints
 *
 * 双后端架构说明：
 * - 当 AGENT_BACKEND=python（默认）时，请求通过 PythonAgentBridge 转发到 Python 后端
 *   此文件中的 LoopController、MemoryEngine 等组件不会被使用
 * - 当 AGENT_BACKEND=local 时，使用 TypeScript 本地实现（已废弃，仅用于回退）
 *
 * 废弃组件说明：
 * - LoopController: 已迁移到 Python agent/loop/controller.py
 * - MemoryEngine: 已迁移到 Python agent/memory/
 * 预计 V6.0 移除 TypeScript 端的废弃组件
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentHarness = void 0;
const path_1 = __importDefault(require("path"));
const CronJobScheduler_1 = require("../cron/CronJobScheduler");
const SkillUsageTracker_1 = require("../evolution/SkillUsageTracker");
const StrategyAdjuster_1 = require("../evolution/StrategyAdjuster");
const LLMCapabilityDetector_1 = require("../evolution/LLMCapabilityDetector");
const ACPActivityTracker_1 = require("../ide/ACPActivityTracker");
const SessionStore_1 = require("../persistence/SessionStore");
const EventBus_1 = require("../shared/EventBus");
const I18nManager_1 = require("../shared/I18nManager");
const MessageProcessor_1 = require("../shared/MessageProcessor");
const SkillRegistry_1 = require("../skills/SkillRegistry");
const Logger_1 = require("../utils/Logger");
const ConstraintsService_1 = require("./constraints/ConstraintsService");
const ContextManager_1 = require("./context/ContextManager");
const ContextWindowManager_1 = require("./context/ContextWindowManager");
const IndependentEvaluationService_1 = require("./evaluation/IndependentEvaluationService");
const LspClientManager_1 = require("./lsp/LspClientManager");
const LspCompletionProvider_1 = require("./lsp/LspCompletionProvider");
const LspDiagnosticsProvider_1 = require("./lsp/LspDiagnosticsProvider");
const AgentRegistry_1 = require("./orchestration/AgentRegistry");
const OrchestratorAgent_1 = require("./orchestration/OrchestratorAgent");
const PersistenceService_1 = require("./persistence/PersistenceService");
const TrajectoryDatabase_1 = require("./persistence/TrajectoryDatabase");
const SandboxExecutor_1 = require("./sandbox/SandboxExecutor");
const registerHarnessTools_1 = require("./tools/registerHarnessTools");
const PermissionGuard_1 = require("./tools/registry/PermissionGuard");
const toolsets_1 = require("./tools/toolsets");
const types_1 = require("./types");
const VerificationService_1 = require("./verification/VerificationService");
/** 从环境变量读取配置 */
function getEnvConfig() {
    const envConfig = {};
    if (process.env.HARNESS_LOOP !== undefined) {
        envConfig.useHarnessLoop = process.env.HARNESS_LOOP === 'true';
    }
    if (process.env.HARNESS_TOOLS !== undefined) {
        envConfig.useHarnessTools = process.env.HARNESS_TOOLS === 'true';
    }
    if (process.env.HARNESS_CONTEXT !== undefined) {
        envConfig.useHarnessContext = process.env.HARNESS_CONTEXT === 'true';
    }
    if (process.env.HARNESS_VERIFICATION !== undefined) {
        envConfig.useHarnessVerification =
            process.env.HARNESS_VERIFICATION === 'true';
    }
    if (process.env.HARNESS_CONSTRAINTS !== undefined) {
        envConfig.useHarnessConstraints =
            process.env.HARNESS_CONSTRAINTS === 'true';
    }
    if (process.env.HARNESS_PERSISTENCE !== undefined) {
        envConfig.useHarnessPersistence =
            process.env.HARNESS_PERSISTENCE === 'true';
    }
    if (process.env.HARNESS_TRAJECTORY !== undefined) {
        envConfig.useTrajectoryPersistence =
            process.env.HARNESS_TRAJECTORY === 'true';
    }
    if (process.env.HARNESS_EVALUATOR !== undefined) {
        envConfig.useIndependentEvaluator =
            process.env.HARNESS_EVALUATOR === 'true';
    }
    return envConfig;
}
/** 默认配置 - TS本地Agent Loop已恢复，useHarnessLoop 默认 true */
const DEFAULT_CONFIG = {
    useHarnessLoop: true,
    useHarnessTools: true,
    useHarnessContext: true,
    useHarnessVerification: true,
    useHarnessConstraints: true,
    useHarnessPersistence: true,
    useTrajectoryPersistence: true,
    useIndependentEvaluator: true,
};
class AgentHarness {
    constructor(config) {
        this.deps = null;
        this.initialized = false;
        // 六层组件
        this.toolRegistry = null;
        this.schemaValidator = null;
        this.permissionGuard = null;
        this.contextManager = null;
        // P0-4: 上下文窗口管理器 — 循环内动态 token 预算管理
        this.contextWindowManager = new ContextWindowManager_1.ContextWindowManager();
        this.verificationService = null;
        this.constraintsService = null;
        this.persistenceService = null;
        this.trajectoryDatabase = null;
        // 独立评估服务（P0 核心功能）
        this.independentEvaluationService = null;
        // 沙箱执行器（安全隔离）
        this.sandboxExecutor = null;
        // 多Agent编排组件
        this.agentRegistry = null;
        this.orchestratorAgent = null;
        // P5: 策略自适应调整器 — 驱动学习闭环
        this.strategyAdjuster = new StrategyAdjuster_1.StrategyAdjuster();
        this.capabilityDetector = new LLMCapabilityDetector_1.LLMCapabilityDetector();
        // Phase 2: LSP 客户端管理器 — 语言服务器协议集成
        this.lspClientManager = null;
        this.lspDiagnosticsProvider = null;
        this.lspCompletionProvider = null;
        // Phase 3: 会话存储 + Cron调度器 + Skill注册中心
        this.sessionStore = null;
        this.cronScheduler = null;
        this.skillRegistry = null;
        this.acpTracker = null;
        this.messageProcessor = null;
        this.i18nManager = null;
        const envConfig = getEnvConfig();
        this.config = { ...DEFAULT_CONFIG, ...envConfig, ...config };
    }
    /**
     * 注入依赖
     */
    setDeps(deps) {
        this.deps = deps;
    }
    /**
     * 初始化 Harness 各层
     */
    async initialize() {
        if (this.initialized)
            return;
        // Python 后端模式下，仅初始化路由层必需的最小组件集
        if ((process.env.AGENT_BACKEND ?? 'python') === 'python') {
            Logger_1.Logger.info('🏗️ Agent Harness 轻量初始化 (Python后端模式)', 'AgentHarness');
            try {
                const result = (0, registerHarnessTools_1.registerHarnessTools)(this.deps?.toolDeps ?? {});
                this.toolRegistry = result.toolRegistry;
                this.permissionGuard = result.permissionGuard;
                // P0-1/P0-2: 同步 SchemaValidator + PermissionGuard 到 ToolRegistry 内部
                this.toolRegistry.setSchemaValidator(result.schemaValidator);
                this.toolRegistry.setPermissionGuard(result.permissionGuard);
                // P1-2：将真实工具注册表注入统一动作调度器（tool 通道可用）
                try {
                    const { configureActionDispatcher } = await Promise.resolve().then(() => __importStar(require('./action')));
                    configureActionDispatcher({ toolRegistry: this.toolRegistry });
                }
                catch (ae) {
                    Logger_1.Logger.warn(`  ⚠️ 动作调度器装配失败: ${ae.message}`, 'AgentHarness');
                }
                Logger_1.Logger.info(`  🔧 工具层(路由用): ${result.registeredCount} 个工具`, 'AgentHarness');
            }
            catch (err) {
                Logger_1.Logger.warn(`  ⚠️ 工具层轻量初始化失败: ${err.message}`, 'AgentHarness');
            }
            this.initialized = true;
            Logger_1.Logger.info('✅ Agent Harness 轻量初始化完成', 'AgentHarness');
            return;
        }
        Logger_1.Logger.info('🏗️ Agent Harness 初始化中...', 'AgentHarness');
        if (!this.deps) {
            Logger_1.Logger.warn('⚠️ 未注入依赖，部分功能不可用', 'AgentHarness');
        }
        // Phase 1: 工具层初始化
        try {
            if (this.config.useHarnessTools) {
                const result = (0, registerHarnessTools_1.registerHarnessTools)(this.deps?.toolDeps ?? {});
                this.toolRegistry = result.toolRegistry;
                this.schemaValidator = result.schemaValidator;
                this.permissionGuard = result.permissionGuard;
                // P1-2：将真实工具注册表注入统一动作调度器（tool 通道可用）
                try {
                    const { configureActionDispatcher } = await Promise.resolve().then(() => __importStar(require('./action')));
                    configureActionDispatcher({ toolRegistry: this.toolRegistry });
                }
                catch (ae) {
                    Logger_1.Logger.warn(`  ⚠️ 动作调度器装配失败: ${ae.message}`, 'AgentHarness');
                }
                // P0-1/P0-2: 同步 SchemaValidator + PermissionGuard 到 ToolRegistry 内部
                this.toolRegistry.setSchemaValidator(result.schemaValidator);
                this.toolRegistry.setPermissionGuard(result.permissionGuard);
                if (this.deps?.skillRegistry) {
                    (0, registerHarnessTools_1.syncToLegacySkillRegistry)(this.toolRegistry, this.deps.skillRegistry);
                    Logger_1.Logger.info('  🔄 双写兼容: 已同步到旧版 SkillRegistry', 'AgentHarness');
                }
                Logger_1.Logger.info(`  🔧 工具层: 启用 (${result.registeredCount} 个工具)`, 'AgentHarness');
                // P0-3: 注册内置工具集（按 Agent 角色预组装工具包）
                (0, toolsets_1.registerBuiltinToolsets)();
                const toolsetIds = (0, toolsets_1.getToolsetRegistry)().list();
                Logger_1.Logger.info(`  📦 工具集层: 启用 (${toolsetIds.length} 个工具集: ${toolsetIds.join(', ')})`, 'AgentHarness');
            }
        }
        catch (err) {
            Logger_1.Logger.error(`  ❌ 工具层初始化失败: ${err.message}`, err, 'AgentHarness');
            throw err;
        }
        // Phase 2: 约束层初始化
        try {
            if (this.config.useHarnessConstraints) {
                this.constraintsService = new ConstraintsService_1.ConstraintsService({
                    permissionGuard: this.permissionGuard || new PermissionGuard_1.PermissionGuard(),
                });
                Logger_1.Logger.info('  🛡️ 约束层: 启用', 'AgentHarness');
            }
        }
        catch (err) {
            Logger_1.Logger.error(`  ❌ 约束层初始化失败: ${err.message}`, err, 'AgentHarness');
            throw err;
        }
        // Phase 2.5: 沙箱执行器初始化
        try {
            this.sandboxExecutor = new SandboxExecutor_1.SandboxExecutor({
                securityLevel: 'high',
                timeoutMs: 30000,
            });
            Logger_1.Logger.info('  🔒 沙箱执行器: 启用 (安全级别: high)', 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.error(`  ❌ 沙箱执行器初始化失败: ${err.message}`, err, 'AgentHarness');
            throw err;
        }
        // Phase 2.6: 多Agent编排初始化
        if (this.deps?.orchestratorAgent) {
            this.orchestratorAgent = this.deps.orchestratorAgent;
            Logger_1.Logger.info('  🤖 多Agent编排: 使用外部提供的 OrchestratorAgent', 'AgentHarness');
        }
        else if (this.deps) {
            this.agentRegistry = new AgentRegistry_1.AgentRegistry();
            // 注册默认Agent
            this.agentRegistry.register({
                id: 'default-agent',
                name: '默认执行Agent',
                capabilities: [
                    {
                        name: '通用任务执行',
                        description: '处理各类通用任务',
                        tools: ['*'],
                    },
                ],
                status: 'idle',
                createdAt: new Date(),
                lastActiveAt: new Date(),
            });
            // 创建OrchestratorAgent
            this.orchestratorAgent = new OrchestratorAgent_1.OrchestratorAgent({
                registry: this.agentRegistry,
                llm: {
                    decomposeGoal: async (goal, context) => {
                        try {
                            const prompt = `请将以下目标分解为可执行的步骤，每个步骤应该是一个独立的任务。请返回JSON格式，格式为 {"tasks": [{"id": "步骤id", "goal": "步骤描述", "dependencies": ["依赖的步骤id"], "priority": 5}]}\n\n目标: ${goal}\n${context ? `上下文: ${context}` : ''}`;
                            const response = await this.deps.llm.chat(prompt);
                            const jsonMatch = response.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                return parsed.tasks || [];
                            }
                        }
                        catch {
                            Logger_1.Logger.warn('LLM目标分解失败，使用默认分解', 'AgentHarness');
                        }
                        return [
                            {
                                id: 'step-1',
                                goal,
                                context,
                                dependencies: [],
                                priority: 5,
                                status: 'pending',
                            },
                        ];
                    },
                },
                config: {
                    enableMultiAgent: true,
                    complexityThreshold: 'complex',
                    maxSubAgents: 3,
                },
            });
            Logger_1.Logger.info('  🤖 多Agent编排: 启用 (内部初始化)', 'AgentHarness');
        }
        // Phase 3: 验证层初始化
        if (this.config.useHarnessVerification) {
            this.verificationService = new VerificationService_1.VerificationService(this.deps ? { llm: this.deps.llm } : {});
            Logger_1.Logger.info('  ✅ 验证层: 启用', 'AgentHarness');
        }
        // Phase 4: 持久化层初始化
        if (this.config.useHarnessPersistence) {
            this.persistenceService = new PersistenceService_1.PersistenceService(this.deps?.persistenceDeps || {});
            await this.persistenceService.initialize();
            Logger_1.Logger.info('  💾 持久化层: 启用', 'AgentHarness');
        }
        // Phase 4.2: 独立评估服务初始化（P0 核心功能）
        if (this.config.useIndependentEvaluator && this.deps) {
            this.independentEvaluationService = new IndependentEvaluationService_1.IndependentEvaluationService({
                llm: this.deps.llm,
                enableLLMEvaluation: true,
            });
            Logger_1.Logger.info('  📋 独立评估服务: 启用', 'AgentHarness');
        }
        // Phase 4.5: 轨迹持久化初始化
        if (this.config.useTrajectoryPersistence) {
            const dbPath = path_1.default.resolve(process.cwd(), 'data', 'trajectory', 'trajectory.db');
            this.trajectoryDatabase = new TrajectoryDatabase_1.TrajectoryDatabase(dbPath);
            // P3: 注入语义嵌入函数 — 使 TrajectoryDatabase 支持语义相似度检索
            try {
                const { SemanticSimilarityEngine } = await Promise.resolve().then(() => __importStar(require('../memory/SemanticSimilarityEngine')));
                const semanticEngine = new SemanticSimilarityEngine();
                await semanticEngine.initialize();
                this.trajectoryDatabase.setEmbedFunction((text) => {
                    const vector = semanticEngine.generateVectorSync(text);
                    return vector;
                });
                Logger_1.Logger.info('  📐 语义嵌入: 已注入 TrajectoryDatabase', 'AgentHarness');
            }
            catch (semErr) {
                Logger_1.Logger.warn(`  ⚠️ 语义嵌入注入失败，回退到关键词检索: ${semErr.message}`, 'AgentHarness');
            }
            Logger_1.Logger.info('  📊 轨迹持久化: 启用', 'AgentHarness');
        }
        // Phase 5: 上下文层初始化
        if (this.config.useHarnessContext && this.deps) {
            this.contextManager = new ContextManager_1.ContextManager({
                constitutionalBuilder: this.deps.constitutionalBuilder,
                memoryInjector: this.deps.memoryInjector,
                dynamicContext: this.deps.dynamicContext,
                historyProvider: this.deps.historyProvider,
                personaCore: this.deps.personaCore,
                environmentSensor: this.deps.environmentSensor,
                evolutionExamples: this.deps.evolutionExamples,
                referenceResolver: this.deps.contextReferenceResolver || undefined,
            });
            Logger_1.Logger.info('  📋 上下文层: 启用', 'AgentHarness');
            if (this.deps.personaCore) {
                Logger_1.Logger.info('  🎭 进化闭环: PersonaCore 语气注入已连通', 'AgentHarness');
            }
        }
        // Phase 6: 循环层已迁移到 Python 后端（agent/loop/controller.py）
        // TS 本地循环层（LoopController/Executor/Planner/Evaluator/ReflectionEngine）已删除
        // 当 AGENT_BACKEND=python（默认）时由 PythonAgentBridge 处理
        Logger_1.Logger.info('  🔄 循环层: 由 Python 后端处理（AGENT_BACKEND=python）', 'AgentHarness');
        // P5.1: 将 LLM 能力检测策略提示注入 StrategyAdjuster
        try {
            const providerName = this.deps?.llm?.constructor?.name || 'unknown';
            const hints = this.capabilityDetector.getStrategyHints(providerName);
            this.strategyAdjuster.setLLMStrategyHints(hints);
            Logger_1.Logger.info(`  🧠 LLM能力策略提示已注入 (lowCapability=${hints.lowCapability}, maxRetries=${hints.maxRetries})`, 'AgentHarness');
        }
        catch (e) {
            Logger_1.Logger.debug(`  LLM能力检测初始化跳过: ${e.message}`, 'AgentHarness');
        }
        // P3: 订阅 learning_signal 事件，转发到 StrategyAdjuster
        if (this.deps?.eventBus) {
            this.deps.eventBus.on('learning_signal', (payload) => {
                try {
                    const signal = payload;
                    this.strategyAdjuster.recordSignal({
                        signalType: signal.signalType,
                        toolName: signal.toolName,
                        error: signal.error,
                        quality: signal.quality,
                        duration: signal.duration,
                        timestamp: signal.timestamp,
                    });
                }
                catch {
                    // 学习信号处理失败不影响主流程
                }
            });
            Logger_1.Logger.info('  📡 学习信号订阅: 已注册', 'AgentHarness');
        }
        // Phase 6.5: 注册敏感信息存储拦截钩子（由独立方法管理，不嵌入初始化流程）
        await this.registerSensitiveDataHooks();
        // Phase 6.6: LSP 集成层初始化
        try {
            this.lspClientManager = LspClientManager_1.LspClientManager.getInstance();
            this.lspDiagnosticsProvider = new LspDiagnosticsProvider_1.LspDiagnosticsProvider(this.lspClientManager);
            this.lspCompletionProvider = new LspCompletionProvider_1.LspCompletionProvider(this.lspClientManager);
            if (this.deps?.workspaceRootUri) {
                this.lspClientManager.configureWorkspace({
                    rootUri: this.deps.workspaceRootUri,
                    folders: [{ uri: this.deps.workspaceRootUri }],
                });
            }
            Logger_1.Logger.info('  🌐 LSP 集成层: 启用（按需连接语言服务器）', 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.warn(`  ⚠️ LSP 集成层初始化失败（非阻塞）: ${err.message}`, 'AgentHarness');
            this.lspClientManager = null;
            this.lspDiagnosticsProvider = null;
            this.lspCompletionProvider = null;
        }
        // Phase 3: 会话存储 + Cron调度器 + Skill注册中心
        try {
            this.sessionStore = new SessionStore_1.SessionStore();
            Logger_1.Logger.info(`  🗄️ 会话存储: 已就绪 (${this.sessionStore.getStats().sessions} 个会话)`, 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.warn(`  ⚠️ 会话存储初始化失败（非阻塞）: ${err.message}`, 'AgentHarness');
            this.sessionStore = null;
        }
        try {
            this.cronScheduler = CronJobScheduler_1.CronJobScheduler.getInstance();
            this.cronScheduler.start();
            Logger_1.Logger.info(`  ⏰ Cron调度器: 已启动 (${this.cronScheduler.getJobs().length} 个任务)`, 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.warn(`  ⚠️ Cron调度器初始化失败（非阻塞）: ${err.message}`, 'AgentHarness');
            this.cronScheduler = null;
        }
        try {
            this.skillRegistry = SkillRegistry_1.SkillRegistry.getInstance();
            Logger_1.Logger.info(`  🔧 Skill注册中心: 已就绪 (${this.skillRegistry.getSkillCount()} 个技能)`, 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.warn(`  ⚠️ Skill注册中心初始化失败（非阻塞）: ${err.message}`, 'AgentHarness');
            this.skillRegistry = null;
        }
        // Phase 4: ACP 活动追踪器 + 消息处理层 + i18n
        try {
            this.acpTracker = ACPActivityTracker_1.ACPActivityTracker.getInstance();
            Logger_1.Logger.info(`  📡 ACP活动追踪器: 已就绪`, 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.warn(`  ⚠️ ACP活动追踪器初始化失败（非阻塞）: ${err.message}`, 'AgentHarness');
            this.acpTracker = null;
        }
        try {
            this.messageProcessor = MessageProcessor_1.MessageProcessor.getInstance();
            Logger_1.Logger.info(`  📨 消息处理层: 已就绪`, 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.warn(`  ⚠️ 消息处理层初始化失败（非阻塞）: ${err.message}`, 'AgentHarness');
            this.messageProcessor = null;
        }
        try {
            this.i18nManager = I18nManager_1.I18nManager.getInstance();
            Logger_1.Logger.info(`  🌐 i18n管理器: 已就绪 (${this.i18nManager.getLocale()}, ${this.i18nManager.getStats().totalKeys} 条消息)`, 'AgentHarness');
        }
        catch (err) {
            Logger_1.Logger.warn(`  ⚠️ i18n管理器初始化失败（非阻塞）: ${err.message}`, 'AgentHarness');
            this.i18nManager = null;
        }
        // Phase 7: 注册进化反馈钩子（闭环）
        if (this.constraintsService && this.deps?.evolutionEngine) {
            this.constraintsService.registerHook(types_1.LifecycleEvent.AFTER_RESPONSE, async (hookCtx) => {
                const evo = this.deps.evolutionEngine;
                const input = String(hookCtx.metadata.input || '');
                const response = String(hookCtx.metadata.response || '');
                const quality = hookCtx.metadata.quality;
                const traceId = String(hookCtx.metadata.traceId || '');
                const toolsUsedRaw = hookCtx.metadata.toolsUsed;
                const toolsUsed = Array.isArray(toolsUsedRaw)
                    ? toolsUsedRaw
                    : [];
                evo.collectFeedback(input, response, {
                    success: true,
                    toolsUsed,
                });
                if (quality) {
                    evo.assessQuality(traceId, true, quality.overall, 0);
                }
                // 高质量任务 → 自动生成 SKILL.md
                if (quality && quality.overall >= 0.7) {
                    const metadata = hookCtx.metadata;
                    evo.generateSkill({
                        input,
                        response,
                        toolsUsed,
                        totalDuration: (typeof metadata.duration === 'number'
                            ? metadata.duration
                            : 0),
                        qualityScore: quality.overall,
                        traceId,
                    });
                }
                // 跟踪本次使用的工具中是否有已注册的 skill
                for (const toolName of toolsUsed) {
                    SkillUsageTracker_1.skillUsageTracker.trackUse(toolName);
                }
                if (this.persistenceService) {
                    this.persistenceService.recordEvolutionMetric({
                        metricType: 'feedback',
                        value: quality?.overall ?? 0.7,
                        timestamp: Date.now(),
                        metadata: {
                            traceId,
                            inputLength: input.length,
                            responseLength: response.length,
                        },
                    });
                }
                return { proceed: true };
            });
            Logger_1.Logger.info('  🧬 进化闭环: 启用', 'AgentHarness');
        }
        // Phase 7.5: 注册调度任务完成事件监听（反馈闭环）
        if (this.deps?.evolutionEngine) {
            EventBus_1.EventBus.on('scheduled_task_completed', (payload) => {
                const data = payload;
                Logger_1.Logger.info(`📊 调度任务完成事件: ${data.taskName} (${data.success ? '成功' : '失败'})`, 'AgentHarness');
                // 调用 EvolutionEngine 收集反馈
                this.deps.evolutionEngine.collectFeedback(`调度任务: ${data.taskName}`, data.success
                    ? '任务执行成功'
                    : `任务执行失败: ${data.error || '未知错误'}`, {
                    success: data.success,
                    intent: data.taskId,
                    error: data.error,
                }, 'scheduler');
            });
            Logger_1.Logger.info('  📊 调度任务反馈监听: 启用', 'AgentHarness');
        }
        // Phase 7.6: 注册文件变更事件监听（记录文件变更历史）
        EventBus_1.EventBus.on('file_changed', (payload) => {
            const data = payload;
            Logger_1.Logger.debug(`📁 文件变更: ${path_1.default.basename(data.filePath)} (${data.changeType})`, 'AgentHarness');
            // 记录文件变更到持久化服务
            if (this.persistenceService) {
                this.persistenceService.recordEvolutionMetric({
                    metricType: 'file_change',
                    value: 1,
                    timestamp: Date.now(),
                    metadata: {
                        filePath: data.filePath,
                        changeType: data.changeType,
                        timestamp: data.timestamp,
                        matchedRulesCount: data.matchedRules.length,
                    },
                });
            }
        });
        Logger_1.Logger.info('  📁 文件变更监听: 启用', 'AgentHarness');
        // Phase 7.8: 注册 FeedbackLoops 闭环钩子
        if (this.deps?.feedbackCollector && this.constraintsService) {
            const { FeedbackLoops } = require('./loops/FeedbackLoops');
            const feedbackLoops = new FeedbackLoops({
                feedbackCollector: this.deps.feedbackCollector,
                evolutionEngine: this.deps.evolutionEngine,
                memoryAssistant: this.deps.memoryAssistant,
            });
            this.constraintsService.registerHook(types_1.LifecycleEvent.AFTER_RESPONSE, feedbackLoops.createAFTER_RESPONSEHook());
            Logger_1.Logger.info('  🔄 FeedbackLoops 闭环钩子: 已注册', 'AgentHarness');
        }
        this.initialized = true;
        Logger_1.Logger.info('✅ Agent Harness 初始化完成', 'AgentHarness');
    }
    /**
     * 处理用户输入（TS 入口壳，非 Agent 核心）。
     *
     * Agent 核心（ReAct / Loop / 工具调用 / 记忆）已在 Python 端实现（agent/loop、agent/core）。
     * 本方法优先经 PythonAgentBridge 路由到 Python 后端（AGENTS.md §0.1）；
     * 仅当桥接不可用时退化为单次 LLM 直答（TS 本地不再实现 ReAct 循环）。
     */
    async processInput(input) {
        const llm = this.deps?.llm;
        const budget = this._getDynamicBudget();
        if (!llm) {
            return {
                response: '系统尚未就绪，请稍后重试。',
                quality: {
                    overall: 0,
                    accuracy: 0,
                    usefulness: 0,
                    friendliness: 0,
                    efficiency: 0,
                    details: 'LLM不可用',
                },
                trace: {
                    traceId: input.traceId || `harness_${Date.now()}`,
                    state: types_1.LoopState.FAILED,
                    stateTransitions: [],
                    trajectory: [],
                    totalDuration: 0,
                    totalToolCalls: 0,
                    budgetState: {
                        roundsUsed: 0,
                        softRoundLimit: budget.softRoundLimit,
                        hardRoundLimit: budget.hardRoundLimit,
                        tokensUsed: 0,
                        tokenWarningLimit: 0,
                        tokenHardLimit: 0,
                        startTime: Date.now(),
                        maxDurationMs: budget.maxDurationMs,
                        toolCallsUsed: 0,
                        maxToolCalls: budget.maxToolCalls,
                    },
                },
                metadata: { loopRounds: 0 },
            };
        }
        try {
            const { getPythonBridge } = await Promise.resolve().then(() => __importStar(require('../server/bootstrap')));
            const bridge = getPythonBridge();
            if (bridge) {
                const result = await bridge.processInput(input.text, input.userId || 'default', input.traceId);
                const qs = typeof result.qualityScore === 'number' ? result.qualityScore : 0.7;
                return {
                    response: result.response || '',
                    quality: {
                        overall: qs,
                        accuracy: qs,
                        usefulness: qs,
                        friendliness: Math.min(qs + 0.1, 1.0),
                        efficiency: qs,
                        details: `Python backend (quality=${qs.toFixed(2)}, rounds=${result.roundsUsed ?? '?'}, tools=${result.toolCallsMade ?? '?'})`,
                    },
                    trace: {
                        traceId: result.traceId || input.traceId || `harness_${Date.now()}`,
                        state: types_1.LoopState.COMPLETED,
                        stateTransitions: [],
                        trajectory: [],
                        totalDuration: result.duration ?? 0,
                        totalToolCalls: result.toolCallsMade ?? 0,
                        budgetState: {
                            roundsUsed: result.roundsUsed ?? 1,
                            softRoundLimit: budget.softRoundLimit,
                            hardRoundLimit: budget.hardRoundLimit,
                            tokensUsed: 0,
                            tokenWarningLimit: 0,
                            tokenHardLimit: 0,
                            startTime: Date.now(),
                            maxDurationMs: budget.maxDurationMs,
                            toolCallsUsed: result.toolCallsMade ?? 0,
                            maxToolCalls: budget.maxToolCalls,
                        },
                    },
                    metadata: { loopRounds: result.roundsUsed ?? 1, backend: 'python' },
                };
            }
        }
        catch (bridgeErr) {
            Logger_1.Logger.warn(`Python bridge unavailable, falling back to local LLM: ${bridgeErr.message}`, 'AgentHarness');
        }
        // TS 本地回退：Python 桥接不可用时，使用简化 ReAct 循环（最多 3 轮工具调用）
        if (this.deps?.llm) {
            try {
                const fallbackStart = Date.now();
                const systemPrompt = '你是家百星，一个智能AI助手。当需要执行操作时，使用提供的工具。如果无可用工具，直接回答问题。';
                const messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: input.text },
                ];
                const MAX_REACT_ROUNDS = 3;
                let totalToolCalls = 0;
                let finalContent = '';
                const toolsSchema = this.toolRegistry ? this.toolRegistry.toOpenAITools() : null;
                const hasToolCapability = toolsSchema && toolsSchema.length > 0 && typeof this.deps.llm.chatWithTools === 'function';
                if (hasToolCapability) {
                    for (let round = 0; round < MAX_REACT_ROUNDS; round++) {
                        const llmResult = await this.deps.llm.chatWithTools(messages, toolsSchema, 4096, 'auto');
                        if (llmResult.content) {
                            messages.push({ role: 'assistant', content: llmResult.content });
                        }
                        if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
                            finalContent = llmResult.content || '';
                            break;
                        }
                        const assistantMsg = {
                            role: 'assistant',
                            content: llmResult.content || null,
                            tool_calls: llmResult.toolCalls,
                        };
                        messages.push(assistantMsg);
                        for (const tc of llmResult.toolCalls) {
                            totalToolCalls++;
                            try {
                                const toolResult = await this.toolRegistry.executeToolCall(tc, {
                                    sessionId: input.userId || 'default',
                                    userId: input.userId || 'default',
                                });
                                const outputText = toolResult.success
                                    ? (typeof toolResult.result === 'string' ? toolResult.result : JSON.stringify(toolResult.result))
                                    : `工具执行失败: ${toolResult.error || '未知错误'}`;
                                messages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: outputText.slice(0, 2000),
                                });
                            }
                            catch (toolErr) {
                                Logger_1.Logger.warn(`回退路径工具执行失败: ${tc.function?.name} — ${toolErr.message}`, 'AgentHarness');
                                messages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `工具执行异常: ${toolErr.message}`,
                                });
                            }
                        }
                        finalContent = '';
                    }
                    if (!finalContent && messages.length > 0) {
                        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
                        finalContent = lastAssistant?.content || '工具调用完成，但未生成最终回复。';
                    }
                }
                else {
                    const llmResponse = await this.deps.llm.chat(input.text, systemPrompt);
                    finalContent = typeof llmResponse === 'string' ? llmResponse : String(llmResponse);
                }
                const fallbackQuality = hasToolCapability && totalToolCalls > 0 ? 0.6 : 0.5;
                return {
                    response: finalContent,
                    quality: {
                        overall: fallbackQuality,
                        accuracy: fallbackQuality,
                        usefulness: fallbackQuality,
                        friendliness: Math.min(fallbackQuality + 0.1, 1.0),
                        efficiency: fallbackQuality - 0.1,
                        details: `TS local fallback (react=${hasToolCapability}, tools=${totalToolCalls})`,
                    },
                    trace: {
                        traceId: input.traceId || `harness_${Date.now()}`,
                        state: types_1.LoopState.COMPLETED,
                        stateTransitions: [],
                        trajectory: [],
                        totalDuration: Date.now() - fallbackStart,
                        totalToolCalls,
                        budgetState: {
                            roundsUsed: 1,
                            softRoundLimit: budget.softRoundLimit,
                            hardRoundLimit: budget.hardRoundLimit,
                            tokensUsed: 0,
                            tokenWarningLimit: 0,
                            tokenHardLimit: 0,
                            startTime: fallbackStart,
                            maxDurationMs: budget.maxDurationMs,
                            toolCallsUsed: totalToolCalls,
                            maxToolCalls: budget.maxToolCalls,
                        },
                    },
                    metadata: { loopRounds: 1, backend: 'ts_local_fallback' },
                };
            }
            catch (llmErr) {
                Logger_1.Logger.warn(`Local LLM also failed: ${llmErr.message}`, 'AgentHarness');
            }
        }
        return {
            response: 'Agent 后端不可用，请检查 Python 服务状态。',
            quality: {
                overall: 0,
                accuracy: 0,
                usefulness: 0,
                friendliness: 0,
                efficiency: 0,
                details: 'Backend unavailable',
            },
            trace: {
                traceId: input.traceId || `harness_${Date.now()}`,
                state: types_1.LoopState.FAILED,
                stateTransitions: [],
                trajectory: [],
                totalDuration: 0,
                totalToolCalls: 0,
                budgetState: {
                    roundsUsed: 0,
                    softRoundLimit: budget.softRoundLimit,
                    hardRoundLimit: budget.hardRoundLimit,
                    tokensUsed: 0,
                    tokenWarningLimit: 0,
                    tokenHardLimit: 0,
                    startTime: Date.now(),
                    maxDurationMs: budget.maxDurationMs,
                    toolCallsUsed: 0,
                    maxToolCalls: budget.maxToolCalls,
                },
            },
            metadata: { loopRounds: 0, backend: 'unavailable' },
        };
    }
    /**
     * 执行生命周期钩子
     */
    _getDynamicBudget() {
        const hints = this.capabilityDetector?.getStrategyHints?.() || {};
        const reflectionConfig = this.strategyAdjuster?.getAdjustedReflectionConfig?.() || {};
        const maxSteps = hints.maxRecommendedSteps || 15;
        const softRoundLimit = Math.min(maxSteps, 10);
        const hardRoundLimit = Math.min(maxSteps, 15);
        const maxToolCalls = hints.lowCapability ? 10 : 20;
        const maxDurationMs = hints.lowCapability ? 120000 : 60000;
        return { softRoundLimit, hardRoundLimit, maxToolCalls, maxDurationMs, maxRetries: reflectionConfig.maxRetries || 2 };
    }
    async executeHook(event, extra) {
        if (!this.constraintsService)
            return;
        try {
            const hookContext = {
                event,
                metadata: extra,
            };
            const result = await this.constraintsService.executeHooks(event, hookContext);
            if (!result.proceed) {
                Logger_1.Logger.info(`🛑 钩子拦截: ${event} - ${result.reason || '未提供原因'}`, 'AgentHarness');
            }
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 生命周期钩子执行失败: ${event} - ${err.message}`, 'AgentHarness');
        }
    }
    /**
     * 获取工具注册表
     */
    getToolRegistry() {
        return this.toolRegistry;
    }
    /**
     * 获取 Schema 验证器
     */
    getSchemaValidator() {
        return this.schemaValidator;
    }
    /**
     * 获取权限守卫
     */
    getPermissionGuard() {
        return this.permissionGuard;
    }
    /**
     * 获取上下文管理器
     */
    getContextManager() {
        return this.contextManager;
    }
    /**
     * 获取验证服务
     */
    getVerificationService() {
        return this.verificationService;
    }
    /**
     * 获取约束服务
     */
    getConstraintsService() {
        return this.constraintsService;
    }
    /**
     * 获取持久化服务
     */
    getPersistenceService() {
        return this.persistenceService;
    }
    /**
     * 获取轨迹数据库
     */
    getTrajectoryDatabase() {
        return this.trajectoryDatabase;
    }
    /**
     * 注入 TrajectoryFlywheel（已迁移到 Python 后端，此方法为空操作）
     */
    injectTrajectoryFlywheel(_flywheel) {
        Logger_1.Logger.info('🔄 TrajectoryFlywheel 注入已跳过（循环层已迁移到 Python）', 'AgentHarness');
    }
    /**
     * 获取独立评估服务（P0 核心功能）
     */
    getIndependentEvaluationService() {
        return this.independentEvaluationService;
    }
    /**
     * 获取沙箱执行器
     */
    getSandboxExecutor() {
        return this.sandboxExecutor;
    }
    /**
     * 获取 LSP 客户端管理器
     */
    getLspClientManager() {
        return this.lspClientManager;
    }
    /**
     * 获取 LSP 诊断提供器
     */
    getLspDiagnosticsProvider() {
        return this.lspDiagnosticsProvider;
    }
    /**
     * 获取 LSP 补全提供器
     */
    getLspCompletionProvider() {
        return this.lspCompletionProvider;
    }
    /**
     * 获取会话存储
     */
    getSessionStore() {
        return this.sessionStore;
    }
    /**
     * 获取 Cron 调度器
     */
    getCronScheduler() {
        return this.cronScheduler;
    }
    /**
     * 获取 Skill 注册中心
     */
    getSkillRegistry() {
        return this.skillRegistry;
    }
    getACPTracker() {
        return this.acpTracker;
    }
    getMessageProcessor() {
        return this.messageProcessor;
    }
    getI18nManager() {
        return this.i18nManager;
    }
    /**
     * 获取 Harness 配置
     */
    getConfig() {
        return this.config;
    }
    /**
     * 中止当前执行循环（已迁移到 Python 后端，此方法为空操作）
     */
    abortCurrentLoop() {
        Logger_1.Logger.info('🛑 AgentHarness: 中止信号已跳过（循环层已迁移到 Python）', 'AgentHarness');
    }
    /**
     * 更新配置（运行时热更新）
     */
    updateConfig(partial) {
        this.config = { ...this.config, ...partial };
        Logger_1.Logger.info(`Harness 配置更新: ${JSON.stringify(partial)}`, 'AgentHarness');
    }
    /**
     * 关闭 Harness
     */
    async shutdown() {
        Logger_1.Logger.info('🏗️ Agent Harness 关闭', 'AgentHarness');
        this.initialized = false;
        // Fix: close resources to prevent leaks
        if (this.trajectoryDatabase) {
            try {
                this.trajectoryDatabase.close();
            }
            catch {
                /* best-effort */
            }
            this.trajectoryDatabase = null;
        }
        if (this.persistenceService) {
            try {
                void this.persistenceService.shutdown?.();
            }
            catch {
                /* best-effort */
            }
            this.persistenceService = null;
        }
        if (this.sandboxExecutor) {
            this.sandboxExecutor = null;
        }
        // Phase 2: 关闭 LSP 连接
        if (this.lspClientManager) {
            try {
                await this.lspClientManager.disconnectAll();
            }
            catch {
                /* best-effort */
            }
            this.lspClientManager = null;
            this.lspDiagnosticsProvider = null;
            this.lspCompletionProvider = null;
        }
        // Phase 3: 关闭会话存储 + Cron调度器
        if (this.sessionStore) {
            try {
                this.sessionStore.close();
            }
            catch {
                /* best-effort */
            }
            this.sessionStore = null;
        }
        if (this.cronScheduler) {
            try {
                this.cronScheduler.stop();
            }
            catch {
                /* best-effort */
            }
            this.cronScheduler = null;
        }
        this.skillRegistry = null;
        if (this.acpTracker) {
            try {
                ACPActivityTracker_1.ACPActivityTracker.resetInstance();
            }
            catch {
                /* best-effort */
            }
            this.acpTracker = null;
        }
        if (this.messageProcessor) {
            try {
                MessageProcessor_1.MessageProcessor.resetInstance();
            }
            catch {
                /* best-effort */
            }
            this.messageProcessor = null;
        }
        this.i18nManager = null;
    }
    /**
     * 注册敏感数据存储拦截钩子
     * 独立方法避免业务逻辑嵌入约束层初始化流程
     */
    async registerSensitiveDataHooks() {
        if (!this.constraintsService)
            return;
        this.constraintsService.registerHook(types_1.LifecycleEvent.BEFORE_TOOL_CALL, async (hookCtx) => {
            const toolName = hookCtx.toolName || '';
            if (toolName === 'memory_store' || toolName === 'note_take') {
                const result = this.constraintsService.enforceBehaviorConstraint('no-sensitive-storage', { toolName, params: hookCtx.params });
                if (!result.compliant) {
                    return {
                        proceed: false,
                        replacementResult: {
                            success: false,
                            output: `🛡️ 安全拦截: ${result.violation}`,
                            duration: 0,
                            validated: false,
                        },
                        reason: result.violation,
                    };
                }
            }
            return { proceed: true };
        });
        Logger_1.Logger.info('  🛡️ 敏感数据钩子: 已注册 (约束层外)', 'AgentHarness');
    }
}
exports.AgentHarness = AgentHarness;
