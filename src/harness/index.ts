/**
 * Harness Agent Framework - 入口索引
 *
 * 导出六层架构全部组件 + Phase 10 多Agent编排
 */

export { AgentHarness, type HarnessDeps } from './AgentHarness';
export type {
  LLMProviderDeps,
  ConstitutionalBuilderDeps,
  MemoryInjectorDeps,
  MemoryStoreDeps,
  DynamicContextDeps,
  HistoryProviderDeps,
  SkillRegistryDeps,
  EvolutionEngineDeps,
  PersonaCoreDeps,
  EvolutionExamplesDeps,
} from './deps';
export {
  ToolRegistry,
  ToolReliabilityTracker,
} from './tools/registry/ToolRegistry';
export { SchemaValidator } from './tools/registry/SchemaValidator';
export { PermissionGuard } from './tools/registry/PermissionGuard';
export {
  registerHarnessTools,
  syncToLegacySkillRegistry,
  type HarnessToolDeps,
  type ToolRegistrationResult,
} from './tools/registerHarnessTools';

// 循环层
export {
  LoopController,
  type LoopControllerDeps,
  type ExecutorOutput,
  type EvaluatorOutput,
  type ReporterOutput,
} from './loop/LoopController';
export { Planner, type PlannerDeps } from './loop/Planner';
export { Executor, type ExecutorDeps } from './loop/Executor';
export { Evaluator, type EvaluatorDeps } from './loop/Evaluator';
export { Reporter } from './loop/Reporter';
export {
  StepEvaluator,
  type StepEvaluationParams,
  type StepEvaluationResult,
  type StepIssue,
} from './evaluation/StepEvaluator';
export {
  IndependentEvaluationService,
  type IndependentEvaluationResult,
  type EvaluationInput,
  type IndependentEvaluationServiceDeps,
} from './evaluation/IndependentEvaluationService';

// 上下文层
export {
  ContextManager,
  type ContextManagerDeps,
} from './context/ContextManager';
export { TokenBudgetAllocator } from './context/TokenBudgetAllocator';

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
  type PersistenceServiceDeps,
  type MemoryStoreOptions,
  type MemoryRecallOptions,
  type MemoryItem as PersistenceMemoryItem,
  type TaskState,
  type UserProfile as PersistenceUserProfile,
  type EvolutionMetric,
} from './persistence/PersistenceService';

// 导出所有类型
export type {
  HarnessConfig,
  ChatMessage,
  UserInput,
  AgentResult,
  LoopState,
  ExecutionPlan,
  PlanStep,
  BudgetAllocation,
  BudgetState,
  StepResult,
  LoopTrace,
  LoopContext,
  ToolDefinition,
  ToolParameterDef,
  ToolContext,
  ToolResult,
  RegisteredTool,
  ContextEntry,
  TokenAllocation,
  ValidationResult,
  SafetyCheckResult,
  QualityScore,
  GoalProgress,
  LifecycleEvent,
  LifecycleHook,
  HookContext,
  HookResult,
  BudgetCheckResult,
  PermissionResult,
} from './types';

export { ToolCategory, Permission } from './types';

// ============ Phase 10: 多Agent编排 ============
export { AgentRegistry } from './orchestration/AgentRegistry';
export { TaskDispatcher } from './orchestration/TaskDispatcher';
export { ResultAggregator } from './orchestration/ResultAggregator';
export { OrchestratorAgent } from './orchestration/OrchestratorAgent';
export { SubAgentFanout } from './orchestration/SubAgentFanout';
export type {
  AgentCapability,
  AgentRegistration,
  AgentHealth,
} from './orchestration/AgentRegistry';
export type {
  TaskNode,
  TaskExecutor,
  TaskDispatcherConfig,
} from './orchestration/TaskDispatcher';
export type {
  AggregatedResult,
  TaskDetail,
  ResultConflict,
} from './orchestration/ResultAggregator';
export type {
  OrchestratorLLM,
  OrchestratorAgentDeps,
  OrchestratorConfig,
} from './orchestration/OrchestratorAgent';
export type {
  FanoutStrategy,
  FanoutConfig,
  SubTaskResult,
  FanoutResult,
} from './orchestration/SubAgentFanout';

// ============ Phase 11: 自评估与持续优化管道 ============
export { QualityScorer } from './evaluation/QualityScorer';
export { EvaluationPipeline } from './evaluation/EvaluationPipeline';
export { OptimizationFeedbackLoop } from './evaluation/OptimizationFeedbackLoop';
export { GoldenEvalSet } from './evaluation/GoldenEvalSet';
export { AssertionValidator } from './evaluation/AssertionValidator';
export { EvalTrendAnalyzer } from './evaluation/EvalTrendAnalyzer';
export { EvalGate } from './evaluation/EvalGate';
export type {
  QualityDimensions,
  WeightConfig,
} from './evaluation/QualityScorer';
export type {
  EvaluationContext,
  PipelineConfig,
  PipelineStageConfig,
  PipelineResult,
  StageResult,
} from './evaluation/EvaluationPipeline';
export type {
  OptimizationFeedbackResult,
  OptimizationFeedbackConfig,
} from './evaluation/OptimizationFeedbackLoop';
export type {
  GoldenEvalCase,
  EvalAssertion,
  EvalSetStats,
} from './evaluation/GoldenEvalSet';
export type {
  AssertionResult,
  AssertionContext,
} from './evaluation/AssertionValidator';
export type {
  TrendDirection,
  TrendAnalysis,
  TrendReport,
  EvalReportSummary,
} from './evaluation/EvalTrendAnalyzer';
export type {
  EvalGateConfig,
  GateResult,
  GateCheck,
} from './evaluation/EvalGate';
