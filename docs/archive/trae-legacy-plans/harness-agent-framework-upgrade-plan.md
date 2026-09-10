# Jiabaixing 基于 Harness Agent Framework 的架构升级方案

> 版本: v4.0 → v5.0
> 日期: 2026-05-23
> 基于: [Harness Agent Framework](https://github.com/harness-ai/agent)
> 方法论: 先设计理想目标架构，再基于现有代码制定分阶段迁移方案

---

# 第一部分：Harness Agent Framework 核心理念

## 1.1 什么是 Harness Engineering

**核心公式**: `Agent = Model + Harness`

Harness（马具）是包裹在 AI 模型外部的完整运行系统，将模型的原始认知能力转化为可靠的生产输出。马本身很强壮，但没有马具可能跑偏、受惊、半路吃草。马具不让马更强壮，而是让马的力量可靠地转化为有用的工作。

**范式演进**:

| 阶段 | 年份 | 关注点 | 代表实践 |
|------|------|--------|---------|
| Prompt Engineering | 2023 | 优化输入文本 | Few-shot, CoT |
| Context Engineering | 2024 | 优化信息上下文 | RAG, 上下文窗口管理 |
| Agent Engineering | 2025 | 构建自主执行体 | ReAct, Tool Use |
| **Harness Engineering** | **2026** | **设计完整运行系统** | **六层架构, 质量门禁, 约束控制** |

**核心转变**:
- ~~"找到最好的模型"~~ → "为模型设计最好的运行系统"
- ~~"写出最好的 Prompt"~~ → "构建完整的循环-工具-上下文-验证链"
- ~~"评估模型能力"~~ → "评估端到端系统表现"

## 1.2 Harness 六层架构模型

```
Agent Harness 六层架构
│
├── Layer 1: Loop（循环层）
│   Agent 持续运行直到目标达成或触发终止条件
│
├── Layer 2: Tools（工具层）
│   让 AI 从"说"变为"做"，接入真实环境
│
├── Layer 3: Context（上下文层）
│   精确控制 AI 看到什么、看不到什么
│
├── Layer 4: Persistence（持久化层）
│   跨会话/执行保持记忆与状态
│
├── Layer 5: Verification（验证层）
│   执行后自检，确保输出质量
│
└── Layer 6: Constraints（约束层）
    明确的安全边界与行为限制
```

六层之间相互增强：Loop 驱动 Tools 执行，Tools 的输出经 Context 过滤后进入 Verification，Constraints 全程约束每一层的行为，Persistence 跨循环保持状态。

## 1.3 四大设计原则

| 原则 | 说明 |
|------|------|
| **约束，而非指令** | Harness 不告诉模型"怎么做"，而是设定"不能做什么"的边界 |
| **状态外部化** | Agent 不持有状态，所有状态由 Harness 管理和持久化 |
| **Rippable Architecture** | 每个组件都是对模型能力不足的假设，模型进步后可逐步拆除 |
| **可观测性优先** | 每一步执行都有结构化日志、指标、追踪 |

---

# 第二部分：理想目标架构（v5.0）

## 2.1 架构总览

```
用户输入
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Gateway Layer                                  │
│  Express + WebSocket + Rate Limiting + Auth                          │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Agent Harness (核心)                               │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              Layer 6: Constraints（约束层）                       │ │
│  │  预算控制 · 权限分级 · 安全边界 · 行为约束                        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│       │                                                               │
│  ┌────▼────────────────────────────────────────────────────────────┐ │
│  │              Layer 1: Loop（循环层）                              │ │
│  │                                                                  │ │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐    │ │
│  │  │ Planner  │──▶│ Executor │──▶│ Evaluator│──▶│ Reporter │    │ │
│  │  │ 规划节点  │   │ 执行节点  │   │ 评估节点  │   │ 报告节点  │    │ │
│  │  └──────────┘   └──────────┘   └──────────┘   └──────────┘    │ │
│  │       │              │              │              │             │ │
│  │       ▼              ▼              ▼              ▼             │ │
│  │  ┌──────────────────────────────────────────────────────────┐   │ │
│  │  │           Loop Controller（循环控制器）                    │   │ │
│  │  │  状态机 · 预算管理 · 回溯决策 · 循环终止                    │   │ │
│  │  └──────────────────────────────────────────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│       │              │              │                                 │
│  ┌────▼──────────────▼──────────────▼─────────────────────────────┐ │
│  │              Layer 2: Tools（工具层）                             │ │
│  │                                                                  │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │ │
│  │  │ Memory Tools │  │  File Tools  │  │ Desktop Tools│            │ │
│  │  │ recall/store │  │ read/edit/  │  │ automate/   │            │ │
│  │  │ search/del  │  │ search/list │  │ screenshot  │            │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘            │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │ │
│  │  │ Cognition   │  │  Code Tools  │  │ System Tools │            │ │
│  │  │ emotion/    │  │ generate/   │  │ schedule/   │            │ │
│  │  │ scene/reflect│  │ analyze/fix │  │ search/web  │            │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘            │ │
│  │                                                                  │ │
│  │  ToolRegistry · Schema Validation · Permission Check             │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              Layer 3: Context（上下文层）                         │ │
│  │                                                                  │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │ │
│  │  │ Constitutional│  │   Memory     │  │   Dynamic    │          │ │
│  │  │ Prompt Builder│  │   Injector   │  │   Context    │          │ │
│  │  │ (人设+规则)   │  │ (5条自动注入) │  │ (时间/场景)  │          │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │ │
│  │                                                                  │ │
│  │  ContextWindow · TokenBudget · Compression · Priority            │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              Layer 4: Persistence（持久化层）                     │ │
│  │                                                                  │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │ │
│  │  │ Conversation │  │    Memory    │  │    Task      │          │ │
│  │  │   History    │  │    Store     │  │    State     │          │ │
│  │  │ (SQLite)     │  │ (SQLite+Chroma)│ │ (SQLite)     │          │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │ │
│  │                                                                  │ │
│  │  ┌──────────────┐  ┌──────────────┐                             │ │
│  │  │    User      │  │   Evolution  │                             │ │
│  │  │   Profile    │  │    Metrics   │                             │ │
│  │  └──────────────┘  └──────────────┘                             │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              Layer 5: Verification（验证层）                      │ │
│  │                                                                  │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │ │
│  │  │   Tool       │  │   Output     │  │   Quality    │          │ │
│  │  │   Result     │  │   Safety     │  │   Score      │          │ │
│  │  │   Validator  │  │   Check      │  │   Evaluator  │          │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │ │
│  │                                                                  │ │
│  │  Pre-condition · Post-condition · Idempotency · Rollback         │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
    │              │              │
    ▼              ▼              ▼
┌─────────┐  ┌─────────┐  ┌──────────────┐
│  Model  │  │  Event  │  │  Proactive   │
│  Router │  │   Bus   │  │  Scheduler   │
│(本地+云) │  │(跨模块) │  │(Cron+触发)   │
└─────────┘  └─────────┘  └──────────────┘
```

## 2.2 六层架构详细设计

### Layer 1: Loop（循环层）— Agent 的核心执行引擎

**目标**: 从简单的 FC 循环升级为 Plan-Execute-Evaluate 循环，支持回溯和重新规划。

```
Loop Controller (状态机)
    │
    ├── State: PLANNING ──────▶ Planner 节点
    │   │                        │
    │   │                        ├── 分析用户意图
    │   │                        ├── 分解为子任务（可选）
    │   │                        ├── 生成执行计划
    │   │                        └── 输出: Plan{steps[], dependencies, budget}
    │   │
    │   ▼
    ├── State: EXECUTING ─────▶ Executor 节点
    │   │                        │
    │   │                        ├── 按 Plan 执行步骤
    │   │                        ├── 调用工具 (Layer 2)
    │   │                        ├── 注入上下文 (Layer 3)
    │   │                        └── 输出: StepResult{success, output, duration}
    │   │
    │   ▼
    ├── State: EVALUATING ─────▶ Evaluator 节点
    │   │                        │
    │   │                        ├── 验证工具结果 (Layer 5)
    │   │                        ├── 检查目标达成度
    │   │                        ├── 决策: 继续/回溯/完成
    │   │                        └── 输出: EvalResult{progress, nextAction}
    │   │
    │   ▼
    ├── State: REPORTING ──────▶ Reporter 节点
    │   │                        │
    │   │                        ├── 生成最终响应
    │   │                        ├── 质量评分 (Layer 5)
    │   │                        ├── 知识提取 (Layer 4)
    │   │                        └── 输出: FinalResult{response, metrics}
    │   │
    │   ▼
    └── State: COMPLETED / FAILED / BUDGET_EXCEEDED
```

**Loop Controller 核心接口**:

```typescript
/** 循环状态 */
enum LoopState {
  PLANNING = 'planning',
  EXECUTING = 'executing',
  EVALUATING = 'evaluating',
  REPORTING = 'reporting',
  COMPLETED = 'completed',
  FAILED = 'failed',
  BUDGET_EXCEEDED = 'budget_exceeded',
}

/** 执行计划 */
interface ExecutionPlan {
  steps: PlanStep[];
  dependencies: Map<string, string[]>;  // stepId → 依赖的 stepIds
  estimatedBudget: BudgetAllocation;
  fallbackStrategy?: 'retry' | 'replan' | 'abort';
}

/** 计划步骤 */
interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  expectedOutput?: string;
  retryCount: number;
  maxRetries: number;
}

/** 循环控制器接口 */
interface ILoopController {
  run(input: UserInput, context: LoopContext): Promise<LoopResult>;
  getState(): LoopState;
  abort(): void;
  getTrace(): LoopTrace;
}

/** 循环上下文 — 所有状态外部化 */
interface LoopContext {
  messages: ChatMessage[];
  plan: ExecutionPlan | null;
  currentStepIndex: number;
  stepResults: Map<string, StepResult>;
  budget: BudgetState;
  trace: LoopTrace;
  metadata: Record<string, unknown>;
}
```

**预算控制（Constraints 层在 Loop 中的体现）**:

```typescript
interface BudgetState {
  // 轮次预算
  roundsUsed: number;
  softRoundLimit: number;   // 默认 4
  hardRoundLimit: number;   // 默认 8

  // Token 预算
  tokensUsed: number;
  tokenWarningLimit: number;  // 默认 4500
  tokenHardLimit: number;     // 默认 6000

  // 时间预算
  startTime: number;
  maxDurationMs: number;      // 默认 60000 (60秒)

  // 工具调用预算
  toolCallsUsed: number;
  maxToolCalls: number;       // 默认 20
}
```

### Layer 2: Tools（工具层）— 让 AI 从"说"变为"做"

**目标**: 从集中式注册改为声明式注册 + Schema 验证 + 权限分级 + 独立模块化。

```typescript
/** 工具定义 — 声明式 */
interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: JSONSchema;          // JSON Schema 定义参数
  requiredPermissions: Permission[];  // 权限要求
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  idempotent: boolean;             // 是否幂等
  timeout: number;                 // 超时时间(ms)
  requiresConfirmation?: boolean;  // 是否需要用户确认
}

/** 工具执行结果 — 结构化 */
interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
  validated: boolean;              // 是否经过验证
  metadata?: Record<string, unknown>;
}

/** 工具注册表接口 */
interface IToolRegistry {
  register(definition: ToolDefinition, executor: ToolExecutor): void;
  unregister(name: string): void;
  get(name: string): RegisteredTool | undefined;
  getAll(): RegisteredTool[];
  toOpenAITools(): OpenAIToolDef[];
  execute(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** 权限枚举 */
enum Permission {
  MEMORY_READ = 'memory:read',
  MEMORY_WRITE = 'memory:write',
  FILE_READ = 'file:read',
  FILE_WRITE = 'file:write',
  DESKTOP_CONTROL = 'desktop:control',
  NETWORK_ACCESS = 'network:access',
  CODE_EXECUTE = 'code:execute',
  SYSTEM_ADMIN = 'system:admin',
}

/** 工具分类 */
enum ToolCategory {
  MEMORY = 'memory',       // 记忆工具
  FILE = 'file',           // 文件工具
  CODE = 'code',           // 代码工具
  DESKTOP = 'desktop',     // 桌面自动化
  COGNITION = 'cognition', // 认知工具(情绪/场景/反思)
  SYSTEM = 'system',       // 系统工具(调度/搜索/网络)
}
```

**工具模块化拆分**:

```
src/harness/tools/
├── registry/
│   ├── ToolRegistry.ts          # 工具注册表核心 (~300行)
│   ├── SchemaValidator.ts       # JSON Schema 参数验证 (~150行)
│   └── PermissionGuard.ts       # 权限检查中间件 (~200行)
│
├── memory/
│   ├── memory_recall.ts         # 记忆检索 (~100行)
│   ├── memory_store.ts          # 记忆存储 (~100行)
│   └── memory_search.ts         # 记忆搜索 (~100行)
│
├── file/
│   ├── file_read.ts             # 文件读取 (~80行)
│   ├── file_edit.ts             # 增量编辑 (~150行)
│   ├── file_search.ts           # 内容搜索 (~100行)
│   ├── file_list.ts             # 目录列表 (~60行)
│   └── multi_file_edit.ts       # 多文件原子编辑 (~200行)
│
├── code/
│   ├── code_generate.ts         # 代码生成 (~100行)
│   ├── code_analyze.ts          # 代码分析 (~100行)
│   └── code_fix.ts              # 代码修复 (~100行)
│
├── desktop/
│   ├── desktop_automate.ts      # 桌面自动化 (~150行)
│   └── desktop_screenshot.ts    # 截图 (~80行)
│
├── cognition/
│   ├── emotion_detect.ts        # 情绪检测 (~80行)
│   ├── scene_analyze.ts         # 场景分析 (~80行)
│   └── self_reflect.ts          # 自我反思 (~80行)
│
└── system/
    ├── ask_clarification.ts     # 澄清提问 (~80行)
    ├── preview_execution.ts     # 执行预览 (~100行)
    └── rollback_changes.ts      # 变更回滚 (~100行)
```

### Layer 3: Context（上下文层）— 精确控制 AI 看到什么

**目标**: 从硬编码的 prompt 拼接改为可组合的上下文管道，支持优先级、Token 预算分配和智能压缩。

```typescript
/** 上下文条目 */
interface ContextEntry {
  id: string;
  type: 'system' | 'memory' | 'history' | 'dynamic' | 'tool_result';
  content: string;
  priority: number;           // 1-10, 10 最高
  tokenEstimate: number;
  expiresAt?: number;         // 过期时间戳
  source: string;             // 来源标识
}

/** 上下文管理器接口 */
interface IContextManager {
  // 构建上下文
  buildContext(input: UserInput, state: LoopState): Promise<ChatMessage[]>;

  // 上下文条目管理
  addEntry(entry: ContextEntry): void;
  removeEntry(id: string): void;
  getEntries(): ContextEntry[];

  // Token 预算分配
  allocateTokenBudget(totalBudget: number): TokenAllocation;

  // 压缩策略
  compress(entries: ContextEntry[], targetTokens: number): ContextEntry[];
}

/** Token 预算分配 */
interface TokenAllocation {
  systemPrompt: number;     // 30% - 人设+规则
  memory: number;           // 15% - 自动注入记忆
  history: number;          // 25% - 对话历史
  dynamicContext: number;   // 15% - 动态上下文(时间/场景)
  toolResults: number;      // 15% - 工具结果
  reserve: number;          // 10% - 预留
}
```

**上下文构建管道**:

```
UserInput
    │
    ▼
┌─────────────────────────────────────────────┐
│  Context Pipeline                            │
│                                              │
│  1. Constitutional Prompt (priority: 10)     │
│     人设 + 行为规则 + 核心原则               │
│                                              │
│  2. Dynamic Context (priority: 9)            │
│     当前时间 + 时段 + 星期 + 场景            │
│                                              │
│  3. User Profile (priority: 8)               │
│     偏好 + 习惯 + 沟通风格                    │
│                                              │
│  4. Auto Memories (priority: 7)              │
│     5条最相关记忆                             │
│                                              │
│  5. Conversation History (priority: 5)       │
│     最近对话（按 Token 预算截断）             │
│                                              │
│  6. Tool Results (priority: 6)               │
│     FC 循环中的工具执行结果                   │
│                                              │
│  ─── Token Budget Allocator ───              │
│  总预算: model.contextWindow - outputReserve  │
│  按优先级 + 分配比例填充，超出则压缩          │
└─────────────────────────────────────────────┘
```

### Layer 4: Persistence（持久化层）— 跨会话保持状态

**目标**: 从分散的持久化逻辑改为统一的持久化服务，支持跨会话任务状态恢复。

```typescript
/** 持久化服务接口 */
interface IPersistenceService {
  // 对话持久化
  saveConversation(sessionId: string, messages: ChatMessage[]): Promise<void>;
  loadConversation(sessionId: string): Promise<ChatMessage[]>;

  // 记忆持久化
  storeMemory(content: string, options: MemoryStoreOptions): Promise<string>;
  recallMemory(query: string, options?: MemoryRecallOptions): Promise<MemoryItem[]>;
  deleteMemory(id: string): Promise<boolean>;

  // 任务状态持久化（新增）
  saveTaskState(taskId: string, state: TaskState): Promise<void>;
  loadTaskState(taskId: string): Promise<TaskState | null>;
  listActiveTasks(): Promise<TaskState[]>;

  // 用户画像持久化
  saveUserProfile(userId: string, profile: UserProfile): Promise<void>;
  loadUserProfile(userId: string): Promise<UserProfile>;

  // 进化指标持久化
  recordEvolutionMetric(metric: EvolutionMetric): Promise<void>;
  getEvolutionMetrics(timeRange?: TimeRange): Promise<EvolutionMetrics>;
}

/** 跨会话任务状态（新增） */
interface TaskState {
  taskId: string;
  userId: string;
  description: string;
  status: 'pending' | 'in_progress' | 'paused' | 'completed' | 'failed';
  plan: ExecutionPlan;
  currentStepIndex: number;
  stepResults: Map<string, StepResult>;
  createdAt: number;
  updatedAt: number;
  resumeContext?: string;  // 恢复时注入的上下文
}
```

### Layer 5: Verification（验证层）— 确保输出质量

**目标**: 从简单的工具结果验证升级为多层验证体系。

```typescript
/** 验证服务接口 */
interface IVerificationService {
  // 工具结果验证
  validateToolResult(toolName: string, result: ToolResult): ValidationResult;

  // 输出安全检查
  checkOutputSafety(output: string): SafetyCheckResult;

  // 质量评分
  scoreQuality(context: QualityContext): QualityScore;

  // 目标达成度评估
  evaluateGoalProgress(originalInput: string, currentOutput: string): GoalProgress;
}

/** 验证结果 */
interface ValidationResult {
  valid: boolean;
  sanitizedOutput: string;
  warnings: string[];
  errors: string[];
  autoFixed: boolean;  // 是否自动修复
}

/** 安全检查结果 */
interface SafetyCheckResult {
  safe: boolean;
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  violations: string[];
  sanitizedOutput?: string;
}

/** 质量评分 */
interface QualityScore {
  overall: number;        // 0.0-1.0
  accuracy: number;       // 准确性
  usefulness: number;     // 有用性
  friendliness: number;   // 友好度
  efficiency: number;     // 效率（工具调用是否合理）
  details: string;        // 评分理由
}

/** 目标达成度 */
interface GoalProgress {
  achieved: boolean;
  progress: number;       // 0.0-1.0
  remainingSteps: string[];
  suggestedAction: 'continue' | 'replan' | 'abort';
}
```

### Layer 6: Constraints（约束层）— 安全边界与行为限制

**目标**: 从分散的预算控制和安全检查改为统一的约束框架，5 重防御。

```
5 重防御体系:

1. Prompt Guardrails（提示词护栏）
   └── Constitutional Prompt 中明确禁止行为
       当前实现: ConstitutionPromptBuilder ✅

2. Schema Constraints（Schema 约束）
   └── 工具参数 JSON Schema 验证，防止参数注入
       当前实现: 无 ❌ → 新增 SchemaValidator

3. Runtime Approval（运行时审批）
   └── 高风险操作需用户确认
       当前实现: preview_execution 工具 ✅ → 增强

4. Tool Verification（工具验证）
   └── 工具结果前置/后置条件检查
       当前实现: FCLoopHelper.validateToolResult ✅ → 增强

5. Lifecycle Hooks（生命周期钩子）
   └── 执行前/后/失败的回调，支持审计和回滚
       当前实现: 无 ❌ → 新增 LifecycleHookManager
```

```typescript
/** 约束服务接口 */
interface IConstraintsService {
  // 预算控制
  checkBudget(state: BudgetState): BudgetCheckResult;
  allocateBudget(task: ExecutionPlan): BudgetAllocation;

  // 权限检查
  checkPermission(tool: string, action: string, context: ToolContext): PermissionResult;

  // 安全边界
  checkSafetyBoundary(input: string, action: string): SafetyBoundaryResult;

  // 生命周期钩子
  registerHook(event: LifecycleEvent, hook: LifecycleHook): void;
  executeHooks(event: LifecycleEvent, context: HookContext): Promise<HookResult>;

  // 行为约束
  enforceBehaviorConstraint(constraint: BehaviorConstraint, context: LoopContext): ConstraintResult;
}

/** 生命周期事件 */
enum LifecycleEvent {
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
```

## 2.3 核心类与接口关系

```
┌──────────────────────────────────────────────────────────────────┐
│                        AgentHarness                                │
│  (系统入口，组装六层，协调运行)                                     │
│                                                                    │
│  - loopController: ILoopController                                 │
│  - toolRegistry: IToolRegistry                                     │
│  - contextManager: IContextManager                                 │
│  - persistenceService: IPersistenceService                         │
│  - verificationService: IVerificationService                       │
│  - constraintsService: IConstraintsService                         │
│  - modelRouter: IModelRouter                                       │
│  - eventBus: IEventBus                                             │
│                                                                    │
│  + processInput(input: UserInput): Promise<AgentResult>            │
│  + processProactive(trigger: ProactiveTrigger): Promise<void>      │
│  + getTaskState(taskId: string): Promise<TaskState | null>         │
│  + shutdown(): Promise<void>                                       │
└──────────────────────────────────────────────────────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  Model   │  │  Event   │  │ Proactive│  │  Config  │
   │  Router  │  │   Bus    │  │Scheduler │  │ Manager  │
   └──────────┘  └──────────┘  └──────────┘  └──────────┘
```

## 2.4 数据流设计

```
用户输入
    │
    ▼
AgentHarness.processInput(input)
    │
    ├── 1. Constraints 层: 检查安全边界
    │   └── 不通过 → 返回拒绝响应
    │
    ├── 2. Context 层: 构建上下文
    │   ├── Constitutional Prompt
    │   ├── Dynamic Context (时间/场景)
    │   ├── User Profile
    │   ├── Auto Memories (5条)
    │   └── Conversation History
    │
    ├── 3. Loop 层: Plan-Execute-Evaluate 循环
    │   │
    │   ├── [PLANNING] LLM 分析意图，生成 ExecutionPlan
    │   │   └── 简单任务 → 跳过规划，直接执行
    │   │
    │   ├── [EXECUTING] FC 循环执行
    │   │   ├── LLM.chatWithTools(messages, tools)
    │   │   ├── 有 toolCalls?
    │   │   │   ├── 是: Tools 层执行
    │   │   │   │   ├── Schema 验证参数
    │   │   │   │   ├── 权限检查
    │   │   │   │   ├── 执行工具 (超时控制)
    │   │   │   │   ├── Verification 层验证结果
    │   │   │   │   └── 结果注入 Context
    │   │   │   └── 否: 进入 EVALUATING
    │   │   └── 预算检查 (Constraints 层)
    │   │
    │   ├── [EVALUATING] 评估目标达成度
    │   │   ├── 目标达成 → REPORTING
    │   │   ├── 需要回溯 → 重新规划
    │   │   └── 预算耗尽 → 强制终止
    │   │
    │   └── [REPORTING] 生成最终响应
    │       ├── 质量评分 (Verification 层)
    │       └── 输出安全检查 (Constraints 层)
    │
    ├── 4. Persistence 层: 异步持久化
    │   ├── 对话历史保存
    │   ├── 知识提取 → 记忆存储
    │   ├── 用户画像更新
    │   └── 进化指标记录
    │
    └── 5. 返回 AgentResult
        ├── response: string
        ├── quality: QualityScore
        ├── trace: LoopTrace
        └── metadata: Record<string, unknown>
```

## 2.5 目标目录结构

```
src/
├── harness/                        # Harness 核心（新增）
│   ├── AgentHarness.ts             # 系统入口，六层组装 (~400行)
│   │
│   ├── loop/                       # Layer 1: 循环层
│   │   ├── LoopController.ts       # 状态机 + 循环控制 (~300行)
│   │   ├── Planner.ts              # 规划节点 (~200行)
│   │   ├── Executor.ts             # 执行节点 (~250行)
│   │   ├── Evaluator.ts            # 评估节点 (~200行)
│   │   ├── Reporter.ts             # 报告节点 (~150行)
│   │   └── types.ts                # 循环层类型定义 (~150行)
│   │
│   ├── tools/                      # Layer 2: 工具层
│   │   ├── registry/
│   │   │   ├── ToolRegistry.ts     # 工具注册表 (~300行)
│   │   │   ├── SchemaValidator.ts  # JSON Schema 验证 (~150行)
│   │   │   └── PermissionGuard.ts  # 权限守卫 (~200行)
│   │   ├── memory/                 # 记忆工具 (3文件, ~300行)
│   │   ├── file/                   # 文件工具 (5文件, ~590行)
│   │   ├── code/                   # 代码工具 (3文件, ~300行)
│   │   ├── desktop/                # 桌面工具 (2文件, ~230行)
│   │   ├── cognition/              # 认知工具 (3文件, ~240行)
│   │   └── system/                 # 系统工具 (3文件, ~280行)
│   │
│   ├── context/                    # Layer 3: 上下文层
│   │   ├── ContextManager.ts       # 上下文管理器 (~300行)
│   │   ├── ConstitutionalBuilder.ts # 宪法 Prompt 构建 (~250行)
│   │   ├── MemoryInjector.ts       # 记忆自动注入 (~150行)
│   │   ├── DynamicContext.ts       # 动态上下文(时间/场景) (~100行)
│   │   ├── TokenBudgetAllocator.ts # Token 预算分配 (~150行)
│   │   └── ContextCompressor.ts    # 上下文压缩 (~200行)
│   │
│   ├── persistence/                # Layer 4: 持久化层
│   │   ├── PersistenceService.ts   # 统一持久化服务 (~300行)
│   │   ├── ConversationStore.ts    # 对话存储 (~200行)
│   │   ├── TaskStateStore.ts       # 任务状态存储（新增）(~200行)
│   │   └── EvolutionStore.ts       # 进化指标存储 (~150行)
│   │
│   ├── verification/               # Layer 5: 验证层
│   │   ├── VerificationService.ts  # 验证服务 (~200行)
│   │   ├── ToolResultValidator.ts  # 工具结果验证 (~150行)
│   │   ├── OutputSafetyChecker.ts  # 输出安全检查 (~150行)
│   │   ├── QualityScorer.ts        # 质量评分 (~200行)
│   │   └── GoalEvaluator.ts        # 目标达成评估 (~150行)
│   │
│   └── constraints/                # Layer 6: 约束层
│       ├── ConstraintsService.ts   # 约束服务 (~250行)
│       ├── BudgetController.ts     # 预算控制 (~200行)
│       ├── PermissionManager.ts    # 权限管理 (~200行)
│       ├── SafetyBoundary.ts       # 安全边界 (~150行)
│       └── LifecycleHookManager.ts # 生命周期钩子 (~200行)
│
├── models/                         # 模型层（保留+增强）
│   ├── LLMProvider.ts              # LLM 接口 (~500行, 精简)
│   ├── ModelRouter.ts              # 模型路由（新增）(~300行)
│   └── OpenAICompatibleModel.ts    # OpenAI 兼容模型 (~400行)
│
├── memory/                         # 记忆层（保留+增强）
│   ├── MemoryEngine.ts             # 记忆引擎核心 (~600行, 精简)
│   ├── MemoryRetriever.ts          # 混合检索 (~300行)
│   ├── MemoryTracker.ts            # 验证+追踪 (~200行)
│   ├── VectorStore.ts              # 向量存储 (~200行)
│   └── UserProfile.ts              # 用户画像 (~400行)
│
├── scheduler/                      # 调度层（保留+增强）
│   ├── ProactiveScheduler.ts       # 主动调度器 (~400行)
│   ├── CronParser.ts               # Cron 解析 (~150行)
│   ├── TriggerEngine.ts            # 触发引擎 (~200行)
│   └── BehaviorAnalyzer.ts         # 行为分析 (~200行)
│
├── persona/                        # 人设层（保留）
│   ├── PersonaCore.ts              # 人格核心
│   └── PersonaRules.ts             # 人设规则
│
├── shared/                         # 共享模块（保留+增强）
│   ├── EventBus.ts                 # 事件总线
│   ├── Logger.ts                   # 日志
│   ├── types.ts                    # 共享类型
│   └── ConfigManager.ts            # 配置管理（新增）
│
├── gateway/                        # 网关层（从 server/ 精简）
│   ├── server.ts                   # Express + WS
│   ├── routes.ts                   # 路由
│   └── middleware.ts               # 中间件
│
├── desktop/                        # 桌面自动化（保留）
├── multimodal/                     # 多模态（保留）
├── security/                       # 安全（保留）
└── frontend/                       # 前端（保留）
```

## 2.6 三层→六层映射关系

**核心区别**: 三层是"先做什么再做什么"（时序划分），六层是"谁负责什么"（职责划分）。

| 三层 (v4.0) | 拆分到六层 (v5.0) | 说明 |
|---|---|---|
| **Layer 1 Preprocessor** 输入验证 | → **Constraints** 安全边界 | 输入安全检查是约束，不是预处理步骤 |
| **Layer 1 Preprocessor** 直接命令 | → **Loop** Planner 的简单路径 | 简单命令跳过规划直接执行 |
| **Layer 1 Preprocessor** 澄清提问 | → **Loop** Planner 的决策 | 澄清是规划的一部分 |
| **Layer 2 LLM Core** FC 循环 | → **Loop** 循环控制 | 循环是独立关注点 |
| **Layer 2 LLM Core** 工具调用 | → **Tools** 独立层 | 工具注册与执行是独立关注点 |
| **Layer 2 LLM Core** prompt 拼接 | → **Context** 独立层 | 上下文构建是独立关注点 |
| **Layer 2 LLM Core** 记忆注入 | → **Context** MemoryInjector | 记忆注入是上下文管理的一部分 |
| **Layer 2 LLM Core** 预算控制 | → **Constraints** BudgetController | 预算控制是约束，不是循环逻辑 |
| **Layer 2 LLM Core** 结果验证 | → **Verification** 独立层 | 验证是独立关注点 |
| **Layer 2 LLM Core** 质量评分 | → **Verification** QualityScorer | 质量评分是验证的一部分 |
| **Layer 3 Post** 对话持久化 | → **Persistence** 独立层 | 持久化是独立关注点 |
| **Layer 3 Post** 知识提取 | → **Persistence** + **Context** | 提取存入持久化，注入属于上下文 |
| **Layer 3 Post** 进化反馈 | → **Persistence** EvolutionStore | 进化指标是持久化的一部分 |

**一句话**: 三层把循环、工具、上下文、验证、约束全塞进 Layer 2，六层把它们各自独立出来，每层可独立演进、独立测试、独立替换。

## 2.7 与现有架构的关键差异

| 维度 | v4.0 (当前) | v5.0 (目标) |
|------|------------|------------|
| **核心循环** | FC 循环 (单层) | Plan-Execute-Evaluate 循环 (四阶段) |
| **规划能力** | 无显式规划，LLM 隐式分解 | Planner 节点显式生成 ExecutionPlan |
| **回溯机制** | 无，线性执行 | Evaluator 评估后可回溯重新规划 |
| **工具注册** | 集中式 InfrastructureToolRegistrar (966行) | 声明式 + 独立模块 + Schema 验证 |
| **工具权限** | 无分级 | 8 级权限 + 4 级风险等级 |
| **上下文管理** | 硬编码拼接 | 可组合管道 + Token 预算分配 |
| **压缩策略** | 保留最近 4 条 | 按优先级 + Token 预算智能压缩 |
| **持久化** | 分散在各模块 | 统一 PersistenceService |
| **跨会话任务** | 不支持 | TaskStateStore 支持任务暂停/恢复 |
| **验证** | 工具结果验证 + 质量评分 | 5 层验证 (参数/结果/安全/质量/目标) |
| **约束** | 预算控制 + 高风险拦截 | 5 重防御 + 生命周期钩子 |
| **God Class** | JiabaixingCore (1449行) | AgentHarness (400行) + 六层独立模块 |
| **类型安全** | 91 处 as unknown as | 0 处 (目标) |
| **同步 I/O** | 部分 fs.readFileSync | 全异步 |

---

# 第三部分：分阶段迁移方案

## Phase 1: 基础设施搭建 — Harness 骨架 + 工具层拆分

**目标**: 建立 Harness 目录结构和核心接口，将工具层从集中式注册拆分为独立模块。不改变现有流程，新旧并行。

### 1.1 创建 Harness 骨架

**新增文件**:

| 文件 | 内容 | 行数 |
|------|------|------|
| `src/harness/AgentHarness.ts` | 空壳类，暂时委托给 JiabaixingCore | ~50 |
| `src/harness/loop/types.ts` | LoopState, ExecutionPlan, PlanStep, BudgetState 等类型 | ~150 |
| `src/harness/tools/registry/ToolRegistry.ts` | 新版工具注册表（实现 IToolRegistry） | ~300 |
| `src/harness/tools/registry/SchemaValidator.ts` | JSON Schema 参数验证 | ~150 |
| `src/harness/tools/registry/PermissionGuard.ts` | 权限检查中间件 | ~200 |

**修改文件**:

| 文件 | 修改内容 |
|------|---------|
| `src/server/bootstrap.ts` | 在初始化流程中创建 AgentHarness 实例 |
| `src/main.ts` | 路由请求到 AgentHarness（可选，默认仍走 JiabaixingCore） |

### 1.2 拆分工具层

将 `InfrastructureToolRegistrar.ts` (966行) 中的 12 个工具拆分为独立文件：

| 原工具 | 新文件 | 行数 |
|--------|--------|------|
| memory_recall | `src/harness/tools/memory/memory_recall.ts` | ~100 |
| memory_store | `src/harness/tools/memory/memory_store.ts` | ~100 |
| emotion_detect | `src/harness/tools/cognition/emotion_detect.ts` | ~80 |
| analyze_scene | `src/harness/tools/cognition/scene_analyze.ts` | ~80 |
| self_reflect | `src/harness/tools/cognition/self_reflect.ts` | ~80 |
| desktop_automate | `src/harness/tools/desktop/desktop_automate.ts` | ~150 |
| ask_clarification | `src/harness/tools/system/ask_clarification.ts` | ~80 |
| preview_execution | `src/harness/tools/system/preview_execution.ts` | ~100 |
| get_active_file | `src/harness/tools/file/file_read.ts` (合并) | ~80 |
| incremental_edit | `src/harness/tools/file/file_edit.ts` | ~150 |
| rollback_changes | `src/harness/tools/system/rollback_changes.ts` | ~100 |
| multi_file_edit | `src/harness/tools/file/multi_file_edit.ts` | ~200 |

**迁移策略**: 新工具文件同时注册到新旧两个注册表（SkillRegistry + ToolRegistry），确保兼容性。

### 1.3 验收标准

- [ ] `npm run build:fast` 通过
- [ ] `npm test` 通过
- [ ] 新 Harness 目录结构已创建
- [ ] 12 个工具已拆分为独立文件
- [ ] 新旧注册表双写，功能不退化
- [ ] InfrastructureToolRegistrar.ts 行数 < 200 (仅保留注册编排逻辑)

---

## Phase 2: 循环层 + 上下文层 — Plan-Execute-Evaluate 循环

**目标**: 实现 LoopController 状态机和 ContextManager，替换现有的 FC 循环。

### 2.1 实现循环层

**新增文件**:

| 文件 | 内容 | 行数 |
|------|------|------|
| `src/harness/loop/LoopController.ts` | 状态机 + 循环控制 | ~300 |
| `src/harness/loop/Planner.ts` | 规划节点（简单任务跳过规划） | ~200 |
| `src/harness/loop/Executor.ts` | 执行节点（FC 循环核心） | ~250 |
| `src/harness/loop/Evaluator.ts` | 评估节点（目标达成度 + 回溯决策） | ~200 |
| `src/harness/loop/Reporter.ts` | 报告节点（响应生成 + 质量评分） | ~150 |

**关键设计决策**:

- **Planner 何时激活**: 当 LLM 判断任务需要 3+ 步骤时激活规划，简单问答跳过
- **Evaluator 回溯条件**: 工具执行失败且重试次数耗尽，或 LLM 判断当前路径无法达成目标
- **与现有 FC 循环的关系**: Executor 节点内部复用现有 FC 循环逻辑，但由 LoopController 控制循环的启动和终止

**迁移步骤**:

1. 实现 LoopController 状态机
2. 实现 Executor 节点（从 JiabaixingCore.executeFCLoop 提取逻辑）
3. 实现 Planner 节点（新增规划能力）
4. 实现 Evaluator 节点（从 FCLoopHelper.computeQualityScore 增强）
5. 实现 Reporter 节点
6. 在 AgentHarness 中组装循环层
7. 添加功能开关：`USE_HARNESS_LOOP=true` 切换新旧循环

### 2.2 实现上下文层

**新增文件**:

| 文件 | 内容 | 行数 |
|------|------|------|
| `src/harness/context/ContextManager.ts` | 上下文管理器 | ~300 |
| `src/harness/context/ConstitutionalBuilder.ts` | 从 ConstitutionPromptBuilder 迁移 | ~250 |
| `src/harness/context/MemoryInjector.ts` | 从 MemoryAssistant.autoRetrieveMemories 迁移 | ~150 |
| `src/harness/context/DynamicContext.ts` | 动态上下文（时间/场景） | ~100 |
| `src/harness/context/TokenBudgetAllocator.ts` | Token 预算分配 | ~150 |
| `src/harness/context/ContextCompressor.ts` | 从 FCLoopHelper.compressFCMessages 增强 | ~200 |

**关键设计决策**:

- **Token 预算分配**: 按固定比例分配（system 30%, memory 15%, history 25%, dynamic 15%, tools 15%, reserve 10%）
- **压缩策略**: 按优先级压缩，低优先级的条目先被截断或摘要
- **与现有 Context 构建的关系**: ContextManager 替代 JiabaixingCore 中的硬编码 prompt 拼接

### 2.3 验收标准

- [ ] `npm run build:fast` 通过
- [ ] `npm test` 通过
- [ ] LoopController 状态机可运行
- [ ] Plan-Execute-Evaluate 循环可完成简单任务
- [ ] ContextManager 可构建上下文
- [ ] Token 预算分配正常工作
- [ ] 功能开关可切换新旧循环
- [ ] 新循环通过现有集成测试

---

## Phase 3: 验证层 + 约束层 — 5 重防御体系

**目标**: 实现多层验证和约束框架，增强系统安全性和可靠性。

### 3.1 实现验证层

**新增文件**:

| 文件 | 内容 | 行数 |
|------|------|------|
| `src/harness/verification/VerificationService.ts` | 验证服务入口 | ~200 |
| `src/harness/verification/ToolResultValidator.ts` | 从 FCLoopHelper.validateToolResult 增强 | ~150 |
| `src/harness/verification/OutputSafetyChecker.ts` | 输出安全检查 | ~150 |
| `src/harness/verification/QualityScorer.ts` | 从 FCLoopHelper.computeQualityScore 增强 | ~200 |
| `src/harness/verification/GoalEvaluator.ts` | 目标达成评估（新增） | ~150 |

**增强点**:

- **ToolResultValidator**: 增加前置条件检查（参数类型验证）和后置条件验证（结果格式验证）
- **QualityScorer**: 增加任务复杂度因子、工具选择合理性评估
- **GoalEvaluator**: 新增，评估当前输出是否达成用户原始目标

### 3.2 实现约束层

**新增文件**:

| 文件 | 内容 | 行数 |
|------|------|------|
| `src/harness/constraints/ConstraintsService.ts` | 约束服务入口 | ~250 |
| `src/harness/constraints/BudgetController.ts` | 从现有预算控制增强 | ~200 |
| `src/harness/constraints/PermissionManager.ts` | 权限管理（新增） | ~200 |
| `src/harness/constraints/SafetyBoundary.ts` | 从 SecurityChecker 增强 | ~150 |
| `src/harness/constraints/LifecycleHookManager.ts` | 生命周期钩子（新增） | ~200 |

**5 重防御实现**:

| 防御层 | 实现 | 对应现有代码 |
|--------|------|-------------|
| Prompt Guardrails | ConstitutionalBuilder 中的禁止行为 | ConstitutionPromptBuilder ✅ |
| Schema Constraints | SchemaValidator + ToolRegistry | 无 ❌ → 新增 |
| Runtime Approval | PermissionGuard + preview_execution | preview_execution ✅ → 增强 |
| Tool Verification | ToolResultValidator | FCLoopHelper.validateToolResult ✅ → 增强 |
| Lifecycle Hooks | LifecycleHookManager | 无 ❌ → 新增 |

### 3.3 验收标准

- [ ] `npm run build:fast` 通过
- [ ] `npm test` 通过
- [ ] 5 重防御全部可工作
- [ ] 工具参数 Schema 验证生效
- [ ] 权限分级检查生效
- [ ] 生命周期钩子可注册和触发
- [ ] 高风险操作被正确拦截

---

## Phase 4: 持久化层统一 + 跨会话任务

**目标**: 统一持久化接口，新增跨会话任务状态管理。

### 4.1 统一持久化服务

**新增文件**:

| 文件 | 内容 | 行数 |
|------|------|------|
| `src/harness/persistence/PersistenceService.ts` | 统一持久化入口 | ~300 |
| `src/harness/persistence/ConversationStore.ts` | 从 ConversationHistoryManager 迁移 | ~200 |
| `src/harness/persistence/TaskStateStore.ts` | 跨会话任务状态（新增） | ~200 |
| `src/harness/persistence/EvolutionStore.ts` | 从 EvolutionOrchestrator 提取 | ~150 |

### 4.2 跨会话任务支持

**新增能力**:

- 任务创建: 用户可创建长期任务（如"每天早上提醒我喝水"）
- 任务暂停/恢复: LoopController 可暂停执行中的任务，下次会话恢复
- 任务状态查询: 通过 API 查询活跃任务列表
- 任务取消: 用户可随时取消任务

**新增 API**:

```
POST /api/tasks/create       # 创建跨会话任务
GET  /api/tasks/list         # 查询活跃任务
POST /api/tasks/:id/cancel   # 取消任务
POST /api/tasks/:id/pause    # 暂停任务
POST /api/tasks/:id/resume   # 恢复任务
```

### 4.3 验收标准

- [ ] `npm run build:fast` 通过
- [ ] `npm test` 通过
- [ ] PersistenceService 统一接口可工作
- [ ] 跨会话任务可创建、暂停、恢复、取消
- [ ] 任务恢复时上下文正确注入
- [ ] 现有持久化功能不退化

---

## Phase 5: AgentHarness 完整集成 + 旧代码清理

**目标**: 将 AgentHarness 作为系统唯一入口，清理旧代码。

### 5.1 AgentHarness 完整集成

**修改文件**:

| 文件 | 修改内容 |
|------|---------|
| `src/harness/AgentHarness.ts` | 完整实现六层组装，替换 JiabaixingCore |
| `src/server/bootstrap.ts` | 初始化 AgentHarness 而非 JiabaixingCore |
| `src/main.ts` | 路由全部请求到 AgentHarness |
| `src/gateway/routes.ts` | 新增任务管理 API 路由 |

### 5.2 旧代码清理

**可删除的文件/模块**:

| 文件 | 行数 | 原因 |
|------|------|------|
| `src/core/JiabaixingCore.ts` | 1449 | 被 AgentHarness 替代 |
| `src/core/InfrastructureToolRegistrar.ts` | 966 | 工具已拆分到 harness/tools/ |
| `src/core/FCLoopHelper.ts` | 265 | 逻辑已迁移到 loop/ + verification/ |
| `src/core/ConstitutionPromptBuilder.ts` | 309 | 逻辑已迁移到 context/ConstitutionalBuilder.ts |
| `src/core/MemoryAssistant.ts` | 214 | 逻辑已迁移到 context/MemoryInjector.ts + persistence/ |
| `src/core/DirectExecutor.ts` | 349 | 逻辑已迁移到 loop/Planner.ts |
| `src/core/SceneAnalyzer.ts` | 176 | 逻辑已迁移到 tools/cognition/ |
| `src/core/ProactiveMessageGenerator.ts` | 360 | 逻辑已迁移到 scheduler/ |
| `src/core/FileEditManager.ts` | ~300 | 逻辑已迁移到 tools/file/ |
| `src/core/ExecutionTracer.ts` | ~200 | 逻辑已迁移到 LoopController.trace |
| `src/core/SecurityChecker.ts` | ~200 | 逻辑已迁移到 constraints/ |
| `src/core/ToolResultAggregator.ts` | ~150 | 逻辑已迁移到 verification/ |
| `src/core/OptimizationScheduler.ts` | ~300 | 逻辑已迁移到 scheduler/ |

**预计删除**: ~5,238 行旧代码

### 5.3 类型安全修复

| 修复项 | 当前 | 目标 |
|--------|------|------|
| `as unknown as` 断言 | 91 处 | 0 处 |
| 动态 `require()` | 33 处 | 0 处 |
| `.substr()` | 60 处 | 0 处 |
| `console.log/error` | ~80 处 | 0 处 |
| 同步文件 I/O | 部分 | 全异步 |

### 5.4 验收标准

- [ ] `npm run build:fast` 通过
- [ ] `npm test` 100% 通过
- [ ] AgentHarness 是系统唯一入口
- [ ] JiabaixingCore 及其委托模块已删除
- [ ] 0 处 `as unknown as`（核心模块）
- [ ] 0 处动态 `require()`
- [ ] 0 处 `.substr()`
- [ ] 所有文件 < 500 行
- [ ] 端到端测试通过：对话 → 工具调用 → 主动消息 → 跨会话任务
- [ ] CLAUDE.md 更新

---

# 第四部分：风险评估与应对

## 4.1 技术风险

| 风险 | 概率 | 影响 | 应对策略 |
|------|------|------|---------|
| Plan-Execute-Evaluate 循环增加延迟 | 高 | 中 | 简单任务跳过规划，直接进入执行；规划超时自动降级到 FC 循环 |
| 本地 3B 模型规划能力不足 | 高 | 高 | 规划任务路由到云端模型；规划结果简化为步骤列表而非复杂 DAG |
| 工具拆分引入新 Bug | 中 | 中 | 双注册阶段确保兼容；每个工具独立测试 |
| 跨会话任务状态恢复失败 | 中 | 高 | 任务状态持久化到 SQLite；恢复失败时重新规划 |
| 迁移期间新旧系统冲突 | 中 | 中 | 功能开关控制；渐进式切换；保留回退路径 |

## 4.2 兼容性风险

| 风险 | 影响 | 缓解策略 |
|------|------|---------|
| API 接口变更 | 前端需要适配 | 保持现有 API 不变，新增 /api/tasks/* 路由 |
| Skill 接口变更 | 现有 28 个技能需要适配 | 提供适配器包装旧 Skill 为新 ToolDefinition |
| EventBus 事件变更 | 跨模块通信受影响 | 新增事件类型，不修改现有事件 |
| 配置格式变更 | 部署配置需要更新 | 向后兼容，新配置项有默认值 |

## 4.3 回退策略

每个 Phase 都有独立的功能开关，可以随时回退到旧实现：

```typescript
// 配置开关
const HARNESS_CONFIG = {
  USE_HARNESS_LOOP: false,      // Phase 2: 使用新循环层
  USE_HARNESS_CONTEXT: false,   // Phase 2: 使用新上下文层
  USE_HARNESS_TOOLS: false,     // Phase 1: 使用新工具层
  USE_HARNESS_VERIFICATION: false, // Phase 3: 使用新验证层
  USE_HARNESS_CONSTRAINTS: false,  // Phase 3: 使用新约束层
  USE_HARNESS_PERSISTENCE: false,  // Phase 4: 使用新持久化层
};
```

---

# 第五部分：质量保障

## 5.1 代码质量门禁

```bash
# 每次提交前必须通过
npm run build:fast     # TypeScript 编译
npm run lint           # ESLint 检查
npm run format:check   # Prettier 检查
npm test               # 测试套件
```

## 5.2 验收指标

| 指标 | 当前值 (v4.0) | 目标值 (v5.0) |
|------|--------------|--------------|
| 总代码行数 | ~146,000 | < 120,000 |
| 超 500 行文件数 | 69 | 0 |
| 超 1000 行文件数 | 15 | 0 |
| `as unknown as` 数量 | 91 | 0 (核心模块) |
| 动态 require 数量 | 33 | 0 |
| `.substr()` 数量 | 60 | 0 |
| 测试通过率 | ~79% | 100% |
| 构建状态 | 通过 | 通过 |
| Harness 六层覆盖率 | 0% | 100% |
| 跨会话任务支持 | 无 | 有 |
| 工具权限分级 | 无 | 8 级权限 + 4 级风险 |

## 5.3 测试策略

| Phase | 测试类型 | 覆盖目标 | 通过标准 |
|-------|---------|---------|---------|
| Phase 1 | 单元测试 | 新工具模块 + ToolRegistry | 100% 通过 |
| Phase 2 | 单元+集成 | LoopController + ContextManager | 100% 通过 |
| Phase 3 | 单元+集成 | VerificationService + ConstraintsService | 100% 通过 |
| Phase 4 | 单元+集成+e2e | PersistenceService + 跨会话任务 | 100% 通过 |
| Phase 5 | 全量测试 | 端到端 + 回归 | 100% 通过 |

---

**文档版本**: 1.0
**编写日期**: 2026-05-23
**适用范围**: Jiabaixing v4.0 → v5.0 基于 Harness Agent Framework 架构升级
