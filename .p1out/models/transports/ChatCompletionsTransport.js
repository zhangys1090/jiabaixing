"use strict";
/**
 * @deprecated TS 本地 LLM 传输层（AGENT_BACKEND=local 回退）。
 * AGENT_BACKEND=python（默认）经 PythonAgentBridge /v1/llm/* 委派 Python agent.llm，不再使用本层。
 *
 * OpenAI Chat Completions 传输层
 *
 * 适配所有 OpenAI 兼容 API:
 *   - OpenAI 官方 / DeepSeek / 智谱 / 通义 / Kimi / 小米 / 等
 *   - 本地 vLLM / Ollama / LM Studio
 *
 * 端点: POST {baseUrl}/chat/completions
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatCompletionsTransport = void 0;
const BaseTransport_1 = require("./BaseTransport");
const Logger_1 = require("../../utils/Logger");
class ChatCompletionsTransport extends BaseTransport_1.BaseTransport {
    constructor() {
        super(...arguments);
        this.providerType = 'openai_compatible';
    }
    convertMessages(input) {
        // 优先使用直接传入的 messages 数组（Function Calling 循环）
        if (input.messages && input.messages.length > 0) {
            return input.messages.map((m) => ({
                role: m.role,
                content: m.content ?? undefined,
                tool_calls: m.tool_calls,
                tool_call_id: m.tool_call_id,
                name: m.name,
            }));
        }
        // 否则从 prompt + systemPrompt 构建
        const messages = [];
        if (input.systemPrompt) {
            messages.push({ role: 'system', content: input.systemPrompt });
        }
        messages.push({ role: 'user', content: input.prompt || input.text || '' });
        return messages;
    }
    convertTools(tools) {
        if (!tools || tools.length === 0)
            return undefined;
        // OpenAI 格式即统一中间表示，直接透传
        return tools;
    }
    buildRequest(input, messages, tools) {
        const body = {
            model: this.config.modelName,
            messages,
            temperature: input.temperature ?? this.config.temperature,
            max_tokens: input.maxTokens ?? this.config.maxTokens,
            top_p: input.topP ?? this.config.topP,
            stream: false,
        };
        // thinking 模式（DeepSeek R1 等）
        const extra = this.config.extra;
        if (extra?.thinkingMode === 'enabled') {
            body.thinking = { type: 'enabled' };
            if (extra.reasoningEffort) {
                body.reasoning_effort = extra.reasoningEffort;
            }
        }
        // Function Calling
        if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = input.toolChoice || 'auto';
        }
        return {
            url: `${this.config.baseUrl}/chat/completions`,
            method: 'POST',
            headers: this.getAuthHeaders(),
            body,
        };
    }
    normalizeResponse(response) {
        if (!response.ok) {
            throw new Error(`API 请求失败 (${response.status}): ${response.text.substring(0, 200)}`);
        }
        let data;
        try {
            data = JSON.parse(response.text);
        }
        catch (err) {
            Logger_1.Logger.debug(`ChatCompletions响应JSON解析失败: ${err?.message}`, 'ChatCompletionsTransport');
            throw new Error(`API 响应 JSON 解析失败: ${response.text.substring(0, 200)}`);
        }
        const choices = data.choices;
        if (!choices || choices.length === 0) {
            throw new Error('模型未返回有效内容');
        }
        const message = choices[0].message;
        const generatedText = message?.content || '';
        const reasoningContent = message?.reasoning_content;
        const result = {
            text: generatedText,
            finishReason: String(choices[0].finish_reason || 'stop'),
        };
        if (reasoningContent) {
            result.metadata = { reasoningContent };
        }
        // 解析 tool_calls
        const rawToolCalls = message?.tool_calls;
        if (rawToolCalls && rawToolCalls.length > 0) {
            result.toolCalls = this.normalizeToolCalls(rawToolCalls);
        }
        // 解析 usage
        const usage = data.usage;
        if (usage) {
            result.tokens = {
                prompt: usage.prompt_tokens || 0,
                completion: usage.completion_tokens || 0,
                total: usage.total_tokens || 0,
            };
        }
        return result;
    }
    /**
     * 规范化 tool_calls（DeepSeek V4 等可能缺失 id/type 字段）
     */
    normalizeToolCalls(rawToolCalls) {
        return rawToolCalls.map((tc, index) => {
            const fn = tc.function;
            let args = '';
            if (fn) {
                if (typeof fn.arguments === 'string') {
                    args = fn.arguments;
                }
                else if (fn.arguments !== undefined && fn.arguments !== null) {
                    try {
                        args = JSON.stringify(fn.arguments);
                    }
                    catch (err) {
                        Logger_1.Logger.debug(`函数参数序列化失败: ${err?.message}`, 'ChatCompletionsTransport');
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
exports.ChatCompletionsTransport = ChatCompletionsTransport;
