/**
 * @deprecated MemoryEngine 核心逻辑已迁移至 Python agent/memory (AGENTS.md §0.1)。
 *
 * 本文件不再包含任何 TS 侧记忆核心实现，仅作向后兼容的【重导出壳】。
 * 运行时 `new MemoryEngine()` 实际得到 MemoryEngineBridge 实例，
 * 经 bridgeRegistry 代理到 Python FastAPI(:3112) 的 /v1/memory/* 端点。
 *
 * 此壳将在后续清理轮次中删除（届时调用方直接 import { MemoryEngineBridge }）。
 */

import { emitDeprecationWarning } from '../shared/deprecationWarning';
emitDeprecationWarning(
  'MemoryEngine',
  'PythonAgentBridge (AGENT_BACKEND=python)',
  'V6.0',
  'MemoryEngine re-exports MemoryEngineBridge; import MemoryEngineBridge directly instead.'
);

export {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  MemoryContent,
  MemoryEngineBridge as MemoryEngine,
  MemoryItem,
  MemoryTier,
  MemoryType,
  TrackedResult,
  ValidationResult,
} from './MemoryEngineBridge';
