/**
 * Harness Agent Framework - 核心类型定义
 *
 * 基于 Harness Agent Framework 六层架构:
 * Layer 1: Loop（循环层）
 * Layer 2: Tools（工具层）
 * Layer 3: Context（上下文层）
 * Layer 4: Persistence（持久化层）
 * Layer 5: Verification（验证层）
 * Layer 6: Constraints（约束层）
 */

// ============ 通用类型 ============

/** Harness 配置 */
export interface HarnessConfig {
  useHarnessLoop: boolean;
  useHarnessTools: boolean;
  useHarnessContext: boolean;
  useHarnessVerification: boolean;
  useHarnessConstraints: boolean;
  useHarnessPersistence: boolean;
  useIndependentEvaluator: boolean;
  useTrajectoryPersistence: boolean;
  /** P0-3: Agent 类型（用于选择默认工具集，如 'coding'/'desktop'/'daily'） */
  agentType?: string;
}

/** 聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** 用户输入 */
export interface UserInput {
  text: string;
  userId?: string;
  traceId?: string;
  images?: Array<{ url: string; mimeType?: string }>;
  metadata?: Record<string, unknown>;
}

/** Agent 执行结果 */
export interface AgentResult {
  response: string;
  quality: QualityScore;
  trace: LoopTrace;
  metadata: Record<string, unknown>;
}

// ============ Layer 1: Loop（循环层）============

/** 任务状态枚举 - 统一版本 */
export enum UnifiedTaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  RETRYING = 'retrying',
  CANCELLED = 'cancelled',
}

/** 任务优先级枚举 - 统一版本 */
export enum UnifiedTaskPriority {
  LOW = 1,
  MEDIUM = 5,
  HIGH = 8,
  CRITICAL = 10,
}

/** 统一任务节点 - 合并所有三种任务模型 */
export interface UnifiedTaskNode {
  /** 任务唯一标识 */
  id: string;
  /** 任务描述 */
  description: string;
  /** 任务目标（可选，兼容TaskDispatcher） */
  goal?: string;
  /** 指定的Agent ID（可选） */
  agentId?: string;
  /** 分配给哪个Agent（运行时） */
  assignedTo?: string;
  /** 要调用的工具名称 */
  toolName?: string;
  /** 工具参数 */
  toolParams?: Record<string, unknown>;
  /** 所需工具列表（可选，兼容TaskDispatcher） */
  tools?: string[];
  /** 当前状态 */
  status: UnifiedTaskStatus;
  /** 依赖的任务ID列表 */
  dependencies: string[];
  /** 执行结果 */
  result?: unknown;
  /** 错误信息 */
  error?: string;
  /** 开始执行时间 */
  startTime?: number;
  /** 结束执行时间 */
  endTime?: number;
  /** 预计执行时间（秒） */
  estimatedTime?: number;
  /** 任务优先级 1-10 */
  priority: UnifiedTaskPriority;
  /** 最大重试次数 */
  maxRetries: number;
  /** 当前重试次数 */
  currentRetry: number;
  /** 超时时间（秒） */
  timeout: number;
  /** 重试延迟（秒） */
  retryDelay: number;
  /** 任务元数据 */
  metadata: Record<string, unknown>;
  /** 是否为关键步骤 */
  isEssential: boolean;
  /** 上下文信息（可选，兼容TaskDispatcher） */
  context?: string;
  /** 预期输出（可选） */
  expectedOutput?: string;
}

/** 计划步骤 - 保持向后兼容，内部使用UnifiedTaskNode */
export interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  expectedOutput?: string;
  /** P2: 输入绑定 — 从上游步骤输出解析参数，格式 { paramName: '$stepId.outputPath' } */
  inputBindings?: Record<string, string>;
  /** P2: 输出模式 — 声明步骤输出的字段类型，用于数据流验证 */
  outputSchema?: Record<string, string>;
  /** P2: 并行组 — 同组的步骤可并行执行 */
  parallelGroup?: string;
  retryCount: number;
  maxRetries: number;
  /** 转换为UnifiedTaskNode的便捷方法 */
  toUnifiedTaskNode(): UnifiedTaskNode;
}

/** P2: 步骤输出 — 封装步骤执行结果，支持中间结果传递 */
export interface StepOutput {
  stepId: string;
  results?: unknown;
  /** P2: 结构化数据 — 供下游步骤通过 inputBindings 引用 */
  data?: Record<string, unknown>;
  /** P2: 人类可读摘要 */
  summary?: string;
  /** P2: 输出类型 — tool_result=工具结果，llm_response=LLM响应 */
  type?: 'tool_result' | 'llm_response' | 'final';
  timestamp?: number;
  duration?: number;
  success?: boolean;
  error?: string;
}

/** P2: 数据流通道 — 描述步骤间的数据传递关系 */
export interface DataFlowChannel {
  sourceStepId: string;
  targetStepId: string;
  sourcePath?: string;
  targetPath?: string;
  dataType?: string;
  /** P2: 字段映射 — 源字段到目标字段的映射关系 */
  mapping?: Record<string, string>;
}

/** P2: 步骤状态 — 跟踪步骤执行过程中的状态信息 */
export interface StepStateInfo {
  stepId: string;
  status: StepState;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  lastError?: string;
  metadata: Record<string, unknown>;
}

/** E3-3: 步骤级状态机枚举 — 9 个状态 */
export enum StepState {
  PENDING = 'pending',
  READY = 'ready',
  RUNNING = 'running',
  WAITING_APPROVAL = 'waiting_approval',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRYING = 'retrying',
  BLOCKED = 'blocked',
  SKIPPED = 'skipped',
}

/** E3-3: 步骤状态合法转换表 */
export const STEP_STATE_TRANSITIONS: Record<StepState, StepState[]> = {
  [StepState.PENDING]: [StepState.READY, StepState.BLOCKED, StepState.SKIPPED],
  [StepState.READY]: [
    StepState.RUNNING,
    StepState.WAITING_APPROVAL,
    StepState.SKIPPED,
  ],
  [StepState.RUNNING]: [
    StepState.COMPLETED,
    StepState.FAILED,
    StepState.RETRYING,
    StepState.WAITING_APPROVAL,
  ],
  [StepState.WAITING_APPROVAL]: [StepState.RUNNING, StepState.SKIPPED],
  [StepState.COMPLETED]: [StepState.PENDING],
  [StepState.FAILED]: [StepState.RETRYING, StepState.SKIPPED],
  [StepState.RETRYING]: [
    StepState.RUNNING,
    StepState.FAILED,
    StepState.COMPLETED,
  ],
  [StepState.BLOCKED]: [StepState.READY, StepState.SKIPPED],
  [StepState.SKIPPED]: [StepState.PENDING],
};

/** E3-3: 步骤状态转换记录 */
export interface StepStateTransition {
  stepId: string;
  fromState: StepState;
  toState: StepState;
  reason: string;
  timestamp: number;
}

/** 循环状态 */
export enum LoopState {
  PLANNING = 'planning',
  DEBATING = 'debating',
  EXECUTING = 'executing',
  EVALUATING = 'evaluating',
  REPORTING = 'reporting',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ABORTED = 'aborted',
  BUDGET_EXCEEDED = 'budget_exceeded',
}

/** 执行计划 */
export interface ExecutionPlan {
  steps: PlanStep[];
  dependencies: Map<string, string[]>;
  estimatedBudget: BudgetAllocation;
  fallbackStrategy?: 'retry' | 'replan' | 'abort';
  /** 简单任务标记 — 跳过规划直接执行 */
  simple?: boolean;
  /** Planner 的 LLM 推理过程 — 确保数据流从 Planner → Executor 不断裂 */
  planReasoning?: string;
  /** 工具调用模式：required=必须调用工具，auto=自动选择，none=不调工具 */
  toolCallMode: 'required' | 'auto' | 'none';
  /** Planner 推荐的工具名列表，Executor 据此筛选工具 */
  recommendedTools: string[];
  /** P2: 执行模式 — dag=DAG并行执行，sequential=顺序执行 */
  executionMode?: 'dag' | 'sequential';
  /** P2: 数据流通道 — 描述步骤间的数据传递关系 */
  dataFlowChannels?: DataFlowChannel[];
  /** P3: 规划层级 — 标识计划的复杂度等级（none/simple/direct/complex/research） */
  planTier?: 'none' | 'simple' | 'direct' | 'complex' | 'research';
  /** P3: Tree of Thoughts 元数据 — 候选评估、推理链等 */
  totMeta?: {
    candidatesCount?: number;
    candidateCount?: number;
    selectedRank?: number;
    selectedStrategy?: string;
    evaluations?: Array<{
      candidateIndex: number;
      feasibilityScore: number;
      reasoning?: string;
    }>;
  };
}

/** 预算分配 */
export interface BudgetAllocation {
  maxRounds: number;
  maxToolCalls: number;
  maxTokens: number;
  maxDurationMs: number;
}

/** 预算状态 */
export interface BudgetState {
  roundsUsed: number;
  softRoundLimit: number;
  hardRoundLimit: number;
  tokensUsed: number;
  tokenWarningLimit: number;
  tokenHardLimit: number;
  startTime: number;
  maxDurationMs: number;
  toolCallsUsed: number;
  maxToolCalls: number;
}

/** 步骤执行结果 */
export interface StepResult {
  stepId: string;
  success: boolean;
  output: string;
  duration: number;
  toolName?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  /** P2: 结构化数据 — 工具执行的结构化结果，供下游步骤引用 */
  structuredData?: Record<string, unknown>;
  /** P2: 输出摘要 — 人类可读的执行结果摘要 */
  outputSummary?: string;
}

/** 详细轨迹步骤 */
export interface TrajectoryStep {
  /** 步骤类型 */
  type: 'planning' | 'tool_call' | 'tool_result' | 'evaluation' | 'reporting';
  /** 时间戳 */
  timestamp: number;
  /** 持续时间(ms) */
  duration?: number;
  /** 工具名称 (如果是工具步骤) */
  toolName?: string;
  /** 工具参数 (如果是工具调用) */
  toolParams?: Record<string, unknown>;
  /** 工具结果 (如果是工具步骤) */
  toolResult?: ToolResult;
  /** 模型输入 (如果是LLM调用) */
  modelInput?: string;
  /** 模型输出 (如果是LLM调用) */
  modelOutput?: string;
  /** 评估结果 (如果是评估步骤) */
  evaluationResult?: {
    goalProgress: number;
    suggestedAction: string;
    reason: string;
  };
  /** 其他元数据 */
  metadata?: Record<string, unknown>;
}

/** 循环追踪 */
export interface LoopTrace {
  traceId: string;
  state: LoopState;
  /** 状态转换历史 */
  stateTransitions: Array<{
    state: LoopState;
    timestamp: number;
    duration?: number;
    result?: string;
  }>;
  /** 完整执行轨迹 */
  trajectory: TrajectoryStep[];
  totalDuration: number;
  totalToolCalls: number;
  budgetState: BudgetState;
}

/** P3-4: 跨步骤状态条目 — 封装状态值及版本信息，支持追溯与回滚 */
export interface StateEntry {
  /** 状态键名 */
  key: string;
  /** 状态值 */
  value: unknown;
  /** 写入该状态的步骤 ID */
  writtenBy: string;
  /** 写入时间戳 */
  timestamp: number;
  /** 版本号，每次更新递增 */
  version: number;
}

/** P3-1: 计划验证错误类型 */
export type PlanValidationErrorType =
  | 'tool_unavailable'
  | 'dependency_missing'
  | 'circular_dependency'
  | 'budget_insufficient'
  | 'invalid_params';

/** P3-1: 计划验证警告类型 */
export type PlanValidationWarningType =
  | 'no_fallback'
  | 'parallel_conflict'
  | 'low_confidence'
  | 'redundant_step';

/** P3-1: 计划验证错误 */
export interface PlanValidationError {
  stepId: string;
  type: PlanValidationErrorType;
  message: string;
}

/** P3-1: 计划验证警告 */
export interface PlanValidationWarning {
  stepId: string;
  type: PlanValidationWarningType;
  message: string;
}

/** P3-1: 计划验证结果 */
export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
  warnings: PlanValidationWarning[];
  estimatedSuccessRate: number;
}

/** P3-2: 步骤进度 */
export interface StepProgress {
  stepId: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  duration: number;
}

/** P3-2: 预算消耗 */
export interface BudgetConsumption {
  rounds: number;
  tokens: number;
  toolCalls: number;
  time: number;
}

/** P3-2: 执行进度 */
export interface ExecutionProgress {
  traceId: string;
  overallProgress: number;
  currentPhase: string;
  stepProgress: StepProgress[];
  estimatedTimeRemaining: number;
  budgetConsumption: BudgetConsumption;
  bottlenecks: string[];
}

/** P3-3: 根因分析 */
export interface RootCauseAnalysis {
  failureType:
    | 'tool_unavailable'
    | 'timeout'
    | 'budget_exceeded'
    | 'context_insufficient'
    | 'plan_incorrect'
    | 'tool_error';
  impactScope: 'single_step' | 'downstream' | 'global';
  affectedSteps: string[];
  rootCause: string;
  fixSuggestions: string[];
}

/** P3-3: 重规划修复动作 */
export interface ReplanFixAction {
  stepId: string;
  action:
    | 'replace_tool'
    | 'retry_with_different_params'
    | 'add_context'
    | 'remove_step';
  details: Record<string, unknown>;
}

/** P3-3: 重规划策略 */
export interface ReplanStrategy {
  type: 'local_fix' | 'partial_replan' | 'full_replan' | 'fallback';
  stepsToReplan: string[];
  stepsToKeep: string[];
  fixActions: ReplanFixAction[];
}

/** 循环上下文 — 所有状态外部化 */
export interface LoopContext {
  messages: ChatMessage[];
  plan: ExecutionPlan | null;
  currentStepIndex: number;
  stepResults: Map<string, StepResult>;
  stepOutputs: Map<string, StepOutput>;
  dataFlowChannels: DataFlowChannel[];
  crossStepState: Map<string, StateEntry>;
  stepStates: Map<string, StepStateInfo>;
  stepStateHistory: StepStateInfo[];
  budget: BudgetState;
  trace: LoopTrace;
  metadata: Record<string, unknown>;
}

// ============ Layer 2: Tools（工具层）============

/** 工具分类 */
export enum ToolCategory {
  MEMORY = 'memory',
  FILE = 'file',
  CODE = 'code',
  DESKTOP = 'desktop',
  COGNITION = 'cognition',
  SYSTEM = 'system',
  DAILY = 'daily',
  NETWORK = 'network',
  PERCEPTION = 'perception',
  META = 'meta',
}

/** 权限枚举 */
export enum Permission {
  MEMORY_READ = 'memory:read',
  MEMORY_WRITE = 'memory:write',
  FILE_READ = 'file:read',
  FILE_WRITE = 'file:write',
  DESKTOP_CONTROL = 'desktop:control',
  NETWORK_ACCESS = 'network:access',
  CODE_EXECUTE = 'code:execute',
  SYSTEM_ADMIN = 'system:admin',
}

/** 风险等级 — 与 Python core.types.RiskLevel 对齐 */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** 工具定义 — 声明式 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** 简短描述（渐进式披露 Level 1: 一句话概括） */
  shortDesc?: string;
  category: ToolCategory;
  /** 语义标签（如 'git', 'search', 'file', 'code', 'debug'） */
  tags?: string[];
  /** 适用场景（如 'coding', 'desktop', 'daily', 'research', 'briefing'） */
  scenes?: string[];
  /** 工具能力等级: 1=基础(始终暴露), 2=中级(场景匹配时), 3=高级(明确需要时) */
  capabilityLevel?: 1 | 2 | 3;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, ToolParameterDef>;
  requiredParams: string[];
  requiredPermissions: Permission[];
  riskLevel: RiskLevel;
  /** 是否幂等（重复调用结果相同） */
  idempotent: boolean;
  /** 超时时间(ms) */
  timeout: number;
  /** 是否需要用户确认 */
  requiresConfirmation?: boolean;
}

/** 工具参数定义（JSON Schema 风格） */
export interface ToolParameterDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  items?: ToolParameterDef;
  properties?: Record<string, ToolParameterDef>;
  enum?: string[];
  default?: unknown;
}

/** 工具执行上下文 */
export interface ToolContext {
  userId?: string;
  traceId?: string;
  /** D2 会话标识: 用于把认知工具结果回灌到对应 Python 会话的 LLM 上下文。
   *  上层(编排/ActionDispatcher/聊天会话)应在构造 ctx 时写入; 缺失时 cognition_result 不带 sessionId(诚实降级, 不转发)。 */
  sessionId?: string;
  permissions: Set<Permission>;
  metadata: Record<string, unknown>;
}

/** 工具执行结果 — 结构化 */
export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
  validated: boolean;
  /** 是否需要用户确认 */
  needsConfirmation?: boolean;
  metadata?: Record<string, unknown>;
  /** 结构化输出：将 output 标准化为可被 LLM 精确引用的格式 */
  structuredOutput?: StructuredToolOutput;
  /** 内容哈希锚点：用于 LLM 精确定位输出中的特定行/段 */
  contentHash?: string;
}

/**
 * 结构化工具输出 — 统一格式
 * 借鉴 Harness Engineering 的 Hashline 格式：
 * 将工具输出标准化为带锚点的结构化数据，LLM 可精确引用
 */
export interface StructuredToolOutput {
  /** 输出类型标识 */
  type: 'text' | 'json' | 'file_content' | 'list' | 'error' | 'binary_info';
  /** 主要内容 */
  content: string;
  /** 摘要（用于上下文窗口受限时替换完整内容） */
  summary?: string;
  /** 带锚点的行内容（类似 Hashline: 行号+内容哈希） */
  anchoredLines?: Array<{
    /** 行号（从1开始） */
    line: number;
    /** 内容哈希（前8位） */
    hash: string;
    /** 行内容 */
    content: string;
  }>;
  /** 总行数/总条目数 */
  totalLines?: number;
  /** 截断信息 */
  truncation?: {
    /** 是否已截断 */
    truncated: boolean;
    /** 原始总长度 */
    originalLength: number;
    /** 截断后长度 */
    truncatedLength: number;
  };
  /** 输出 schema 类型名（用于 LLM 理解输出结构） */
  schemaType?: string;
}

/** 工具调用 */
export interface ToolCall {
  id?: string;
  name: string;
  params: Record<string, unknown>;
}

/** 已注册工具 */
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (
    params: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolResult>;
}

// ============ Layer 3: Context（上下文层）============

/** 上下文条目 */
export interface ContextEntry {
  id: string;
  type: 'system' | 'memory' | 'history' | 'dynamic' | 'tool_result';
  content: string;
  /** 1-10, 10 最高 */
  priority: number;
  tokenEstimate: number;
  expiresAt?: number;
  source: string;
}

/** Token 预算分配 */
export interface TokenAllocation {
  systemPrompt: number;
  memory: number;
  history: number;
  dynamicContext: number;
  toolResults: number;
  reserve: number;
}

// ============ Layer 5: Verification（验证层）============

/** 输出 Guardrail 检查结果 */
export interface GuardrailResult {
  passed: boolean;
  reason?: string;
  triggeredBy?: string;
  sanitizedOutput?: string;
  riskLevel?: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

/** 输出 Guardrail 定义 */
export interface OutputGuardrail {
  name: string;
  description: string;
  check: (output: string) => GuardrailResult;
}

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  sanitizedOutput: string;
  warnings: string[];
  errors: string[];
  autoFixed: boolean;
  /** P0: 安全验证失败阻断标记 — 为 true 时应中止当前步骤 */
  safetyBlocked?: boolean;
}

/** 安全检查结果 */
export interface SafetyCheckResult {
  safe: boolean;
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  violations: string[];
  sanitizedOutput?: string;
}

/** 质量评分 */
export interface QualityScore {
  overall: number;
  accuracy: number;
  usefulness: number;
  friendliness: number;
  efficiency: number;
  details: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: string, code?: string): Result<T> {
  return { ok: false, error, code };
}

export function isOk<T>(result: Result<T>): result is { ok: true; value: T } {
  return result.ok === true;
}

export function isErr<T>(
  result: Result<T>
): result is { ok: false; error: string; code?: string } {
  return result.ok === false;
}

/** 目标达成度 */
export interface GoalProgress {
  achieved: boolean;
  progress: number;
  remainingSteps: string[];
  suggestedAction: 'continue' | 'replan' | 'abort';
}

// ============ Layer 6: Constraints（约束层）============

/** 生命周期事件 */
export enum LifecycleEvent {
  BEFORE_LOOP = 'before_loop',
  BEFORE_TOOL_CALL = 'before_tool_call',
  AFTER_TOOL_CALL = 'after_tool_call',
  BEFORE_RESPONSE = 'before_response',
  AFTER_RESPONSE = 'after_response',
  ON_ERROR = 'on_error',
  ON_BUDGET_EXCEEDED = 'on_budget_exceeded',
  ON_PLAN_CREATED = 'on_plan_created',
  ON_STEP_COMPLETED = 'on_step_completed',
}

/** 生命周期钩子 */
export type LifecycleHook = (context: HookContext) => Promise<HookResult>;

/** 钩子上下文 */
export interface HookContext {
  event: LifecycleEvent;
  toolName?: string;
  params?: Record<string, unknown>;
  result?: ToolResult;
  loopState?: LoopState;
  budgetState?: BudgetState;
  metadata: Record<string, unknown>;
}

/** 钩子结果 */
export interface HookResult {
  /** 是否允许继续执行 */
  proceed: boolean;
  /** 修改后的参数（仅 BEFORE_TOOL_CALL 有效） */
  modifiedParams?: Record<string, unknown>;
  /** 替换结果（仅 AFTER_TOOL_CALL 有效） */
  replacementResult?: ToolResult;
  /** 中止原因 */
  reason?: string;
}

/** 预算检查结果 */
export interface BudgetCheckResult {
  withinBudget: boolean;
  warnings: string[];
  remaining: {
    rounds: number;
    tokens: number;
    toolCalls: number;
    durationMs: number;
  };
}

/** 约束等级 — 区分硬约束和软约束 */
export type ConstraintLevel = 'hard' | 'soft' | 'advisory';

/** 约束定义 */
export interface ConstraintDefinition {
  /** 约束名称 */
  name: string;
  /** 约束等级：hard=不可违反（安全），soft=建议遵守，advisory=仅供参考 */
  level: ConstraintLevel;
  /** 约束描述 */
  description: string;
}

/** 自适应预算配置 — 根据任务复杂度动态调整 */
export interface AdaptiveBudgetConfig {
  /** 简单任务的预算 */
  simple: BudgetAllocation;
  /** 中等任务的预算 */
  moderate: BudgetAllocation;
  /** 复杂任务的预算 */
  complex: BudgetAllocation;
  /** 创造性探索模式的额外预算 */
  creativeBonus: Partial<BudgetAllocation>;
}

/** 创造性探索模式配置 */
export interface CreativeExplorationConfig {
  /** 是否启用创造性探索 */
  enabled: boolean;
  /** 允许的最大额外工具调用次数 */
  maxExtraToolCalls: number;
  /** 允许的最大额外轮次 */
  maxExtraRounds: number;
  /** 触发条件：当任务评分高于此值时允许探索 */
  qualityThreshold: number;
  /** 探索提示词（注入给 LLM） */
  explorationPrompt: string;
}

/** 权限检查结果 */
export interface PermissionResult {
  allowed: boolean;
  missing: Permission[];
  reason?: string;
}

// ============ 任务模型转换辅助函数 ============

/**
 * 将PlanStep转换为UnifiedTaskNode
 */
export function planStepToUnifiedTaskNode(step: PlanStep): UnifiedTaskNode {
  return {
    id: step.id,
    description: step.description,
    goal: step.description,
    toolName: step.toolName,
    toolParams: step.toolParams,
    expectedOutput: step.expectedOutput,
    status: UnifiedTaskStatus.PENDING,
    dependencies: [],
    priority: UnifiedTaskPriority.MEDIUM,
    maxRetries: step.maxRetries,
    currentRetry: step.retryCount,
    timeout: 300,
    retryDelay: 1,
    metadata: {},
    isEssential: true,
  };
}

/**
 * 将DAGTask中的TaskNode转换为UnifiedTaskNode
 */
export function dagTaskNodeToUnifiedTaskNode(
  node: import('../core/DAGTask').TaskNode
): UnifiedTaskNode {
  const statusMap: Record<
    import('../core/DAGTask').TaskStatus,
    UnifiedTaskStatus
  > = {
    pending: UnifiedTaskStatus.PENDING,
    running: UnifiedTaskStatus.RUNNING,
    success: UnifiedTaskStatus.SUCCESS,
    failed: UnifiedTaskStatus.FAILED,
    skipped: UnifiedTaskStatus.SKIPPED,
    retrying: UnifiedTaskStatus.RETRYING,
  };
  const priorityMap: Record<
    import('../core/DAGTask').TaskPriority,
    UnifiedTaskPriority
  > = {
    low: UnifiedTaskPriority.LOW,
    medium: UnifiedTaskPriority.MEDIUM,
    high: UnifiedTaskPriority.HIGH,
    critical: UnifiedTaskPriority.CRITICAL,
  };
  return {
    id: node.id,
    description: node.description,
    goal: node.description,
    toolName: node.toolName,
    toolParams: node.params,
    status: statusMap[node.status] || UnifiedTaskStatus.PENDING,
    dependencies: node.dependencies,
    result: node.result,
    error: node.error?.message,
    startTime: node.startTime?.getTime(),
    endTime: node.endTime?.getTime(),
    estimatedTime: node.estimatedTime,
    priority: priorityMap[node.priority] || UnifiedTaskPriority.MEDIUM,
    maxRetries: node.maxRetries,
    currentRetry: node.currentRetry,
    timeout: node.timeout,
    retryDelay: node.retryDelay,
    metadata: node.metadata,
    isEssential: node.isEssential,
  };
}

/**
 * 将TaskDispatcher的TaskNode转换为UnifiedTaskNode
 */
export function dispatcherTaskNodeToUnifiedTaskNode(
  node: import('./orchestration/TaskDispatcher').TaskNode
): UnifiedTaskNode {
  const statusMap: Record<string, UnifiedTaskStatus> = {
    pending: UnifiedTaskStatus.PENDING,
    running: UnifiedTaskStatus.RUNNING,
    completed: UnifiedTaskStatus.SUCCESS,
    failed: UnifiedTaskStatus.FAILED,
    cancelled: UnifiedTaskStatus.CANCELLED,
  };
  return {
    id: node.id,
    description: node.goal,
    goal: node.goal,
    agentId: node.agentId,
    assignedTo: node.assignedTo,
    tools: node.tools,
    status: statusMap[node.status] || UnifiedTaskStatus.PENDING,
    dependencies: node.dependencies,
    result: node.result,
    error: node.error,
    priority: node.priority as unknown as UnifiedTaskPriority,
    maxRetries: 2,
    currentRetry: 0,
    timeout: 300,
    retryDelay: 1,
    metadata: {},
    isEssential: true,
    context: node.context,
  };
}

/**
 * 将UnifiedTaskNode转换为PlanStep（向后兼容）
 */
export function unifiedTaskNodeToPlanStep(node: UnifiedTaskNode): PlanStep {
  return {
    id: node.id,
    description: node.description,
    toolName: node.toolName,
    toolParams: node.toolParams,
    expectedOutput: node.expectedOutput,
    retryCount: node.currentRetry,
    maxRetries: node.maxRetries,
    toUnifiedTaskNode: () => node,
  };
}

/**
 * 将UnifiedTaskNode转换为DAGTask的TaskNode
 */
let _DAGTask: typeof import('../core/DAGTask') | undefined = undefined;
function getDAGTask(): typeof import('../core/DAGTask') {
  if (!_DAGTask) _DAGTask = require('../core/DAGTask');
  return _DAGTask!;
}

export function unifiedTaskNodeToDagTaskNode(
  node: UnifiedTaskNode
): import('../core/DAGTask').TaskNode {
  const { TaskStatus, TaskPriority, TaskNode } = getDAGTask();
  const statusMap: Record<
    UnifiedTaskStatus,
    import('../core/DAGTask').TaskStatus
  > = {
    [UnifiedTaskStatus.PENDING]: TaskStatus.PENDING,
    [UnifiedTaskStatus.RUNNING]: TaskStatus.RUNNING,
    [UnifiedTaskStatus.SUCCESS]: TaskStatus.SUCCESS,
    [UnifiedTaskStatus.FAILED]: TaskStatus.FAILED,
    [UnifiedTaskStatus.SKIPPED]: TaskStatus.SKIPPED,
    [UnifiedTaskStatus.RETRYING]: TaskStatus.RETRYING,
    [UnifiedTaskStatus.CANCELLED]: TaskStatus.FAILED,
  };
  const priorityMap: Record<
    UnifiedTaskPriority,
    import('../core/DAGTask').TaskPriority
  > = {
    [UnifiedTaskPriority.LOW]: TaskPriority.LOW,
    [UnifiedTaskPriority.MEDIUM]: TaskPriority.MEDIUM,
    [UnifiedTaskPriority.HIGH]: TaskPriority.HIGH,
    [UnifiedTaskPriority.CRITICAL]: TaskPriority.CRITICAL,
  };
  const dagNode = new TaskNode(
    node.id,
    node.description,
    node.toolName || '',
    node.toolParams || {},
    statusMap[node.status],
    node.dependencies,
    priorityMap[node.priority]
  );
  dagNode.estimatedTime = node.estimatedTime || 0;
  dagNode.maxRetries = node.maxRetries;
  dagNode.currentRetry = node.currentRetry;
  dagNode.timeout = node.timeout;
  dagNode.retryDelay = node.retryDelay;
  dagNode.metadata = node.metadata;
  dagNode.isEssential = node.isEssential;
  if (node.startTime) {
    dagNode.startTime = new Date(node.startTime);
  }
  if (node.endTime) {
    dagNode.endTime = new Date(node.endTime);
  }
  if (node.result) {
    dagNode.result = node.result;
  }
  if (node.error) {
    dagNode.error = new Error(node.error);
  }
  return dagNode;
}
