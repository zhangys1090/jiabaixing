"use strict";
/**
 * MultiModelProvider — 多模型 LLM 提供者
 *
 * 替代旧的 LLMProvider，从 ProviderManager 读取配置
 * 支持：
 * - 多 provider 注册
 * - 自动降级 (第一个失败→第二个→...)
 * - 任务复杂度路由 (简单→便宜模型, 复杂→强模型)
 *
 * 兼容原 LLMProvider 的 chat(), chatWithTools(), generate() 接口
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiModelProvider = void 0;
const Logger_1 = require("../utils/Logger");
const OpenAICompatibleModel_1 = require("./OpenAICompatibleModel");
const PythonBackedModel_1 = require("./PythonBackedModel");
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const ProviderManager_1 = require("./ProviderManager");
const LLMResponseCache_1 = require("./LLMResponseCache");
const RequestQueue_1 = require("./RequestQueue");
const PromptOptimizer_1 = require("./PromptOptimizer");
const prompt_templates_1 = require("./prompt-templates");
const PreferenceInjector_1 = require("../memory/PreferenceInjector");
const PerformanceMonitor_1 = require("../monitoring/PerformanceMonitor");
class MultiModelProvider {
    instances = new Map();
    responseCache;
    requestQueue;
    maxRetries = 2;
    baseRetryInterval = 1000;
    serviceAvailable = false;
    localUnavailable = false;
    static CONNECTION_ERRORS = [
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
    constructor() {
        this.responseCache = new LLMResponseCache_1.LLMResponseCache();
        this.requestQueue = new RequestQueue_1.RequestQueue(2);
        this.initFromProviderManager();
    }
    /** 从 ProviderManager 初始化所有模型实例 */
    initFromProviderManager() {
        const pm = (0, ProviderManager_1.getProviderManager)();
        const providers = pm.getAll();
        if (providers.length === 0) {
            Logger_1.Logger.warn('⚠️ 未配置任何 Provider，尝试从 .env 导入', 'MultiModelProvider');
            pm.importFromEnv();
        }
        for (const p of pm.getAll()) {
            try {
                const model = this.createModel(p);
                this.instances.set(p.name, model);
                Logger_1.Logger.info(`✅ 已加载模型: ${p.displayName} (${p.model}) @ ${p.baseUrl}`, 'MultiModelProvider');
            }
            catch (e) {
                Logger_1.Logger.warn(`⚠️ 加载模型失败 ${p.name}: ${e.message}`, 'MultiModelProvider');
            }
        }
        if (this.instances.size === 0) {
            Logger_1.Logger.error('❌ 没有任何模型实例可用', new Error('No models'), 'MultiModelProvider');
        }
        else {
            this.serviceAvailable = true;
        }
    }
    createModel(config) {
        // P2-3 C: AGENT_BACKEND=python 模式下桥壳化 — 经 PythonAgentBridge 委派，
        // 不再实例化 TS 本地 LLM 客户端（OpenAICompatibleModel）。
        if ((0, bridgeRegistry_1.getActivePythonBridge)()) {
            return new PythonBackedModel_1.PythonBackedModel(config.model);
        }
        return new OpenAICompatibleModel_1.OpenAICompatibleModel({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            modelName: config.model,
            timeout: 90000,
            maxTokens: 8192,
            temperature: 0.7,
            topP: 0.9,
            thinkingMode: (config.extra?.thinkingMode || 'disabled'),
            reasoningEffort: config.extra?.reasoningEffort || undefined,
        });
    }
    /** 获取所有可用模型名称列表 */
    getAvailableModels() {
        const pm = (0, ProviderManager_1.getProviderManager)();
        return pm.getAll().map((p) => ({
            name: p.name,
            displayName: p.displayName,
            model: p.model,
            healthy: p.healthy,
        }));
    }
    /** 根据 ProviderManager 的路由规则获取模型列表（按优先级排序） */
    getModelsForInput(input) {
        const pm = (0, ProviderManager_1.getProviderManager)();
        const providers = pm.getProvidersForInput(input);
        const models = [];
        for (const p of providers) {
            const m = this.instances.get(p.name);
            if (m)
                models.push({ name: p.name, model: m });
        }
        // 如果路由没有返回模型，fallback 到所有可用实例
        if (models.length === 0) {
            for (const [name, model] of this.instances) {
                models.push({ name, model });
            }
        }
        return models;
    }
    /** 获取单个指定名称的模型 */
    getModel(name) {
        return this.instances.get(name);
    }
    /** 获取主模型 */
    getPrimaryModel() {
        const pm = (0, ProviderManager_1.getProviderManager)();
        const primary = pm.getPrimary();
        if (primary)
            return this.instances.get(primary.name);
        return this.instances.values().next().value;
    }
    async initialize() {
        for (const [name, model] of this.instances) {
            try {
                await model.initialize();
                const pm = (0, ProviderManager_1.getProviderManager)();
                pm.updateHealth(name, true);
            }
            catch (e) {
                Logger_1.Logger.warn(`⚠️ ${name} 初始化失败: ${e.message}`, 'MultiModelProvider');
                (0, ProviderManager_1.getProviderManager)().updateHealth(name, false);
            }
        }
    }
    async healthCheck() {
        const results = [];
        let anyAvailable = false;
        for (const [name] of this.instances) {
            try {
                const pm = (0, ProviderManager_1.getProviderManager)();
                const config = pm.get(name);
                if (!config)
                    continue;
                const response = await fetch(`${config.baseUrl}/models`, {
                    headers: { Authorization: `Bearer ${config.apiKey}` },
                    signal: AbortSignal.timeout(10000),
                });
                const available = response.ok || response.status === 401;
                results.push({ name, available });
                pm.updateHealth(name, available);
                if (available)
                    anyAvailable = true;
            }
            catch {
                results.push({ name, available: false });
                (0, ProviderManager_1.getProviderManager)().updateHealth(name, false);
            }
        }
        this.serviceAvailable = anyAvailable;
        return {
            available: anyAvailable,
            message: anyAvailable
                ? `${results.filter((r) => r.available).length}/${results.length} 个模型可用`
                : '没有可用的模型',
            models: results,
        };
    }
    /** 带降级的重试执行 */
    async executeWithFallback(operation, input, operationName) {
        if (this.localUnavailable) {
            throw new Error('所有模型已标记不可用');
        }
        const models = this.getModelsForInput(input);
        if (models.length === 0) {
            throw new Error('没有可用的模型');
        }
        let lastError = null;
        for (const { name, model } of models) {
            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    const result = await operation(model, name);
                    (0, ProviderManager_1.getProviderManager)().updateHealth(name, true);
                    return result;
                }
                catch (error) {
                    lastError = error;
                    const errMsg = lastError.message.toLowerCase();
                    const isConnErr = MultiModelProvider.CONNECTION_ERRORS.some((e) => errMsg.includes(e));
                    if (!isConnErr && attempt < this.maxRetries) {
                        const delay = this.baseRetryInterval * Math.pow(2, attempt);
                        Logger_1.Logger.warn(`${operationName} ${name} 第${attempt + 1}次失败，${delay}ms后重试: ${lastError.message}`, 'MultiModelProvider');
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    if (isConnErr) {
                        Logger_1.Logger.warn(`${operationName} ${name} 连接错误，切换到下一个模型: ${lastError.message}`, 'MultiModelProvider');
                        (0, ProviderManager_1.getProviderManager)().updateHealth(name, false);
                        break; // 跳出重试循环，尝试下一个模型
                    }
                    // 非连接错误且重试耗尽
                    Logger_1.Logger.warn(`${operationName} ${name} 重试耗尽，切换到下一个模型`, 'MultiModelProvider');
                }
            }
        }
        this.localUnavailable = true;
        throw lastError || new Error(`${operationName} 所有模型均失败`);
    }
    // ═══════════════════════════════════════════════════════════
    // 以下方法与原 LLMProvider 的 public API 保持兼容
    // ═══════════════════════════════════════════════════════════
    async chat(message, history = [], systemPromptOverride, input) {
        const defaultPrompt = (0, prompt_templates_1.getPromptTemplate)('chat');
        const systemPrompt = (0, PreferenceInjector_1.injectPreferences)(systemPromptOverride || defaultPrompt);
        const compressedHistory = PromptOptimizer_1.PromptOptimizer.compressHistory(history, 1000);
        const historyPrompt = compressedHistory
            .map((h) => `${h.role}: ${h.content}`)
            .join('\n');
        const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
        const optimizedPrompt = PromptOptimizer_1.PromptOptimizer.optimizePrompt(humanPrompt, 2000);
        const cacheKey = this.responseCache.generateKey(optimizedPrompt, systemPrompt);
        const cached = this.responseCache.get(cacheKey);
        if (cached)
            return cached;
        const routeInput = input || message;
        const result = await this.executeWithFallback(async (model) => {
            const response = await model.generate({
                prompt: optimizedPrompt,
                systemPrompt,
                temperature: 0.8,
                maxTokens: 1024,
            });
            if (response.error)
                throw new Error(response.error);
            if (!response.text)
                throw new Error('模型未返回内容');
            return response.text;
        }, routeInput, 'chat');
        this.responseCache.set(cacheKey, result);
        return result;
    }
    async chatWithTools(messages, tools, maxTokens = 4096, toolChoice = 'auto', input) {
        const sanitizedMessages = this.sanitizeMessagesForAPI(messages);
        const routeInput = input || sanitizedMessages[0]?.content || '';
        return await this.executeWithFallback(async (model) => {
            const response = await model.generate({
                messages: sanitizedMessages,
                tools,
                maxTokens,
                temperature: 0.8,
                toolChoice,
            });
            const inputEst = sanitizedMessages.reduce((s, m) => s + (m.content?.length || 0), 0);
            const outputEst = (response.text?.length || 0) * 2;
            PerformanceMonitor_1.perf.recordTokenUsage(Math.round(inputEst * 1.3), Math.round(outputEst * 1.3));
            return {
                content: response.text || '',
                toolCalls: response.toolCalls
                    ? this.normalizeToolCalls(response.toolCalls)
                    : undefined,
            };
        }, routeInput, 'chatWithTools');
    }
    async streamChat(message, onChunk, history = [], systemPromptOverride) {
        const defaultPrompt = (0, prompt_templates_1.getPromptTemplate)('chat');
        const systemPrompt = (0, PreferenceInjector_1.injectPreferences)(systemPromptOverride || defaultPrompt);
        const compressedHistory = PromptOptimizer_1.PromptOptimizer.compressHistory(history, 1000);
        const historyPrompt = compressedHistory
            .map((h) => `${h.role}: ${h.content}`)
            .join('\n');
        const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
        const optimizedPrompt = PromptOptimizer_1.PromptOptimizer.optimizePrompt(humanPrompt, 2000);
        // streamChat 用主模型（流式一般比较重，用最强的）
        const primary = this.getPrimaryModel();
        if (!primary)
            throw new Error('没有可用的模型');
        // TODO: 实现真正的 streaming (目前用非流式模拟)
        const response = await primary.generate({
            prompt: optimizedPrompt,
            systemPrompt,
            temperature: 0.8,
            maxTokens: 1024,
        });
        const text = response.text || '';
        if (text) {
            onChunk(text);
        }
        return text;
    }
    async multimodalChat(message, images, history = []) {
        const systemPrompt = (0, PreferenceInjector_1.injectPreferences)((0, prompt_templates_1.getPromptTemplate)('multimodalChat'));
        const compressedHistory = PromptOptimizer_1.PromptOptimizer.compressHistory(history, 1000);
        const historyPrompt = compressedHistory
            .map((h) => `${h.role}: ${h.content}`)
            .join('\n');
        const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
        const optimizedPrompt = PromptOptimizer_1.PromptOptimizer.optimizePrompt(humanPrompt, 2000);
        const cacheKey = this.responseCache.generateKey(optimizedPrompt + (images?.length || 0).toString(), systemPrompt);
        const cached = this.responseCache.get(cacheKey);
        if (cached)
            return cached;
        // 多模态用主模型（通常需要视觉能力）
        const primary = this.getPrimaryModel();
        if (!primary)
            throw new Error('没有可用的模型');
        const response = await primary.generate({
            prompt: optimizedPrompt,
            systemPrompt,
            temperature: 0.7,
            maxTokens: 2048,
            images,
        });
        if (response.error)
            throw new Error(response.error);
        if (!response.text)
            throw new Error('模型未返回内容');
        this.responseCache.set(cacheKey, response.text);
        return response.text;
    }
    /** 兼容原 LLMProvider 的 markLocalUnavailable */
    markLocalUnavailable(message) {
        this.localUnavailable = true;
        Logger_1.Logger.warn(`🚫 标记为不可用: ${message}`, 'MultiModelProvider');
    }
    /** 兼容: 降级时的提示 */
    generateFallbackPrompt() {
        return '抱歉，我暂时无法连接到大模型服务。';
    }
    sanitizeMessagesForAPI(messages) {
        return messages.map((msg) => {
            const sanitized = {};
            for (const [key, value] of Object.entries(msg)) {
                if (value !== null && value !== undefined) {
                    sanitized[key] = value;
                }
            }
            return sanitized;
        });
    }
    normalizeToolCalls(rawToolCalls) {
        return rawToolCalls.map((tc, index) => {
            const fn = tc.function;
            let args = '';
            if (fn) {
                if (typeof fn.arguments === 'string')
                    args = fn.arguments;
                else if (fn.arguments !== undefined && fn.arguments !== null) {
                    try {
                        args = JSON.stringify(fn.arguments);
                    }
                    catch {
                        args = '{}';
                    }
                }
            }
            return {
                id: tc.id || `tc_${Date.now()}_${index}`,
                type: tc.type || 'function',
                function: {
                    name: fn?.name || 'unknown',
                    arguments: args,
                },
            };
        });
    }
}
exports.MultiModelProvider = MultiModelProvider;
