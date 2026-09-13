"use strict";
/**
 * @deprecated TS 本地 LLM 传输层（AGENT_BACKEND=local 回退）。
 * AGENT_BACKEND=python（默认）经 PythonAgentBridge /v1/llm/* 委派 Python agent.llm，不再使用本层。
 *
 * 传输层工厂
 *
 * 根据 Provider 类型创建对应的 Transport 实例
 * 配置来源: ProviderConfig.extra.transport 或 baseUrl 推断
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransportFactory = void 0;
const Logger_1 = require("../../utils/Logger");
const AnthropicMessagesTransport_1 = require("./AnthropicMessagesTransport");
const ChatCompletionsTransport_1 = require("./ChatCompletionsTransport");
const ResponsesTransport_1 = require("./ResponsesTransport");
class TransportFactory {
    /**
     * 根据类型创建传输层
     */
    static create(type, config) {
        switch (type) {
            case 'openai_compatible':
                return new ChatCompletionsTransport_1.ChatCompletionsTransport(config);
            case 'openai_responses':
                return new ResponsesTransport_1.ResponsesTransport(config);
            case 'anthropic':
                return new AnthropicMessagesTransport_1.AnthropicMessagesTransport(config);
            default:
                Logger_1.Logger.warn(`传输层类型 ${type} 暂未实现，降级为 openai_compatible`, 'TransportFactory');
                return new ChatCompletionsTransport_1.ChatCompletionsTransport(config);
        }
    }
    /**
     * 从 ProviderConfig 推断传输层类型
     */
    static inferType(config) {
        // 优先使用显式配置
        const explicit = config.extra?.transport;
        if (explicit) {
            return explicit;
        }
        const wireApi = config.extra?.wire_api;
        if (wireApi === 'responses') {
            return 'openai_responses';
        }
        const url = (config.baseUrl || '').toLowerCase();
        if (url.includes('anthropic.com')) {
            return 'anthropic';
        }
        if (url.includes('generativelanguage.googleapis.com')) {
            return 'gemini';
        }
        if (url.includes('bedrock')) {
            return 'bedrock';
        }
        // 默认 OpenAI 兼容
        return 'openai_compatible';
    }
    /**
     * 从 ProviderConfig 创建传输层（自动推断类型）
     */
    static fromProviderConfig(config) {
        const type = this.inferType(config);
        const transportConfig = {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            modelName: config.model,
            timeout: config.timeout ?? 30000,
            maxTokens: config.maxTokens ?? 4096,
            temperature: config.temperature ?? 0.7,
            topP: config.topP ?? 0.9,
            extra: config.extra,
        };
        return this.create(type, transportConfig);
    }
}
exports.TransportFactory = TransportFactory;
