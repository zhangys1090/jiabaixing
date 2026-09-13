"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransportFactory = exports.ResponsesTransport = exports.ChatCompletionsTransport = exports.BaseTransport = exports.AnthropicMessagesTransport = void 0;
var AnthropicMessagesTransport_1 = require("./AnthropicMessagesTransport");
Object.defineProperty(exports, "AnthropicMessagesTransport", { enumerable: true, get: function () { return AnthropicMessagesTransport_1.AnthropicMessagesTransport; } });
var BaseTransport_1 = require("./BaseTransport");
Object.defineProperty(exports, "BaseTransport", { enumerable: true, get: function () { return BaseTransport_1.BaseTransport; } });
var ChatCompletionsTransport_1 = require("./ChatCompletionsTransport");
Object.defineProperty(exports, "ChatCompletionsTransport", { enumerable: true, get: function () { return ChatCompletionsTransport_1.ChatCompletionsTransport; } });
var ResponsesTransport_1 = require("./ResponsesTransport");
Object.defineProperty(exports, "ResponsesTransport", { enumerable: true, get: function () { return ResponsesTransport_1.ResponsesTransport; } });
var TransportFactory_1 = require("./TransportFactory");
Object.defineProperty(exports, "TransportFactory", { enumerable: true, get: function () { return TransportFactory_1.TransportFactory; } });
