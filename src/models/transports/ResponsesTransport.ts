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

import type { ModelInput, ModelOutput } from '../../core/ModelInterface';
import {
  BaseTransport,
  type TransportRequest,
  type TransportResponse,
} from './BaseTransport';

interface ResponsesInputMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

interface ResponsesFunctionCall {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface ResponsesToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export class ResponsesTransport extends BaseTransport {
  readonly providerType = 'openai_responses';

  convertMessages(input: ModelInput): ResponsesInputMessage[] {
    if (input.messages && input.messages.length > 0) {
      return input.messages.map((m) => ({
        role: m.role as ResponsesInputMessage['role'],
        content: m.content ?? null,
      }));
    }

    const messages: ResponsesInputMessage[] = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }
    messages.push({
      role: 'user',
      content: input.prompt || input.text || '',
    });
    return messages;
  }

  convertTools(
    tools: Array<Record<string, unknown>> | undefined
  ): ResponsesToolDef[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((t) => {
      const fn = t.function as Record<string, unknown> | undefined;
      const params = (fn?.parameters as Record<string, unknown>) || {};
      return {
        type: 'function',
        name: (fn?.name as string) || 'unknown',
        description: (fn?.description as string) || '',
        parameters: {
          type: 'object',
          properties: (params.properties as Record<string, unknown>) || {},
          required: (params.required as string[]) || [],
        },
      };
    });
  }

  buildRequest(
    input: ModelInput,
    messages: unknown[],
    tools: unknown[] | undefined
  ): TransportRequest {
    const systemMsg = input.messages?.find((m) => m.role === 'system');
    const instructions =
      input.systemPrompt || (systemMsg?.content as string) || undefined;

    const nonSystemMessages = (messages as ResponsesInputMessage[]).filter(
      (m) => m.role !== 'system'
    );

    const body: Record<string, unknown> = {
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

  normalizeResponse(response: TransportResponse): ModelOutput {
    if (!response.ok) {
      throw new Error(
        `Responses API 请求失败 (${response.status}): ${response.text.substring(0, 200)}`
      );
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new Error(
        `Responses API 响应 JSON 解析失败: ${response.text.substring(0, 200)}`
      );
    }

    const outputItems = data.output as
      | Array<Record<string, unknown>>
      | undefined;
    if (!outputItems || outputItems.length === 0) {
      throw new Error('Responses API 未返回有效 output');
    }

    let text = '';
    const toolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];

    for (const item of outputItems) {
      const itemType = item.type as string;

      if (itemType === 'message') {
        const content = item.content as
          | Array<Record<string, unknown>>
          | undefined;
        if (content) {
          for (const block of content) {
            if (block.type === 'output_text' || block.type === 'text') {
              text += (block.text as string) || '';
            }
          }
        }
      } else if (itemType === 'function_call') {
        toolCalls.push({
          id: (item.id as string) || `tc_${Date.now()}`,
          type: 'function',
          function: {
            name: (item.name as string) || 'unknown',
            arguments:
              typeof item.arguments === 'string'
                ? (item.arguments as string)
                : JSON.stringify(item.arguments || {}),
          },
        });
      }
    }

    const result: ModelOutput = {
      text,
      finishReason:
        (data.status as string) === 'completed'
          ? 'stop'
          : String(data.status || 'stop'),
    };

    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }

    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage) {
      const inputTokens = (usage.input_tokens as number) || 0;
      const outputTokens = (usage.output_tokens as number) || 0;
      result.tokens = {
        prompt: inputTokens,
        completion: outputTokens,
        total: inputTokens + outputTokens,
      };
    }

    return result;
  }

  parseStreamChunk(chunk: string): string | null {
    const lines = chunk.split('\n');
    let content = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.type === 'response.output_text.delta') {
          content += (parsed.delta as string) || '';
        } else if (parsed.type === 'response.output_item.added') {
          const item = parsed.item as Record<string, unknown> | undefined;
          if (item?.type === 'message') {
            const itemContent = item.content as
              | Array<Record<string, unknown>>
              | undefined;
            if (itemContent) {
              for (const block of itemContent) {
                if (block.text) content += block.text as string;
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return content || null;
  }
}
