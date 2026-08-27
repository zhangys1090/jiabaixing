/**
 * @deprecated TS 本地 LLM 传输层（AGENT_BACKEND=local 回退）。
 * AGENT_BACKEND=python（默认）经 PythonAgentBridge /v1/llm/* 委派 Python agent.llm，不再使用本层。
 *
 * 传输层工厂
 *
 * 根据 Provider 类型创建对应的 Transport 实例
 * 配置来源: ProviderConfig.extra.transport 或 baseUrl 推断
 */

import { Logger } from '../../utils/Logger';
import { AnthropicMessagesTransport } from './AnthropicMessagesTransport';
import { BaseTransport, type TransportConfig } from './BaseTransport';
import { ChatCompletionsTransport } from './ChatCompletionsTransport';
import { ResponsesTransport } from './ResponsesTransport';

/** 支持的传输层类型 */
export type TransportType =
  | 'openai_compatible'
  | 'openai_responses'
  | 'anthropic'
  | 'gemini'
  | 'bedrock';

export class TransportFactory {
  /**
   * 根据类型创建传输层
   */
  static create(type: TransportType, config: TransportConfig): BaseTransport {
    switch (type) {
      case 'openai_compatible':
        return new ChatCompletionsTransport(config);
      case 'openai_responses':
        return new ResponsesTransport(config);
      case 'anthropic':
        return new AnthropicMessagesTransport(config);
      default:
        Logger.warn(
          `传输层类型 ${type} 暂未实现，降级为 openai_compatible`,
          'TransportFactory'
        );
        return new ChatCompletionsTransport(config);
    }
  }

  /**
   * 从 ProviderConfig 推断传输层类型
   */
  static inferType(config: {
    baseUrl?: string;
    extra?: Record<string, unknown>;
  }): TransportType {
    // 优先使用显式配置
    const explicit = config.extra?.transport as string | undefined;
    if (explicit) {
      return explicit as TransportType;
    }

    const wireApi = config.extra?.wire_api as string | undefined;
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
  static fromProviderConfig(config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout?: number;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    extra?: Record<string, unknown>;
  }): BaseTransport {
    const type = this.inferType(config);
    const transportConfig: TransportConfig = {
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
