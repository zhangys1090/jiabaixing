/**
 * Harness Agent Framework - 入口索引
 */

export { AgentHarness, type HarnessDeps } from './AgentHarness';
export { ToolRegistry, ToolReliabilityTracker } from './tools/registry/ToolRegistry';
export { SchemaValidator } from './tools/registry/SchemaValidator';
export { PermissionGuard } from './tools/registry/PermissionGuard';
export {
  registerHarnessTools,
  syncToLegacySkillRegistry,
  type HarnessToolDeps,
  type ToolRegistrationResult,
} from './tools/registerHarnessTools';

// 循环层
export { LoopController, type LoopControllerDeps, type ExecutorOutput, type EvaluatorOutput, type ReporterOutput } from './loop/LoopController';
export { Planner, type PlannerDeps } from './loop/Planner';
export { Executor, type ExecutorDeps } from './loop/Executor';
export { Evaluator, type EvaluatorDeps } from './loop/Evaluator';
export { Reporter } from './loop/Reporter';
export { StepEvaluator, type StepEvaluationParams, type StepEvaluationResult, type StepIssue } from './evaluation/StepEvaluator';
export { 
  IndependentEvaluationService, 
  type IndependentEvaluationResult, 
  type EvaluationInput, 
  type IndependentEvaluationServiceDeps 
} from './evaluation/IndependentEvaluationService';

// 上下文层
export { ContextManager, type ContextManagerDeps } from './context/ContextManager';
export { TokenBudgetAllocator } from './context/TokenBudgetAllocator';

// 验证层
export { VerificationService, type VerificationServiceDeps } from './verification/VerificationService';

// 约束层
export { ConstraintsService, type ConstraintsServiceDeps } from './constraints/ConstraintsService';

// 持久化层
export { PersistenceService, type PersistenceServiceDeps, type MemoryStoreOptions, type MemoryRecallOptions, type MemoryItem as PersistenceMemoryItem, type TaskState, type UserProfile as PersistenceUserProfile, type EvolutionMetric } from './persistence/PersistenceService';

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

export {
  ToolCategory,
  Permission,
} from './types';
