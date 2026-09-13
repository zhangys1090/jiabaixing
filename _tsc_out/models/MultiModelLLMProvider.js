"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoutingStrategy = exports.MultiModelLLMProvider = void 0;
/**
 * @deprecated 多模型路由核心已迁移 Python (agent/llm/router: provider_manager /
 * credential_pool / RotationStrategy)。此文件仅作兼容 re-export 壳，实际实现见
 * MultiModelLLMProviderBridge（保留本地模型注册/路由/健康检查的回退能力）。
 * 下游 `import { MultiModelLLMProvider }` 与类型导出无需改动。
 */
const deprecationWarning_1 = require("../shared/deprecationWarning");
(0, deprecationWarning_1.emitDeprecationWarning)('MultiModelLLMProvider', 'MultiModelLLMProviderBridge (AGENT_BACKEND=python)', 'V6.0');
var MultiModelLLMProviderBridge_1 = require("./MultiModelLLMProviderBridge");
Object.defineProperty(exports, "MultiModelLLMProvider", { enumerable: true, get: function () { return MultiModelLLMProviderBridge_1.MultiModelLLMProviderBridge; } });
var types_1 = require("./types");
Object.defineProperty(exports, "RoutingStrategy", { enumerable: true, get: function () { return types_1.RoutingStrategy; } });
