/**
 * Provider 传输层系统
 *
 * 统一入口: TransportFactory → BaseTransport → ModelOutput
 *
 * 支持传输层:
 *   - openai_compatible: OpenAI/DeepSeek/智谱/通义/Kimi/小米/vLLM 等 (Chat Completions)
 *   - openai_responses: OpenAI Responses API (/v1/responses)
 *   - anthropic: Anthropic Claude 原生 Messages API (/v1/messages)
 *   - gemini: Google Gemini 原生（待实现）
 *   - bedrock: AWS Bedrock（待实现）
 *
 * 数据流: convert_messages → convert_tools → build_kwargs → normalize_response
 */

export { AnthropicMessagesTransport } from './AnthropicMessagesTransport';
export { BaseTransport } from './BaseTransport';
export type {
  TransportConfig,
  TransportRequest,
  TransportResponse,
  UnifiedMessage,
  UnifiedToolDef,
} from './BaseTransport';
export { ChatCompletionsTransport } from './ChatCompletionsTransport';
export { ResponsesTransport } from './ResponsesTransport';
export { TransportFactory } from './TransportFactory';
export type { TransportType } from './TransportFactory';
