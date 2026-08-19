"use strict";
/**
 * LLM Provider - 统一使用 OpenAI 兼容接口
 * 支持重试机制和健康检查，增强连接稳定性
 * v2: 支持多模型热切换和自动故障转移
 *
 * 迁移说明：LLM 核心（chat / chatWithTools / healthCheck / getModelName /
 * markLocalUnavailable / resetAvailability）已归属 Python agent/llm。
 * 当 AGENT_BACKEND=python（默认）且 PythonAgentBridge 可用时，上述方法
 * 经 bridgeRegistry 代理到 Python FastAPI (:3112) 的 /v1/llm/* 端点。
 * AGENT_BACKEND=local 降级时仍走 TS 本地实现。
 * 多模态 / 代码助手 / 多模型路由策略暂留 TS（第二批迁移）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMProviderBridge = void 0;
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const PreferenceInjector_1 = require("../memory/PreferenceInjector");
const Logger_1 = require("../utils/Logger");
const ChatProvider_1 = require("./ChatProvider");
const CodeProvider_1 = require("./CodeProvider");
const LLMResponseCache_1 = require("./LLMResponseCache");
const MessageSanitizer_1 = require("./MessageSanitizer");
const MultimodalProvider_1 = require("./MultimodalProvider");
const OpenAICompatibleModel_1 = require("./OpenAICompatibleModel");
const prompt_templates_1 = require("./prompt-templates");
const PromptOptimizer_1 = require("./PromptOptimizer");
const PythonBackedModel_1 = require("./PythonBackedModel");
const RequestQueue_1 = require("./RequestQueue");
/**
 * @deprecated LLM 核心（chat / chatWithTools / healthCheck / multimodal / code /
 * devGenerateCode / mark-unavailable / reset）已迁移 Python agent/llm，经
 * PythonAgentBridge 代理 /v1/llm/* 端点。此类保留为兼容桥接实现：bridge 优先，
 * bridge 为 null（AGENT_BACKEND=local）时回落本地 ChatProvider/CodeProvider/
 * MultimodalProvider。原路径 src/models/LLMProvider.ts 已改为 re-export 壳。
 */
class LLMProviderBridge {
    constructor(modelName, model) {
        this.maxRetries = 2;
        this.baseRetryInterval = 1000;
        this.serviceAvailable = false;
        this.zhipuModel = null;
        this.localUnavailable = false;
        this.localUnavailableSince = 0;
        this._fallbackLastErrorTime = 0;
        this._fallbackConsecutiveFailures = 0;
        // v5.1: 优先使用 ProviderManager 配置
        const pmPrimary = (() => {
            try {
                const { getProviderManager } = require('./ProviderManager');
                const pm = getProviderManager();
                const pk = pm.getPrimary();
                return pk
                    ? {
                        key: pk.apiKey,
                        base: pk.baseUrl,
                        model: pk.model,
                        name: pk.name,
                        extra: pk.extra,
                    }
                    : null;
            }
            catch (err) {
                Logger_1.Logger.debug(`LLMProviderBridge初始化失败: ${err?.message}`, 'LLMProviderBridge');
                return null;
            }
        })();
        if (model) {
            this.model = model;
            this.modelName = modelName || 'external';
            Logger_1.Logger.info('🔌 使用外部注入的模型实例', 'LLMProvider');
        }
        else if ((0, bridgeRegistry_1.getActivePythonBridge)()) {
            // Python 后端模式（AGENT_BACKEND=python）：不实例化 TS 本地 LLM 客户端（§0.1 收口）。
            // 所有真实调用经 PythonAgentBridge 委派 Python agent.llm；此处仅放置占位模型满足 Model 契约。
            this.modelName = modelName || process.env.LLM_MODEL || 'python-backend';
            this.model = new PythonBackedModel_1.PythonBackedModel(this.modelName);
            this.zhipuModel = null;
            this.serviceAvailable = true;
            Logger_1.Logger.info('🐍 使用 Python 后端 LLM（桥接模式，TS 本地客户端已禁用）', 'LLMProvider');
        }
        else {
            // 优先使用 ProviderManager 主模型
            if (pmPrimary) {
                this.modelName = pmPrimary.model;
                Logger_1.Logger.info(`🔌 使用 ProviderManager 主模型: ${pmPrimary.name} (${pmPrimary.model})`, 'LLMProvider');
                this.model = new OpenAICompatibleModel_1.OpenAICompatibleModel({
                    baseUrl: pmPrimary.base,
                    apiKey: pmPrimary.key,
                    modelName: pmPrimary.model,
                    timeout: 90000,
                    maxTokens: 8192,
                    temperature: 0.6,
                    topP: 0.9,
                    thinkingMode: (pmPrimary.extra?.thinkingMode ||
                        'disabled'),
                    reasoningEffort: pmPrimary.extra?.reasoningEffort || undefined,
                });
            }
            else {
                this.modelName =
                    modelName || process.env.LLM_MODEL || 'deepseek-v4-flash';
                Logger_1.Logger.info('🔌 使用 OpenAI 兼容模式', 'LLMProvider');
                this.model = new OpenAICompatibleModel_1.OpenAICompatibleModel({
                    baseUrl: process.env.OPENAI_API_BASE ||
                        process.env.LLM_BASE_URL ||
                        'https://api.deepseek.com',
                    apiKey: process.env.OPENAI_API_KEY ||
                        process.env.LLM_API_KEY ||
                        'not-needed',
                    modelName: this.modelName,
                    thinkingMode: process.env.DEEPSEEK_THINKING_MODE ||
                        'disabled',
                    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT,
                });
                if (process.env.ZHIPU_API_KEY) {
                    this.zhipuModel = new OpenAICompatibleModel_1.OpenAICompatibleModel({
                        baseUrl: process.env.ZHIPU_BASE_URL ||
                            'https://open.bigmodel.cn/api/paas/v4',
                        apiKey: process.env.ZHIPU_API_KEY,
                        modelName: process.env.ZHIPU_MODEL || 'glm-4.5-air',
                        timeout: 60000,
                    });
                    Logger_1.Logger.info(`✅ LLMProvider 已加载智谱降级模型: ${process.env.ZHIPU_MODEL || 'glm-4.5-air'}`, 'LLMProvider');
                }
                else {
                    Logger_1.Logger.info('ℹ️ 未配置 ZHIPU_API_KEY，不加载智谱降级模型', 'LLMProvider');
                }
            }
        }
        this.responseCache = new LLMResponseCache_1.LLMResponseCache();
        this.requestQueue = new RequestQueue_1.RequestQueue(2);
        // v5.1 Task 7: 初始化三个子 Provider（门面模式）
        this.chatProvider = new ChatProvider_1.ChatProvider(this.model, this.modelName);
        this.codeProvider = new CodeProvider_1.CodeProvider(this.model, this.modelName);
        this.multimodalProvider = new MultimodalProvider_1.MultimodalProvider(this.model, this.modelName);
    }
    /**
     * 根据输入复杂度选择合适的模型
     * 简单任务（问候/短查询）→ 主模型
     * 复杂任务（代码/分析）→ 主模型（能力最强）
     * 如果主模型不可用，降级到备用模型
     */
    selectModel(_input) {
        if (this.localUnavailable || !this.serviceAvailable) {
            // 自动恢复：如果已过恢复间隔，重置标志并重试主模型
            if (this.localUnavailable &&
                this.localUnavailableSince > 0 &&
                Date.now() - this.localUnavailableSince >
                    LLMProviderBridge.RECOVERY_INTERVAL_MS) {
                Logger_1.Logger.info('🔄 主模型恢复间隔已过，重新尝试使用主模型', 'LLMProvider');
                this.localUnavailable = false;
                this.localUnavailableSince = 0;
                return this.model;
            }
            if (this.zhipuModel) {
                Logger_1.Logger.info('🚀 主模型不可用，使用降级模型', 'LLMProvider');
                return this.zhipuModel;
            }
            // 没有降级模型时，仍然返回主模型让调用方处理（而非直接抛异常阻塞所有请求）
            Logger_1.Logger.warn('⚠️ 主模型不可用且无降级模型，仍尝试使用主模型', 'LLMProvider');
            return this.model;
        }
        // 检查主模型熔断状态
        if (this.model && typeof this.model.isCircuitOpen === 'function') {
            if (this.model.isCircuitOpen()) {
                Logger_1.Logger.warn('⚠️ 主模型熔断中，切换到降级模型', 'LLMProvider');
                if (this.zhipuModel)
                    return this.zhipuModel;
            }
        }
        // 当前主模型可用，直接用
        return this.model;
    }
    async initialize() {
        try {
            await this.model.initialize();
            this.serviceAvailable = true;
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ LLM 初始化失败: ${error.message}`, 'LLMProvider');
            this.serviceAvailable = false;
        }
        if (this.zhipuModel) {
            try {
                await this.zhipuModel.initialize();
                Logger_1.Logger.info('✅ 智谱降级模型初始化完成', 'LLMProvider');
            }
            catch (zError) {
                Logger_1.Logger.warn(`⚠️ 智谱降级模型初始化失败: ${zError.message}`, 'LLMProvider');
            }
        }
    }
    async healthCheck() {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmHealthCheck();
        }
        try {
            const baseUrl = process.env.OPENAI_API_BASE ||
                process.env.LLM_BASE_URL ||
                'https://api.deepseek.com';
            const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || 'not-needed';
            Logger_1.Logger.info(`🔍 执行健康检查: baseUrl=${baseUrl}`, 'LLMProvider');
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                signal: AbortSignal.timeout(10000),
            });
            if (response.ok) {
                this.serviceAvailable = true;
                this.localUnavailable = false;
                Logger_1.Logger.info(`✅ 健康检查通过: ${baseUrl}`, 'LLMProvider');
                return {
                    available: true,
                    message: `LLM 服务可用，模型 ${this.modelName}`,
                };
            }
            // 401 通常是 API key 认证问题，但模型调用仍可能成功
            if (response.status === 401) {
                this.serviceAvailable = true;
                this.localUnavailable = false;
                return {
                    available: true,
                    message: `LLM 服务可用（/models 返回 401，但模型调用正常），模型 ${this.modelName}`,
                };
            }
            this.serviceAvailable = false;
            this.localUnavailable = true;
            this.localUnavailableSince = Date.now();
            return { available: false, message: 'LLM 服务响应异常' };
        }
        catch (error) {
            this.serviceAvailable = false;
            this.localUnavailable = true;
            this.localUnavailableSince = Date.now();
            Logger_1.Logger.warn(`🚫 本地 LLM 不可用，已标记: ${error.message}`, 'LLMProvider');
            return {
                available: false,
                message: `无法连接到 LLM 服务: ${error.message}`,
            };
        }
    }
    async multimodalChat(message, images, history = []) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmMultimodalChat(message, images ?? [], history);
        }
        if (this.localUnavailable) {
            throw new Error('本地模型已标记不可用');
        }
        return this.multimodalProvider.multimodalChat(message, images, history);
    }
    async multimodalCodeAnalysis(userQuery, images, filePath) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmMultimodalCodeAnalysis(userQuery, images, filePath);
        }
        return this.multimodalProvider.multimodalCodeAnalysis(userQuery, images, filePath);
    }
    async analyzeCode(filePath, content, userQuery) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmCodeAnalyze(filePath, content, userQuery);
        }
        return this.codeProvider.analyzeCode(filePath, content, userQuery);
    }
    async generateModificationPlan(filePath, content, userQuery) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmCodeModificationPlan(filePath, content, userQuery);
        }
        return this.codeProvider.generateModificationPlan(filePath, content, userQuery);
    }
    async generateModifiedFileContent(filePath, currentContent, userRequest, fileExists) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmCodeModifiedContent(filePath, currentContent, userRequest, fileExists);
        }
        return this.codeProvider.generateModifiedFileContent(filePath, currentContent, userRequest, fileExists);
    }
    async chat(message, history = [], systemPromptOverride) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmChat(message, history, systemPromptOverride);
        }
        if (this.localUnavailable || !this.serviceAvailable) {
            if (this.zhipuModel) {
                if (this._fallbackConsecutiveFailures >= 3 &&
                    Date.now() - this._fallbackLastErrorTime < LLMProviderBridge.FALLBACK_COOLDOWN_MS) {
                    Logger_1.Logger.warn('⚠️ 降级模型近期连续失败，冷却中，直接抛出错误', 'LLMProvider');
                    throw new Error('主模型和降级模型均不可用，请稍后重试');
                }
                Logger_1.Logger.info('🚀 本地模型已标记不可用，直接使用智谱降级模型', 'LLMProvider');
                try {
                    const defaultPrompt = (0, prompt_templates_1.getPromptTemplate)('chat');
                    const systemPrompt = (0, PreferenceInjector_1.injectPreferences)(systemPromptOverride || defaultPrompt);
                    const compressedHistory = PromptOptimizer_1.PromptOptimizer.compressHistory(history, 1000);
                    const historyPrompt = compressedHistory
                        .map((h) => `${h.role}: ${h.content}`)
                        .join('\n');
                    const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
                    const optimizedPrompt = PromptOptimizer_1.PromptOptimizer.optimizePrompt(humanPrompt, 2000);
                    const zhipuResponse = await this.zhipuModel.generate({
                        prompt: optimizedPrompt,
                        systemPrompt: systemPrompt,
                        temperature: 0.6,
                        maxTokens: 1024,
                    });
                    if (zhipuResponse.text) {
                        this._fallbackConsecutiveFailures = 0;
                        return zhipuResponse.text;
                    }
                }
                catch (zhipuError) {
                    this._fallbackConsecutiveFailures++;
                    this._fallbackLastErrorTime = Date.now();
                    Logger_1.Logger.error(`❌ 智谱降级也失败`, zhipuError, 'LLMProvider');
                }
            }
            throw new Error('所有模型均不可用');
        }
        try {
            return await this.chatProvider.chat(message, history, systemPromptOverride);
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ 主模型 LLM聊天失败: ${error.message}`, 'LLMProvider');
            this.localUnavailable = true;
            this.localUnavailableSince = Date.now();
            Logger_1.Logger.info('🚫 本地模型已标记为不可用，后续请求将直接使用智谱降级', 'LLMProvider');
            if (this.zhipuModel) {
                try {
                    const defaultPrompt = (0, prompt_templates_1.getPromptTemplate)('chat');
                    const fallbackSystemPrompt = (0, PreferenceInjector_1.injectPreferences)(systemPromptOverride || defaultPrompt);
                    const compressedHistory = PromptOptimizer_1.PromptOptimizer.compressHistory(history, 1000);
                    const historyPrompt = compressedHistory
                        .map((h) => `${h.role}: ${h.content}`)
                        .join('\n');
                    const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
                    const fallbackOptimizedPrompt = PromptOptimizer_1.PromptOptimizer.optimizePrompt(humanPrompt, 2000);
                    const zhipuResponse = await this.zhipuModel.generate({
                        prompt: fallbackOptimizedPrompt,
                        systemPrompt: fallbackSystemPrompt,
                        temperature: 0.6,
                        maxTokens: 1024,
                    });
                    if (zhipuResponse.text) {
                        this._fallbackConsecutiveFailures = 0;
                        Logger_1.Logger.info(`✅ 智谱降级模型回复成功 (${zhipuResponse.text.length} 字符)`, 'LLMProvider');
                        return zhipuResponse.text;
                    }
                }
                catch (zhipuError) {
                    this._fallbackConsecutiveFailures++;
                    this._fallbackLastErrorTime = Date.now();
                    Logger_1.Logger.error(`❌ 智谱降级也失败`, zhipuError, 'LLMProvider');
                }
            }
            Logger_1.Logger.error(`⚠️ LLM聊天失败`, error, 'LLMProvider');
            throw error;
        }
    }
    /**
     * 使用 Function Calling 调用 LLM
     * v3: LLM 原生架构核心方法，支持工具调用循环
     * v5.1 Task 7: 委托给 ChatProvider，保留门面中的 zhipuModel 降级逻辑
     */
    async chatWithTools(messages, tools, maxTokens = 4096, toolChoice = 'auto') {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmChatWithTools(messages, tools, maxTokens, toolChoice);
        }
        // 如果本地模型不可用，直接走智谱降级
        if ((this.localUnavailable || !this.serviceAvailable) && this.zhipuModel) {
            Logger_1.Logger.info('🚀 chatWithTools 主模型不可用，直接降级到智谱模型', 'LLMProvider');
            try {
                const sanitizedMessages = this.sanitizeMessagesForAPI(messages);
                const response = await this.zhipuModel.generate({
                    messages: sanitizedMessages,
                    tools,
                    maxTokens,
                    temperature: 0.5,
                    toolChoice,
                });
                let toolCalls = response.toolCalls
                    ? this.normalizeToolCalls(response.toolCalls)
                    : undefined;
                if (toolCalls && tools) {
                    const validToolNames = new Set(tools.map((t) => t.function?.name).filter(Boolean));
                    toolCalls = this._validateFallbackToolCalls(toolCalls, validToolNames);
                }
                return {
                    content: response.text || '',
                    toolCalls,
                };
            }
            catch (zhipuError) {
                Logger_1.Logger.error(`❌ 智谱降级也失败: ${zhipuError.message}`, zhipuError, 'LLMProvider');
                throw zhipuError;
            }
        }
        try {
            return await this.chatProvider.chatWithTools(messages, tools, maxTokens, toolChoice);
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ chatWithTools 主模型失败: ${error.message}`, 'LLMProvider');
            this.localUnavailable = true;
            this.localUnavailableSince = Date.now();
            if (this.zhipuModel) {
                Logger_1.Logger.info('🚀 chatWithTools 降级到智谱模型', 'LLMProvider');
                try {
                    const sanitizedMessages = this.sanitizeMessagesForAPI(messages);
                    const response = await this.zhipuModel.generate({
                        messages: sanitizedMessages,
                        tools,
                        maxTokens,
                        temperature: 0.5,
                        toolChoice,
                    });
                    let toolCalls = response.toolCalls
                        ? this.normalizeToolCalls(response.toolCalls)
                        : undefined;
                    if (toolCalls && tools) {
                        const validToolNames = new Set(tools.map((t) => t.function?.name).filter(Boolean));
                        toolCalls = this._validateFallbackToolCalls(toolCalls, validToolNames);
                    }
                    return {
                        content: response.text || '',
                        toolCalls,
                    };
                }
                catch (zhipuError) {
                    Logger_1.Logger.error(`❌ 智谱降级也失败: ${zhipuError.message}`, zhipuError, 'LLMProvider');
                }
            }
            Logger_1.Logger.error(`❌ Function Calling 失败: ${error.message}`, error, 'LLMProvider');
            throw error;
        }
    }
    /**
     * F0-04: 规范化 tool_calls，确保所有必需字段存在
     * 防止 DeepSeek 等模型返回格式异常的 tool_calls 导致下游崩溃
     */
    normalizeToolCalls(toolCalls) {
        return toolCalls.map((tc, index) => ({
            id: tc.id || `tc_${Date.now()}_${index}`,
            type: tc.type || 'function',
            function: {
                name: tc.function?.name || 'unknown',
                arguments: tc.function?.arguments || '{}',
            },
        }));
    }
    /**
     * 验证降级模型返回的 tool_calls，过滤幻觉工具调用
     *
     * 降级模型（如智谱）可能不熟悉主模型的工具集，
     * 容易产生不存在的工具名。此方法过滤掉无效工具调用，
     * 并尝试修复 arguments 中的 JSON 格式问题。
     */
    _validateFallbackToolCalls(toolCalls, validToolNames) {
        if (!toolCalls || toolCalls.length === 0) return undefined;
        const validated = [];
        for (const tc of toolCalls) {
            const name = tc.function?.name || 'unknown';
            if (!validToolNames.has(name)) {
                Logger_1.Logger.warn(`⚠️ 降级模型幻觉工具调用: "${name}" 不在已注册工具中，跳过`, 'LLMProvider');
                continue;
            }
            let args = tc.function?.arguments || '{}';
            if (typeof args === 'object' && args !== null) {
                try {
                    args = JSON.stringify(args);
                }
                catch {
                    args = '{}';
                }
            }
            if (typeof args !== 'string') {
                args = '{}';
            }
            try {
                JSON.parse(args);
            }
            catch {
                Logger_1.Logger.warn(`⚠️ 降级模型工具参数非法JSON: ${name}，尝试修复`, 'LLMProvider');
                try {
                    const repaired = MessageSanitizer_1.MessageSanitizer.repairJson(args);
                    if (repaired) {
                        args = JSON.stringify(repaired);
                    }
                    else {
                        args = '{}';
                    }
                }
                catch {
                    args = '{}';
                }
            }
            validated.push({
                id: tc.id,
                type: tc.type || 'function',
                function: { name, arguments: args },
            });
        }
        return validated.length > 0 ? validated : undefined;
    }
    /**
     * v3: 清理 messages 数组，确保符合 OpenAI API 规范
     *
     * 已委托给 MessageSanitizer.sanitizeMessagesForAPI 统一实现。
     * - 合并多条 system 消息为一条
     * - 为 tool 消息添加 name 字段
     * - 移除空 content 的 assistant 消息（除非有 tool_calls）
     */
    sanitizeMessagesForAPI(messages) {
        return MessageSanitizer_1.MessageSanitizer.sanitizeMessages(messages);
    }
    /**
     * 开发副驾专用：专业代码生成（无人设，无"亲爱的主人"等强制称呼）
     * 使用专业开发者 system prompt，直接生成可执行代码
     * v5.1 Task 7: 委托给 CodeProvider
     */
    async devGenerateCode(userRequest, filePath, existingContent) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return bridge.llmDevGenerateCode(userRequest, filePath, existingContent);
        }
        return this.codeProvider.devGenerateCode(userRequest, filePath, existingContent);
    }
    isAvailable() {
        return (this.model !== null && this.serviceAvailable && !this.localUnavailable);
    }
    isServiceAvailable() {
        return this.serviceAvailable && !this.localUnavailable;
    }
    getModelName() {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return this.modelName || 'python-backend';
        }
        return this.modelName;
    }
    /** 永久标记本地模型不可用（供外部调用，如启动时健康检查失败） */
    markLocalUnavailable(reason) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            bridge.llmMarkUnavailable(reason).catch((err) => {
                Logger_1.Logger.warn(`Python markUnavailable 失败: ${err.message}`, 'LLMProvider');
            });
            this.localUnavailable = true;
            this.localUnavailableSince = Date.now();
            this.serviceAvailable = false;
            return;
        }
        this.localUnavailable = true;
        this.localUnavailableSince = Date.now();
        this.serviceAvailable = false;
        Logger_1.Logger.warn(`🚫 本地模型已标记不可用${reason ? `: ${reason}` : ''}`, 'LLMProvider');
    }
    /** 重置可用性标志（供外部调用，如用户手动切换回本地模型） */
    resetAvailability() {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            bridge.llmResetAvailability().catch((err) => {
                Logger_1.Logger.warn(`Python resetAvailability 失败: ${err.message}`, 'LLMProvider');
            });
            this.localUnavailable = false;
            this.serviceAvailable = true;
            return;
        }
        this.localUnavailable = false;
        this.serviceAvailable = true;
        Logger_1.Logger.info('🔄 本地模型可用性已重置', 'LLMProvider');
    }
}
exports.LLMProviderBridge = LLMProviderBridge;
LLMProviderBridge.RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
LLMProviderBridge.CONNECTION_ERRORS = [
    'econnrefused',
    'econnreset',
    'enetunreach',
    'connection refused',
    'connect econnrefused',
    'network error',
    'network timeout',
    'fetch failed',
    'abort',
    '超时',
];
LLMProviderBridge.FALLBACK_COOLDOWN_MS = 60 * 1000;
