/**
 * OpenAI Chat Completions 传输层
 *
 * 适配所有 OpenAI 兼容 API:
 *   - OpenAI 官方 / DeepSeek / 智谱 / 通义 / Kimi / 小米 / 等
 *   - 本地 vLLM / Ollama / LM Studio
 *
 * 端点: POST {baseUrl}/chat/completions
 */

import type { ModelInput, ModelOutput } from '../../core/ModelInterface';
import {
  BaseTransport,
  type TransportRequest,
  type TransportResponse,
} from './BaseTransport';

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export class ChatCompletionsTransport extends BaseTransport {
  readonly providerType = 'openai_compatible';

  convertMessages(input: ModelInput): ChatMessage[] {
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
    const messages: ChatMessage[] = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }
    messages.push({ role: 'user', content: input.prompt || input.text || '' });
    return messages;
  }

  convertTools(
    tools: Array<Record<string, unknown>> | undefined
  ): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    // OpenAI 格式即统一中间表示，直接透传
    return tools;
  }

  buildRequest(
    input: ModelInput,
    messages: unknown[],
    tools: unknown[] | undefined
  ): TransportRequest {
    const body: Record<string, unknown> = {
      model: this.config.modelName,
      messages,
      temperature: input.temperature ?? this.config.temperature,
      max_tokens: input.maxTokens ?? this.config.maxTokens,
      top_p: input.topP ?? this.config.topP,
      stream: false,
    };

    // thinking 模式（DeepSeek R1 等）
    const extra = this.config.extra as
      | { thinkingMode?: string; reasoningEffort?: string }
      | undefined;
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

  normalizeResponse(response: TransportResponse): ModelOutput {
    if (!response.ok) {
      throw new Error(
        `API 请求失败 (${response.status}): ${response.text.substring(0, 200)}`
      );
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new Error(
        `API 响应 JSON 解析失败: ${response.text.substring(0, 200)}`
      );
    }

    const choices = data.choices as
      | Array<Record<string, Record<string, unknown>>>
      | undefined;
    if (!choices || choices.length === 0) {
      throw new Error('模型未返回有效内容');
    }

    const message = choices[0].message as Record<string, unknown> | undefined;
    const generatedText = (message?.content as string) || '';
    const reasoningContent = message?.reasoning_content as string | undefined;

    const result: ModelOutput = {
      text: generatedText,
      finishReason: String(choices[0].finish_reason || 'stop'),
    };

    if (reasoningContent) {
      result.metadata = { reasoningContent };
    }

    // 解析 tool_calls
    const rawToolCalls = message?.tool_calls as
      | Array<Record<string, unknown>>
      | undefined;
    if (rawToolCalls && rawToolCalls.length > 0) {
      result.toolCalls = this.normalizeToolCalls(rawToolCalls);
    }

    // 解析 usage
    const usage = data.usage as Record<string, number> | undefined;
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
  private normalizeToolCalls(
    rawToolCalls: Array<Record<string, unknown>>
  ): Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> {
    return rawToolCalls.map((tc, index) => {
      const fn = tc.function as Record<string, unknown> | undefined;
      let args = '';
      if (fn) {
        if (typeof fn.arguments === 'string') {
          args = fn.arguments;
        } else if (fn.arguments !== undefined && fn.arguments !== null) {
          try {
            args = JSON.stringify(fn.arguments);
          } catch {
            args = '{}';
          }
        }
      }
      return {
        id: (tc.id as string) || `tc_${Date.now()}_${index}`,
        type: (tc.type as string) || 'function',
        function: {
          name: (fn?.name as string) || 'unknown',
          arguments: args,
        },
      };
    });
  }
}
