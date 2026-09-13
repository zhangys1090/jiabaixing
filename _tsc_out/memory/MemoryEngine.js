"use strict";
/**
 * @deprecated MemoryEngine 核心逻辑已迁移至 Python agent/memory (AGENTS.md §0.1)。
 *
 * 本文件不再包含任何 TS 侧记忆核心实现，仅作向后兼容的【重导出壳】。
 * 运行时 `new MemoryEngine()` 实际得到 MemoryEngineBridge 实例，
 * 经 bridgeRegistry 代理到 Python FastAPI(:3112) 的 /v1/memory/* 端点。
 *
 * 此壳将在后续清理轮次中删除（届时调用方直接 import { MemoryEngineBridge }）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryType = exports.MemoryTier = exports.MemoryEngine = void 0;
const deprecationWarning_1 = require("../shared/deprecationWarning");
(0, deprecationWarning_1.emitDeprecationWarning)('MemoryEngine', 'PythonAgentBridge (AGENT_BACKEND=python)', 'V6.0', 'MemoryEngine re-exports MemoryEngineBridge; import MemoryEngineBridge directly instead.');
var MemoryEngineBridge_1 = require("./MemoryEngineBridge");
Object.defineProperty(exports, "MemoryEngine", { enumerable: true, get: function () { return MemoryEngineBridge_1.MemoryEngineBridge; } });
Object.defineProperty(exports, "MemoryTier", { enumerable: true, get: function () { return MemoryEngineBridge_1.MemoryTier; } });
Object.defineProperty(exports, "MemoryType", { enumerable: true, get: function () { return MemoryEngineBridge_1.MemoryType; } });
