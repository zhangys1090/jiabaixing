/**
 * Anthropic Messages API 传输层
 *
 * 适配 Anthropic Claude 原生 API（非 OpenAI 兼容模式）
 * 端点: POST {baseUrl}/v1/messages
 *
 * 差异点:
 *   - system 是顶级字段而非 messages 数组中的 role
 *   - 工具定义格式不同（input_schema 而非 parameters）
 *   - 响应 content 是数组（可含 text/tool_use 块）
 *   - 认证头用 x-api-key 而非 Bearer
 */

import type { ModelInput, ModelOutput } from '../../core/ModelInterface';
import {
  BaseTransport,
  type TransportRequest,
  type TransportResponse,
} from './BaseTransport';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<{ type: string; text?: string; cache_control?: { type: string } }>;
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  cache_control?: { type: string };
}

export class AnthropicMessagesTransport extends BaseTransport {
  readonly providerType = 'anthropic';

  convertMessages(input: ModelInput): AnthropicMessage[] {
    const messages: AnthropicMessage[] = [];

    if (input.messages && input.messages.length > 0) {
      // 跳过 system role（Anthropic 用顶级 system 字段）
      for (const m of input.messages) {
        if (m.role === 'system') continue;
        messages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content || '',
        });
      }
    } else {
      messages.push({
        role: 'user',
        content: input.prompt || input.text || '',
      });
    }

    return messages;
  }

  convertTools(
    tools: Array<Record<string, unknown>> | undefined
  ): AnthropicToolDef[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((t) => {
      const fn = t.function as Record<string, unknown> | undefined;
      const params = (fn?.parameters as Record<string, unknown>) || {};
      return {
        name: (fn?.name as string) || 'unknown',
        description: (fn?.description as string) || '',
        input_schema: {
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
    const cacheEnabled = this.config.extra?.cacheControl === true;

    // 提取 system prompt（从 messages 或 input.systemPrompt）
    let systemPrompt = input.systemPrompt || '';
    if (!systemPrompt && input.messages) {
      const sysMsg = input.messages.find((m) => m.role === 'system');
      if (sysMsg) systemPrompt = sysMsg.content || '';
    }

    const body: Record<string, unknown> = {
      model: this.config.modelName,
      messages: cacheEnabled
        ? this.applyMessageCacheControl(messages)
        : messages,
      max_tokens: input.maxTokens ?? this.config.maxTokens,
      temperature: input.temperature ?? this.config.temperature,
      stream: false,
    };

    if (systemPrompt) {
      body.system = cacheEnabled
        ? [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ]
        : systemPrompt;
    }

    if (tools && tools.length > 0) {
      body.tools = cacheEnabled
        ? this.applyToolCacheControl(tools as AnthropicToolDef[])
        : tools;
      // Anthropic tool_choice 格式
      if (input.toolChoice === 'auto') {
        body.tool_choice = { type: 'auto' };
      } else if (input.toolChoice === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (typeof input.toolChoice === 'object' && input.toolChoice) {
        const tc = input.toolChoice as {
          function: { name: string };
        };
        body.tool_choice = { type: 'tool', name: tc.function.name };
      }
    }

    return {
      url: `${this.config.baseUrl}/v1/messages`,
      method: 'POST',
      headers: this.getAuthHeaders(),
      body,
    };
  }

  /**
   * 为最后一条消息添加 cache_control 标记
   *
   * Anthropic 前缀缓存策略：标记最后一条消息作为缓存断点，
   * 使后续请求中相同的前缀（system + tools + 历史消息）命中缓存，省 75% 输入 token 费用。
   */
  private applyMessageCacheControl(messages: unknown[]): AnthropicMessage[] {
    if (messages.length === 0) return messages as AnthropicMessage[];
    const result = [...messages] as AnthropicMessage[];
    const last = result[result.length - 1];
    if (typeof last.content === 'string' && last.content.length > 0) {
      result[result.length - 1] = {
        ...last,
        content: [
          {
            type: 'text',
            text: last.content,
            cache_control: { type: 'ephemeral' },
          },
        ],
      };
    }
    return result;
  }

  /**
   * 为最后一个工具添加 cache_control 标记
   *
   * 工具定义在会话中通常不变，标记最后一个工具作为缓存断点，
   * 使 system + tools 前缀整体命中缓存。
   */
  private applyToolCacheControl(tools: AnthropicToolDef[]): AnthropicToolDef[] {
    if (tools.length === 0) return tools;
    const result = [...tools];
    result[result.length - 1] = {
      ...result[result.length - 1],
      cache_control: { type: 'ephemeral' },
    };
    return result;
  }

  normalizeResponse(response: TransportResponse): ModelOutput {
    if (!response.ok) {
      throw new Error(
        `Anthropic API 请求失败 (${response.status}): ${response.text.substring(0, 200)}`
      );
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new Error(
        `Anthropic API 响应 JSON 解析失败: ${response.text.substring(0, 200)}`
      );
    }

    const content = data.content as Array<Record<string, unknown>> | undefined;
    if (!content || content.length === 0) {
      throw new Error('Anthropic 模型未返回有效内容');
    }

    // 提取文本和工具调用
    let text = '';
    const toolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];

    for (const block of content) {
      if (block.type === 'text') {
        text += block.text as string;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: (block.id as string) || `tc_${Date.now()}`,
          type: 'function',
          function: {
            name: (block.name as string) || 'unknown',
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }

    const result: ModelOutput = {
      text,
      finishReason: String(data.stop_reason || 'end_turn'),
    };

    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }

    // 解析 usage
    const usage = data.usage as Record<string, number> | undefined;
    if (usage) {
      result.tokens = {
        prompt: usage.input_tokens || 0,
        completion: usage.output_tokens || 0,
        total: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      };
    }

    return result;
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  parseStreamChunk(chunk: string): string | null {
    // Anthropic SSE 事件格式: event: content_block_delta\ndata: {...}
    const lines = chunk.split('\n');
    let content = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.type === 'content_block_delta') {
          const delta = parsed.delta as Record<string, string> | undefined;
          if (delta?.text) content += delta.text;
        }
      } catch {
        // 忽略解析错误
      }
    }
    return content || null;
  }
}
