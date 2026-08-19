/**
 * @deprecated LLM 核心已迁移 Python (agent/llm)。此文件仅作兼容 re-export 壳，
 * 实际实现见 LLMProviderBridge（经 PythonAgentBridge 代理 /v1/llm/* 端点）。
 * 下游 `import { LLMProvider }` 无需改动即可获得桥接实现。
 */
import { emitDeprecationWarning } from '../shared/deprecationWarning';
emitDeprecationWarning(
  'LLMProvider',
  'LLMProviderBridge (AGENT_BACKEND=python)',
  'V6.0'
);

export { LLMProviderBridge as LLMProvider } from './LLMProviderBridge';
