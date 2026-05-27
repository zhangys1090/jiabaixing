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

/** 循环状态 */
export enum LoopState {
  PLANNING = 'planning',
  EXECUTING = 'executing',
  EVALUATING = 'evaluating',
  REPORTING = 'reporting',
  COMPLETED = 'completed',
  FAILED = 'failed',
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
}

/** 计划步骤 */
export interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  expectedOutput?: string;
  retryCount: number;
  maxRetries: number;
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

/** 循环上下文 — 所有状态外部化 */
export interface LoopContext {
  messages: ChatMessage[];
  plan: ExecutionPlan | null;
  currentStepIndex: number;
  stepResults: Map<string, StepResult>;
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

/** 风险等级 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** 工具定义 — 声明式 */
export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
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
  metadata?: Record<string, unknown>;
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

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  sanitizedOutput: string;
  warnings: string[];
  errors: string[];
  autoFixed: boolean;
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
export type LifecycleHook = (
  context: HookContext
) => Promise<HookResult>;

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

/** 权限检查结果 */
export interface PermissionResult {
  allowed: boolean;
  missing: Permission[];
  reason?: string;
}
