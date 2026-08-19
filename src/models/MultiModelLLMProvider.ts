/**
 * @deprecated 多模型路由核心已迁移 Python (agent/llm/router: provider_manager /
 * credential_pool / RotationStrategy)。此文件仅作兼容 re-export 壳，实际实现见
 * MultiModelLLMProviderBridge（保留本地模型注册/路由/健康检查的回退能力）。
 * 下游 `import { MultiModelLLMProvider }` 与类型导出无需改动。
 */
import { emitDeprecationWarning } from '../shared/deprecationWarning';
emitDeprecationWarning(
  'MultiModelLLMProvider',
  'MultiModelLLMProviderBridge (AGENT_BACKEND=python)',
  'V6.0'
);

export { MultiModelLLMProviderBridge as MultiModelLLMProvider } from './MultiModelLLMProviderBridge';
export { RoutingStrategy } from './types';
export type {
  ModelCapabilityProfile,
  ModelHealthStatus,
  MultiModelConfig,
  RegisteredModel,
  RoutingResult,
} from './types';
