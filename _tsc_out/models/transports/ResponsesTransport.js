"use strict";
/**
 * OpenAI Responses API 传输层
 *
 * 适配 OpenAI 新一代 Responses API（2025年3月发布）
 * 端点: POST {baseUrl}/responses
 *
 * 与 Chat Completions 的关键差异:
 *   - input 替代 messages（支持字符串或消息数组）
 *   - instructions 替代 system role
 *   - max_output_tokens 替代 max_tokens
 *   - 响应 output 是项数组（message / function_call / function_call_output）
 *   - 每个 output item 有 type 和 status
 *
 * 兼容性: OpenAI 官方、以及已适配 Responses 协议的第三方服务
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponsesTransport = void 0;
const BaseTransport_1 = require("./BaseTransport");
class ResponsesTransport extends BaseTransport_1.BaseTransport {
    providerType = 'openai_responses';
    convertMessages(input) {
        if (input.messages && input.messages.length > 0) {
            return input.messages.map((m) => ({
                role: m.role,
                content: m.content ?? null,
            }));
        }
        const messages = [];
        if (input.systemPrompt) {
            messages.push({ role: 'system', content: input.systemPrompt });
        }
        messages.push({
            role: 'user',
            content: input.prompt || input.text || '',
        });
        return messages;
    }
    convertTools(tools) {
        if (!tools || tools.length === 0)
            return undefined;
        return tools.map((t) => {
            const fn = t.function;
            const params = fn?.parameters || {};
            return {
                type: 'function',
                name: fn?.name || 'unknown',
                description: fn?.description || '',
                parameters: {
                    type: 'object',
                    properties: params.properties || {},
                    required: params.required || [],
                },
            };
        });
    }
    buildRequest(input, messages, tools) {
        const systemMsg = input.messages?.find((m) => m.role === 'system');
        const instructions = input.systemPrompt || systemMsg?.content || undefined;
        const nonSystemMessages = messages.filter((m) => m.role !== 'system');
        const body = {
            model: this.config.modelName,
            input: nonSystemMessages.length > 0 ? nonSystemMessages : '',
            temperature: input.temperature ?? this.config.temperature,
            max_output_tokens: input.maxTokens ?? this.config.maxTokens,
            top_p: input.topP ?? this.config.topP,
            stream: false,
        };
        if (instructions) {
            body.instructions = instructions;
        }
        if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = input.toolChoice || 'auto';
        }
        return {
            url: `${this.config.baseUrl}/responses`,
            method: 'POST',
            headers: this.getAuthHeaders(),
            body,
        };
    }
    normalizeResponse(response) {
        if (!response.ok) {
            throw new Error(`Responses API 请求失败 (${response.status}): ${response.text.substring(0, 200)}`);
        }
        let data;
        try {
            data = JSON.parse(response.text);
        }
        catch {
            throw new Error(`Responses API 响应 JSON 解析失败: ${response.text.substring(0, 200)}`);
        }
        const outputItems = data.output;
        if (!outputItems || outputItems.length === 0) {
            throw new Error('Responses API 未返回有效 output');
        }
        let text = '';
        const toolCalls = [];
        for (const item of outputItems) {
            const itemType = item.type;
            if (itemType === 'message') {
                const content = item.content;
                if (content) {
                    for (const block of content) {
                        if (block.type === 'output_text' || block.type === 'text') {
                            text += block.text || '';
                        }
                    }
                }
            }
            else if (itemType === 'function_call') {
                toolCalls.push({
                    id: item.id || `tc_${Date.now()}`,
                    type: 'function',
                    function: {
                        name: item.name || 'unknown',
                        arguments: typeof item.arguments === 'string'
                            ? item.arguments
                            : JSON.stringify(item.arguments || {}),
                    },
                });
            }
        }
        const result = {
            text,
            finishReason: data.status === 'completed'
                ? 'stop'
                : String(data.status || 'stop'),
        };
        if (toolCalls.length > 0) {
            result.toolCalls = toolCalls;
        }
        const usage = data.usage;
        if (usage) {
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            result.tokens = {
                prompt: inputTokens,
                completion: outputTokens,
                total: inputTokens + outputTokens,
            };
        }
        return result;
    }
    parseStreamChunk(chunk) {
        const lines = chunk.split('\n');
        let content = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:'))
                continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]')
                continue;
            try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'response.output_text.delta') {
                    content += parsed.delta || '';
                }
                else if (parsed.type === 'response.output_item.added') {
                    const item = parsed.item;
                    if (item?.type === 'message') {
                        const itemContent = item.content;
                        if (itemContent) {
                            for (const block of itemContent) {
                                if (block.text)
                                    content += block.text;
                            }
                        }
                    }
                }
            }
            catch {
                // ignore
            }
        }
        return content || null;
    }
}
exports.ResponsesTransport = ResponsesTransport;
