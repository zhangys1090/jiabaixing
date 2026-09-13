"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMProvider = void 0;
/**
 * @deprecated LLM 核心已迁移 Python (agent/llm)。此文件仅作兼容 re-export 壳，
 * 实际实现见 LLMProviderBridge（经 PythonAgentBridge 代理 /v1/llm/* 端点）。
 * 下游 `import { LLMProvider }` 无需改动即可获得桥接实现。
 */
const deprecationWarning_1 = require("../shared/deprecationWarning");
(0, deprecationWarning_1.emitDeprecationWarning)('LLMProvider', 'LLMProviderBridge (AGENT_BACKEND=python)', 'V6.0');
var LLMProviderBridge_1 = require("./LLMProviderBridge");
Object.defineProperty(exports, "LLMProvider", { enumerable: true, get: function () { return LLMProviderBridge_1.LLMProviderBridge; } });
