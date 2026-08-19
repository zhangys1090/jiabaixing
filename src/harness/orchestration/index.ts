/**
 * Harness Phase 10: 多Agent编排 — 入口索引
 *
 * 导出所有编排层组件
 */

export { A2AProtocolManager, AgentRegistry } from './AgentRegistry';
export { OrchestratorAgent } from './OrchestratorAgent';
export { ResultAggregator } from './ResultAggregator';
export { TaskDispatcher } from './TaskDispatcher';

export type {
  A2AAgentCard,
  A2ACapability,
  A2ATask,
  A2ATaskEvent,
  A2ATaskStatus,
  AgentCapability,
  AgentRegistration,
} from './AgentRegistry';
export type {
  OrchestratorAgentDeps,
  OrchestratorLLM,
} from './OrchestratorAgent';
export type { AggregatedResult, TaskDetail } from './ResultAggregator';
export type { TaskNode } from './TaskDispatcher';
