/**
 * @deprecated TS 本地 LLM 传输层（AGENT_BACKEND=local 回退）。
 * AGENT_BACKEND=python（默认）经 PythonAgentBridge /v1/llm/* 委派 Python agent.llm，不再使用本层。
 *
 * Provider 传输层系统
 *
 * 统一入口: TransportFactory → BaseTransport → ModelOutput
 *
 * 支持传输层:
 *   - openai_compatible: OpenAI/DeepSeek/智谱/通义/Kimi/小米/vLLM 等
 *   - anthropic: Anthropic Claude 原生 Messages API
 *   - gemini: Google Gemini 原生（待实现）
 *   - bedrock: AWS Bedrock（待实现）
 *   - codex: OpenAI Codex Responses（待实现）
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
export { TransportFactory } from './TransportFactory';
export type { TransportType } from './TransportFactory';
