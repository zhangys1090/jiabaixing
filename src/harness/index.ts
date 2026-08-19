/**
 * Harness Agent Framework - 入口索引
 *
 * 导出六层架构全部组件 + Phase 10 多Agent编排
 */

export { AgentHarness, type HarnessDeps } from './AgentHarness';
export type {
  ConstitutionalBuilderDeps,
  DynamicContextDeps,
  EvolutionEngineDeps,
  EvolutionExamplesDeps,
  HistoryProviderDeps,
  LLMProviderDeps,
  MemoryInjectorDeps,
  MemoryStoreDeps,
  PersonaCoreDeps,
  SkillRegistryDeps,
} from './deps';
export {
  registerHarnessTools,
  syncToLegacySkillRegistry,
  type HarnessToolDeps,
  type ToolRegistrationResult,
} from './tools/registerHarnessTools';
export { PermissionGuard } from './tools/registry/PermissionGuard';
export { SchemaValidator } from './tools/registry/SchemaValidator';
export {
  ToolRegistry,
  ToolReliabilityTracker,
} from './tools/registry/ToolRegistry';

// 循环层 — 已迁移到 Python 后端（agent/loop/），TS 端循环层组件已删除
export {
  IndependentEvaluationService,
  type EvaluationInput,
  type IndependentEvaluationResult,
  type IndependentEvaluationServiceDeps,
} from './evaluation/IndependentEvaluationService';
export {
  StepEvaluator,
  type StepEvaluationParams,
  type StepEvaluationResult,
  type StepIssue,
} from './evaluation/StepEvaluator';

// 上下文层 — ContextManager/TokenBudgetAllocator 已废弃（V6.0 移除）
// 替代方案：Python 端 HarnessContext（agent/harness/context.py）
// 仍保留内部使用，不再公开导出

// 验证层
export {
  VerificationService,
  type VerificationServiceDeps,
} from './verification/VerificationService';

// 约束层
export {
  ConstraintsService,
  type ConstraintsServiceDeps,
} from './constraints/ConstraintsService';

// 持久化层
export {
  PersistenceService,
  type EvolutionMetric,
  type MemoryRecallOptions,
  type MemoryStoreOptions,
  type MemoryItem as PersistenceMemoryItem,
  type PersistenceServiceDeps,
  type UserProfile as PersistenceUserProfile,
  type TaskState,
} from './persistence/PersistenceService';

// 导出所有类型
export type {
  AgentResult,
  BudgetAllocation,
  BudgetCheckResult,
  BudgetState,
  ChatMessage,
  ContextEntry,
  ExecutionPlan,
  GoalProgress,
  HarnessConfig,
  HookContext,
  HookResult,
  LifecycleEvent,
  LifecycleHook,
  LoopContext,
  LoopState,
  LoopTrace,
  PermissionResult,
  PlanStep,
  QualityScore,
  RegisteredTool,
  SafetyCheckResult,
  StepResult,
  TokenAllocation,
  ToolContext,
  ToolDefinition,
  ToolParameterDef,
  ToolResult,
  UserInput,
  ValidationResult,
} from './types';

export { Permission, ToolCategory } from './types';

// ============ Phase 10: 多Agent编排 ============
export { AgentRegistry } from './orchestration/AgentRegistry';
export type {
  AgentCapability,
  AgentHealth,
  AgentRegistration,
} from './orchestration/AgentRegistry';
export { OrchestratorAgent } from './orchestration/OrchestratorAgent';
export type {
  OrchestratorAgentDeps,
  OrchestratorConfig,
  OrchestratorLLM,
} from './orchestration/OrchestratorAgent';
export { ResultAggregator } from './orchestration/ResultAggregator';
export type {
  AggregatedResult,
  ResultConflict,
  TaskDetail,
} from './orchestration/ResultAggregator';
export { SubAgentFanout } from './orchestration/SubAgentFanout';
export type {
  FanoutConfig,
  FanoutResult,
  FanoutStrategy,
  SubTaskResult,
} from './orchestration/SubAgentFanout';
export { TaskDispatcher } from './orchestration/TaskDispatcher';
export type {
  TaskDispatcherConfig,
  TaskExecutor,
  TaskNode,
} from './orchestration/TaskDispatcher';

// ============ Phase 11: 自评估与持续优化管道 ============
export { AssertionValidator } from './evaluation/AssertionValidator';
export type {
  AssertionContext,
  AssertionResult,
} from './evaluation/AssertionValidator';
export { EvalGate } from './evaluation/EvalGate';
export type {
  EvalGateConfig,
  GateCheck,
  GateResult,
} from './evaluation/EvalGate';
export { EvalTrendAnalyzer } from './evaluation/EvalTrendAnalyzer';
export type {
  EvalReportSummary,
  TrendAnalysis,
  TrendDirection,
  TrendReport,
} from './evaluation/EvalTrendAnalyzer';
export { EvaluationPipeline } from './evaluation/EvaluationPipeline';
export type {
  EvaluationContext,
  PipelineConfig,
  PipelineResult,
  PipelineStageConfig,
  StageResult,
} from './evaluation/EvaluationPipeline';
export { GoldenEvalSet } from './evaluation/GoldenEvalSet';
export type {
  EvalAssertion,
  EvalSetStats,
  GoldenEvalCase,
} from './evaluation/GoldenEvalSet';
export { OptimizationFeedbackLoop } from './evaluation/OptimizationFeedbackLoop';
export type {
  OptimizationFeedbackConfig,
  OptimizationFeedbackResult,
} from './evaluation/OptimizationFeedbackLoop';
export { QualityScorer } from './evaluation/QualityScorer';
export type {
  QualityDimensions,
  WeightConfig,
} from './evaluation/QualityScorer';
