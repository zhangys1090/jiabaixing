"use strict";
/**
 * 模型管理器 - MultiModelManager适配器
 * 统一使用 MultiModelManager 实现，保持向后兼容
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelManager = void 0;
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const Logger_1 = require("../utils/Logger");
const OpenAICompatibleModel_1 = require("./OpenAICompatibleModel");
const PythonBackedModel_1 = require("./PythonBackedModel");
/** MultiModelManager 存根（原模块已删除） */
class MultiModelManager {
    static instance;
    currentModelName = 'default';
    static create() {
        return new MultiModelManager();
    }
    static getInstance() {
        if (!MultiModelManager.instance) {
            MultiModelManager.instance = new MultiModelManager();
        }
        return MultiModelManager.instance;
    }
    models = new Map();
    async initializeAll() { }
    getAvailableModels() {
        return [];
    }
    selectModel(_task) {
        return 'default';
    }
    addModel(_config) { }
    removeModel(_id) { }
    getModel(_id) {
        return undefined;
    }
    listModels() {
        return [];
    }
    registerModel(_config) { }
    getCurrentModelName() {
        return this.currentModelName;
    }
}
class ModelManager {
    models = new Map();
    initialized = false;
    multiModelManager;
    constructor() {
        this.multiModelManager = MultiModelManager.getInstance();
    }
    async initialize() {
        try {
            await this.registerDefaultModels();
            await this.multiModelManager.initializeAll();
            this.initialized = true;
            Logger_1.Logger.info('✅ 模型管理器初始化成功（使用MultiModelManager）', 'ModelManager');
        }
        catch (error) {
            Logger_1.Logger.error('❌ 模型管理器初始化失败:', error, 'ModelManager');
            throw error;
        }
    }
    async registerDefaultModels() {
        // 小米 MiMo 优先：如果配置了 XIAOMI_API_KEY，自动作为默认模型
        const xiaomiApiKey = process.env.XIAOMI_API_KEY;
        const xiaomiBaseUrl = process.env.XIAOMI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
        const xiaomiModel = process.env.XIAOMI_MODEL || 'mimo-v2.5-pro';
        const llmModel = xiaomiApiKey
            ? xiaomiModel
            : process.env.LLM_MODEL || 'deepseek-v4-flash';
        const baseUrl = xiaomiApiKey
            ? xiaomiBaseUrl
            : process.env.OPENAI_API_BASE || 'http://127.0.0.1:8001/v1';
        const apiKey = xiaomiApiKey
            ? xiaomiApiKey
            : process.env.OPENAI_API_KEY || 'not-needed';
        const defaultConfig = {
            name: 'default',
            displayName: 'Default Model',
            priority: 1,
            baseUrl: baseUrl,
            apiKey: apiKey,
            modelName: llmModel,
            enabled: true,
        };
        this.multiModelManager.registerModel(defaultConfig);
        // P2-3 C: AGENT_BACKEND=python 模式下桥壳化 — 经 PythonAgentBridge 委派，
        // 不再实例化 TS 本地 LLM 客户端（OpenAICompatibleModel）。
        if ((0, bridgeRegistry_1.getActivePythonBridge)()) {
            const pythonModel = new PythonBackedModel_1.PythonBackedModel(llmModel);
            await pythonModel.initialize();
            this.models.set('openai_compatible', pythonModel);
            this.models.set('default', pythonModel);
            Logger_1.Logger.info('✅ Python 后端模型占位注册成功', 'ModelManager');
            return;
        }
        const openaiModel = new OpenAICompatibleModel_1.OpenAICompatibleModel({
            baseUrl: baseUrl,
            apiKey: apiKey,
            modelName: llmModel,
        });
        try {
            await openaiModel.initialize();
            this.models.set('openai_compatible', openaiModel);
            this.models.set('default', openaiModel);
            Logger_1.Logger.info('✅ OpenAI 兼容模型注册成功', 'ModelManager');
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ 初始化 LLM.Server 模型失败: ${error.message}`, 'ModelManager');
            Logger_1.Logger.warn('⚠️ 没有可用的大模型，使用占位模型', 'ModelManager');
            const placeholder = new PlaceholderModel();
            this.models.set('placeholder', placeholder);
            this.models.set('default', placeholder);
        }
    }
    registerModel(name, model) {
        this.models.set(name, model);
        Logger_1.Logger.info(`➕ 注册模型: ${name}`, 'ModelManager');
    }
    getModel(name) {
        this.ensureInitialized();
        return this.models.get(name) || null;
    }
    getDefaultModel() {
        this.ensureInitialized();
        const currentModelName = this.multiModelManager.getCurrentModelName();
        if (currentModelName) {
            const model = this.models.get(currentModelName);
            if (model)
                return model;
        }
        return this.models.get('default') || null;
    }
    listModels() {
        this.ensureInitialized();
        const multiModelNames = this.multiModelManager.getAvailableModels();
        const localNames = Array.from(this.models.keys());
        return [...new Set([...multiModelNames, ...localNames])];
    }
    async generate(modelName, input) {
        this.ensureInitialized();
        const model = this.getModel(modelName);
        if (!model) {
            throw new Error(`模型 ${modelName} 不存在`);
        }
        return await model.generate(input);
    }
    async shutdown() {
        if (this.initialized) {
            Logger_1.Logger.info('🔌 关闭所有模型', 'ModelManager');
            for (const [name, model] of this.models.entries()) {
                try {
                    await model.shutdown();
                    Logger_1.Logger.info(`✅ 关闭模型: ${name}`, 'ModelManager');
                }
                catch (error) {
                    Logger_1.Logger.error(`❌ 关闭模型 ${name} 失败:`, error, 'ModelManager');
                }
            }
            this.models.clear();
            this.initialized = false;
            Logger_1.Logger.info('✅ 模型管理器关闭完成', 'ModelManager');
        }
    }
    getMultiModelManager() {
        return this.multiModelManager;
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('模型管理器未初始化！请先调用initialize方法。');
        }
    }
}
exports.ModelManager = ModelManager;
class PlaceholderModel {
    async initialize() { }
    async generate(input) {
        const promptText = input.prompt || '';
        return {
            text: `[占位模型] 收到提示：${promptText.substring(0, 50)}...`,
            error: '没有可用的大模型，请检查 OPENAI_API_BASE 配置',
        };
    }
    async *stream(input) {
        const promptText = input.prompt || '';
        yield '[占位模型] 收到提示：';
        yield promptText.substring(0, 50);
        yield '...';
        yield '\n[错误] 没有可用的大模型，请检查 OPENAI_API_BASE 配置';
    }
    async getModelInfo() {
        return {
            name: 'placeholder',
            details: '占位模型，当没有可用模型时使用',
        };
    }
    async shutdown() { }
    getName() {
        return 'placeholder';
    }
}
