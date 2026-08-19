"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiabaixingCore = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const EvolutionOrchestrator_1 = require("../evolution/EvolutionOrchestrator");
const FeedbackCollector_1 = require("../evolution/FeedbackCollector");
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const LLMProvider_1 = require("../models/LLMProvider");
const PerformanceMonitor_1 = require("../monitoring/PerformanceMonitor");
const SecurityAuditor_1 = require("../monitoring/SecurityAuditor");
const PersonaCore_1 = require("../persona/PersonaCore");
const PersonaRules_1 = require("../persona/PersonaRules");
const contracts_1 = require("../shared/contracts");
const EventBus_1 = require("../shared/EventBus");
const TrajectoryExporter_1 = require("../training/TrajectoryExporter");
const Logger_1 = require("../utils/Logger");
const MemoryLeakGuard_1 = require("../utils/MemoryLeakGuard");
const ConstitutionPromptBuilder_1 = require("./ConstitutionPromptBuilder");
const ConversationHistoryManager_1 = require("./ConversationHistoryManager");
const MemoryAssistant_1 = require("./MemoryAssistant");
const OptimizationScheduler_1 = require("./OptimizationScheduler");
const StreamResponseService_1 = require("./StreamResponseService");
const TreeOfThought_1 = require("./TreeOfThought");
function adaptMemoryEngineForPromptBuilder(me) {
    return me;
}
/**
 * JiabaixingCore 核心引擎
 *
 * V5.0 统一架构：
 * - 完全委托给 AgentHarness 处理
 * - 保留必要的集成组件（记忆、调度、进化）
 * - 移除旧的 FC 循环、DirectExecutor 等残留
 */
/** 上下文文件扫描列表（按优先级排序） */
const CONTEXT_FILE_LIST = [
    'JIABAIXING.md',
    'CONTEXT.md',
    '.jiabaixing/context.md',
    'CLAUDE.md',
];
/** 上下文文件缓存有效期（5分钟） */
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
class JiabaixingCore {
    constructor() {
        this.initialized = false;
        this.memoryEngine = null;
        this.traeOptimizationIntegrator = null;
        // 反馈收集器 — 闭合 Loop B（进化反馈经 Python 后端 python/agent/evolution 采集）
        this.feedbackCollector = new FeedbackCollector_1.FeedbackCollector();
        this.scenarioScheduler = null;
        /** 进化编排器（AGENT_BACKEND=python 模式下为 null，进化由 Python agent.evolution 经 PythonAgentBridge 接管） */
        this.orchestrator = null;
        // V5.0: 核心组件
        this.harness = null;
        // RL 训练轨迹导出器
        this.trajectoryExporter = new TrajectoryExporter_1.TrajectoryExporter();
        this.trajectoryBuffer = [];
        this.memoryLeakGuard = MemoryLeakGuard_1.MemoryLeakGuard.getInstance();
        // 项目上下文文件缓存
        this._contextFileCache = [];
        this._contextCacheTimestamp = 0;
        /**
         * Python 后端桥接解析器（由 bootstrap.ts 注入，避免循环依赖）
         *
         * 当 AGENT_BACKEND=python 时，processInput 会优先通过此解析器
         * 获取 PythonAgentBridge 实例并转发请求，实现统一路由。
         */
        this.pythonBridgeResolver = null;
        this.personaCore = new PersonaCore_1.PersonaCore();
        this.personaGuard = new PersonaRules_1.PersonaRules(this.personaCore);
        this.llm = new LLMProvider_1.LLMProvider(process.env.LLM_MODEL || 'deepseek-v4-flash');
        this.performanceMonitor = PerformanceMonitor_1.PerformanceMonitor.getInstance();
        this.streamResponseService = new StreamResponseService_1.StreamResponseService();
        this.securityAuditor = new SecurityAuditor_1.SecurityAuditor({
            logFilePath: path_1.default.join(process.cwd(), 'data', 'logs', 'security-audit.log'),
        });
        // 初始化宪法 prompt 构建器 (V1 evolution removed)
        this.constitutionPromptBuilder = new ConstitutionPromptBuilder_1.ConstitutionPromptBuilder({
            memoryEngine: adaptMemoryEngineForPromptBuilder(this.memoryEngine),
            evolutionEngine: undefined,
        });
        // 初始化进化编排器
        // P2-3 收口：python 模式不实例化 TS 进化编排器（避免 TS 独立运行 Agent 核心，§0.1）。
        this.orchestrator = (0, bridgeRegistry_1.getActivePythonBridge)()
            ? null
            : EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
        // 初始化对话历史管理器
        this.conversationHistoryManager = new ConversationHistoryManager_1.ConversationHistoryManager();
        this.memoryLeakGuard.registerBuffer('trajectoryBuffer', this.trajectoryBuffer, { maxSize: 1000, warningThreshold: 0.8 });
    }
    getLLM() {
        return this.llm;
    }
    getPersonaCore() {
        return this.personaCore;
    }
    async initialize() {
        if (this.initialized) {
            Logger_1.Logger.info('JiabaixingCore 已初始化，跳过', 'JiabaixingCore');
            return;
        }
        const isPythonBackend = (process.env.AGENT_BACKEND ?? 'python') === 'python' &&
            this.pythonBridgeResolver;
        if (isPythonBackend) {
            Logger_1.Logger.info('JiabaixingCore 轻量初始化 (Python后端模式 — 跳过本地AI组件)', 'JiabaixingCore');
            this.initialized = true;
            return;
        }
        Logger_1.Logger.info('🧠 初始化 JiabaixingCore (V5.0 统一架构)', 'JiabaixingCore');
        Logger_1.Logger.info('✅ 步骤5：SkillRegistry 核心技能由 AgentHarness 双写兼容注册', 'JiabaixingCore');
        // 模型初始化 + 健康检查
        try {
            await this.llm.initialize();
            const healthCheckResult = await this.llm.healthCheck();
            if (!healthCheckResult.available) {
                Logger_1.Logger.warn(`⚠️ LLM服务暂时不可用: ${healthCheckResult.message}，将以降级模式运行`, 'JiabaixingCore');
                this.llm.markLocalUnavailable(healthCheckResult.message);
            }
            else {
                Logger_1.Logger.info(`✅ 步骤6：LLM健康检查通过: ${healthCheckResult.message}`, 'JiabaixingCore');
                Logger_1.Logger.info(`   LLM模型: ${process.env.LLM_MODEL || 'deepseek-v4-flash'}`, 'JiabaixingCore');
            }
        }
        catch (llmError) {
            Logger_1.Logger.warn(`⚠️ LLM初始化失败: ${llmError.message}，将以降级模式运行`, 'JiabaixingCore');
            this.llm.markLocalUnavailable(llmError.message);
        }
        // 异步加载对话历史
        await this.conversationHistoryManager.init();
        // 初始化优化调度器
        this.optimizationSchedulerManager = new OptimizationScheduler_1.OptimizationScheduler({
            memoryEngine: this
                .memoryEngine,
        });
        this.memoryAssistant = new MemoryAssistant_1.MemoryAssistant({
            memoryEngine: this.memoryEngine,
        });
        if (process.env.ENABLE_AUTO_OPTIMIZE !== 'false') {
            await this.optimizationSchedulerManager.applyOptimizationsFromReport();
            this.optimizationSchedulerManager.startOptimizationScheduler();
            Logger_1.Logger.info('🧬 步骤9：自动优化调度已启动（每24小时执行一次）', 'JiabaixingCore');
        }
        else {
            Logger_1.Logger.info('⏸️ 步骤9：自动优化调度已禁用（ENABLE_AUTO_OPTIMIZE=false）', 'JiabaixingCore');
        }
        this.optimizationSchedulerManager.setupUserCorrectionHandler();
        this.optimizationSchedulerManager.watchAnalysisReport();
        this.performanceMonitor.startMonitoring();
        this.initialized = true;
        Logger_1.Logger.info('✅ JiabaixingCore 初始化完成 (V5.0)', 'JiabaixingCore');
    }
    /**
     * 注入记忆引擎
     */
    setMemoryEngine(memoryEngine) {
        this.memoryEngine = memoryEngine;
        this.constitutionPromptBuilder = new ConstitutionPromptBuilder_1.ConstitutionPromptBuilder({
            memoryEngine: adaptMemoryEngineForPromptBuilder(this.memoryEngine),
            evolutionEngine: undefined,
        });
    }
    /**
     * 注入 Python 后端桥接解析器
     *
     * @param resolver - 返回 PythonAgentBridge 实例或 null 的回调函数
     *
     * Usage:
     *   core.setPythonBridgeResolver(() => pythonBridge);
     */
    setPythonBridgeResolver(resolver) {
        this.pythonBridgeResolver = resolver;
        Logger_1.Logger.info('🔌 Python 后端桥接解析器已注入，processInput 将统一路由到 Python 后端', 'JiabaixingCore');
    }
    getPythonBridgeResolver() {
        return this.pythonBridgeResolver;
    }
    /**
     * 获取宪法 Prompt 构建器
     */
    getConstitutionPromptBuilder() {
        return this.constitutionPromptBuilder;
    }
    /**
     * 获取对话历史管理器
     */
    getConversationHistoryManager() {
        return this.conversationHistoryManager;
    }
    /**
     * 设置场景感知调度器
     */
    setScenarioScheduler(scheduler) {
        this.scenarioScheduler = scheduler;
    }
    /**
     * 获取场景感知调度器
     */
    getScenarioScheduler() {
        return this.scenarioScheduler;
    }
    /**
     * 获取性能监控器
     */
    getPerformanceMonitor() {
        return this.performanceMonitor;
    }
    /**
     * 设置TRAE优化系统集成器
     */
    setTRAEOptimizationIntegrator(integrator) {
        this.traeOptimizationIntegrator = integrator;
        Logger_1.Logger.info('✅ TRAE优化系统集成器已注入', 'JiabaixingCore');
    }
    /**
     * 获取TRAE优化系统集成器
     */
    getTRAEOptimizationIntegrator() {
        return this.traeOptimizationIntegrator;
    }
    /**
     * 注入 Agent Harness（V5.0 统一架构）
     */
    setHarness(harness) {
        this.harness = harness;
        Logger_1.Logger.info('✅ Agent Harness 已注入 (V5.0)', 'JiabaixingCore');
    }
    /**
     * 获取 Agent Harness
     */
    getHarness() {
        return this.harness;
    }
    exportTrajectories(format = 'sharegpt') {
        const fmt = format === 'jsonl'
            ? TrajectoryExporter_1.ExportFormat.JSONL
            : format === 'openai_finetune'
                ? TrajectoryExporter_1.ExportFormat.OPENAI_FINETUNE
                : TrajectoryExporter_1.ExportFormat.SHAREGPT;
        return this.trajectoryExporter.export(this.trajectoryBuffer, fmt);
    }
    getTrajectoryStats() {
        return this.trajectoryExporter.getStats(this.trajectoryBuffer);
    }
    /**
     * 获取记忆引擎实例
     */
    getMemoryEngine() {
        return this.memoryEngine;
    }
    /**
     * 获取记忆助手实例（供 FeedbackLoops 使用）
     */
    getMemoryAssistant() {
        return this.memoryAssistant;
    }
    /**
     * 加载项目上下文文件并注入到 ConstitutionPromptBuilder
     * 使用缓存机制，5分钟内不重复读磁盘
     */
    async loadAndInjectProjectContext() {
        try {
            const now = Date.now();
            const cacheExpired = now - this._contextCacheTimestamp >= CONTEXT_CACHE_TTL_MS;
            if (cacheExpired) {
                this._contextFileCache = await this.scanContextFiles();
                this._contextCacheTimestamp = now;
                Logger_1.Logger.info(`📄 项目上下文文件已加载: ${this._contextFileCache.length} 个`, 'JiabaixingCore');
            }
            const contextText = this._contextFileCache
                .map((entry) => `[${entry.fileName}]\n${entry.content}`)
                .join('\n\n');
            this.constitutionPromptBuilder.setProjectContext(contextText);
        }
        catch (error) {
            Logger_1.Logger.warn(`项目上下文文件加载失败: ${error.message}`, 'JiabaixingCore');
            // 加载失败不影响主流程
        }
    }
    /**
     * 扫描项目根目录下的上下文文件
     * @returns 成功读取的上下文文件条目列表
     */
    async scanContextFiles() {
        const projectRoot = process.cwd();
        const entries = [];
        for (const fileName of CONTEXT_FILE_LIST) {
            const filePath = path_1.default.join(projectRoot, fileName);
            try {
                if (fs_1.default.existsSync(filePath)) {
                    const content = fs_1.default.readFileSync(filePath, 'utf-8').trim();
                    if (content.length > 0) {
                        entries.push({
                            fileName,
                            content,
                            loadedAt: Date.now(),
                        });
                        Logger_1.Logger.debug(`📄 加载上下文文件: ${fileName} (${content.length} 字符)`, 'JiabaixingCore');
                    }
                }
            }
            catch (error) {
                Logger_1.Logger.debug(`跳过上下文文件 ${fileName}: ${error.message}`, 'JiabaixingCore');
            }
        }
        return entries;
    }
    /**
     * 手动刷新项目上下文文件缓存
     * @returns 刷新后加载的上下文文件数量
     */
    async refreshProjectContext() {
        this._contextCacheTimestamp = 0;
        await this.loadAndInjectProjectContext();
        return this._contextFileCache.length;
    }
    /**
     * 获取当前已加载的上下文文件列表
     * @returns 上下文文件条目的只读副本
     */
    getLoadedContextFiles() {
        return [...this._contextFileCache];
    }
    async getLLMHealth() {
        return this.llm.healthCheck();
    }
    /**
     * V5.0 统一 processInput
     *
     * 完全委托给 AgentHarness 处理，保留降级路径
     */
    async processInput(input, userId, traceId, images) {
        if (!this.initialized) {
            await this.initialize();
        }
        // ═══════════════════════════════════════════════════════════════
        // 统一 Python 后端路由
        // 当 AGENT_BACKEND=python 且 bridge 可用时，所有调用 core.processInput
        // 的入口（HTTP路由/WebSocket/CLI/调度器/集成管理器）一次性全部走 Python 后端
        // ═══════════════════════════════════════════════════════════════
        // V5.0 默认启用 Python 后端（真后端）：AGENT_BACKEND 未设置时按 python 处理；
        // 仅当显式设置 AGENT_BACKEND=local 时回退到 TS 本地（已废弃）。
        // pythonBridgeResolver 守卫确保：未桥接 / 测试场景下安全降级到 TS 本地。
        if ((process.env.AGENT_BACKEND ?? 'python') === 'python' &&
            this.pythonBridgeResolver) {
            const bridge = this.pythonBridgeResolver();
            if (bridge) {
                const bridgeResult = await bridge.processInput(input, userId, traceId, images);
                return {
                    response: bridgeResult.response,
                    traceId: bridgeResult.traceId || traceId || Logger_1.Logger.generateTraceId(),
                    intent: bridgeResult.intent || 'python_backend',
                    quality: bridgeResult.qualityScore ?? 0,
                    qualityScore: bridgeResult.qualityScore,
                    toolCallsMade: bridgeResult.toolCallsMade,
                    roundsUsed: bridgeResult.roundsUsed,
                    duration: bridgeResult.duration,
                    finishReason: bridgeResult.finishReason,
                };
            }
        }
        const finalTraceId = traceId || Logger_1.Logger.generateTraceId();
        Logger_1.Logger.setTraceId(finalTraceId);
        Logger_1.Logger.info(`🚀 开始处理用户输入: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`, 'JiabaixingCore');
        // 加载项目上下文文件并注入到 ConstitutionPromptBuilder
        await this.loadAndInjectProjectContext();
        // 立即发送处理开始的信号，让前端知道后端已开始处理
        void EventBus_1.EventBus.emit('agent_execution_update', {
            traceId: finalTraceId,
            phase: 'processing_start',
            status: 'started',
            timestamp: new Date().toISOString(),
        });
        const startTime = Date.now();
        let requestSuccess = false;
        // 更新用户活跃状态
        if (this.scenarioScheduler) {
            this.scenarioScheduler.updateUserActivity();
        }
        // 标记记忆引擎用户活跃（用于"做梦"机制判断空闲状态）
        if (this.memoryEngine?.markUserActive) {
            this.memoryEngine.markUserActive();
        }
        this.securityAuditor.logAuditEntry({
            level: 'info',
            category: 'user_action',
            userId: userId || 'anonymous',
            action: 'process_input',
            details: { inputLength: input.length, traceId: finalTraceId },
            severity: 'low',
        });
        try {
            // ═══════════════════════════════════════════════════════════════
            // V5.0: Harness Agent Framework (统一架构)
            // ═══════════════════════════════════════════════════════════════
            if (this.harness && this.harness.getConfig().useHarnessLoop) {
                Logger_1.Logger.info('🏗️ V5.0 Harness 统一处理', 'JiabaixingCore');
                // 获取上一个助手消息，供 FeedbackLoops 进行纠正检测
                const previousResponse = this.conversationHistoryManager.getPreviousAssistantMessage?.() || '';
                const harnessResult = await this.harness.processInput({
                    text: input,
                    userId,
                    traceId: finalTraceId,
                    images, // Fix: pass images through to harness
                    metadata: { previousResponse },
                });
                const safeResponse = harnessResult.response;
                const qualityScore = harnessResult.quality.overall;
                Logger_1.Logger.info(`🏗️ Harness 处理完成 (质量:${qualityScore.toFixed(2)}, 轮次:${harnessResult.metadata.loopRounds}, 工具:${harnessResult.trace.totalToolCalls})`, 'JiabaixingCore');
                requestSuccess = qualityScore >= 0.5;
                // 累积 RL 训练轨迹 (通过 MemoryLeakGuard 管理防止内存泄漏)
                const trajectoryEntry = {
                    id: finalTraceId,
                    steps: [
                        { role: 'user', content: input },
                        { role: 'assistant', content: safeResponse },
                    ],
                    quality: qualityScore,
                    metadata: {
                        loopRounds: harnessResult.metadata.loopRounds,
                        toolCalls: harnessResult.trace.totalToolCalls,
                        userId,
                    },
                };
                this.trajectoryBuffer.push(trajectoryEntry);
                this.memoryLeakGuard.pushToBuffer('trajectoryBuffer', trajectoryEntry);
                // 更新对话历史
                this.conversationHistoryManager.addUserMessage(input);
                this.conversationHistoryManager.addAssistantMessage(safeResponse);
                // 闭环逻辑已迁移到 FeedbackLoops，通过 AFTER_RESPONSE 钩子自动触发
                this.streamResponseService.stream(safeResponse, finalTraceId);
                Logger_1.Logger.info(`✅ 流式推送已启动: traceId=${finalTraceId}, 响应长度=${safeResponse.length}, 质量=${qualityScore.toFixed(2)}`, 'JiabaixingCore');
                Logger_1.Logger.debug(`📦 对话历史已更新，当前 ${this.conversationHistoryManager.getLength()} 条，将在 ${contracts_1.SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS}ms 内批量保存`, 'JiabaixingCore');
                return {
                    response: safeResponse,
                    traceId: finalTraceId,
                    intent: 'harness_orchestrated',
                    quality: harnessResult.quality.overall,
                    loopRounds: harnessResult.metadata.loopRounds,
                    toolCallsCount: harnessResult.trace.totalToolCalls,
                };
            }
            // ═══════════════════════════════════════════════════════════════
            // 降级：如果 Harness 不可用
            // ═══════════════════════════════════════════════════════════════
            Logger_1.Logger.warn('⚠️ Harness 不可用，使用简单回复', 'JiabaixingCore');
            const fallbackResponse = `抱歉，当前系统配置不完整，请检查环境变量设置。`;
            this.conversationHistoryManager.addUserMessage(input);
            this.conversationHistoryManager.addAssistantMessage(fallbackResponse);
            this.streamResponseService.stream(fallbackResponse, finalTraceId);
            Logger_1.Logger.warn(`⚠️ 流式推送已启动(降级): traceId=${finalTraceId}`, 'JiabaixingCore');
            Logger_1.Logger.debug(`📦 对话历史已更新，当前 ${this.conversationHistoryManager.getLength()} 条，将在 ${contracts_1.SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS}ms 内批量保存`, 'JiabaixingCore');
            return {
                response: fallbackResponse,
                traceId: finalTraceId,
                intent: 'fallback_simple',
                quality: 0.1,
                qualityScore: 0.1,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 处理用户输入失败', error, 'JiabaixingCore');
            const fallbackResponse = `抱歉，处理过程中出现了问题：${error.message}`;
            this.conversationHistoryManager.addUserMessage(input);
            this.conversationHistoryManager.addAssistantMessage(fallbackResponse);
            this.streamResponseService.stream(fallbackResponse, finalTraceId);
            Logger_1.Logger.error(`❌ 流式推送已启动(错误): traceId=${finalTraceId}, error=${error.message}`, error, 'JiabaixingCore');
            Logger_1.Logger.debug(`📦 对话历史已更新，当前 ${this.conversationHistoryManager.getLength()} 条，将在 ${contracts_1.SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS}ms 内批量保存`, 'JiabaixingCore');
            return {
                response: fallbackResponse,
                traceId: finalTraceId,
                intent: 'error_fallback',
                quality: 0.0,
                qualityScore: 0.0,
            };
        }
        finally {
            const duration = Date.now() - startTime;
            this.performanceMonitor.recordRequest(duration, requestSuccess);
            Logger_1.Logger.clearTraceId();
        }
    }
    async processInputWithTracking(input, userId, traceId) {
        const finalTraceId = traceId || Logger_1.Logger.generateTraceId();
        const startTime = Date.now();
        EventBus_1.EventBus.startTrace(finalTraceId, 'core_process_input', {
            input: input.substring(0, 50),
            userId,
        });
        void EventBus_1.EventBus.emit('agent_execution_update', {
            traceId: finalTraceId,
            phase: 'processing_start',
            status: 'started',
            timestamp: new Date().toISOString(),
        });
        try {
            const result = await this.processInput(input, userId, finalTraceId);
            EventBus_1.EventBus.completeTrace(finalTraceId, true);
            return {
                success: true,
                response: result.response,
                intent: result.intent,
                duration: Date.now() - startTime,
                traceId: finalTraceId,
            };
        }
        catch (error) {
            EventBus_1.EventBus.failTrace(finalTraceId, error.message);
            void EventBus_1.EventBus.emit('agent_execution_update', {
                traceId: finalTraceId,
                phase: 'processing_error',
                status: 'failed',
                result: { error: error.message },
                timestamp: new Date().toISOString(),
            });
            return {
                success: false,
                error: error.message,
                duration: Date.now() - startTime,
                traceId: finalTraceId,
            };
        }
    }
    /**
     * 生成主动消息 — 使用 LLM 生成人格化的主动消息
     */
    async generateProactiveMessage(context) {
        // 主动消息原因 → 引导文案映射
        const reasonGuidance = {
            long_silence: '用户已经很久没有互动了，用温暖的方式打个招呼，不要有压力感',
            negative_emotion_trend: '用户之前的情绪不太好，用关心但不刻意的语气问候',
            morning_greeting: '早上好，用轻松的方式开启新的一天',
            evening_checkin: '晚上好，关心一下今天过得怎么样',
            late_night: '用户还在熬夜，用关心的语气提醒休息',
            scheduled: '有日程提醒需要告知用户',
            behavior_pattern: '根据用户的行为习惯，提供适时的建议',
            git_changes: '用户的代码仓库有变化，可以主动提供建议',
            idle_reminder: '用户似乎空闲了，可以提供一些有用的建议',
        };
        const guidance = reasonGuidance[context.reason] || '用自然的方式与用户互动';
        try {
            const systemPrompt = `${this.personaCore.buildPersonaSummary()}

你正在发起一次主动对话。规则：
- 不要说"我是AI"或"作为助手"
- 不要过度热情或刻意
- 保持自然、温暖、简洁
- 不超过50字
- 不要用"主人"称呼
- ${guidance}`;
            const userPrompt = context.context
                ? `背景信息: ${context.context}\n场景: ${context.scene}`
                : `场景: ${context.scene}`;
            const response = await this.llm.chat(userPrompt, [], systemPrompt);
            return response || this.getFallbackProactiveMessage(context.reason);
        }
        catch {
            return this.getFallbackProactiveMessage(context.reason);
        }
    }
    /**
     * 主动消息降级方案
     */
    getFallbackProactiveMessage(reason) {
        const fallbacks = {
            long_silence: '在忙什么呢？需要帮忙的话随时说~',
            negative_emotion_trend: '今天还好吗？有什么我能帮上的？',
            morning_greeting: '早~ 新的一天开始了，有什么计划吗？',
            evening_checkin: '晚上好，今天辛苦了~',
            late_night: '这么晚了还在忙？注意休息哦',
            scheduled: '有个提醒想跟你说一下~',
            behavior_pattern: '想到一个可能对你有帮助的建议~',
            git_changes: '看到你的代码有更新，需要帮忙review吗？',
            idle_reminder: '闲着的话，要不要看看待办事项？',
        };
        return fallbacks[reason] || '在呢，需要什么帮忙吗？';
    }
    // ═══════════════════════════════════════════════════════════
    // P1 #8: Tree-of-Thought 推理框架
    // 多路径探索 + 评估 + 回溯，增强复杂推理能力
    // ═══════════════════════════════════════════════════════════
    async treeOfThoughtReasoning(problem, options) {
        const engine = new TreeOfThought_1.TreeOfThoughtEngine(this.llm);
        return engine.reason(problem, options);
    }
}
exports.JiabaixingCore = JiabaixingCore;
