# 家百星 (Jiabaixing) 顶层开发设计文档

> **版本**: 1.2
> **日期**: 2026-06-22
> **定位**: Agent 演化路线图 × 系统架构 × 阶段增强计划
> **源码规模**: ~340 个 .ts 文件，~130 个 Manager/Service/Engine 类

---

## 一、Agent 演化阶段与项目定位

### 1.1 行业演化框架

| 阶段              | 特征                   | 代表          | 时间      | 家百星状态                      |
| ----------------- | ---------------------- | ------------- | --------- | ------------------------------- |
| **1. 工具调用**   | 单步、单工具、被动     | Function Call | 2023      | ✅ 已超越                       |
| **2. 任务执行**   | 多步、多工具、简单规划 | AutoGPT       | 2023-现在 | ✅ 已具备，增强已完成           |
| **3. 自主规划**   | 长任务、反思、纠错     | Devin、Cline  | 2024-现在 | 🔧 部分具备，需增强             |
| **4. 环境自适应** | 感知、学习、进化       | 进行中        | 2025-2026 | 🔧 基础框架已有，核心能力待完善 |
| **5. 社会协作**   | 多Agent、分工、协商    | 未来          | 2027+     | 🔧 基础已实现，待增强           |

### 1.2 项目当前所处阶段

家百星当前处于 **阶段3 的深化期**（阶段2增强已全部完成），阶段4的基础框架已搭建但核心闭环尚未打通：

```
阶段2 ✅                    阶段3 🔧                   阶段4 🔧
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ 多步执行      │     │ 长任务规划    │     │ 环境感知      │
│ 多工具编排    │ ──→ │ 反思纠错      │ ──→ │ 学习进化      │
│ DAG+数据流    │     │ 自主决策      │     │ 自我修改      │
│ LLM深度规划   │     │ 根因分析+重规划│     │ 进化闭环      │
│ 实时进度追踪  │     │ 计划验证+监控  │     │ 环境建模      │
└──────────────┘     └──────────────┘     └──────────────┘
  ✅ 增强已完成        部分具备，需增强       框架已有，待完善
```

---

## 二、系统架构全景

### 2.1 六层 Harness 架构（核心执行引擎）

```
用户输入 → JiabaixingCore.processInput()
  → ContextManager.buildContext()              [C层 - Context]
  → ConstraintsService.executeHooks()          [L层 - Constraints]
  → LoopController.run()
      → Planner.plan()                          [E层 - Plan]
      → Executor.execute() → ToolRegistry       [E+T层 - Execute]
      → Evaluator.evaluate()                    [E+V层 - Evaluate]
      → Reporter.report()                       [E层 - Report]
  → PersistenceService.record()                [S层 - Persistence]
  → EventBus.emit('response_ready')
```

### 2.2 模块地图与演化阶段映射

```
src/
├── core/ (13 文件)                      ← 中央编排
│   ├── JiabaixingCore.ts               ← 核心引擎（阶段1-2）
│   ├── ScenarioAwareScheduler.ts        ← 场景调度（阶段3）
│   ├── DAGTask.ts                       ← DAG任务图（阶段3）
│   ├── TaskComplexityAnalyzer.ts        ← 复杂度分析（阶段2-3）
│   ├── DynamicTaskAdjuster.ts           ← 动态调整（阶段3）
│   └── UnifiedContextPipeline.ts        ← 上下文管道（阶段2）
│
├── harness/ (100+ 文件)                 ← 六层管控 (E-T-C-S-L-V)
│   ├── AgentHarness.ts                  ← 总控（阶段2）
│   ├── loop/ (9 文件)                   ← PEE循环（阶段2-3）
│   │   ├── LoopController.ts           ← 循环控制器（阶段2）
│   │   ├── Planner.ts                  ← 规划器（阶段2-3）
│   │   ├── Executor.ts                 ← 执行器（阶段2）
│   │   ├── Evaluator.ts               ← 评估器（阶段3）
│   │   ├── RetryExecutor.ts           ← 重试执行器（阶段3）
│   │   ├── ContextCompressor.ts       ← 上下文压缩（阶段2）
│   │   └── AutonomousTrigger.ts       ← 自主触发器（阶段4）
│   ├── tools/ (50+ 文件)               ← 工具层（阶段1-2）
│   │   ├── registry/ (6 文件)          ← 注册/权限/校验/MCP桥
│   │   └── {code,cognition,daily,desktop,
│   │         file,memory,network,system}/ ← 8类工具
│   ├── orchestration/ (5 文件)         ← 多Agent编排（阶段5预留）
│   │   ├── OrchestratorAgent.ts        ← 顶层协调Agent
│   │   ├── SubAgentFanout.ts           ← 子Agent扇出
│   │   └── AgentRegistry.ts            ← Agent注册中心
│   ├── evaluation/ (11 文件)           ← 评估子系统（阶段3）
│   ├── verification/                    ← 验证层（阶段3）
│   ├── persistence/                     ← 持久化层（阶段2-3）
│   ├── sandbox/                         ← 沙箱（阶段3）
│   └── constraints/                     ← 约束层（阶段2）
│
├── memory/ (29 文件)                    ← 记忆系统（阶段4）
│   ├── MemoryEngine.ts                 ← 三层记忆引擎
│   ├── KnowledgeGraphBuilder.ts         ← 知识图谱+推理
│   ├── UserProfile.ts                  ← 用户画像
│   ├── SemanticSimilarityEngine.ts      ← 语义相似度
│   └── {ShortTerm,LongTerm}Memory.ts   ← 短期/长期记忆
│
├── evolution/ (17 文件)               ← 进化引擎（阶段4）
│   ├── v2/EvolutionEngineV2.ts         ← 进化引擎V2
│   ├── v2/EvolutionPlanner.ts          ← 进化规划
│   ├── v2/SelfModificationEngine.ts    ← 自我修改+安全边界
│   ├── v2/EvolutionRollback.ts         ← 进化回滚
│   ├── EvolutionOrchestrator.ts        ← 进化编排器
│   ├── FeedbackCollector.ts            ← 反馈收集
│   └── SkillUsageTracker.ts            ← 技能追踪
│
├── desktop/ (17 文件)                 ← 桌面自动化（阶段4）
│   ├── DesktopAgentLoop.ts             ← 桌面智能体循环
│   ├── DesktopDecisionEngine.ts        ← Q-Learning决策引擎
│   ├── DesktopVisionEngine.ts          ← 视觉理解
│   └── ApprovalGate.ts                ← 人工确认门控
│
├── models/ (14 文件)                    ← LLM 模型层（阶段1-2）
├── server/ (50+ 文件)                  ← HTTP/WS 服务
├── security/ (12 文件)                 ← 安全
├── integration/ (15 文件)             ← 即时通讯适配器
├── interaction/ (5 文件)              ← 交互引擎
├── multimodal/ (6 文件)               ← 多模态（阶段4）
├── user/ (4 文件)                     ← 用户演化（阶段4）
└── shared/ (5 文件)                   ← 共享基础设施
```

### 2.3 数据流闭环

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户输入                                  │
│                           │                                     │
│                    JiabaixingCore                               │
│                    .processInput()                              │
│                           │                                     │
│              ┌────────────┼────────────┐                       │
│              ▼            ▼            ▼                       │
│         Context层    Constraints层   Memory检索                 │
│              │            │            │                       │
│              └────────────┼────────────┘                       │
│                           ▼                                     │
│                    LoopController                               │
│              ┌────────────┼────────────┐                       │
│              ▼            ▼            ▼                       │
│          Planner      Executor     Evaluator                   │
│           规划         执行          评估                       │
│              │            │            │                       │
│              │     ┌──────┴──────┐     │                       │
│              │     ▼             ▼     │                       │
│              │  ToolRegistry  Sandbox  │                       │
│              │  (50+工具)     (沙箱)   │                       │
│              │     │             │     │                       │
│              └─────┼─────────────┼─────┘                       │
│                    ▼             ▼                              │
│              Reporter      Persistence                         │
│               报告           持久化                             │
│                    │             │                              │
│                    ▼             ▼                              │
│              用户输出      EvolutionOrchestrator                │
│                              │                                  │
│                    ┌─────────┼─────────┐                       │
│                    ▼         ▼         ▼                       │
│              Feedback    Strategy    Knowledge                  │
│              Collector   Optimizer   Graph                      │
│              反馈收集    策略优化    知识图谱                     │
│                    │         │         │                        │
│                    └─────────┼─────────┘                       │
│                              ▼                                  │
│                    自我进化闭环                                  │
│                    (阶段4核心)                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、各阶段能力现状评估

### 3.1 阶段1：工具调用 ✅ 已超越

| 能力           | 状态    | 实现位置                           |
| -------------- | ------- | ---------------------------------- |
| 单步工具调用   | ✅ 完成 | `ToolRegistry`, `Executor`         |
| 工具Schema校验 | ✅ 完成 | `SchemaValidator`                  |
| 工具权限控制   | ✅ 完成 | `PermissionGuard`, `ToolCallGuard` |
| MCP桥接        | ✅ 完成 | `MCPToolBridge`                    |

**已注册工具清单（8类50+）**：

| 类别 | 工具                                                                                                                                                                     | 数量 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 记忆 | memory_recall, memory_search, memory_store, knowledge_query                                                                                                              | 4    |
| 认知 | emotion_detect, scene_analyze, self_reflect                                                                                                                              | 3    |
| 文件 | file_list, file_read, file_search, file_grep, file_dedup, get_active_file, incremental_edit, multi_file_edit                                                             | 8    |
| 代码 | code_analyze, code_fix, code_generate, code_review, code_review_project, csv_analyze                                                                                     | 6    |
| 日常 | task_manage, calendar, reminder_set, note_take, batch_task, daily_report, morning_brief, natural_schedule, system_status, task_analytics, task_dependency, task_priority | 12   |
| 桌面 | desktop_screenshot, desktop_automate                                                                                                                                     | 2    |
| 网络 | web_search, web_fetch, browser_agent, image_generate, chart_generate, tts_speak, message_push, skill_create                                                              | 8    |
| 系统 | shell_exec, shell_generate, execute_code, ask_clarification, context_manage, delegate_task, preview_execution, rollback_changes, log_view, log_clean, voice_interact     | 11   |

### 3.2 阶段2：任务执行 ✅ 已具备（增强已完成）

| 能力             | 状态    | 实现位置                                                                                                       | 增强需求  |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| 多步执行循环     | ✅ 完成 | `LoopController` PEE循环                                                                                       | -         |
| 多工具编排       | ✅ 完成 | `Executor.chatWithTools()`                                                                                     | -         |
| 简单任务规划     | ✅ 完成 | `Planner` 正则+LLM双模式                                                                                       | 🔶 需增强 |
| 上下文管理       | ✅ 完成 | `ContextManager`, `TokenBudgetAllocator`                                                                       | -         |
| 上下文压缩       | ✅ 完成 | `ContextCompressor` 4级压缩                                                                                    | -         |
| 复杂度分析       | ✅ 完成 | `TaskComplexityAnalyzer`                                                                                       | 🔶 需增强 |
| 预算控制         | ✅ 完成 | `BudgetState` 轮次/Token/时间/工具调用                                                                         | -         |
| 持久化           | ✅ 完成 | `PersistenceService`, `TrajectoryDatabase`                                                                     | -         |
| 工具重试         | ✅ 完成 | `RetryExecutor` 分类重试                                                                                       | -         |
| **工具执行韧性** | ⚠️ 部分 | `Executor` L1✅指数退避重试 / L2⚠️规则化参数修正(死代码) / L3❌LLM辅助修正(未实现) / L4⚠️降级替代(死代码)      | 🔴 需修复 |
| 批处理           | ✅ 完成 | `BatchProcessor`                                                                                               | -         |
| **任务依赖图**   | ✅ 完成 | `LoopController.buildDAGFromPlan()` 拓扑排序+并行调度                                                          | -         |
| **任务并行执行** | ✅ 完成 | `LoopController.executeWithDAG()` 基于 `dependencies: Map<string, string[]>` + `executionMode: 'dag'`          | -         |
| **中间结果传递** | ✅ 完成 | `LoopContext.stepOutputs` + `dataFlowChannels` + `crossStepState`，`LoopController.resolveStepInputBindings()` | -         |

### 3.3 阶段3：自主规划 🔧 部分具备，需增强

| 能力                             | 状态      | 实现位置                                                                                                             | 增强需求      |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| 长任务分解                       | 🔶 部分   | `Planner` + `TaskComplexityAnalyzer`                                                                                 | 🔴 需增强     |
| 反思评估                         | ✅ 完成   | `IndependentEvaluationService`                                                                                       | -             |
| **反思引擎**                     | ⚠️ 死代码 | `ReflectionEngine` 三层反思代码完整，但从未被import/实例化/注入到LoopController                                      | 🔴 需修复集成 |
| **反思结论注入Thought**          | ⚠️ 死代码 | `LoopController._lastReflectionInsight` + `buildThoughtPrompt()` — 依赖reflectionEngine注入                          | 🔴 需修复集成 |
| 纠错重规划                       | ✅ 完成   | `Evaluator.suggestedAction='replan'` + `LoopController.analyzeRootCause()` + `generateReplanStrategy()`              | -             |
| 输出Guardrail                    | ✅ 完成   | `OutputGuardrailEngine`                                                                                              | -             |
| 检查点回滚                       | ✅ 完成   | `CheckpointService`, `EvolutionRollback`                                                                             | -             |
| 沙箱执行                         | ✅ 完成   | `SandboxExecutor`                                                                                                    | -             |
| 辩论验证                         | ✅ 完成   | `DefaultDebater`                                                                                                     | -             |
| 安全边界                         | ✅ 完成   | `SelfModificationEngine` 安全边界                                                                                    | -             |
| **计划验证**                     | ✅ 完成   | `LoopController.validatePlan()` 检查工具可用性/依赖缺失/循环依赖/预算/并行冲突                                       | -             |
| **执行监控**                     | ✅ 完成   | `LoopController.ExecutionProgress` + `onStepStarted/onStepCompleted` + `estimateTimeRemaining` + `detectBottlenecks` | -             |
| **自适应重规划**                 | ✅ 完成   | `LoopController.analyzeRootCause()` + `generateReplanStrategy()`，`RootCauseAnalysis` 类型                           | -             |
| **跨步骤状态管理**               | ✅ 完成   | `LoopContext.stepOutputs` + `dataFlowChannels` + `crossStepState`                                                    | -             |
| **Plan-Battle-Execute 辩论验证** | ✅ 完成   | `DefaultDebater` Plan-Battle-Execute 辩论验证模式                                                                    | -             |
| **Fast Path 快速路径**           | ✅ 完成   | 中等复杂度任务跳过 Planner LLM 调用，直接执行                                                                        | -             |
| **多Agent协调**                  | ✅ 完成   | `OrchestratorAgent` 复杂任务多Agent协调                                                                              | 🔶 需增强     |
| **并行组执行**                   | ✅ 完成   | 基于 `parallelGroup` 的并行执行                                                                                      | -             |
| **步骤级动态调整**               | ⚠️ 死代码 | `Executor.shouldReplan()` + `suggestStepAdjustment()` — 方法存在但从未被调用                                         | 🔴 需修复集成 |

### 3.4 阶段4：环境自适应 🔧 框架已有，待完善

| 能力                 | 状态    | 实现位置                                                                                                                | 增强需求      |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| 情绪感知             | ✅ 完成 | `FeedbackCollector.detectEmotionShift()`                                                                                | -             |
| 场景识别             | ✅ 完成 | `scene_analyze` 工具                                                                                                    | -             |
| 知识图谱             | ✅ 完成 | `KnowledgeGraphBuilder`                                                                                                 | 🔶 需增强推理 |
| 用户画像             | ✅ 完成 | `UserProfile` 5维度                                                                                                     | -             |
| 技能学习             | ✅ 完成 | `SkillUsageTracker`, `EvolutionEngineV2.learnFromFewShots()`                                                            | -             |
| 策略优化             | ✅ 完成 | `StrategyOptimizer`                                                                                                     | -             |
| 自主触发             | ✅ 完成 | `AutonomousTrigger` 3种模式                                                                                             | 🔶 需增强     |
| 进化引擎             | ✅ 完成 | `EvolutionEngineV2` + `EvolutionOrchestrator`                                                                           | 🔶 需增强     |
| **进化学习闭环集成** | ✅ 完成 | `EvolutionOrchestrator` 协调 FeedbackCollector/StrategyOptimizer/KnowledgeGraphBuilder                                  | 🔶 需增强     |
| 桌面感知             | ✅ 完成 | `DesktopVisionEngine`, `DesktopDecisionEngine`                                                                          | -             |
| **记忆系统增强**     | ⚠️ 孤立 | `TrajectoryDatabase` 余弦相似度+向量语义检索已实现，`querySimilarTasks`被调用；但`SemanticSimilarityEngine`从未被import | 🔶 需集成     |
| **语义相似度引擎**   | ⚠️ 孤立 | `SemanticSimilarityEngine` 代码完整但从未被任何模块import或使用                                                         | 🔴 需集成     |
| **学习信号管道**     | ⚠️ 半通 | `LearningSignalCollector` 收集信号✅，`eventBus.emit('learning_signal')`发射✅，但无订阅者消费                          | 🔴 需修复     |
| **策略自适应**       | ✅ 完成 | `StrategyAdjuster` recordSignal(6处调用) + getAdjustedToolPriority/getAdjustedReflectionConfig(2处消费)                 | -             |
| **上下文主动检索**   | ✅ 完成 | `ContextManager.activelyRetrieveContext()` + `focusByAttention()` 注意力聚焦                                            | -             |
| **学习闭环**         | ✅ 基础 | `LearningSignalCollector` + `StrategyAdjuster` + Executor集成，信号管道已打通                                           | 🔶 需增强     |
| **环境建模**         | ❌ 缺失 | 无持久化环境状态模型                                                                                                    | 🔴 需实现     |
| **预测能力**         | ❌ 缺失 | `predictNextAction` 精度不足                                                                                            | 🔴 需增强     |

### 3.5 阶段5：社会协作 🔧 基础已实现，待增强

| 能力             | 状态    | 实现位置                                                        | 增强需求  |
| ---------------- | ------- | --------------------------------------------------------------- | --------- |
| Agent注册        | ✅ 完成 | `AgentRegistry`                                                 | -         |
| 任务分发         | ✅ 完成 | `TaskDispatcher`                                                | -         |
| 结果聚合         | ✅ 完成 | `ResultAggregator`                                              | -         |
| 子Agent扇出      | ✅ 完成 | `SubAgentFanout` 3种策略                                        | -         |
| 协调Agent        | ✅ 完成 | `OrchestratorAgent`                                             | 🔶 需增强 |
| **Agent协商**    | ✅ 基础 | `AgentRegistry.startNegotiation/sendNegotiationMessage`         | 🔶 需增强 |
| **任务竞标**     | ✅ 基础 | `AgentRegistry.publishBidding/evaluateBids`                     | 🔶 需增强 |
| **共享知识**     | ✅ 基础 | `AgentRegistry.publishKnowledge/queryKnowledge`                 | 🔶 需增强 |
| **结构化通信**   | ✅ 基础 | `AgentRegistry.registerMessageHandler/broadcastMessage`         | 🔶 需增强 |
| **冲突检测**     | ✅ 基础 | `ResultAggregator.detectConflicts`（file_write + goal_overlap） | 🔶 需增强 |
| **LLM仲裁**      | ✅ 基础 | `ResultAggregator.resolveConflictsWithLLM`                      | 🔶 需增强 |
| **置信度合并**   | ✅ 基础 | `ResultAggregator.mergeWithConsensus`                           | 🔶 需增强 |
| **动态角色分配** | ✅ 基础 | `OrchestratorAgent.assignDynamicRoles/rebalanceRoles`           | 🔶 需增强 |
| **角色专业化**   | ❌ 缺失 | 无自动专业化机制                                                | 📐 未来   |

> **架构说明**: 阶段5的基础能力已集成到 `AgentRegistry`（协商/竞标/知识/通信）和 `ResultAggregator`（冲突/仲裁/合并）中。当前为内存级实现，满足单进程多Agent协作。未来增强方向：(1) 拆分为独立微服务 (2) 持久化知识库 (3) 跨进程Agent通信 (4) 角色自演化

---

## 四、阶段2增强计划：任务执行能力提升 ✅ 已全部实现

### 4.1 增强目标

将家百星从"简单多步执行"提升到"结构化任务执行"，核心增强点：

```
当前（阶段2基础）              目标（阶段2增强）
┌──────────────────┐     ┌──────────────────┐
│ 顺序执行步骤      │     │ DAG依赖图执行     │
│ 步骤间无数据流    │ ──→ │ 步骤间结构化传递   │
│ 无并行能力        │     │ 可并行步骤并行执行  │
│ 简单正则规划      │     │ LLM深度规划+验证   │
│ 无中间状态追踪    │     │ 实时进度+状态追踪   │
└──────────────────┘     └──────────────────┘
```

### 4.2 增强项 E2-1：DAG任务依赖图执行 ✅ 已实现

> **实现状态**: ✅ 已实现（2026-06-15 确认）
>
> **接口差异说明**: 文档提议 `ExecutionPlan.dag?: DAGNode[]`，实际实现为 `ExecutionPlan.dependencies: Map<string, string[]>` + `executionMode: 'sequential' | 'dag'`。dependencies 天然表达 DAG 边关系，无需额外 DAGNode 结构。

**现状问题**：`DAGTask` 已定义类型但未集成到 `LoopController`，任务只能顺序执行。

**增强方案**：将 `DAGTask` 集成到 `LoopController` 的执行路径中。

**实现路径**（修改现有文件，不创建新文件）：

```
修改文件:
  src/core/DAGTask.ts              ← 增强DAG执行引擎（拓扑排序+并行调度）
  src/harness/loop/LoopController.ts ← 集成DAG执行路径
  src/harness/loop/Planner.ts       ← 输出DAG结构化计划
  src/harness/types.ts              ← 扩展ExecutionPlan支持DAG
```

**DAG执行流程**：

```
Planner.plan()
    │
    ▼ 输出 ExecutionPlan (含 DAG)
    │
DAGTask.execute()
    │
    ├── 拓扑排序 → 确定执行层级
    │
    ├── 层级1: [Step A, Step B]  ← 可并行
    │         │          │
    │         ▼          ▼
    │       Result A   Result B
    │         │          │
    │         └────┬─────┘
    │              ▼
    ├── 层级2: [Step C]          ← 依赖A+B
    │              │
    │              ▼
    │           Result C
    │
    └── 汇总所有结果 → Reporter
```

**关键接口变更**：

```typescript
// src/harness/types.ts 扩展
interface ExecutionPlan {
  steps: PlanStep[];
  dag?: DAGNode[]; // 新增：DAG依赖图
  parallelGroups?: string[][]; // 新增：可并行执行的步骤组
}

interface PlanStep {
  // ... 现有字段
  dependencies?: string[]; // 新增：依赖的步骤ID
  outputSchema?: Record<string, unknown>; // 新增：输出数据结构
}

interface StepResult {
  stepId: string;
  success: boolean;
  output?: Record<string, unknown>; // 新增：结构化输出
  error?: string;
}
```

### 4.3 增强项 E2-2：步骤间结构化数据流 ✅ 已实现

> **实现状态**: ✅ 已实现（2026-06-15 确认）
>
> **接口差异说明**: 文档提议 `StepDataPipe` 接口，实际实现为 `LoopContext.stepOutputs` + `dataFlowChannels` + `crossStepState`。数据流通过 `LoopController.resolveStepInputBindings()` 和 `generateUpstreamContext()` 编排，无需独立 StepDataPipe 类。

**现状问题**：`stepResults: Map<string, StepResult>` 存在但步骤间无结构化数据传递机制。

**增强方案**：在 `LoopContext` 中建立步骤间数据管道。

**实现路径**：

```
修改文件:
  src/harness/types.ts              ← 扩展StepResult和LoopContext
  src/harness/loop/Executor.ts      ← 执行时注入上游步骤输出
  src/harness/loop/LoopController.ts ← 编排数据流
```

**数据流模型**：

```typescript
// 步骤间数据管道
interface StepDataPipe {
  /** 获取上游步骤的输出 */
  getUpstreamOutput(stepId: string): Record<string, unknown> | undefined;
  /** 获取所有上游步骤的输出 */
  getAllUpstreamOutputs(): Map<string, Record<string, unknown>>;
  /** 设置当前步骤的输出 */
  setCurrentOutput(output: Record<string, unknown>): void;
}
```

### 4.4 增强项 E2-3：LLM深度规划 ✅ 已实现

> **实现状态**: ✅ 已实现（2026-06-15 确认）
>
> **实现说明**: `Planner` 已输出含 DAG、dependencies、dataFlowChannels、executionMode 的结构化计划，含计划可行性预检（`validatePlan`）。

**现状问题**：`Planner` 对简单任务用正则匹配，复杂任务才调LLM，但LLM规划缺乏结构化输出和验证。

**增强方案**：增强 `Planner` 的LLM规划能力，增加计划验证环节。

**实现路径**：

```
修改文件:
  src/harness/loop/Planner.ts          ← 增强LLM规划prompt+结构化输出
  src/harness/loop/LoopController.ts   ← 增加计划验证步骤
  src/core/TaskComplexityAnalyzer.ts   ← 增强复杂度评估维度
```

**增强点**：

1. **结构化规划输出**：LLM规划结果解析为 `ExecutionPlan`（含DAG、依赖、预估耗时）
2. **计划可行性预检**：验证所需工具是否已注册、参数是否合法、依赖是否可满足
3. **复杂度评估增强**：增加"是否需要DAG"、"是否可并行"两个维度

### 4.5 增强项 E2-4：实时进度追踪 ✅ 已实现

> **实现状态**: ✅ 已实现（2026-06-15 确认）
>
> **实现说明**: `LoopController` 含 `ExecutionProgress` 类型、`onStepStarted/onStepCompleted` 回调、`estimateTimeRemaining` 和 `detectBottlenecks` 方法。

**现状问题**：执行过程中无结构化进度信息，前端只能显示"正在执行"。

**增强方案**：通过 `EventBus` 发射结构化进度事件。

**实现路径**：

```
修改文件:
  src/shared/eventTypes.ts            ← 增加进度事件类型
  src/harness/loop/Executor.ts        ← 执行时发射进度事件
  src/harness/loop/LoopController.ts  ← 汇总进度信息
```

**进度事件模型**：

```typescript
interface TaskProgressEvent {
  traceId: string;
  totalSteps: number;
  completedSteps: number;
  currentStep: string;
  currentStepProgress: number; // 0-1
  estimatedTimeRemaining: number; // ms
  status: 'planning' | 'executing' | 'evaluating' | 'completed' | 'failed';
}
```

---

## 五、阶段3增强计划：自主规划能力提升（部分已实现）

### 5.1 增强目标

将家百星从"被动执行+简单纠错"提升到"自主规划+深度反思+自适应纠错"：

```
当前（阶段3基础）              目标（阶段3增强）
┌──────────────────┐     ┌──────────────────┐
│ 简单replan逻辑    │     │ 根因分析+自适应   │
│ 无计划验证        │ ──→ │ 计划可行性预检     │
│ 无执行监控        │     │ 实时监控+预警      │
│ 步骤状态不完整    │     │ 完整状态机管理     │
│ 无经验复用        │     │ 历史经验驱动规划   │
└──────────────────┘     └──────────────────┘
```

### 5.2 增强项 E3-1：根因分析+自适应重规划 ✅ 已实现

> **实现状态**: ✅ 已实现（2026-06-15 确认）
>
> **接口差异说明**: 文档提议 `RootCauseReport`，实际实现为 `RootCauseAnalysis` 类型（含 `impactScope`、`affectedSteps` 等字段）。方法位于 `LoopController.analyzeRootCause()` 和 `generateReplanStrategy()`。

**现状问题**：`Evaluator` 返回 `suggestedAction='replan'` 后，`LoopController` 只是重新调用 `Planner`，无根因分析。

**增强方案**：在重规划前增加根因分析，将失败原因注入重新规划的上下文。

**实现路径**：

```
修改文件:
  src/harness/loop/LoopController.ts   ← 增加根因分析环节
  src/harness/loop/Evaluator.ts        ← 增强评估输出（含根因）
  src/harness/loop/Planner.ts          ← 接收根因信息，调整规划策略
```

**根因分析流程**：

```
Evaluator.evaluate()
    │
    ▼ suggestedAction = 'replan'
    │
RootCauseAnalyzer（新增方法，集成在LoopController中）
    │
    ├── 分析失败步骤的工具调用结果
    ├── 分析错误类型（参数错误/工具不可用/超时/权限不足）
    ├── 分析上下文是否充分
    │
    ▼ 输出 RootCauseReport
    │
Planner.replan(rootCause, originalPlan, partialResults)
    │
    ├── 根据根因调整策略：
    │   - 工具不可用 → 换工具/降级方案
    │   - 参数错误 → 修正参数
    │   - 超时 → 拆分为更小步骤
    │   - 上下文不足 → 补充检索
    │
    ▼ 输出调整后的 ExecutionPlan
```

**关键接口**：

```typescript
interface RootCauseReport {
  failedStepId: string;
  errorType:
    | 'tool_unavailable'
    | 'param_error'
    | 'timeout'
    | 'permission'
    | 'context_insufficient'
    | 'unknown';
  errorMessage: string;
  suggestedFix: string;
  affectedSteps: string[]; // 受影响的后续步骤
  partialResults: Map<string, StepResult>; // 已完成的步骤结果
}
```

### 5.3 增强项 E3-2：计划可行性预检 ✅ 已实现

> **实现状态**: ✅ 已实现（2026-06-15 确认）
>
> **接口差异说明**: 文档提议 `PlanValidationResult.issues`，实际实现为 `PlanValidationResult.errors` + `warnings` + `estimatedSuccessRate`。验证方法位于 `LoopController.validatePlan()`，检查工具可用性、依赖缺失、循环依赖、预算、并行冲突。

**现状问题**：`Planner` 生成的计划直接执行，不验证可行性，导致执行中才发现工具缺失或参数错误。

**增强方案**：在 `Planner` 和 `Executor` 之间增加计划验证环节。

**实现路径**：

```
修改文件:
  src/harness/loop/LoopController.ts   ← 增加验证环节
  src/harness/loop/Planner.ts          ← 输出计划时附带资源需求
```

**验证清单**：

```typescript
interface PlanValidationResult {
  valid: boolean;
  issues: PlanIssue[];
}

interface PlanIssue {
  stepId: string;
  severity: 'error' | 'warning';
  type:
    | 'tool_not_registered'
    | 'param_schema_mismatch'
    | 'circular_dependency'
    | 'budget_exceeded'
    | 'missing_context';
  message: string;
  suggestion: string;
}
```

**验证流程**：

```
Planner.plan() → ExecutionPlan
    │
    ▼
PlanValidator.validate(plan, toolRegistry, budget)
    │
    ├── 检查所有步骤所需工具是否已注册
    ├── 检查参数是否符合工具Schema
    ├── 检查DAG是否有循环依赖
    ├── 检查预算是否充足
    │
    ▼ PlanValidationResult
    │
    ├── valid=true → Executor.execute()
    └── valid=false → 修正计划或报错
```

### 5.4 增强项 E3-3：完整执行状态机 ❌ 待实现

> **实现状态**: ❌ 待实现
>
> **当前差距**: 有 `LoopState`（9状态循环级），但缺 `StepState`（步骤级状态），缺 `READY`/`WAITING_APPROVAL`/`BLOCKED` 状态。

**现状问题**：`LoopState` 只有9个状态，缺乏细粒度的步骤级状态管理。

**增强方案**：扩展状态机，支持步骤级状态追踪和状态转换约束。

**实现路径**：

```
修改文件:
  src/harness/types.ts              ← 扩展StepState枚举
  src/harness/loop/LoopController.ts ← 集成步骤状态机
  src/harness/loop/Executor.ts      ← 更新步骤状态
```

**增强的状态模型**：

```typescript
enum StepState {
  PENDING = 'pending',
  READY = 'ready', // 新增：依赖满足，可执行
  RUNNING = 'running',
  WAITING_APPROVAL = 'waiting_approval', // 新增：等待人工确认
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped', // 新增：被跳过
  RETRYING = 'retrying', // 新增：重试中
  BLOCKED = 'blocked', // 新增：被上游阻塞
}

// 合法状态转换
const STEP_TRANSITIONS: Record<StepState, StepState[]> = {
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
  [StepState.FAILED]: [StepState.RETRYING, StepState.SKIPPED],
  [StepState.RETRYING]: [StepState.COMPLETED, StepState.FAILED],
  [StepState.BLOCKED]: [StepState.READY, StepState.SKIPPED],
  [StepState.COMPLETED]: [],
  [StepState.SKIPPED]: [],
};
```

### 5.5 增强项 E3-4：历史经验驱动规划 ❌ 待实现

> **实现状态**: ❌ 待实现
>
> **当前差距**: `TrajectoryDatabase` 无 `querySimilarTasks` 方法，`Planner` 无历史经验注入。

**现状问题**：`Planner` 每次从零开始规划，不利用历史成功/失败经验。

**增强方案**：将 `TrajectoryDatabase` 中的历史轨迹作为规划参考。

**实现路径**：

```
修改文件:
  src/harness/loop/Planner.ts          ← 注入历史经验
  src/harness/persistence/TrajectoryQueryService.ts ← 增加经验查询方法
  src/evolution/EvolutionOrchestrator.ts ← 将规划经验写入进化系统
```

**经验驱动规划流程**：

```
用户输入
    │
    ▼
TrajectoryQueryService.querySimilarTasks(input)
    │
    ├── 检索相似任务的历史轨迹
    ├── 过滤出高评分轨迹（qualityScore > 0.7）
    │
    ▼ 历史经验
    │
Planner.plan(input, historicalExperience)
    │
    ├── 如果有相似成功经验 → 复用计划模板
    ├── 如果有相似失败经验 → 避免已知错误路径
    ├── 如果无相似经验 → LLM从零规划
    │
    ▼ ExecutionPlan（融合历史经验）
```

---

## 六、阶段4路线图：环境自适应

### 6.1 核心目标

打通"感知→学习→进化"闭环，让系统能从交互中持续自我改进。

### 6.2 关键闭环

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐       │
│   │  感知    │──→│  学习    │──→│  进化    │       │
│   │ Perceive │    │ Learn   │    │ Evolve  │       │
│   └────▲────┘    └────▲────┘    └────▲────┘       │
│        │              │              │              │
│        │              │              │              │
│   ┌────┴────┐    ┌────┴────┐    ┌────┴────┐       │
│   │ 环境状态 │    │ 知识图谱 │    │ 策略权重 │       │
│   │ 用户画像 │    │ 技能库   │    │ 安全边界 │       │
│   │ 情绪模式 │    │ 反馈记录 │    │ 行为模式 │       │
│   └─────────┘    └─────────┘    └─────────┘       │
│                                                     │
│   已有组件：                                        │
│   感知: FeedbackCollector, DesktopVisionEngine,     │
│         EmotionAnalyzer, SceneRecognizer            │
│   学习: KnowledgeGraphBuilder, SkillUsageTracker,  │
│         UserProfile, StrategyOptimizer              │
│   进化: EvolutionEngineV2, EvolutionOrchestrator,  │
│         SelfModificationEngine, EvolutionPlanner    │
│                                                     │
│   缺失环节：                                        │
│   🔴 统一学习闭环（各子系统独立运行，无协调）        │
│   🔴 环境状态持久化模型                              │
│   🔴 预测→验证→调整循环                             │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 6.3 阶段4实现优先级

| 优先级 | 任务                                                     | 依赖 | 预估 | 状态                                                |
| ------ | -------------------------------------------------------- | ---- | ---- | --------------------------------------------------- |
| P0     | 统一学习闭环：`EvolutionOrchestrator` 协调所有学习子系统 | 无   | 2周  | ⚠️ 半通：StrategyAdjuster直连✅，EventBus事件驱动❌ |
| P1     | 环境状态模型：持久化当前环境感知结果                     | P0   | 1周  | ❌ 待实现                                           |
| P1     | 预测验证循环：`predictNextAction` → 执行 → 验证 → 调整   | P0   | 2周  | ❌ 待实现                                           |
| P2     | 自主触发增强：`AutonomousTrigger` 基于学习结果主动行动   | P1   | 1周  | ❌ 待实现                                           |
| P2     | 跨会话知识迁移增强                                       | P1   | 1周  | ❌ 待实现                                           |

---

## 七、阶段5：社会协作 🔧 基础已实现

### 7.1 已有基础

- `OrchestratorAgent`：顶层协调Agent，支持动态角色分配与重平衡
- `SubAgentFanout`：子Agent扇出（parallel/sequential/adaptive）
- `AgentRegistry`：Agent注册中心 + 协商/竞标/知识/通信四大子系统
- `TaskDispatcher`：任务分发，支持DAG分层并行 + 批量并发控制
- `ResultAggregator`：结果聚合 + 冲突检测 + LLM仲裁 + 置信度合并

### 7.2 已实现的E5能力

| 能力       | 实现位置            | 接口                                                                                                        | 说明                                          |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Agent协商  | `AgentRegistry`     | `startNegotiation` / `sendNegotiationMessage` / `getNegotiationSession` / `getActiveNegotiations`           | 结构化协商协议：提议→接受/拒绝→完成/失败      |
| 任务竞标   | `AgentRegistry`     | `registerBidHandler` / `publishBidding` / `evaluateBids` / `submitBid`                                      | 三种策略：balanced / fastest / most_confident |
| 共享知识   | `AgentRegistry`     | `publishKnowledge` / `queryKnowledge` / `referenceKnowledge` / `subscribeToKnowledge` / `getKnowledgeStats` | 内存级知识库，支持类型/场景/质量/关键词过滤   |
| 结构化通信 | `AgentRegistry`     | `registerMessageHandler` / `broadcastMessage` / `negotiateBetweenAgents`                                    | 点对点 + 广播，idle Agent自动过滤             |
| 冲突检测   | `ResultAggregator`  | `detectConflicts`                                                                                           | file_write冲突 + goal_overlap冲突             |
| LLM仲裁    | `ResultAggregator`  | `resolveConflictsWithLLM`                                                                                   | LLM判定冲突胜出方                             |
| 置信度合并 | `ResultAggregator`  | `mergeWithConsensus`                                                                                        | 加权合并多Agent结果                           |
| 动态角色   | `OrchestratorAgent` | `assignDynamicRoles` / `rebalanceRoles`                                                                     | 按能力匹配角色，过载时重平衡                  |

### 7.3 待增强

| 能力         | 描述                                   | 预估时间 | 优先级 |
| ------------ | -------------------------------------- | -------- | ------ |
| 知识库持久化 | SharedKnowledge 持久化到 SQLite/向量库 | 2026 Q4  | P1     |
| 协商协议增强 | 多轮协商、条件接受、部分接受           | 2026 Q4  | P2     |
| 跨进程通信   | Agent间通过消息队列/HTTP通信           | 2027+    | P2     |
| 角色专业化   | Agent根据能力自动专业化                | 2027+    | P3     |
| 微服务拆分   | AgentRegistry 拆分为独立服务           | 2027+    | P3     |

---

## 八、实现路线图总览

### 8.1 里程碑时间线

```
2026 Q2 (当前)          2026 Q3               2026 Q4              2027+
─────────────────────────────────────────────────────────────────────────
│ 阶段2增强 ✅           │ 阶段3增强            │ 阶段4完善           │ 阶段5增强
│                        │                      │                     │
│ ✅ DAG任务执行         │ ✅ 根因分析+自适应    │ □ 统一学习闭环      │ □ 知识库持久化
│ ✅ 步骤间数据流        │    重规划             │ □ 环境状态模型      │ □ 协商协议增强
│ ✅ LLM深度规划         │ ✅ 计划可行性预检     │ □ 预测验证循环      │ □ 跨进程通信
│ ✅ 实时进度追踪        │ ❌ 完整执行状态机     │ □ 自主触发增强      │ □ 角色专业化
│ ✅ 社会协作基础         │ ❌ 历史经验驱动       │ □ 跨会话迁移增强    │ □ 微服务拆分
```

### 8.2 增强项依赖关系

```
E2-1 DAG执行 ──────→ E3-1 根因分析（依赖DAG步骤信息）
    │                      │
    ▼                      ▼
E2-2 数据流 ──────→ E3-2 计划验证（依赖数据流验证）
    │                      │
    ▼                      ▼
E2-3 LLM规划 ─────→ E3-3 状态机（依赖细粒度状态）
    │                      │
    ▼                      ▼
E2-4 进度追踪 ────→ E3-4 经验驱动（依赖历史轨迹）
                           │
                           ▼
                    E4-1 统一学习闭环
                    E4-2 环境状态模型
                    E4-3 预测验证循环
```

### 8.3 每个增强项的验收标准

| 增强项          | 验收标准                                              | 测试要求          | 状态                                                  |
| --------------- | ----------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| E2-1 DAG执行    | 含3+步骤的DAG任务可正确拓扑排序执行，并行步骤实际并行 | 单元测试+集成测试 | ✅ 完成                                               |
| E2-2 数据流     | 步骤B可引用步骤A的结构化输出，类型安全                | 单元测试          | ✅ 完成                                               |
| E2-3 LLM规划    | 复杂任务输出含DAG的ExecutionPlan，通过可行性预检      | 集成测试          | ✅ 完成                                               |
| E2-4 进度追踪   | 前端可实时显示步骤级进度，含预估剩余时间              | E2E测试           | ✅ 完成                                               |
| E2-5 工具韧性   | L1-L4四层韧性金字塔：重试→参数修正→LLM修正→降级替代   | 单元测试          | ⚠️ L1✅ L2死代码 L3❌ L4死代码                        |
| E3-1 根因分析   | replan时输出RootCauseAnalysis，新计划避免相同错误     | 单元测试+集成测试 | ✅ 完成                                               |
| E3-2 计划验证   | 工具缺失/参数错误/循环依赖在执行前被检测              | 单元测试          | ✅ 完成                                               |
| E3-3 状态机     | 步骤状态转换合法，非法转换被拒绝                      | 单元测试          | ❌ 待实现                                             |
| E3-4 经验驱动   | 相似任务复用历史计划，失败经验被规避                  | 集成测试          | ❌ 待实现                                             |
| E3-5 反思引擎   | 三层反思+结论注入Thought+经验持久化+效果度量          | 单元测试          | ⚠️ 死代码：ReflectionEngine从未被import/实例化/注入   |
| E3-6 步骤级调整 | shouldReplan + suggestStepAdjustment 五种调整动作     | 单元测试          | ⚠️ 死代码：方法存在但从未被调用                       |
| E4-1 学习闭环   | 学习信号实时收集+策略自适应+Executor集成              | 单元测试          | ⚠️ 半通：信号发射无订阅者，StrategyAdjuster直连✅     |
| E4-2 记忆增强   | 余弦相似度+向量语义检索+动态嵌入函数                  | 单元测试          | ⚠️ TrajectoryDatabase✅，SemanticSimilarityEngine孤立 |
| E4-3 上下文增强 | 主动检索+注意力聚焦+token预算优化                     | 单元测试          | ✅ 完成                                               |
| E5-1 社会协作   | 协商+竞标+知识+通信+冲突检测+仲裁+角色分配            | 单元测试          | ⚠️ 方法已定义但从未被调用                             |

---

## 九、技术约束与风险

### 9.1 技术约束

| 约束       | 说明                                  | 影响                       |
| ---------- | ------------------------------------- | -------------------------- |
| 单进程架构 | Node.js单进程，DAG并行受限于事件循环  | 并行度有限，IO密集型可并行 |
| LLM延迟    | LLM调用延迟高（1-5s）                 | 规划和评估环节耗时         |
| Token预算  | 上下文窗口有限（4K-128K）             | 长任务需压缩上下文         |
| 安全边界   | `SelfModificationEngine` 限制文件修改 | 进化能力受限               |

### 9.2 风险与缓解

| 风险                | 概率 | 影响             | 缓解措施                       |
| ------------------- | ---- | ---------------- | ------------------------------ |
| DAG并行执行竞态条件 | 中   | 数据不一致       | 步骤间数据管道只读，写入需加锁 |
| LLM规划不可靠       | 高   | 生成无效计划     | 计划验证+降级为正则规划        |
| 根因分析误判        | 中   | 重规划方向错误   | 多维度分析+人工确认            |
| 进化闭环失控        | 低   | 系统行为不可预测 | 安全边界+回滚机制+人工审批     |

---

## 十、术语表

| 术语       | 全称                   | 说明                         |
| ---------- | ---------------------- | ---------------------------- |
| PEE        | Plan-Execute-Evaluate  | 家百星核心执行循环           |
| DAG        | Directed Acyclic Graph | 有向无环图，用于任务依赖建模 |
| Harness    | Agent Harness          | 六层管控框架                 |
| Guardrail  | Output Guardrail       | 输出安全护栏                 |
| Trajectory | Execution Trajectory   | 执行轨迹，用于经验回放       |
| Checkpoint | State Checkpoint       | 状态检查点，用于回滚         |

---

**文档版本**: 1.2
**创建日期**: 2026-06-14
**最后更新**: 2026-06-22
**维护者**: 家百星开发团队
**下次审查**: 2026-07-15
