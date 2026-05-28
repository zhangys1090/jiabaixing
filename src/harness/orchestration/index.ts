/**
 * Harness Phase 10: 多Agent编排 — 入口索引
 *
 * 导出所有编排层组件
 */

export { AgentRegistry } from './AgentRegistry';
export { TaskDispatcher } from './TaskDispatcher';
export { ResultAggregator } from './ResultAggregator';
export { OrchestratorAgent } from './OrchestratorAgent';

export type { AgentCapability, AgentRegistration } from './AgentRegistry';
export type { TaskNode } from './TaskDispatcher';
export type { AggregatedResult, TaskDetail } from './ResultAggregator';
export type {
  OrchestratorLLM,
  OrchestratorAgentDeps,
} from './OrchestratorAgent';
