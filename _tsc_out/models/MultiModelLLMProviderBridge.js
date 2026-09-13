"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiModelLLMProviderBridge = exports.RoutingStrategy = void 0;
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const Logger_1 = require("../utils/Logger");
const ModelSelector_1 = require("./ModelSelector");
const OpenAICompatibleModel_1 = require("./OpenAICompatibleModel");
const PythonBackedModel_1 = require("./PythonBackedModel");
const types_1 = require("./types");
var types_2 = require("./types");
Object.defineProperty(exports, "RoutingStrategy", { enumerable: true, get: function () { return types_2.RoutingStrategy; } });
class MultiModelLLMProviderBridge {
    static instance = null;
    models = new Map();
    config;
    initialized = false;
    healthCheckTimer;
    modelSelector;
    constructor(config = {}) {
        this.config = {
            defaultStrategy: config.defaultStrategy || types_1.RoutingStrategy.PRIORITY,
            healthCheckIntervalMs: config.healthCheckIntervalMs || 30000,
            maxConsecutiveFailures: config.maxConsecutiveFailures || 3,
            requestTimeoutMs: config.requestTimeoutMs || 30000,
            enableHealthCheck: config.enableHealthCheck ?? true,
        };
        this.modelSelector = ModelSelector_1.ModelSelector.getInstance();
    }
    static getInstance(config) {
        if (!MultiModelLLMProviderBridge.instance) {
            MultiModelLLMProviderBridge.instance = new MultiModelLLMProviderBridge(config);
        }
        return MultiModelLLMProviderBridge.instance;
    }
    static reset() {
        if (MultiModelLLMProviderBridge.instance) {
            MultiModelLLMProviderBridge.instance.cleanup();
        }
        MultiModelLLMProviderBridge.instance = null;
    }
    async initialize() {
        if (this.initialized)
            return;
        await this.registerDefaultModels();
        if (this.config.enableHealthCheck) {
            this.startHealthCheck();
        }
        this.initialized = true;
        Logger_1.Logger.info(`✅ MultiModelLLMProviderBridge 初始化完成，已注册 ${this.models.size} 个模型`, 'MultiModelLLMProviderBridge');
    }
    async registerDefaultModels() {
        /* 本地模型已注释 - 日志报错本地模型不可用
        const localBaseUrl =
          process.env.OPENAI_API_BASE ||
          process.env.LLM_BASE_URL ||
          'http://127.0.0.1:8001/v1';
        const localApiKey =
          process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || 'not-needed';
        const localModelName = process.env.LLM_MODEL || 'deepseek-v4-flash';
    
        await this.registerModel(
          'local-llm',
          localModelName,
          {
            name: localModelName,
            baseUrl: localBaseUrl,
            apiKey: localApiKey,
            timeout: 30000,
            maxTokens: 4096,
            temperature: 0.7,
            topP: 0.9,
            frequencyPenalty: 0,
            presencePenalty: 0,
          },
          {
            visionScore: 60,
            codingScore: 50,
            reasoningScore: 50,
            speedScore: 90,
            contextLength: 8192,
            features: ['chat', 'code'],
          },
          10
        );
        Logger.info(
          `✅ 已注册本地模型: ${localModelName} @ ${localBaseUrl}`,
          'MultiModelLLMProviderBridge'
        );
        */
        // --- 小米 MiMo（主模型，OpenAI 兼容接口）---
        const xiaomiApiKey = process.env.XIAOMI_API_KEY;
        const xiaomiBaseUrl = process.env.XIAOMI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
        const xiaomiModelName = process.env.XIAOMI_MODEL || 'mimo-v2.5-pro';
        if (xiaomiApiKey) {
            await this.registerModel('xiaomi', xiaomiModelName, {
                name: xiaomiModelName,
                baseUrl: xiaomiBaseUrl,
                apiKey: xiaomiApiKey,
                timeout: 120000,
                maxTokens: 8192,
                temperature: 0.7,
                topP: 0.9,
                frequencyPenalty: 0,
                presencePenalty: 0,
            }, {
                visionScore: 85,
                codingScore: 88,
                reasoningScore: 90,
                speedScore: 75,
                contextLength: 131072,
                features: ['chat', 'code', 'analysis', 'review'],
            }, 30);
            Logger_1.Logger.info(`✅ 已注册小米 MiMo 模型: ${xiaomiModelName} @ ${xiaomiBaseUrl}`, 'MultiModelLLMProviderBridge');
        }
        else {
            Logger_1.Logger.info('ℹ️ 未配置 XIAOMI_API_KEY，跳过小米 MiMo 模型注册', 'MultiModelLLMProviderBridge');
        }
        const zhipuApiKey = process.env.ZHIPU_API_KEY;
        const zhipuBaseUrl = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
        const zhipuModelName = process.env.ZHIPU_MODEL || 'glm-4.5-air';
        if (zhipuApiKey) {
            await this.registerModel('zhipu', zhipuModelName, {
                name: zhipuModelName,
                baseUrl: zhipuBaseUrl,
                apiKey: zhipuApiKey,
                timeout: 60000,
                maxTokens: 4096,
                temperature: 0.7,
                topP: 0.9,
                frequencyPenalty: 0,
                presencePenalty: 0,
            }, {
                visionScore: 70,
                codingScore: 80,
                reasoningScore: 85,
                speedScore: 70,
                contextLength: 128000,
                features: ['chat', 'code', 'analysis', 'review'],
            }, 20);
            Logger_1.Logger.info(`✅ 已注册智谱模型: ${zhipuModelName} @ ${zhipuBaseUrl}`, 'MultiModelLLMProviderBridge');
        }
        else {
            Logger_1.Logger.info('ℹ️ 未配置 ZHIPU_API_KEY，跳过智谱模型注册', 'MultiModelLLMProviderBridge');
        }
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('MultiModelLLMProviderBridge 未初始化，请先调用 initialize()');
        }
    }
    async registerModel(id, name, config, capabilities, priority = 10) {
        // P2-3 C: AGENT_BACKEND=python 模式下桥壳化 — 经 PythonAgentBridge 委派，
        // 不再实例化 TS 本地 LLM 客户端（OpenAICompatibleModel）。
        const model = (0, bridgeRegistry_1.getActivePythonBridge)()
            ? new PythonBackedModel_1.PythonBackedModel(name)
            : new OpenAICompatibleModel_1.OpenAICompatibleModel({
                baseUrl: config.baseUrl,
                apiKey: config.apiKey,
                modelName: name,
            });
        try {
            await model.initialize();
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 模型 ${name} 初始化失败: ${err.message}`, 'MultiModelLLMProviderBridge');
        }
        const registeredModel = {
            id,
            name,
            model,
            config,
            capabilities,
            health: {
                available: true,
                averageLatencyMs: 0,
                successRate: 1,
                lastCheckTime: Date.now(),
                consecutiveFailures: 0,
            },
            priority,
            enabled: true,
        };
        this.models.set(id, registeredModel);
    }
    unregisterModel(id) {
        this.ensureInitialized();
        const model = this.models.get(id);
        if (!model) {
            Logger_1.Logger.warn(`⚠️ 模型未找到: ${id}`, 'MultiModelLLMProviderBridge');
            return false;
        }
        this.models.delete(id);
        return true;
    }
    listModels() {
        return Array.from(this.models.values());
    }
    getModel(id) {
        return this.models.get(id);
    }
    getModels() {
        return this.models;
    }
    setModelPriority(id, priority) {
        const model = this.models.get(id);
        if (model) {
            model.priority = priority;
        }
    }
    setModelEnabled(id, enabled) {
        const model = this.models.get(id);
        if (model) {
            model.enabled = enabled;
            Logger_1.Logger.info(`${enabled ? '✅' : '❌'} 模型 ${model.name} 已${enabled ? '启用' : '禁用'}`, 'MultiModelLLMProviderBridge');
        }
    }
    route(input, strategy) {
        this.ensureInitialized();
        const activeStrategy = strategy || this.config.defaultStrategy;
        const availableModels = this.getAvailableModels();
        return this.modelSelector.route(availableModels, input, activeStrategy);
    }
    async generate(input, strategy) {
        this.ensureInitialized();
        const routingResult = this.route(input, strategy);
        const fallbackChain = [
            routingResult.modelId,
            ...routingResult.fallbackChain,
        ];
        let lastError;
        for (const modelId of fallbackChain) {
            const model = this.models.get(modelId);
            if (!model || !model.enabled) {
                continue;
            }
            if (!model.health.available) {
                Logger_1.Logger.info(`⏭️ 跳过不可用模型 ${model.name}（上次失败: ${model.health.lastError || '未知'}）`, 'MultiModelLLMProviderBridge');
                continue;
            }
            try {
                Logger_1.Logger.info(`🎯 使用模型: ${model.name} (原因: ${routingResult.reason})`, 'MultiModelLLMProviderBridge');
                const startTime = Date.now();
                const output = await this.executeWithTimeout(model, input);
                const latency = Date.now() - startTime;
                if (!output.text) {
                    throw new Error('模型返回空内容');
                }
                this.updateHealthStatus(model, true, latency);
                output.modelName = model.name;
                output.isFallback = modelId !== routingResult.modelId;
                Logger_1.Logger.info(`✅ 模型 ${model.name} 生成成功 (${latency}ms)`, 'MultiModelLLMProviderBridge');
                return output;
            }
            catch (error) {
                lastError = error;
                this.updateHealthStatus(model, false, 0, error.message);
                Logger_1.Logger.warn(`⚠️ 模型 ${model.name} 失败，尝试降级: ${error.message}`, 'MultiModelLLMProviderBridge');
                const errorMsg = error.message.toLowerCase();
                if (errorMsg.includes('econnrefused') ||
                    errorMsg.includes('econnreset') ||
                    errorMsg.includes('connection refused') ||
                    errorMsg.includes('fetch failed') ||
                    errorMsg.includes('abort')) {
                    model.health.available = false;
                    Logger_1.Logger.warn(`🚫 连接错误，立即禁用模型 ${model.name}`, 'MultiModelLLMProviderBridge');
                }
            }
        }
        throw new Error(`所有模型均失败: ${lastError?.message || '未知错误'}`);
    }
    async *stream(input, strategy) {
        this.ensureInitialized();
        const routingResult = this.route(input, strategy);
        const model = this.models.get(routingResult.modelId);
        if (!model) {
            throw new Error('路由失败：模型未找到');
        }
        yield* model.model.stream(input);
    }
    async benchmarkModel(modelId) {
        const model = this.models.get(modelId);
        if (!model) {
            throw new Error(`模型未找到: ${modelId}`);
        }
        Logger_1.Logger.info(`📊 开始评估模型: ${model.name}`, 'MultiModelLLMProviderBridge');
        const speedScore = await this.testSpeed(model);
        const codingScore = await this.testCoding(model);
        const reasoningScore = await this.testReasoning(model);
        const visionScore = model.capabilities.features.includes('vision')
            ? await this.testVision(model)
            : 0;
        const profile = {
            visionScore,
            codingScore,
            reasoningScore,
            speedScore,
            contextLength: model.capabilities.contextLength,
            features: model.capabilities.features,
        };
        model.capabilities = profile;
        Logger_1.Logger.info(`📊 模型 ${model.name} 评估完成: 速度=${speedScore}, 代码=${codingScore}, 推理=${reasoningScore}, 视觉=${visionScore}`, 'MultiModelLLMProviderBridge');
        return profile;
    }
    getModelName() {
        const availableModels = this.getAvailableModels();
        if (availableModels.length === 0) {
            return '无可用模型';
        }
        const best = this.modelSelector.routeByPriority(availableModels);
        return best.name;
    }
    isAvailable() {
        return this.getAvailableModels().length > 0;
    }
    async healthCheck() {
        if (!this.initialized) {
            return {
                available: false,
                message: 'MultiModelLLMProviderBridge 未初始化',
            };
        }
        const availableModels = this.getAvailableModels();
        if (availableModels.length === 0) {
            return { available: false, message: '没有可用模型' };
        }
        const modelNames = availableModels.map((m) => m.name).join(', ');
        return {
            available: true,
            message: `多模型Provider可用，活跃模型: ${modelNames}`,
        };
    }
    async chat(message, history = [], systemPromptOverride) {
        this.ensureInitialized();
        const defaultPrompt = `你是家百星，28岁私人秘书。成熟、专业、从容。
回复要求：
1. 语气成熟自然，像有经验的专业人士
2. 简洁高效，不啰嗦，不堆砌空洞的关心
3. 如果是技术问题，要专业严谨
4. 如果是闲聊，要保持温暖但不过度
5. 不使用"～""哦""呢""呀"等幼化语气词`;
        const systemPrompt = systemPromptOverride || defaultPrompt;
        const historyPrompt = history
            .map((h) => `${h.role}: ${h.content}`)
            .join('\n');
        const fullPrompt = `${historyPrompt}\n\n用户: ${message}`;
        const routingResult = this.route({ prompt: fullPrompt, systemPrompt, maxTokens: 1024, temperature: 0.8 }, types_1.RoutingStrategy.PRIORITY);
        const fallbackChain = [
            routingResult.modelId,
            ...routingResult.fallbackChain,
        ];
        let lastError;
        for (const modelId of fallbackChain) {
            const registeredModel = this.models.get(modelId);
            if (!registeredModel ||
                !registeredModel.enabled ||
                !registeredModel.health.available) {
                continue;
            }
            try {
                const startTime = Date.now();
                const output = await this.executeWithTimeout(registeredModel, {
                    prompt: fullPrompt,
                    systemPrompt,
                    temperature: 0.8,
                    maxTokens: 1024,
                });
                const latency = Date.now() - startTime;
                this.updateHealthStatus(registeredModel, true, latency);
                if (!output.text) {
                    throw new Error('模型未返回内容');
                }
                return output.text;
            }
            catch (error) {
                lastError = error;
                this.updateHealthStatus(registeredModel, false, 0, error.message);
                Logger_1.Logger.warn(`⚠️ 模型 ${registeredModel.name} chat失败，尝试降级: ${error.message}`, 'MultiModelLLMProviderBridge');
            }
        }
        throw new Error(`所有模型chat均失败: ${lastError?.message || '未知错误'}`);
    }
    async analyzeCode(filePath, content, input) {
        const prompt = `分析代码文件: ${filePath}\n\n代码内容:\n${content}\n\n用户查询: ${input}\n\n请分析代码并提供详细说明。`;
        return this.chat(prompt);
    }
    async generateModifiedFileContent(filePath, content, instruction, fileExists = true) {
        const existsHint = fileExists
            ? '请直接输出修改后的完整文件内容'
            : '文件不存在，请生成新的完整文件内容';
        const prompt = `文件: ${filePath}\n\n原始内容:\n${content}\n\n修改指令: ${instruction}\n\n${existsHint}，不要添加额外说明。`;
        return this.chat(prompt);
    }
    async devGenerateCode(userRequest, filePath, existingContent) {
        const systemPrompt = `你是一名专业的软件开发工程师助手。请根据用户需求生成高质量、规范、可运行的代码。

要求：
- 代码必须完整，包含所有必要的导入（import）和类型定义
- 使用现代最佳实践和语言最新特性
- 代码要规范、易读、有适当的注释
- 如果是修改现有文件，保持原有代码风格
- 如果是新文件，生成完整的文件内容
- 直接输出可用的代码，不要包含解释性文字
- 代码块不要用 markdown 代码块包裹`;
        const fileContext = filePath ? `\n目标文件路径：${filePath}` : '';
        const existingCodeContext = existingContent
            ? `\n\n当前文件内容：\n${existingContent}`
            : '\n（新文件，当前不存在）';
        const prompt = `用户需求：${userRequest}${fileContext}${existingCodeContext}\n\n请生成代码。`;
        const output = await this.generate({ prompt, systemPrompt, temperature: 0.3, maxTokens: 4096 }, types_1.RoutingStrategy.CAPABILITY);
        if (!output.text) {
            throw new Error('模型未返回内容');
        }
        return output.text;
    }
    getHealthStatus() {
        const status = {};
        this.models.forEach((model, id) => {
            status[id] = { ...model.health };
        });
        return status;
    }
    async shutdown() {
        this.cleanup();
        Logger_1.Logger.info('🛑 MultiModelLLMProviderBridge 已关闭', 'MultiModelLLMProviderBridge');
    }
    async checkAllModelsHealth() {
        await this.checkModelsHealth();
    }
    getAvailableModels() {
        return Array.from(this.models.values()).filter((m) => m.enabled && m.health.available);
    }
    async executeWithTimeout(model, input) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`请求超时 (${this.config.requestTimeoutMs}ms)`));
            }, this.config.requestTimeoutMs);
            model.model
                .generate(input)
                .then((output) => {
                clearTimeout(timeout);
                resolve(output);
            })
                .catch((error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
    updateHealthStatus(model, success, latency, error) {
        if (success) {
            model.health.consecutiveFailures = 0;
            model.health.successRate = model.health.successRate * 0.9 + 0.1;
            if (latency > 0) {
                model.health.averageLatencyMs =
                    model.health.averageLatencyMs * 0.9 + latency * 0.1;
            }
        }
        else {
            model.health.consecutiveFailures++;
            model.health.successRate = model.health.successRate * 0.9;
            model.health.lastError = error;
            if (model.health.consecutiveFailures >= this.config.maxConsecutiveFailures) {
                model.health.available = false;
                Logger_1.Logger.warn(`🚫 模型 ${model.name} 连续失败 ${model.health.consecutiveFailures} 次，已标记为不可用`, 'MultiModelLLMProviderBridge');
            }
        }
        model.health.lastCheckTime = Date.now();
    }
    startHealthCheck() {
        this.healthCheckTimer = setInterval(() => {
            void this.checkModelsHealth();
        }, this.config.healthCheckIntervalMs);
    }
    async checkModelsHealth() {
        for (const [, model] of this.models) {
            if (!model.enabled)
                continue;
            try {
                const startTime = Date.now();
                await model.model.generate({
                    prompt: '你好',
                    maxTokens: 5,
                });
                const latency = Date.now() - startTime;
                this.updateHealthStatus(model, true, latency);
            }
            catch (error) {
                this.updateHealthStatus(model, false, 0, error.message);
            }
        }
    }
    cleanup() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = undefined;
        }
        this.models.clear();
        this.initialized = false;
    }
    async testSpeed(model) {
        try {
            const startTime = Date.now();
            await model.model.generate({
                prompt: 'Hello',
                maxTokens: 10,
            });
            const latency = Date.now() - startTime;
            return Math.max(0, Math.min(100, 100 - latency / 10));
        }
        catch {
            return 0;
        }
    }
    async testCoding(model) {
        try {
            const output = await model.model.generate({
                prompt: 'Write a function to calculate factorial in Python',
                maxTokens: 100,
            });
            const hasCode = output.text.includes('def ') && output.text.includes('return');
            return hasCode ? 80 + Math.random() * 20 : 40 + Math.random() * 20;
        }
        catch {
            return 0;
        }
    }
    async testReasoning(model) {
        try {
            const output = await model.model.generate({
                prompt: 'If it takes 5 machines 5 minutes to make 5 widgets, how long does it take 100 machines to make 100 widgets?',
                maxTokens: 50,
            });
            const correct = output.text.includes('5 minutes') || output.text.includes('5分钟');
            return correct ? 90 + Math.random() * 10 : 50 + Math.random() * 20;
        }
        catch {
            return 0;
        }
    }
    async testVision(model) {
        return model.capabilities.visionScore || 50;
    }
}
exports.MultiModelLLMProviderBridge = MultiModelLLMProviderBridge;
