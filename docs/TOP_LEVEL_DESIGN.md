# 家百星 (Jiabaixing) 顶层开发设计文档

> **版本**: 2.2
> **日期**: 2026-08-16
> **定位**: Agent 演化路线图 × 系统架构 × 阶段增强计划 × V5.5 综合更新方案
> **审计说明**: V2.1 基于 Python 后端代码实际状态全面审计，修正了 V2.0 中基于 TS 视角的过时标记
> **源码规模**: ~340 个 .ts 文件 + ~120 个 .py 文件，~130 个 Manager/Service/Engine 类

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
  → PythonAgentBridge.processInput() → Python FastAPI  [桥接层 - V5.6: BridgeProcessResult 携带轨迹]
  → AgentHarness.processInput()                       [TS 壳 - 映射 quality/trace/budget]
  → ConstraintsService.executeHooks()                 [L层 - Constraints]
  → Python LoopController.run()
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
└── shared/ (5+ 文件)                  ← 共享基础设施
    ├── DIContainer.ts                 ← 依赖注入容器 (V5.6 增强)
    ├── DependencyRegistry.ts          ← 依赖注册 + 单例迁移映射
    ├── EventBus.ts                    ← 事件总线
    └── eventTypes.ts                  ← 事件类型定义
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
| **工具执行韧性** | ✅ Python端 | `Executor` L1✅指数退避 / L2✅参数修正(ReflectionEngine) / L3✅LLM辅助修正 / L4✅降级替代 | - |
| 批处理           | ✅ 完成 | `BatchProcessor`                                                                                               | -         |
| **任务依赖图**   | ✅ 完成 | `LoopController.buildDAGFromPlan()` 拓扑排序+并行调度                                                          | -         |
| **任务并行执行** | ✅ 完成 | `LoopController.executeWithDAG()` 基于 `dependencies: Map<string, string[]>` + `executionMode: 'dag'`          | -         |
| **中间结果传递** | ✅ 完成 | `LoopContext.stepOutputs` + `dataFlowChannels` + `crossStepState`，`LoopController.resolveStepInputBindings()` | -         |

### 3.3 阶段3：自主规划 🔧 部分具备，需增强

| 能力                             | 状态      | 实现位置                                                                                                             | 增强需求      |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| 长任务分解                       | 🔶 部分   | `Planner` + `TaskComplexityAnalyzer`                                                                                 | 🔴 需增强     |
| 反思评估                         | ✅ 完成   | `IndependentEvaluationService`                                                                                       | -             |
| **反思引擎**                     | ✅ Python端 | `ReflectionEngine` 三层反思已集成到 LoopController + Executor（reflect/lightweight_reflect/deep_reflect/meta_reflect/reflect_on_success） | - |
| **反思结论注入Thought**          | ✅ Python端 | `LoopController._last_reflection_insight` + replan 时注入根因信息                                                    | - |
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
| **多Agent协调**                  | ✅ 完成   | `OrchestratorAgent` 复杂任务多Agent协调（V5.6: BaseAgent bid/canHandle/healthCheck 统一抽象，TaskDispatcher assignedTo 闭环） | ✅ 已增强     |
| **并行组执行**                   | ✅ 完成   | 基于 `parallelGroup` 的并行执行                                                                                      | -             |
| **步骤级动态调整**               | ⚠️ Python端待集成 | Python端 `Executor` 已有反思重试+降级替代，但 `shouldReplan()` + `suggestStepAdjustment()` 5种调整动作尚未集成 | 🔴 需集成 |

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
| **记忆系统增强**     | ✅ Python端 | `TrajectoryDatabase.query_similar_tasks()` 余弦相似度+向量语义检索已实现，但 Planner 未调用经验注入 | 🔶 需集成Planner |
| **语义相似度引擎**   | ⚠️ TS端孤立 | TS端 `SemanticSimilarityEngine` 代码完整但从未被import；Python端 `TrajectoryDatabase` 已有余弦相似度+向量语义检索 | 🔶 TS→Python迁移 |
| **学习信号管道**     | ✅ Python端 | `_record_signals_async` 生成信号✅ + `FeedbackLoop.feed_to_evolution_engine` 消费✅ + EventBus 订阅者已接线✅ | - |
| **策略自适应**       | ✅ 完成 | `StrategyAdjuster` recordSignal(6处调用) + getAdjustedToolPriority/getAdjustedReflectionConfig(2处消费)                 | -             |
| **上下文主动检索**   | ✅ 完成 | `ContextManager.activelyRetrieveContext()` + `focusByAttention()` 注意力聚焦                                            | -             |
| **学习闭环**         | ✅ 基础 | `LearningSignalCollector` + `StrategyAdjuster` + Executor集成，信号管道已打通                                           | 🔶 需增强     |
| **环境建模**         | ✅ Python端基础 | `perception/bus.py` 的 `EnvironmentState` + `_perceive_environment()` 实时感知 | 🔶 需持久化+跨会话 |
| **预测能力**         | ❌ 缺失 | `predictNextAction` 精度不足                                                                                            | 🔴 需增强     |

### 3.5 阶段5：社会协作 🔧 基础已实现，待增强

| 能力             | 状态    | 实现位置                                                        | 增强需求  |
| ---------------- | ------- | --------------------------------------------------------------- | --------- |
| Agent注册        | ✅ 完成 | `AgentRegistry`                                                 | -         |
| 任务分发         | ✅ 完成 | `TaskDispatcher`                                                | -         |
| 结果聚合         | ✅ 完成 | `ResultAggregator`                                              | -         |
| 子Agent扇出      | ✅ 完成 | `SubAgentFanout` 3种策略                                        | -         |
| 协调Agent        | ✅ 完成 | `OrchestratorAgent`（V5.6: BaseAgent 统一抽象 + bid 竞标） | ✅ 已增强 |
| **Agent协商**    | ✅ Python端 | `AgentRegistry.startNegotiation/sendNegotiationMessage` + A2A协议远程发现 | 🔶 需增强 |
| **任务竞标**     | ✅ Python端 | `AgentRegistry.publishBidding/evaluateBids`                     | 🔶 需增强 |
| **共享知识**     | ✅ Python端 | `AgentRegistry.publishKnowledge/queryKnowledge`                 | 🔶 需增强 |
| **结构化通信**   | ✅ Python端 | `AgentRegistry.registerMessageHandler/broadcastMessage` + A2A manager | 🔶 需增强 |
| **冲突检测**     | ✅ Python端 | `ResultAggregator.detectConflicts`（file_write + goal_overlap） | 🔶 需增强 |
| **LLM仲裁**      | ✅ Python端 | `ResultAggregator.resolveConflictsWithLLM`                      | 🔶 需增强 |
| **置信度合并**   | ✅ Python端 | `ResultAggregator.mergeWithConsensus`                           | 🔶 需增强 |
| **动态角色分配** | ✅ Python端 | `OrchestratorAgent.assignDynamicRoles/rebalanceRoles` + AgentEngine集成 | 🔶 需增强 |
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
| E2-5 工具韧性   | L1-L4四层韧性金字塔：重试→参数修正→LLM修正→降级替代   | 单元测试          | ✅ Python端 L1✅ L2✅ L3✅ L4✅                        |
| E3-1 根因分析   | replan时输出RootCauseAnalysis，新计划避免相同错误     | 单元测试+集成测试 | ✅ 完成                                               |
| E3-2 计划验证   | 工具缺失/参数错误/循环依赖在执行前被检测              | 单元测试          | ✅ 完成                                               |
| E3-3 状态机     | 步骤状态转换合法，非法转换被拒绝                      | 单元测试          | 🔧 Python端 StepStateMachine 已定义，Executor 集成中 |
| E3-4 经验驱动   | 相似任务复用历史计划，失败经验被规避                  | 集成测试          | ✅ Python端 query_similar_tasks + LoopController 规划前经验注入 |
| E3-5 反思引擎   | 三层反思+结论注入Thought+经验持久化+效果度量          | 单元测试          | ✅ Python端 ReflectionEngine 已完整集成               |
| E3-6 步骤级调整 | shouldReplan + suggestStepAdjustment 五种调整动作     | 单元测试          | ✅ Python端已集成：should_replan + _suggest_step_adjustment + _apply_step_adjustment |
| E4-1 学习闭环   | 学习信号实时收集+策略自适应+Executor集成              | 单元测试          | ✅ Python端 EventBus 订阅者已接线+直连消费+策略优化   |
| E4-2 记忆增强   | 余弦相似度+向量语义检索+动态嵌入函数                  | 单元测试          | ✅ Python端 TrajectoryDatabase.query_similar_tasks    |
| E4-3 上下文增强 | 主动检索+注意力聚焦+token预算优化                     | 单元测试          | ✅ 完成                                               |
| E5-1 社会协作   | 协商+竞标+知识+通信+冲突检测+仲裁+角色分配            | 单元测试          | ✅ Python端 AgentRegistry+OrchestratorAgent+A2A      |

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

## 十一、V5.5 综合更新方案与执行计划

> **版本**: 2.1 | **日期**: 2026-08-13 | **基于**: V5.5 Harness Agent Framework + Python 后端

### 11.1 V5.5 架构演进概要

自 V1.2 文档以来，系统已完成重大架构升级：

| 变更项 | V1.2 (2026-06-22) | V5.5 (2026-08-13) |
|--------|-------------------|-------------------|
| AI 核心运行时 | TypeScript 单进程 | Python FastAPI + TypeScript 薄网关 |
| AgentEngine | 80+ 属性 God Object | 7 个 Facade 门面拆分 |
| LoopController | 单体循环 | 4 中间件链（Trajectory/Feedback/Observer/EvolutionSignal） |
| 安全 | 基础 CORS | CORS 白名单 + 绑定 127.0.0.1 + OSV + PathSecurity |
| 数据库 | 同步 SQLite | asyncio.to_thread 异步包装 |
| WebSocket | 基础连接 | 心跳 + 连接数限制 |
| 监控 | 计数器 | 真实百分位延迟 Histogram |
| 工具数 | 33 (TS) | 82+ (Python) |
| 前端面板 | 基础 | 14 个 + Agent 印记条 |
| 测试 | TS 侧 | Python 232 + TS 874 + 前端 11 |

**三端统一入口**：Desktop GUI / TS CLI / Python CLI → 同一 `AgentEngine.process_input()`

### 11.2 各阶段能力现状更新

#### 阶段1-2：工具调用 + 任务执行 ✅ 已全面完成

| 能力 | 状态 | 备注 |
|------|------|------|
| 单步/多步工具调用 | ✅ | 82+ 工具 (Python端) |
| DAG 依赖图执行 | ✅ | `dependencies: Map<string, string[]>` + `executionMode: 'dag'` |
| 步骤间结构化数据流 | ✅ | `stepOutputs` + `dataFlowChannels` + `crossStepState` |
| LLM 深度规划 | ✅ | Planner 输出含 DAG 的结构化计划 + `validatePlan` |
| 实时进度追踪 | ✅ | `ExecutionProgress` + `onStepStarted/onStepCompleted` |
| 上下文压缩 | ✅ | `ContextCompressor` 4 级压缩 |
| 预算控制 | ✅ | 4 维：轮次/Token/时间/工具调用 |
| 工具执行韧性 | ✅ Python端 | L1✅指数退避 / L2✅参数修正(ReflectionEngine) / L3✅LLM辅助修正 / L4✅降级替代 |

#### 阶段3：自主规划 🔧 部分具备，关键项待修复

| 能力 | 状态 | 优先级 | 行动 |
|------|------|--------|------|
| 根因分析+自适应重规划 | ✅ | - | 已完成 |
| 计划可行性预检 | ✅ | - | 已完成 |
| Plan-Battle-Execute 辩论验证 | ✅ | - | 已完成 |
| Fast Path 快速路径 | ✅ | - | 已完成 |
| 并行组执行 | ✅ | - | 已完成 |
| **反思引擎集成** | ✅ Python端已完成 | - | Python端 ReflectionEngine 已完整集成到 LoopController（reflect/lightweight_reflect/deep_reflect/meta_reflect/reflect_on_success） |
| **步骤级动态调整** | ✅ Python端已集成 | - | `should_replan()` + `_suggest_step_adjustment()` + `_apply_step_adjustment()` 3种调整动作已集成 |
| **完整执行状态机** | 🔧 Python端集成中 | **P1** | `StepStateMachine` + `StepState` 9状态枚举已定义，Executor 集成进行中 |
| **历史经验驱动规划** | ✅ Python端基础完成 | **P2** | `TrajectoryDatabase.query_similar_tasks` + LoopController 规划前经验注入；需增强质量反馈闭环 |
| **工具韧性 L2-L4** | ✅ Python端已完成 | - | L2 参数修正(ReflectionEngine) / L3 LLM辅助修正 / L4 降级替代均已实现 |

#### 阶段4：环境自适应 🔧 框架已有，闭环未通

| 能力 | 状态 | 优先级 | 行动 |
|------|------|--------|------|
| 策略自适应 | ✅ | - | `StrategyAdjuster` recordSignal(6处) + getAdjusted*(2处) |
| 上下文主动检索 | ✅ | - | `activelyRetrieveContext()` + `focusByAttention()` |
| **学习信号管道** | ✅ Python端已完成 | - | `_record_signals_async` 生成✅ + `FeedbackLoop` 消费✅ + EventBus 订阅者接线✅ |
| **语义相似度引擎** | ⚠️ TS端孤立 | **P1** | TS端 `SemanticSimilarityEngine` 未被import；Python端 `TrajectoryDatabase.query_similar_tasks` 已实现 |
| **进化学习闭环** | ✅ Python端已完成 | - | `EvolutionOrchestrator` + `StrategyAdapter` 直连✅ + EventBus 订阅者接线✅ |
| **环境状态模型** | ✅ Python端基础 | **P2** | `perception/bus.py` EnvironmentState 实时感知已有，需持久化+跨会话 |
| **预测验证循环** | ❌ 缺失 | **P2** | `predictNextAction` 精度不足 |

#### 阶段5：社会协作 ✅ Python端基础已实现，待增强

| 能力 | 状态 | 优先级 | 行动 |
|------|------|--------|------|
| Agent 协商/竞标/知识/通信 | ✅ Python端 | - | `AgentRegistry` + A2A 协议远程发现 |
| 冲突检测/LLM 仲裁/置信度合并 | ✅ Python端 | - | `ResultAggregator` 已实现 |
| 动态角色分配 | ✅ Python端 | - | `OrchestratorAgent` + AgentEngine 集成 |
| **OrchestratorAgent 主流程集成** | ⚠️ 待增强 | **P2** | `AgentEngine._multi_agent_orchestrator.process_goal_with_loop` 已接入，但复杂任务自动触发需增强 |

### 11.3 综合更新方案

基于上述现状分析，将所有待办项按优先级分为 4 个执行波次：

---

#### Wave 1：死代码激活 + 闭环打通（P0 — ✅ 已完成）

**目标**：将已实现但未集成的"死代码"激活，打通关键闭环

**结果**：审计发现 Python 端已实现大部分"死代码"功能，仅需补充 EventBus 订阅者接线（W1-2/W1-3 已实现代码）

| 编号 | 任务 | 涉及文件 | 验收标准 |
|------|------|----------|----------|
| W1-1 | ~~反思引擎集成~~ | ~~`ReflectionEngine`, `LoopController`~~ | ✅ Python端已完成：ReflectionEngine 已注入 LoopController + Executor，reflect/lightweight_reflect/deep_reflect/meta_reflect/reflect_on_success 全部生效 |
| W1-2 | **学习信号 EventBus 解耦** | `engine.py`, `evolution/orchestrator.py`, `evolution/strategy_adapter.py` | ✅ 已实现：`_wire_domain_event_subscribers()` 注册3个订阅者，domain.evolution.feedback/tool.executed/llm_invoked 事件驱动闭环 |
| W1-3 | **进化闭环 EventBus 驱动** | `engine.py`, `evolution/orchestrator.py`, `evolution/feedback_loop.py` | ✅ 已实现：EvolutionOrchestrator 通过 EventBus 订阅学习信号，自动触发 record_interaction + 策略优化 |
| W1-4 | ~~工具韧性 L2 激活~~ | ~~`executor.py`~~ | ✅ Python端已完成：ErrorClassifier→PARAM_ERROR/SYNTAX_ERROR→ReflectionEngine.reflect()→corrected_args |
| W1-5 | ~~工具韧性 L3 实现~~ | ~~`executor.py`, `llm/provider.py`~~ | ✅ Python端已完成：ReflectionEngine.reflect() 已含 LLM 辅助修正 + alternative_tool + L4降级替代 |

**W1-1 反思引擎集成**：✅ Python端已完成

Python端 `agent/loop/reflection.py` 的 `ReflectionEngine` 已完整集成：
- `LoopController.__init__` 创建 `ReflectionEngine` 实例并传入 `Executor`
- `LoopController` 在工具失败时调用 `reflection.reflect()` 获取修正参数
- `LoopController` 在成功时调用 `reflection.reflect_on_success()` 提取成功经验
- 每轮执行后调用 `reflection.lightweight_reflect()` 快速反思
- 复杂失败时调用 `reflection.deep_reflect()` 深度反思
- 元反思 `reflection.meta_reflect()` 评估反思质量
- `_last_reflection_insight` 用于 replan 时注入根因信息

**W1-2 学习信号 EventBus 解耦详细方案**：

```
当前状态（Python端）：
  - LoopController._record_signals_async() 生成 LearningSignal 列表 ✅
  - FeedbackLoop.feed_to_evolution_engine() 直接调用 EvolutionEngine ✅
  - 但信号传递为直连调用，缺 EventBus 发布/订阅解耦

目标：引入 Python 端 EventBus 机制，学习信号通过事件解耦

实现路径：
1. 在 agent/core/ 创建 event_bus.py（Python 端轻量 EventBus）
2. LoopController._record_signals_async() 改为通过 EventBus 发布信号
3. EvolutionOrchestrator 订阅学习信号事件
4. StrategyAdapter 订阅学习信号事件
5. 保留直连调用作为降级路径（EventBus 不可用时）

修改文件：
  python/agent/core/event_bus.py              ← 新建：Python 端 EventBus
  python/agent/loop/controller.py             ← 信号发布改为 EventBus
  python/agent/evolution/orchestrator.py      ← 订阅学习信号事件
  python/agent/evolution/strategy_adapter.py  ← 订阅学习信号事件
```

**W1-2 学习信号管道打通详细方案**：

```
（已合并到上方 W1-2 方案中，Python 端为实际执行目标）
```

---

#### Wave 2：状态机完善 + 韧性增强（P1 — 2 周）✅ 已全部完成

**目标**：完善执行状态管理，增强系统韧性

| 编号 | 任务 | 涉及文件 | 验收标准 |
|------|------|----------|----------|
| W2-1 | **步骤级状态机集成** | `loop/types.py`, `loop/executor.py` | ✅ StepStateMachine 已定义，Executor 状态转换已修复（PENDING→READY→RUNNING→COMPLETED/FAILED→RETRYING），非法转换拒绝逻辑已验证 |
| W2-2 | **步骤级动态调整激活** | `loop/executor.py`, `loop/controller.py` | ✅ `should_replan()` + `_suggest_step_adjustment()` + `_apply_step_adjustment()` 已集成到 LoopController 评估后决策前 |
| W2-3 | ~~工具韧性 L4 激活~~ | ~~`loop/executor.py`, `tools/registry.py`~~ | ✅ Python端已完成：`_retry_with_reflection` 已含 alternative_tool + robustness fallback |
| W2-4 | **语义相似度→Planner集成** | `persistence/trajectory.py`, `loop/controller.py` | ✅ Python端 `TrajectoryDatabase.query_similar_tasks` 已在规划前调用，历史经验注入 Planner prompt |
| W2-5 | ~~沙箱执行环境~~ | ~~`loop/sandbox.py`, `core/desktop_controller`~~ | ✅ Python端已完成：`SandboxExecutor` + `SecurityLevel` + Windows硬隔离 + 进程树终止 |

**W2-1 步骤级状态机详细方案**：

```python
from enum import Enum

class StepState(str, Enum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    RETRYING = "retrying"
    BLOCKED = "blocked"

STEP_TRANSITIONS: dict[StepState, list[StepState]] = {
    StepState.PENDING: [StepState.READY, StepState.BLOCKED, StepState.SKIPPED],
    StepState.READY: [StepState.RUNNING, StepState.WAITING_APPROVAL, StepState.SKIPPED],
    StepState.RUNNING: [StepState.COMPLETED, StepState.FAILED, StepState.RETRYING, StepState.WAITING_APPROVAL],
    StepState.WAITING_APPROVAL: [StepState.RUNNING, StepState.SKIPPED],
    StepState.FAILED: [StepState.RETRYING, StepState.SKIPPED],
    StepState.RETRYING: [StepState.COMPLETED, StepState.FAILED],
    StepState.BLOCKED: [StepState.READY, StepState.SKIPPED],
    StepState.COMPLETED: [],
    StepState.SKIPPED: [],
}

集成路径：
1. 在 LoopContext 中为每个步骤维护 StepState
2. LoopController 在状态转换时校验合法性
3. Executor 更新步骤状态
4. 前端通过 WebSocket 接收步骤状态变化并实时展示
```

---

#### Wave 3：经验驱动 + 环境自适应（P2 — 3 周）

**目标**：实现历史经验复用和环境自适应核心闭环

| 编号 | 任务 | 涉及文件 | 验收标准 |
|------|------|----------|----------|
| W3-1 | **历史经验驱动规划** | `loop/controller.py`, `persistence/trajectory.py`, `EvolutionOrchestrator` | ✅ 质量反馈闭环已完成：update_execution_quality + query_similar_tasks 质量加权排序 + 经验注入含质量标签与建议 |
| W3-2 | **环境状态持久化模型** | `perception/bus.py`, `persistence/trajectory.py` | ✅ environment_states 表 + save/load/cleanup + PerceptionBus 持久化集成 + LoopController 历史环境补充 |
| W3-3 | **预测验证循环** | `loop/prediction_verification.py`, `loop/executor.py`, `loop/controller.py` | ✅ PredictionVerificationLoop 已实现：predict_step（规则+历史+自适应）→ verify_step（匹配/部分/偏差）→ 调整建议（CONTINUE/RETRY/DOWNGRADE/REPLAN）→ Executor 集成 + 17 项单元测试全通过 |
| W3-4 | **自主触发增强** | `memory/cross_session.py`, `loop/controller.py`, `core/engine.py` | ✅ ProactiveEngine 增强：新增 ENVIRONMENT_ADAPTATION + QUALITY_ALERT 动作类型 + _evaluate_quality_alerts（预测偏差率/工具成功率预警）+ _evaluate_environment_adaptation（网络变化/窗口切换/情绪变化适应）+ LoopController 主循环集成 + engine.py 双路径注入 |
| W3-5 | **多 Agent 协作增强** | `loop/controller.py`, `orchestration/agent_factory.py` | ✅ 增强自动触发：原有 5+ 步骤触发 + 新增预测偏差率>30%触发 + 历史失败经验≥2条触发，降低阈值至 3 步骤即可自动编排 |

**W3-1 历史经验驱动规划详细方案**：

```
当前状态（Python端）：
  - TrajectoryDatabase.query_similar_tasks() 已实现（余弦相似度+关键词检索）✅
  - 但 LoopController/Planner 未调用经验注入 ❌

实现路径：
1. 在 LoopController 执行规划前调用 TrajectoryDatabase.query_similar_tasks(input)
2. 过滤高评分轨迹（quality > 0.7）
3. 将历史经验注入 Planner 的 prompt：
   - 相似成功经验 → 复用计划模板
   - 相似失败经验 → 避免已知错误路径
   - 无相似经验 → LLM 从零规划
4. 将规划结果写入 EvolutionOrchestrator 供后续学习

修改文件：
  python/agent/loop/controller.py             ← 编排经验查询
  python/agent/persistence/trajectory.py      ← 增强 query_similar_tasks（已有基础）
  python/agent/evolution/orchestrator.py      ← 规划经验写入
```

---

#### Wave 4：系统完善 + 体验升级（P3 — 持续）

**目标**：全面提升系统稳定性和用户体验

| 编号 | 任务 | 涉及文件 | 验收标准 |
|------|------|----------|----------|
| W4-1 | **交互体验升级** | 前端 `ChatInterface`, `TypewriterText` | 消息状态机重构 + 打字机效果 + Thinking 可视化 |
| W4-2 | **Golden Eval Set 扩展** | `GoldenEvalSet`, 评估案例 JSON | 30 → 50+ 案例，覆盖 5 类 |
| W4-3 | **跨会话知识迁移** | `MemoryEngine`, `KnowledgeGraphBuilder` | 长期知识跨会话可用 |
| W4-4 | **协商协议增强** | `AgentRegistry` | 多轮协商、条件接受、部分接受 |
| W4-5 | **前端面板数据真实化** | 各 Panel 组件 | 消除 mock 数据，全部连接真实 API |

### 11.4 执行依赖关系

```
Wave 1 (P0) ✅ 已完成        Wave 2 (P1) ✅ 已完成        Wave 3 (P2)
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ ✅ W1-1 反思引擎 │     │ ✅ W2-1 步骤状态机│     │ □ W3-1 经验驱动 │
│     集成         │────→│                 │────→│     规划         │
│                 │     │ ✅ W2-2 步骤级调整 │     │                 │
│ ✅ W1-2 学习信号 │     │     激活         │     │ □ W3-2 环境状态 │
│     EventBus    │────→│                 │     │     持久化       │
│                 │     │ ✅ W2-3 工具韧性  │     │                 │
│ ✅ W1-3 进化闭环 │     │     L4(已完成)   │     │ □ W3-3 预测验证 │
│     EventBus    │────→│                 │     │     循环         │
│                 │     │ ✅ W2-4 语义→     │     │                 │
│ ✅ W1-4 工具韧性 │     │     Planner集成  │────→│ □ W3-4 自主触发 │
│     L2(已完成)   │     │                 │     │     增强         │
│                 │     │ ✅ W2-5 沙箱     │     │                 │
│ ✅ W1-5 工具韧性 │     │     (已完成)     │     │ □ W3-5 多Agent  │
│     L3(已完成)   │────→│                 │     │     增强         │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │ Wave 4 (P3)     │
                                                │ W4-1~W4-5       │
                                                │ 持续迭代         │
                                                └─────────────────┘
```

### 11.5 时间线

```
2026-08 第2-3周        2026-08 第4周~09第2周   2026-09 第3周~10月   2026-10+
─────────────────────────────────────────────────────────────────────────────
│ Wave 1: ✅ 已完成      │ Wave 2: ✅ 已完成     │ Wave 3: ✅ 已完成     │ Wave 4: 完善
│                       │                       │                     │
│ ✅ W1-1 反思引擎集成   │ ✅ W2-1 步骤状态机    │ ✅ W3-1 经验驱动规划  │ □ W4-1 交互升级
│ ✅ W1-2 学习信号EventBus│ ✅ W2-2 步骤级调整   │ ✅ W3-2 环境状态持久化│ □ W4-2 Eval扩展
│ ✅ W1-3 进化闭环EventBus│ ✅ W2-3 韧性L4(已完成)│ ✅ W3-3 预测验证循环  │ □ W4-3 知识迁移
│ ✅ W1-4 韧性L2(已完成) │ ✅ W2-4 语义→Planner │ ✅ W3-4 自主触发增强  │ □ W4-4 协商增强
│ ✅ W1-5 韧性L3(已完成) │ ✅ W2-5 沙箱(已完成)  │ ✅ W3-5 多Agent增强   │ □ W4-5 面板真实化
```

### 11.6 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 死代码激活引入回归 | 中 | 高 | 每个激活项配套单元测试 + 集成测试，先测试后激活 |
| 反思引擎增加 LLM 调用成本 | 高 | 中 | 仅在 Evaluator 评分 < 0.7 时触发反思，简单任务跳过 |
| 步骤状态机与现有 LoopState 冲突 | 中 | 高 | StepState 作为 LoopState 的子状态，不替代而是细化 |
| 学习信号管道消费端性能 | 低 | 中 | 信号处理异步化，背压控制，批量消费 |
| 沙箱环境兼容性 | 中 | 中 | Docker 优先 + vm2 降级，Windows 兼容层 |
| 多 Agent 编排复杂度 | 高 | 高 | 先单进程内集成，验证闭环后再考虑跨进程 |

### 11.7 验收总标准

| 维度 | 标准 |
|------|------|
| 功能 | Wave 1-3 所有任务验收标准通过 |
| 测试 | Python 232+ / TS 874+ 测试全部通过，新增测试覆盖所有变更 |
| 性能 | 反思/学习闭环不增加 P50 延迟超过 20% |
| 安全 | 沙箱执行高危命令 100% 隔离，无逃逸 |
| 体验 | 前端消息状态机完整，打字机效果流畅，Thinking 可视化 |

---

## 十二、V5.6 DI 容器架构增强 (2026-08-16)

### 12.1 问题背景

项目中有 **37 个 `getInstance()` 单例类**，分布在 10+ 个子系统中，导致：

1. **测试困难**：单例状态在测试间泄漏，无法隔离
2. **隐式耦合**：单例之间形成隐式依赖图，初始化顺序不可控
3. **不可并行**：无法同时运行多个 Agent 实例（单例全局共享）
4. **无法热替换**：插件卸载/测试 mock 时单例无法释放

### 12.2 DI 容器增强内容

#### DIContainer 核心能力

| 能力 | API | 说明 |
|------|-----|------|
| 三种生命周期 | `lifecycle: 'singleton' \| 'transient' \| 'scoped'` | singleton=全局唯一, transient=每次新建, scoped=作用域内唯一 |
| 作用域隔离 | `beginScope(id)` / `endScope(id)` | 请求级作用域，scoped 依赖在作用域内单例 |
| 依赖声明 | `dependencies: [TOKEN_A, TOKEN_B]` | 注册时声明依赖，validate() 编译期校验 |
| 标签分类 | `tags: ['core', 'security']` | 按标签分组查询，resolveAllByTag() 批量解析 |
| 容器冻结 | `freeze()` / `isFrozen()` | 引导完成后冻结，防止运行时篡改 |
| 拓扑初始化 | `bootstrap(tokens)` | 按依赖拓扑排序顺序初始化 |
| 优雅销毁 | `dispose()` | 反序调用 onDispose 回调，释放资源 |
| 诊断快照 | `snapshot()` | 返回所有注册项的状态快照，用于调试 |
| 循环依赖检测 | `resolve()` 内置 | 解析链追踪，报错时输出完整依赖链 |
| 独立容器 | `DIContainer.create()` | 创建非全局容器，用于测试隔离 |

#### DI_TOKENS 覆盖范围

从 V5.5 的 28 个 Token 扩展到 **60+ 个**，覆盖全部 37 个单例类：

| 子系统 | Token 数 | 示例 |
|--------|---------|------|
| core | 8 | EVENT_BUS, PERSONA_CORE, ACP_ACTIVITY_TRACKER, ... |
| harness | 12 | TOOL_REGISTRY, CONSTRAINTS_SERVICE, VERIFICATION_SERVICE, ... |
| security | 5 | SECURITY_GUARD, SECURITY_POLICY_ENGINE, URL_SAFETY_CHECKER, ... |
| evolution | 4 | EVOLUTION_ENGINE, IMPLICIT_FEEDBACK_COLLECTOR, ... |
| model | 4 | MODEL_MANAGER, MODEL_SELECTOR, MESSAGE_SANITIZER, ... |
| desktop | 9 | WINDOW_MANAGER, SCREEN_CAPTURE, DESKTOP_ACTION_EXECUTOR, ... |
| infrastructure | 6 | TIMER_MANAGER, CONFIG_LOADER, FILE_SYSTEM, ... |
| memory | 2 | PREFERENCE_MANAGER, ... |
| tool | 2 | MCP_TOOL_BRIDGE, LSP_CLIENT_MANAGER |

#### DependencyRegistry 迁移映射

`SINGLETON_MIGRATION_MAP` 登记 37 个单例的迁移状态，包含：

- `className`：单例类名
- `token`：对应的 DI_TOKENS Symbol
- `module`：模块路径
- `tags`：标签分类
- `dependencies`：依赖的其他 Token
- `priority`：初始化优先级（0=基础设施, 1=核心, 2=业务, 3=高级）
- `migrated`：是否已迁移到 DI（当前全部 false，逐步推进）

### 12.3 迁移策略

```
Phase 1 (V5.6 — 当前)        Phase 2 (V5.8)              Phase 3 (V6.0)
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ DIContainer 基础增强  │   │ 高频单例迁移到 DI     │   │ 全部单例迁移完成      │
│ DI_TOKENS 全量覆盖    │ → │ getInstance 委托 DI   │ → │ 移除 getInstance()   │
│ 迁移映射登记          │   │ 新代码强制用 DI       │   │ 废弃 @singleton 装饰  │
│ 测试容器支持          │   │ ESLint 规则强制       │   │ 容器完全接管生命周期  │
└──────────────────────┘   └──────────────────────┘   └──────────────────────┘
```

**迁移优先级**（按影响面排序）：

| 优先级 | 类 | 原因 |
|--------|-----|------|
| P0 | EventBus, TimerManager, ConfigLoader | 全局基础依赖，被 50+ 模块引用 |
| P1 | SecurityGuard, SecurityPolicyEngine | 安全关键路径，测试隔离需求强 |
| P1 | ModelManager, ModelSelector | LLM 调用链核心 |
| P2 | SkillRegistry, MCPToolBridge, LspClientManager | 工具层，测试 mock 需求 |
| P2 | EvolutionOrchestrator, ImplicitFeedbackCollector | 进化层，已部分迁移 Python |
| P3 | Desktop* 系列 | 桌面自动化，相对独立 |

### 12.4 使用示例

#### 生产环境：通过 DI 容器获取依赖

```typescript
import { DIContainer, DI_TOKENS } from '../shared/DIContainer';

// 解析依赖（自动按生命周期管理）
const eventBus = await DIContainer.getInstance().resolve<JiabaixingEventBus>(DI_TOKENS.EVENT_BUS);
```

#### 测试环境：独立容器 + mock

```typescript
import { DIContainer, DI_TOKENS } from '../shared/DIContainer';

// 创建独立容器，不影响全局
const testContainer = DIContainer.create();
testContainer.registerValue(DI_TOKENS.EVENT_BUS, mockEventBus);
testContainer.registerValue(DI_TOKENS.LLM_PROVIDER, mockLLM);

// 作用域隔离
testContainer.beginScope('test-session-1');
const result = await testContainer.resolve(DI_TOKENS.TOOL_REGISTRY);
testContainer.endScope('test-session-1');
```

#### 引导 + 冻结

```typescript
import { bootstrapContainer, DI_TOKENS } from '../shared/DependencyRegistry';

const container = DIContainer.getInstance();
await registerCoreDependencies();
// ... 注册更多依赖
await bootstrapContainer(container, [
  DI_TOKENS.EVENT_BUS,
  DI_TOKENS.TOOL_REGISTRY,
  DI_TOKENS.CONSTRAINTS_SERVICE,
]);
// 容器已冻结，后续 register() 会抛错
```

---

**文档版本**: 2.2
**创建日期**: 2026-06-14
**最后更新**: 2026-08-16
**维护者**: 家百星开发团队
**下次审查**: 2026-09-01
