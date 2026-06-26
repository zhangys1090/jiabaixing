/**
 * Provider 传输层抽象基类
 *
 * 设计参考: Hermes Agent agent/transports/base.py
 * 数据流: convert_messages → convert_tools → build_kwargs → normalize_response
 *
 * 职责分离:
 *   - Model 类: 管理生命周期、重试、熔断、降级
 *   - Transport 类: 负责请求/响应格式转换（Provider 协议差异）
 *
 * 新增 Provider 只需实现 4 个方法，而非重写整个 Model 类
 */

import type { ModelInput, ModelOutput } from '../../core/ModelInterface';

/** 传输层配置 */
export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  timeout: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  /** 额外 Provider 特定参数 */
  extra?: Record<string, unknown>;
}

/** 转换后的请求体（传输层无关的中间表示） */
export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 原始响应（传输层无关的中间表示） */
export interface TransportResponse {
  status: number;
  ok: boolean;
  text: string;
}

/** 工具定义（OpenAI Function Calling 格式，作为统一中间表示） */
export interface UnifiedToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/** 消息（统一中间表示） */
export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * 传输层抽象基类
 *
 * 子类需实现 4 个核心方法:
 *   1. convertMessages - 将 ModelInput.messages 转换为 Provider 格式
 *   2. convertTools - 将 OpenAI 工具定义转换为 Provider 格式
 *   3. buildRequest - 构建完整 HTTP 请求（url/headers/body）
 *   4. normalizeResponse - 将 Provider 响应转换为 ModelOutput
 */
export abstract class BaseTransport {
  protected config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  /** Provider 类型标识 */
  abstract readonly providerType: string;

  /**
   * 转换消息列表为 Provider 格式
   * 输入: ModelInput（含 messages 或 prompt+systemPrompt）
   * 输出: Provider 特定消息数组
   */
  abstract convertMessages(input: ModelInput): unknown[];

  /**
   * 转换工具定义为 Provider 格式
   * 输入: OpenAI Function Calling 工具定义
   * 输出: Provider 特定工具定义
   */
  abstract convertTools(
    tools: Array<Record<string, unknown>> | undefined
  ): unknown[] | undefined;

  /**
   * 构建完整 HTTP 请求
   * 输入: ModelInput + 已转换的 messages/tools
   * 输出: TransportRequest（url/method/headers/body）
   */
  abstract buildRequest(
    input: ModelInput,
    messages: unknown[],
    tools: unknown[] | undefined
  ): TransportRequest;

  /**
   * 规范化 Provider 响应为 ModelOutput
   * 输入: TransportResponse（原始 HTTP 响应）
   * 输出: ModelOutput（统一输出格式）
   */
  abstract normalizeResponse(response: TransportResponse): ModelOutput;

  /**
   * 构建流式请求（可选，默认与非流式相同）
   */
  buildStreamRequest(
    input: ModelInput,
    messages: unknown[],
    tools: unknown[] | undefined
  ): TransportRequest {
    const req = this.buildRequest(input, messages, tools);
    // 默认在 body 中设置 stream: true
    req.body = { ...req.body, stream: true };
    return req;
  }

  /**
   * 解析流式响应块（可选，子类按需实现）
   * 返回本次 chunk 的文本内容，无内容返回 null
   */
  parseStreamChunk(chunk: string): string | null {
    // 默认实现：解析 SSE data: 行
    const lines = chunk.split('\n');
    let content = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const choices = parsed.choices as
          | Array<Record<string, Record<string, string>>>
          | undefined;
        if (choices && choices.length > 0) {
          const delta = choices[0].delta as Record<string, string> | undefined;
          if (delta?.content) content += delta.content;
        }
      } catch {
        // 忽略解析错误
      }
    }
    return content || null;
  }

  /**
   * 获取认证头（子类可覆盖）
   */
  protected getAuthHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }
}
