# Jiabaixing Code Wiki

> **版本**: 5.0 | **语言**: TypeScript (ES2022) | **运行时**: Node.js ≥20.x | **架构模式**: Harness Agent Framework 六维管控（E-T-C-S-L-V）

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 整体架构](#2-整体架构)
- [3. 目录结构](#3-目录结构)
- [4. 核心模块详解](#4-核心模块详解)
  - [4.1 核心推理引擎 (core)](#41-核心推理引擎-core)
  - [4.2 Harness 六层框架 (harness)](#42-harness-六层框架-harness)
  - [4.3 记忆引擎 (memory)](#43-记忆引擎-memory)
  - [4.4 模型层 (models)](#44-模型层-models)
  - [4.5 交互引擎 (interaction)](#45-交互引擎-interaction)
  - [4.6 人设引擎 (persona)](#46-人设引擎-persona)
  - [4.7 技能系统 (skills)](#47-技能系统-skills)
  - [4.8 进化引擎 (evolution)](#48-进化引擎-evolution)
  - [4.9 安全模块 (security)](#49-安全模块-security)
  - [4.10 多模态感知 (multimodal)](#410-多模态感知-multimodal)
  - [4.11 桌面代理 (desktop)](#411-桌面代理-desktop)
  - [4.12 集成网关 (integration)](#412-集成网关-integration)
  - [4.13 共享基础设施 (shared)](#413-共享基础设施-shared)
  - [4.14 服务器层 (server)](#414-服务器层-server)
  - [4.15 前端应用 (frontend)](#415-前端应用-frontend)
  - [4.16 硬件接入 (hardware)](#416-硬件接入-hardware)
- [5. 依赖关系图](#5-依赖关系图)
- [6. API端点总览](#6-api端点总览)
- [7. 事件总线 (EventBus)](#7-事件总线-eventbus)
- [8. 数据存储](#8-数据存储)
- [9. 项目运行方式](#9-项目运行方式)
- [10. 环境配置](#10-环境配置)
- [11. 测试体系](#11-测试体系)
- [12. CI/CD](#12-cicd)

---

## 1. 项目概述

**Jiabaixing（家百星）** 是一个生产级综合智能体（Agent）系统，融合 AI 对话、桌面控制、定时调度、自我进化、多平台消息网关于一体。系统采用 **Harness Agent Framework（V5.0）** 架构，核心理念源自 Harness Engineering：

> **"Agent = (LLM 推理内核 + 能力组件) × Harness 管控系统"**

不是依赖单一模型的智能，而是通过一套完整的工程管控系统（Harness），将 LLM 的不确定性封装在确定性的运行框架之内，确保 AI 的能力能够稳定、可控地转化为生产力。

### 核心特性

| 特性 | 说明 | Harness 对应 |
|------|------|-------------|
| Harness 六维管控 | E-T-C-S-L-V 六层操作系统级管控 | 全部六层 |
| LLM 原生架构 | LLM 做认知决策，Harness 做工程管控 | E — Execution Loop |
| 声明式工具 | 8 类 25 个 JSON Schema 定义的工具 | T — Tool Registry |
| 可组合上下文管道 | 宪法 Prompt + 记忆 + 动态上下文 + 历史 | C — Context Manager |
| 三层记忆持久化 | 瞬时 / 短期 / 长期 + SQLite + ChromaDB | S — State Store |
| 9 个生命周期钩子 | 工具调用前后拦截、权限验证、策略执行 | L — Lifecycle Hooks |
| 五维质量评分 | accuracy / usefulness / friendliness / efficiency / overall | V — Evaluation Interface |
| 四维预算控制 | 软限制(4轮) + 硬限制(8轮) + Token(4500/6000) + 时间(60s) | L — Constraints |
| 自我进化 | 四闭环进化编排（进化引擎+工具推荐+LLM提供者+人设调整） | V → Evolution |
| 多平台网关 | 微信(扫码+API) / QQ / 飞书 / 钉钉 | Gateway Layer |
| 桌面代理 | 屏幕截图、OCR、UI检查、鼠标键盘自动化 | T — Desktop Tools |
| 拟人化交互 | 人设引擎+情感分析+主动消息+语音合成 | C — Persona |
| 安全管控 | 输入验证、Prompt注入检测、权限管理、数据主权 | L + V + Security |
| 实时通信 | WebSocket双向通信 + EventBus事件驱动 | Gateway Layer |

### V5.0 架构原理 (2026-05-27)

V5.0 基于 Harness Engineering 的六维管控思想，将 Agent 运行时拆解为六个确定性子系统：

**原理1 — 确定性封装**：用工程系统的确定性来管理和约束模型的不确定性。
```
Agent = (LLM推理内核 + 能力组件) × Harness管控系统
模型是"发动机"，Harness是"缰绳"和"底盘"
```

**原理2 — 渐进替换**：不推翻重来，新引擎逐步替换旧引擎。
```
v3.3:  Preprocessor → LLM Core → Postprocessor
V5.0:  统一通过 JiabaixingCore → AgentHarness → LoopController
```

**原理3 — 契约驱动**：前后端共享 [shared/contracts.ts](file:///c:/zy/jiabaixing/src/shared/contracts.ts)，所有 API 端点、WS 事件、数据模型只有一份定义。

**原理4 — 事件驱动解耦**：
```
EventBus.emit('response_ready')
  → eventBusSetup.ts 桥接 (14个事件)
  → WebSocket broadcast
  → 前端 useWebSocket hook
  → Zustand Store 更新
  → React 重新渲染
```

**原理5 — 自觉降级（多层安全网）**：
```typescript
// JiabaixingCore.processInput() 执行路径
if (harness && harness.useHarnessLoop) {
  try { return harness.processInput(); }  // 主路径 — Harness六层Agent
  catch { /* 降级到基础处理 */ }
}
// 降级兜底处理
```

**Harness 在执行架构中的位置**：
```
processInput()
  → Harness.processInput() ← V5.0主路径
      ├─ E — Loop: Planner→Executor→Evaluator→Reporter
      ├─ T — Tools: 8类25个声明式工具
      ├─ C — Context: 宪法+记忆+动态上下文
      ├─ S — Persistence: 跨会话任务状态
      ├─ V — Verification: 结果验证+安全检查+质量评分
      └─ L — Constraints: 预算控制+权限检查+9个生命周期钩子
```

**EventBus → 前端 WebSocket 事件映射**：
| EventBus事件 | WS事件名 | 前端Store |
|-------------|---------|----------|
| `response_ready` | `response_ready` | useChatStore |
| `brain_stage_update` | `brain_stage_update` | useAgentStore |
| `tool_trace` | `tool_trace` | useAgentStore |
| `agent_execution_update` | `agent_execution_update` | useAgentStore |
| `evolution_event` | `evolution_event` | useEvolutionStore |
| `clarification_request` | `clarification_request` | useAgentStore |
| `execution_preview` | `execution_preview` | useAgentStore |
| `skill_execution_update` | `skill_execution_update` | useSkillStore |
| `perception_update` | `perception_update` | useAgentStore |
| `proactive_message` | `proactive_message` | useChatStore |
| `weight_update` | `weight_update` | useSkillStore |
| `server_log` | `server_log` | useMonitorStore |

### V5.0 重构完成 (2026-05-27)

**已删除（~63,000行死代码）**：
- `src/tools/` 整个目录（旧版工具系统）
- `src/ide/` 整个目录（IDE集成模块）
- `src/core/DirectExecutor.ts`（直接执行器，功能已移入Harness）
- `src/core/FCLoopHelper.ts`（FC循环辅助，已由TokenBudgetAllocator替代）
- `src/core/SceneAnalyzer.ts`（场景分析，已移入multimodal模块）
- `src/core/SecurityChecker.ts`（安全检查，已移入security模块）
- `src/core/ExecutionTracer.ts`（执行追踪，已由LoopContext替代）
- `src/core/ProactiveMessageGenerator.ts`（主动消息，已由Scheduler替代）
- `src/core/ProactiveTriggerEngine.ts`（触发引擎，已由EvolutionOrchestrator替代）
- `src/core/MemoryDrivenTrigger.ts`（记忆驱动，已由MemoryAssistant替代）
- `src/core/AgentSelfReflection.ts`（自我反思，已由evaluator实现）
- `src/core/MultiObjectiveTaskCoordinator.ts`（多目标协调，已由DAGTask替代）
- `src/core/FileEditManager.ts`（文件编辑，已由工具系统实现）
- `src/core/InfrastructureToolRegistrar.ts`（工具注册，已由registerHarnessTools.ts替代）
- `src/shared/ServiceContainer.ts`（服务容器，已由直接注入替代）
- `src/llm/FunctionCallingAdapter.ts`（FC适配器，功能已移入LLMProvider）
- `src/multimodal/SpeechProcessor.ts`（语音处理，待实现）
- `src/multimodal/VisionEngine.ts`（视觉引擎，待实现）
- `src/desktop/OCRService.ts`（OCR服务，待实现）
- `src/evolution/SelfHealingEngine.ts`（自我修复，待实现）
- `src/evolution/SelfRefactorEngine.ts`（自我重构，待实现）
- `src/evolution/ToolRecommendationEngine.ts`（工具推荐，待实现）
- `src/memory/MemoryAssociationNetwork.ts`（记忆关联，测试用）
- `src/memory/SQLiteMemoryStore.ts`（SQLite存储，已由MemoryEngine整合）
- `src/skills/SkillBridge.ts`（技能桥接，已由双写兼容替代）
- `src/skills/ExternalSkillManager.ts`（外部技能管理，待实现）

**已重构完成**：
- ✅ V5.0 统一架构：JiabaixingCore → AgentHarness → LoopController
- ✅ Phase 8: Harness Agent Framework 100%完成
- ✅ Phase 9: Full Integration 100%完成
- ✅ TS编译错误：~40个 → 0个
- ✅ 网关消息完整送入 Harness：GatewayBridge 进程隔离 + EventBus 路由
- ✅ 前端 @shared/contracts 模块解析：craco + ModuleScopePlugin 移除
- ✅ CLI 完整功能：start/stop/chat/gateway/schedule/config/status/web
- ✅ 启动日志优化：CONSOLE_LOG_LEVEL=warn + 移除重复初始化

### 当前阶段

| 阶段 | 目标 | 完成度 | 状态 |
|------|------|--------|------|
| Phase 1-7: Foundation | LLM-First, FC loop, 预算, 记忆, 主动触发 | 100% | ✅ 完成 |
| Phase 8: Harness Framework | 六维 E-T-C-S-L-V 架构 | 100% | ✅ 完成 |
| Phase 9: Full Integration | Harness 全通路集成 | 100% | ✅ 完成 |
| Phase 9.5: Evaluator独立化 | 独立评估服务，解决自我评价失真问题 | 100% | ✅ 完成 |
| Phase 10: Multi-Agent | 多Agent协同 + 任务拆解 | 0% | 📋 规划中 |
| Phase 11: Self-Evaluation | 自动评估 + Golden Eval Set | 0% | 📋 规划中 |
| Phase 12: Docker + K8s | 容器化部署 | 0% | 📋 规划中 |

### 已知债务

| 债务 | 详情 | 优先级 |
|------|------|--------|
| 无Golden Eval Set | 缺少结构化的真实失败案例评估数据集 | P1 |
| 无全轨迹审计 | 仅记录工具输出，不记录每步完整上下文快照 | P1 |
| 无Context Compaction | 无上下文压缩机制，长对话会Token爆炸 | P2 |
| `as unknown as` | ~91处类型不安全转换，需逐步清理 | P3 |
| 部分巨型文件 | JiabaixingCore.ts等文件较长，待拆分 | 长期 |

---

### P0 任务完成: Evaluator 独立化 ✅

**完成时间**: 2026-05-17  
**目标**: 解决VerificationService与执行耦合导致的自我评价失真问题

**解决方案**:
- 创建独立的 `IndependentEvaluationService` ([evaluation/IndependentEvaluationService.ts](file:///c:/zy/jiabaixing/src/harness/evaluation/IndependentEvaluationService.ts))
- 重构 `Evaluator` ([loop/Evaluator.ts](file:///c:/zy/jiabaixing/src/harness/loop/Evaluator.ts)) 成为适配器模式
- 在 `AgentHarness` 中集成独立评估服务，支持通过 `useIndependentEvaluator` 配置开关

**核心特性**:
- 规则评估：不依赖LLM的快速检查
- LLM深度评估：可选择的智能评估
- 完整质量评分：任务完成度、数据真实性、安全性、质量分数
- 向后兼容：保持现有接口不变

---

## 2. 整体架构

系统采用 **Harness Agent Framework 六维管控架构**，初始化按12步顺序执行：

```
┌──────────────────────────────────────────────────────────────┐
│                     Gateway Layer（接入层）                    │
│  Express HTTP + WebSocket + 4平台统一网关                      │
│  微信(扫码+API) / QQ(Mirai) / 飞书 / 钉钉                     │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────┴───────────────────────────────┐
│               Agent Harness（六维管控核心）                     │
│                                                               │
│  E — Execution Loop（执行循环）— "心跳"                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Planner → Executor → Evaluator → Reporter              │  │
│  │  观察-思考-行动 循环，任务轮次、终止条件与错误恢复        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  T — Tool Registry（工具注册表）— "能力清单"                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  8类25个声明式工具 · Schema验证 · 权限分级               │  │
│  │  memory / file / code / desktop / cognition / system    │  │
│  │  daily / network                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  C — Context Manager（上下文管理器）— "记忆管家"              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  宪法Prompt · 记忆检索 · 动态上下文 · 对话历史           │  │
│  │  可组合上下文管道 + Token预算分配器（6桶）               │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  S — State Store（状态存储）— "内存与硬盘"                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  任务状态 + 会话历史 + 用户画像 + 进化指标               │  │
│  │  瞬时/短期/长期三层记忆 · SQLite + ChromaDB              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  L — Lifecycle Hooks（生命周期钩子）— "关卡守卫"             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  9个钩子 · 身份验证 · 策略执行 · 日志记录                │  │
│  │  预算控制(软4/硬8/Token4500/时间60s) + 权限检查          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  V — Evaluation Interface（评估接口）— "成绩单与仪表盘"      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  工具结果验证 · 安全检查 · 五维质量评分 · 目标达成度     │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────┴───────────────────────────────┐
│               Infrastructure Layer（设施层）                   │
│  模型管理 / 调度器 / 进化引擎 / 安全 / 技能 / 记忆引擎        │
└───────────────────────────────────────────────────────────────┘
```

### 三层管控平面

```
┌──────────────────────────────────────────────────┐
│              管控平面（Control Plane）              │
│  约束服务(L) · 验证服务(V) · 进化引擎 · 安全审计   │
│  人类驾驭者在此定义目标、制定规则、审核输出        │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────┐
│              执行平面（Execution Plane）            │
│  循环控制器(E) · 工具注册表(T) · 上下文管理器(C)   │
│  持久化服务(S) · Plan-Execute-Evaluate 循环        │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────┐
│              推理平面（Inference Plane）            │
│  LLMProvider · Constitutional Prompt · FC 循环    │
│  模型在此做出所有认知决策                        │
└──────────────────────────────────────────────────┘
```

### 初始化流程（对应 bootstrap.ts 实际执行）

```
1.  核心引擎 (LLMProvider)
2.  安全模块 (SecurityManager, NetworkGuard, DataSovereigntyPipeline)
3.  数据库 (SQLite, MemoryEngine, VectorDB)
4.  交互模块 (EmojiManager)
5.  技能系统 (SkillRegistry + Harness双写兼容)
6.  推理引擎 (InteractionEngine, EmotionAnalyzer, ContinuousDialogManager)
7.  核心初始化 (JiabaixingCore + OptimizationScheduler)
8.  场景感知调度器 (ScenarioAwareScheduler)
9.  进化引擎 (EvolutionEngine, EvolutionOrchestrator)
10. Harness Agent Framework (AgentHarness 六层架构，6开关全部启用)
11. 网关进程隔离 (GatewayBridge → GatewayWorker)
```

---

## 3. 目录结构

```
jiabaixing/
├── src/                          # 源码根目录
│   ├── main.ts                   # 唯一入口，启动Express+WebSocket服务器
│   ├── cli.ts                    # CLI终端入口
│   ├── core/                     # 核心推理引擎 + 调度器
│   │   ├── index.ts              # 核心模块导出
│   │   ├── JiabaixingCore.ts     # 系统总控，Harness路由
│   │   ├── ConstitutionPromptBuilder.ts  # 宪法Prompt构建
│   │   ├── ConversationHistoryManager.ts  # 对话历史管理
│   │   ├── MemoryAssistant.ts    # 记忆辅助
│   │   ├── ScenarioAwareScheduler.ts      # 场景感知调度
│   │   ├── OptimizationScheduler.ts       # 优化调度
│   │   ├── DAGTask.ts            # DAG任务
│   │   ├── TaskComplexityAnalyzer.ts      # 任务复杂度分析
│   │   ├── DynamicTaskAdjuster.ts         # 动态任务调整
│   │   ├── UnifiedContextPipeline.ts      # 统一上下文管道
│   │   └── ModelInterface.ts     # 模型接口
│   ├── harness/                  # ★ V5.0 Harness六层框架（E-T-C-S-L-V）
│   │   ├── index.ts              # Harness导出
│   │   ├── AgentHarness.ts       # 六层组装入口，依赖注入
│   │   ├── types.ts              # 核心类型定义（6层所有接口）
│   │   ├── loop/                 # E — Execution Loop（循环层）
│   │   │   ├── LoopController.ts # Plan-Execute-Evaluate状态机
│   │   │   ├── Planner.ts        # LLM驱动任务规划
│   │   │   ├── Executor.ts       # FC循环执行
│   │   │   ├── Evaluator.ts      # 目标达成度评估
│   │   │   └── Reporter.ts       # 响应生成+质量评分
│   │   ├── tools/                # T — Tool Registry（工具层，8类25工具）
│   │   │   ├── registry/         # 工具注册与验证
│   │   │   │   ├── ToolRegistry.ts       # 工具注册表
│   │   │   │   ├── SchemaValidator.ts    # JSON Schema验证
│   │   │   │   └── PermissionGuard.ts    # 权限分级检查
│   │   │   ├── memory/           # 记忆类工具
│   │   │   ├── cognition/        # 认知类工具
│   │   │   ├── desktop/          # 桌面类工具
│   │   │   ├── file/             # 文件类工具
│   │   │   ├── code/             # 代码类工具
│   │   │   ├── system/           # 系统类工具
│   │   │   ├── daily/            # 日常类工具
│   │   │   ├── network/          # 网络类工具
│   │   │   └── registerHarnessTools.ts  # 工具注册入口
│   │   ├── context/              # C — Context Manager（上下文层）
│   │   │   ├── ContextManager.ts # 可组合上下文管道
│   │   │   └── TokenBudgetAllocator.ts   # Token预算分配器（6桶）
│   │   ├── persistence/          # S — State Store（持久化层）
│   │   │   ├── PersistenceService.ts     # 统一持久化服务
│   │   │   ├── TrajectoryDatabase.ts     # 轨迹数据库
│   │   │   └── TrajectoryQueryService.ts # 轨迹查询服务
│   │   ├── verification/         # V — Evaluation Interface（验证层）
│   │   │   └── VerificationService.ts    # 验证+安全检查+质量评分
│   │   ├── constraints/          # L — Lifecycle Hooks（约束层）
│   │   │   └── ConstraintsService.ts     # 预算控制+权限检查+9个钩子
│   │   └── evaluation/           # 评估模块
│   │       ├── EvalRunner.ts     # 评估运行器
│   │       ├── EvalTypes.ts      # 评估类型定义
│   │       ├── StepEvaluator.ts  # 步骤评估器
│   │       └── IndependentEvaluationService.ts # P0: 独立评估服务（解决自我评价失真）
│   ├── integration/              # 集成网关（4平台统一网关）
│   │   ├── index.ts              # 集成模块导出
│   │   ├── IntegrationManager.ts # 单例管理所有适配器
│   │   ├── GatewayBridge.ts      # IPC桥接器，进程隔离
│   │   ├── gatewayWorker.ts      # 网关独立进程入口
│   │   ├── TRAEOptimizationIntegrator.ts  # TRAE优化集成器
│   │   └── adapters/             # 平台适配器
│   ├── memory/                   # 全生命周期记忆引擎
│   │   ├── index.ts              # 记忆模块导出
│   │   ├── MemoryEngine.ts       # 记忆引擎核心
│   │   ├── BaseMemoryStore.ts    # 基础记忆存储
│   │   ├── ShortTermMemory.ts    # 短期记忆
│   │   ├── LongTermMemory.ts     # 长期记忆
│   │   ├── MemoryRetriever.ts    # 混合检索器
│   │   ├── MemoryTracker.ts      # 记忆验证+追踪
│   │   ├── KnowledgeGraphBuilder.ts  # 知识图谱构建
│   │   ├── ConversationCompressor.ts  # 对话压缩
│   │   ├── ChromaVectorDatabase.ts    # ChromaDB向量数据库
│   │   ├── VectorDatabaseFactory.ts   # 向量数据库工厂
│   │   ├── VectorDatabase.ts     # 向量数据库接口
│   │   ├── VectorDatabaseInterface.ts  # 向量数据库接口
│   │   ├── InMemoryVectorIndex.ts  # 内存向量索引
│   │   ├── PersistentVectorDatabase.ts  # 持久化向量数据库
│   │   ├── PreferenceManager.ts  # 偏好管理器
│   │   ├── PreferenceInjector.ts # 偏好注入器
│   │   ├── UserProfile.ts        # 用户画像
│   │   ├── MemoryEncryption.ts   # 记忆加密
│   │   ├── Database.ts           # 数据库基础
│   │   └── ChineseTokenizer.ts   # 中文分词器
│   ├── models/                   # LLM模型层
│   │   ├── index.ts              # 模型模块导出
│   │   ├── LLMProvider.ts        # LLM提供者
│   │   ├── LLMResponseCache.ts   # LLM响应缓存
│   │   ├── RequestQueue.ts       # 请求队列
│   │   ├── PromptOptimizer.ts    # Prompt优化器
│   │   ├── ModelManager.ts       # 模型管理器
│   │   ├── ModelSelector.ts      # 模型选择器
│   │   ├── MultiModelLLMProvider.ts  # 多模型LLM提供者
│   │   ├── OpenAICompatibleModel.ts  # OpenAI兼容模型
│   │   ├── LlamaCppModel.ts      # LlamaCpp模型
│   │   ├── ModelInterface.ts     # 模型接口
│   │   └── types.ts              # 模型类型定义
│   ├── interaction/              # 交互引擎
│   │   ├── InteractionEngine.ts  # 交互引擎核心
│   │   ├── ContinuousDialogManager.ts  # 连续对话管理
│   │   ├── EmojiManager.ts       # 表情管理
│   │   └── SpeechSynthesizer.ts  # 语音合成
│   ├── persona/                  # 人设引擎
│   │   ├── index.ts              # 人设模块导出
│   │   ├── PersonaCore.ts        # 人设核心
│   │   ├── PersonaRules.ts       # 人设规则
│   │   └── DialogueGenerator.ts  # 对话生成器（降级模式）
│   ├── skills/                   # 技能系统（与Harness双写兼容）
│   │   ├── index.ts              # 技能模块导出
│   │   ├── SkillInterface.ts     # 技能接口
│   │   └── SkillRegistry.ts      # 技能注册中心（单例）
│   ├── evolution/                # 进化引擎
│   │   ├── index.ts              # 进化模块导出
│   │   ├── EvolutionOrchestrator.ts  # 进化编排器
│   │   ├── EvolutionEngine.ts    # 进化引擎
│   │   ├── FeedbackCollector.ts  # 反馈收集器
│   │   ├── StrategyOptimizer.ts  # 策略优化器
│   │   ├── OptimizationResultDispatcher.ts  # 优化结果分发器
│   │   └── decision/             # 决策模块
│   │       └── OptimizationAdvisor.ts  # 优化顾问
│   ├── security/                 # 安全模块
│   │   ├── SecurityManager.ts    # 安全管理器
│   │   ├── SecurityGuard.ts      # 安全守卫
│   │   ├── NetworkGuard.ts       # 网络守卫
│   │   ├── AuthenticationManager.ts  # 认证管理器
│   │   ├── EncryptionManager.ts  # 加密管理器
│   │   ├── DataSovereigntyPipeline.ts  # 数据主权管道
│   │   ├── SecurityPolicyEngine.ts  # 安全策略引擎
│   │   ├── AuditLogger.ts        # 审计日志
│   │   └── types.ts              # 安全类型定义
│   ├── multimodal/               # 多模态感知
│   │   ├── EmotionAnalyzer.ts    # 情感分析
│   │   ├── SceneRecognizer.ts    # 场景识别
│   │   ├── EnvironmentPerceptionEngine.ts  # 环境感知引擎
│   │   └── MultimodalInput.ts    # 多模态输入
│   ├── desktop/                  # 桌面代理
│   │   ├── index.ts              # 桌面模块导出
│   │   ├── DesktopAgentLoop.ts   # 桌面代理循环
│   │   ├── DesktopActionExecutor.ts  # 桌面动作执行器
│   │   ├── DesktopUIInspector.ts # 桌面UI检查器
│   │   ├── DesktopVisionEngine.ts  # 桌面视觉引擎
│   │   ├── StateSnapshotManager.ts  # 状态快照管理器
│   │   ├── ScreenCapture.ts      # 屏幕截图
│   │   ├── WindowManager.ts      # 窗口管理器
│   │   ├── SystemInput.ts        # 系统输入
│   │   └── ElementMatcher.ts     # 元素匹配器
│   ├── hardware/                 # 硬件接入
│   │   ├── DeviceManager.ts      # 设备管理器
│   │   ├── DeviceDiscovery.ts    # 设备发现
│   │   ├── LocalDeviceAccess.ts  # 本地设备访问
│   │   ├── AudioVideoDeviceAccess.ts  # 音视频设备访问
│   │   ├── SmartHomeManager.ts   # 智能家居管理器
│   │   ├── protocols/            # 协议模块
│   │   │   ├── DeviceProtocol.ts  # 设备协议
│   │   │   └── HomeAssistantProtocol.ts  # HomeAssistant协议
│   │   └── types.ts              # 硬件类型定义
│   ├── shared/                   # 共享基础设施
│   │   ├── EventBus.ts           # 事件总线（单例）
│   │   └── contracts.ts          # 前后端共享契约
│   ├── server/                   # 服务器层
│   │   ├── bootstrap.ts          # 系统启动引导
│   │   ├── websocket.ts          # WebSocket服务设置
│   │   ├── eventBusSetup.ts      # EventBus与WebSocket桥接
│   │   ├── shutdown.ts           # 优雅关闭
│   │   └── routes/               # 路由模块
│   │       ├── coreRoutes.ts     # 核心API
│   │       ├── evolutionRoutes.ts  # 进化API
│   │       ├── memoryRoutes.ts   # 记忆API
│   │       ├── securityRoutes.ts # 安全API
│   │       ├── skillRoutes.ts    # 技能API
│   │       ├── performanceRoutes.ts  # 性能API
│   │       ├── integrationRoutes.ts  # 集成API
│   │       ├── systemStateRoutes.ts  # 系统状态API
│   │       ├── debugRoutes.ts    # 调试API
│   │       └── traeRoutes.ts     # TRAE API
│   ├── frontend/                 # 前端React应用
│   │   ├── public/               # 静态资源
│   │   ├── src/                  # 前端源码
│   │   │   ├── components/       # React组件
│   │   │   ├── stores/           # Zustand状态管理
│   │   │   ├── contexts/         # React Context
│   │   │   ├── hooks/            # React Hooks
│   │   │   ├── api/              # API客户端
│   │   │   ├── utils/            # 工具函数
│   │   │   ├── styles/           # 样式文件
│   │   │   ├── types/            # TypeScript类型
│   │   │   ├── App.tsx           # 应用入口组件
│   │   │   └── index.tsx         # React渲染入口
│   │   ├── electron/             # Electron主进程
│   │   │   └── main.js           # Electron入口
│   │   ├── package.json          # 前端依赖
│   │   ├── craco.config.js       # CRA配置覆盖
│   │   ├── tsconfig.json         # TypeScript配置
│   │   ├── .eslintrc.json        # ESLint配置
│   │   ├── .prettierrc.json      # Prettier配置
│   │   └── jest.config.js        # Jest配置
│   ├── config/                   # 配置管理
│   │   ├── ConfigLoader.ts       # 配置加载器
│   │   ├── default.config.ts     # 默认配置
│   │   └── server.config.ts      # 服务器配置
│   ├── monitoring/               # 监控模块
│   │   ├── index.ts              # 监控模块导出
│   │   ├── PerformanceMonitor.ts # 性能监控
│   │   └── SecurityAuditor.ts    # 安全审计
│   ├── io/                       # 文件系统
│   │   └── FileSystem.ts         # 文件系统操作
│   ├── llm/                      # LLM辅助模块
│   │   ├── index.ts              # LLM模块导出
│   │   ├── ModelCapabilityDetector.ts  # 模型能力检测
│   │   ├── PromptTemplateEngine.ts  # Prompt模板引擎
│   │   ├── StreamingResponseHandler.ts  # 流式响应处理
│   │   └── TokenBudgetManager.ts  # Token预算管理
│   ├── mcp/                      # MCP协议
│   │   ├── index.ts              # MCP模块导出
│   │   └── MCPServerManager.ts   # MCP服务器管理器
│   ├── routes/                   # 路由模块（旧，待迁移）
│   │   ├── tasks.ts              # 任务路由
│   │   └── automation.ts         # 自动化路由
│   ├── user/                     # 用户画像
│   │   ├── UserProfileSystem.ts  # 用户画像系统
│   │   ├── ProfileEvolutionManager.ts  # 画像进化管理器
│   │   ├── ProfileTrendAnalyzer.ts  # 画像趋势分析器
│   │   └── types.ts              # 用户类型定义
│   ├── utils/                    # 工具函数
│   │   ├── Logger.ts             # 日志工具
│   │   ├── EnvironmentManager.ts # 环境管理
│   │   ├── TimerManager.ts       # 定时器管理
│   │   └── worker.js             # Worker脚本
│   └── types/                    # 类型声明
│       ├── chromadb.d.ts         # ChromaDB类型
│       ├── ffi-napi.d.ts         # FFI类型
│       ├── ref-napi.d.ts         # Ref类型
│       └── screenshot-desktop.d.ts  # 截图类型
├── tests/                        # 测试文件
│   ├── harness/                  # Harness专项测试（132个用例）
│   ├── unit/                     # 单元测试
│   ├── integration/              # 集成测试
│   ├── e2e/                      # 端到端测试
│   ├── stress/                   # 压力测试
│   ├── acceptance/               # 验收测试
│   ├── coordination/             # 协调测试
│   ├── eval/                     # 评估测试
│   ├── reports/                  # 测试报告
│   ├── __mocks__/                # 测试模拟
│   ├── setup.ts                  # 测试设置
│   ├── phase1-optimization.test.ts  # 阶段1优化测试
│   ├── phase2-intelligence.test.ts  # 阶段2智能测试
│   ├── phase3-autonomy.test.ts   # 阶段3自治测试
│   ├── phase4-integration.test.ts  # 阶段4集成测试
│   ├── TEST_PLAN.md              # 测试计划
│   └── ACCEPTANCE_CRITERIA.md    # 验收标准
├── data/                         # 运行时数据
│   ├── persistence/              # 持久化数据
│   ├── evolution/                # 进化数据
│   ├── feedback/                 # 反馈数据
│   ├── keys/                     # 密钥数据
│   ├── security/                 # 安全数据
│   ├── sync-cache/               # 同步缓存
│   ├── test-profiles/            # 测试配置
│   ├── test-vectors/             # 测试向量
│   ├── trajectory/               # 轨迹数据
│   ├── eval/                     # 评估数据
│   │   ├── reports/              # 评估报告
│   │   └── cases-v1.json         # 评估用例v1
│   ├── user_profile.json         # 用户画像
│   ├── short_term_memory.json    # 短期记忆
│   ├── conversation_state.json   # 对话状态
│   ├── event_bus.db              # 事件总线数据库
│   ├── jiabaixing_memory.db      # 家百星记忆数据库
│   ├── long_term_memory_sqlite.db  # 长期记忆SQLite
│   ├── memory.db                 # 记忆数据库
│   ├── sovereignty_audit.db      # 主权审计数据库
│   ├── vectors.db                # 向量数据库
│   ├── weights.db                # 权重数据库
│   └── optimization_metrics.json # 优化指标
├── docs/                         # 文档
│   ├── development/              # 开发文档
│   ├── integration/              # 集成文档
│   ├── knowledge-base/           # 知识库
│   ├── testing/                  # 测试文档
│   ├── AGI助手/                  # AGI相关
│   ├── 训练资源/                 # 训练资源
│   ├── V5_FRONTEND_UI_PLAN.md    # V5前端UI计划
│   ├── 2026-05-24-v5-harness-full-integration.md  # V5全集成
│   ├── 2026-05-25-v5-architecture-simplification.md  # V5架构简化
│   ├── 400_UI_INTERACTION_TASKS.md  # UI交互任务
│   ├── 500_AGENT_COMPREHENSIVE_TASKS.md  # Agent综合任务
│   ├── ARCHITECTURE_ANALYSIS.md  # 架构分析
│   ├── CORRECTED_INTEGRATION_STRATEGY.md  # 集成策略
│   ├── DEEP_INTEGRATION_GUIDE.md  # 深度集成指南
│   ├── DEEP_INTEGRATION_PLAN_V2.md  # V2集成计划
│   ├── DEVELOPMENT_ASSESSMENT_PLAN.md  # 开发评估计划
│   ├── EXISTING_ARCHITECTURE_ANALYSIS.md  # 现有架构分析
│   ├── FINAL_INTEGRATION_REPORT.md  # 最终集成报告
│   ├── IMPLEMENTATION_GUIDE.md   # 实现指南
│   ├── IMPROVEMENT_SUMMARY.md    # 改进总结
│   ├── INTEGRATION_COMPLETION_REPORT.md  # 集成完成报告
│   ├── LLM_SERVER_VSCODE_INTEGRATION.md  # LLM服务器VSCode集成
│   ├── UI_TEST_SUITE.md          # UI测试套件
│   ├── UI_TEST_EXECUTION_REPORT.md  # UI测试执行报告
│   ├── 三大核心能力分析与优化方案.md
│   ├── 功能完成情况与使用数据验证报告.md
│   ├── 性能优化与P2完成度报告.md
│   ├── 质量检查报告_模块交互与AGENT闭环.md
│   ├── 数据流图.md
│   ├── 数据流图.svg
│   ├── 整合.md
│   ├── 优化.md
│   ├── 优化.txt
│   ├── 测试任务-VIBE_CODING集成.md
│   ├── agent_workflow_mindmap.html
│   ├── agent_vs_manes_comparison.html
│   ├── dependency-and-logging-standardization.md
│   ├── jiabaixing-evolution-plan.html
│   ├── jiabaixing.md
│   ├── startup_log.txt
│   ├── startup_log2.txt
│   └── v5-audit-dashboard.html
├── scripts/                      # 脚本工具
│   ├── auto-fix-linting.js       # 自动修复Lint
│   ├── code-stats.js             # 代码统计
│   ├── debug-check.js            # 调试检查
│   ├── dependency-audit.js       # 依赖审计
│   ├── diagnostic.js             # 诊断
│   ├── evolution-nightly-analysis.js  # 进化夜间分析（JS）
│   ├── evolution-nightly-analysis.ts  # 进化夜间分析（TS）
│   ├── optimization-check.ts     # 优化检查
│   ├── pre-commit.js             # 预提交脚本
│   ├── pre-commit.sh             # 预提交脚本（Shell）
│   └── run-optimization-check.js  # 运行优化检查
├── .trae/                        # TRAE相关
│   ├── documents/                # TRAE文档
│   ├── skills/                   # TRAE技能
│   ├── rules/                    # TRAE规则
│   ├── INTEGRATION_COMPLETION_REPORT.md
│   ├── TRAE_INTEGRATION_GUIDE.md
│   ├── TRAE_OPTIMIZATION_REPORT.md
│   ├── config.json               # TRAE配置
│   └── yhjh.txt
├── .github/                      # GitHub配置
│   └── workflows/                # GitHub Actions工作流
│       ├── backend-ci-cd.yml     # 后端CI/CD
│       └── frontend-ci-cd.yml    # 前端CI/CD
├── .claude/                      # Claude配置
│   ├── settings.json             # Claude设置
│   └── settings.local.json       # Claude本地设置
├── .vscode/                      # VSCode配置
│   ├── DEBUG_GUIDE.md            # 调试指南
│   ├── extensions.json           # 推荐扩展
│   ├── launch.json               # 调试配置
│   ├── settings.json             # 编辑器设置
│   └── tasks.json                # 任务配置
├── tmp/                          # 临时文件
├── dist/                         # 编译输出
├── .env                          # 环境变量（不提交）
├── .env.example                  # 环境变量示例
├── .gitignore                    # Git忽略配置
├── .editorconfig                 # 编辑器配置
├── .eslintrc.json                # ESLint配置
├── .prettierrc.json              # Prettier配置
├── .snyk                         # Snyk配置
├── .npmrc                        # npm配置
├── jest.config.js                # Jest配置
├── tsconfig.json                 # TypeScript配置
├── tsconfig.dev.json             # TypeScript开发配置
├── tsconfig.fast.json            # TypeScript快速构建配置
├── nodemon.json                  # Nodemon配置
├── package.json                  # 项目依赖
├── package-lock.json             # 依赖锁定
├── CLAUDE.md                     # Claude说明
├── PROJECT.md                    # 项目说明
├── README.md                     # 项目README
├── steady-snacking-dahl.md       # 说明文件
├── eslint.config.js              # ESLint配置（新）
├── install-mirai.ps1             # Mirai安装脚本
├── setup-mirai.bat               # Mirai设置脚本
├── start-with-qq.ps1             # QQ启动脚本
├── run-test.bat                  # 测试运行脚本
└── CODE_WIKI.md                  # 本文档
```

---

## 4. 核心模块详解

### 4.1 核心推理引擎 (core)

**路径**: `src/core/` | **核心类**: `JiabaixingCore`

系统的中枢模块，采用 **Harness Agent Framework（V5.0）**：Harness 做工程管控（验证、预算、状态、安全），LLM 做认知决策（选择工具、推理、表达）。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `JiabaixingCore` | [JiabaixingCore.ts](file:///c:/zy/jiabaixing/src/core/JiabaixingCore.ts) | 系统总控，输入预处理 + Harness路由 + 降级兜底 |
| `ConstitutionPromptBuilder` | [ConstitutionPromptBuilder.ts](file:///c:/zy/jiabaixing/src/core/ConstitutionPromptBuilder.ts) | 宪法级System Prompt动态构建（人格+行为规则+时间感知） |
| `ConversationHistoryManager` | [ConversationHistoryManager.ts](file:///c:/zy/jiabaixing/src/core/ConversationHistoryManager.ts) | 对话历史环形缓冲区 |
| `MemoryAssistant` | [MemoryAssistant.ts](file:///c:/zy/jiabaixing/src/core/MemoryAssistant.ts) | 记忆辅助（自动检索/知识提取） |
| `ScenarioAwareScheduler` | [ScenarioAwareScheduler.ts](file:///c:/zy/jiabaixing/src/core/ScenarioAwareScheduler.ts) | 场景感知调度器（30s轮询cron） |
| `OptimizationScheduler` | [OptimizationScheduler.ts](file:///c:/zy/jiabaixing/src/core/OptimizationScheduler.ts) | 优化调度器（24小时周期） |
| `DAGTask` | [DAGTask.ts](file:///c:/zy/jiabaixing/src/core/DAGTask.ts) | DAG任务定义与管理 |
| `TaskComplexityAnalyzer` | [TaskComplexityAnalyzer.ts](file:///c:/zy/jiabaixing/src/core/TaskComplexityAnalyzer.ts) | 任务复杂度分析器 |
| `DynamicTaskAdjuster` | [DynamicTaskAdjuster.ts](file:///c:/zy/jiabaixing/src/core/DynamicTaskAdjuster.ts) | 动态任务调整器 |
| `UnifiedContextPipeline` | [UnifiedContextPipeline.ts](file:///c:/zy/jiabaixing/src/core/UnifiedContextPipeline.ts) | 统一上下文管道 |
| `ModelInterface` | [ModelInterface.ts](file:///c:/zy/jiabaixing/src/core/ModelInterface.ts) | 模型接口定义 |

#### JiabaixingCore 核心方法

```typescript
class JiabaixingCore {
  async initialize(): Promise<void>
  async processInput(input: string, userId?: string, traceId?: string): Promise<ProcessInputResult>
  async processInputWithTracking(input: string, userId?: string, traceId?: string): Promise<TrackedProcessResult>
  setMemoryEngine(memoryEngine: IMemoryEngine): void
  setHarness(harness: unknown): void
  getLLM(): LLMProvider
  getMemoryEngine(): IMemoryEngine | null
  checkHighRiskAction(toolName: string, params: Record<string, unknown>): boolean
  generateProactiveMessage(context): Promise<string>
}
```

#### processInput 处理流程（V5.0 Harness 路由）

```
用户输入
  │
  └─→ Harness.processInput() ← V5.0主路径
      │
      ├─ E — Loop: Planner→Executor→Evaluator→Reporter
      │     ├─ Planner: LLM驱动的步骤分解
      │     ├─ Executor: FC循环执行（工具调用+结果验证）
      │     ├─ Evaluator: 目标达成度评估+回溯决策
      │     └─ Reporter: 响应生成+质量评分
      │
      ├─ T — Tools: 8类25个声明式工具
      │     ├─ SchemaValidator: JSON Schema参数验证
      │     └─ PermissionGuard: 权限分级检查
      │
      ├─ C — Context: 可组合上下文管道
      │     ├─ 宪法Prompt → 记忆检索 → 动态上下文 → 对话历史
      │     └─ TokenBudgetAllocator: 6桶预算分配
      │
      ├─ S — Persistence: 跨会话任务状态
      ├─ V — Verification: 结果验证+安全检查+质量评分
      └─ L — Constraints: 预算控制+权限检查+9个生命周期钩子
```

#### FC循环关键常量

| 常量 | 值 | 说明 | Harness对应 |
|------|----|------|------------|
| `SOFT_TOOL_LIMIT` | 4 | 软预算警告阈值（轮数） | L — Constraints.softRoundLimit |
| `HARD_TOOL_LIMIT` | 8 | 硬预算终止阈值（轮数） | L — Constraints.hardRoundLimit |
| `TOKEN_WARNING` | 4500 | 触发压缩警告的阈值 | L — Constraints.tokenWarningLimit |
| `TOKEN_BUDGET` | 6000 | FC循环messages总token预算 | L — Constraints.tokenHardLimit |
| `TOOL_TIMEOUT_MS` | 30000 | 单个工具超时时间 | T — ToolDefinition.timeout |
| `MAX_TOOL_CALLS` | 20 | 最大工具调用次数 | L — BudgetState.maxToolCalls |
| `MAX_DURATION_MS` | 60000 | 最大执行时间(ms) | L — BudgetState.maxDurationMs |

---

### 4.2 Harness 六层框架 (harness)

**路径**: `src/harness/` | **核心类**: `AgentHarness`

V5.0 架构的核心，提供六维管控能力。每个组件对应 Harness Engineering 的一个核心子系统。

#### 六层组件映射

| Harness 维度 | 实现类 | 文件 | 职责 |
|-------------|--------|------|------|
| **E — Execution Loop** | `LoopController` | [loop/LoopController.ts](file:///c:/zy/jiabaixing/src/harness/loop/LoopController.ts) | Plan-Execute-Evaluate状态机 |
| | `Planner` | [loop/Planner.ts](file:///c:/zy/jiabaixing/src/harness/loop/Planner.ts) | LLM驱动的任务规划 |
| | `Executor` | [loop/Executor.ts](file:///c:/zy/jiabaixing/src/harness/loop/Executor.ts) | FC循环执行（工具调用+结果验证） |
| | `Evaluator` | [loop/Evaluator.ts](file:///c:/zy/jiabaixing/src/harness/loop/Evaluator.ts) | 目标达成度评估+回溯决策 |
| | `Reporter` | [loop/Reporter.ts](file:///c:/zy/jiabaixing/src/harness/loop/Reporter.ts) | 响应生成+质量评分 |
| **T — Tool Registry** | `ToolRegistry` | [tools/registry/ToolRegistry.ts](file:///c:/zy/jiabaixing/src/harness/tools/registry/ToolRegistry.ts) | 声明式工具注册表 |
| | `SchemaValidator` | [tools/registry/SchemaValidator.ts](file:///c:/zy/jiabaixing/src/harness/tools/registry/SchemaValidator.ts) | JSON Schema参数验证 |
| | `PermissionGuard` | [tools/registry/PermissionGuard.ts](file:///c:/zy/jiabaixing/src/harness/tools/registry/PermissionGuard.ts) | 权限分级检查 |
| **C — Context Manager** | `ContextManager` | [context/ContextManager.ts](file:///c:/zy/jiabaixing/src/harness/context/ContextManager.ts) | 可组合上下文管道 |
| | `TokenBudgetAllocator` | [context/TokenBudgetAllocator.ts](file:///c:/zy/jiabaixing/src/harness/context/TokenBudgetAllocator.ts) | Token预算分配器（6桶） |
| **S — State Store** | `PersistenceService` | [persistence/PersistenceService.ts](file:///c:/zy/jiabaixing/src/harness/persistence/PersistenceService.ts) | 统一持久化服务 |
| | `TrajectoryDatabase` | [persistence/TrajectoryDatabase.ts](file:///c:/zy/jiabaixing/src/harness/persistence/TrajectoryDatabase.ts) | 轨迹数据库 |
| | `TrajectoryQueryService` | [persistence/TrajectoryQueryService.ts](file:///c:/zy/jiabaixing/src/harness/persistence/TrajectoryQueryService.ts) | 轨迹查询服务 |
| **V — Evaluation Interface** | `VerificationService` | [verification/VerificationService.ts](file:///c:/zy/jiabaixing/src/harness/verification/VerificationService.ts) | 结果验证+安全检查+质量评分 |
| | `IndependentEvaluationService` | [evaluation/IndependentEvaluationService.ts](file:///c:/zy/jiabaixing/src/harness/evaluation/IndependentEvaluationService.ts) | **P0**: 独立评估服务（解决自我评价失真） |
| **L — Lifecycle Hooks** | `ConstraintsService` | [constraints/ConstraintsService.ts](file:///c:/zy/jiabaixing/src/harness/constraints/ConstraintsService.ts) | 预算控制+权限检查+9个钩子 |
| **入口** | `AgentHarness` | [AgentHarness.ts](file:///c:/zy/jiabaixing/src/harness/AgentHarness.ts) | 六层组装+依赖注入+功能开关 |

#### AgentHarness 依赖注入接口

```typescript
interface HarnessDeps {
  llm: {
    chatWithTools(messages, tools): Promise<LLMResponse>;
    chat(prompt, systemPrompt?): Promise<string>;
  };
  constitutionalBuilder: {
    buildConstitutionPrompt(userId?): Promise<string>;
  };
  memoryInjector: {
    autoRetrieveMemories(input, userId?): Promise<string[]>;
  };
  dynamicContext: {
    getDynamicContext(): string;
  };
  historyProvider: {
    getRecentHistory(limit): ChatMessage[];
  };
  toolDeps?: HarnessToolDeps;
  skillRegistry?: SkillRegistry;
}
```

#### Harness 功能开关（6个独立开关）

```typescript
interface HarnessConfig {
  useHarnessLoop: boolean;          // E — 执行循环
  useHarnessTools: boolean;         // T — 工具注册表
  useHarnessContext: boolean;       // C — 上下文管理
  useHarnessVerification: boolean;  // V — 验证服务
  useHarnessConstraints: boolean;   // L — 约束服务
  useHarnessPersistence: boolean;   // S — 持久化服务
}
// bootstrap.ts 中全部设为 true
```

#### E — Execution Loop 详细流程

```
LoopController.run(input, messages)
  │
  ├── Phase 1: PLANNING
  │     └── Planner.plan(input, context) → ExecutionPlan
  │         ├── steps: PlanStep[]（步骤列表）
  │         ├── dependencies: Map<string, string[]>（步骤依赖）
  │         ├── estimatedBudget: BudgetAllocation（预算分配）
  │         └── simple?: boolean（简单任务标记，跳过规划）
  │
  ├── Phase 2: EXECUTING
  │     └── Executor.execute(plan, context) → ExecutorOutput
  │         ├── FC循环执行工具调用
  │         └── 返回 messages + toolCallsCount + completedNaturally
  │
  ├── Phase 3: EVALUATING
  │     └── Evaluator.evaluate(input, context) → EvaluatorOutput
  │         ├── goalProgress: number (0-1)
  │         ├── suggestedAction: 'continue' | 'replan' | 'abort'
  │         └── reason: string
  │
  │     └── 预算检查 → BUDGET_EXCEEDED 或 回溯重规划（最多1次）
  │
  └── Phase 4: REPORTING
        └── Reporter.report(context) → ReporterOutput
            ├── response: string
            └── quality: QualityScore（五维评分）
```

#### T — Tool Registry 工具清单

| 分类 | 工具 | 功能 | 权限等级 |
|------|------|------|---------|
| **memory** | `memory_recall` | 回忆相关记忆 | low |
| | `memory_search` | 搜索记忆库 | low |
| | `memory_store` | 存储新记忆 | low |
| **cognition** | `emotion_detect` | 情感分析 | low |
| | `scene_analyze` | 场景识别 | low |
| | `self_reflect` | 自我反思 | low |
| **desktop** | `desktop_screenshot` | 桌面截图 | medium |
| | `desktop_automate` | 桌面自动化 | high |
| **file** | `file_list` | 文件列表 | low |
| | `file_search` | 文件搜索 | low |
| | `get_active_file` | 获取活动文件 | low |
| | `incremental_edit` | 增量编辑 | medium |
| | `multi_file_edit` | 多文件编辑 | high |
| **code** | `code_analyze` | 代码分析 | low |
| | `code_fix` | 代码修复 | medium |
| | `code_generate` | 代码生成 | high |
| **system** | `ask_clarification` | 请求澄清 | low |
| | `preview_execution` | 预览执行 | low |
| | `rollback_changes` | 回滚更改 | high |
| **daily** | `task_manage` | 任务管理 | low |
| | `reminder_set` | 提醒设置 | low |
| | `note_take` | 笔记记录 | low |
| | `system_status` | 系统状态 | low |
| **network** | `web_search` | 网络搜索 | low |
| | `skill_create` | 技能创建 | medium |

#### L — Lifecycle Hooks 钩子清单

| 钩子 | 触发时机 | 作用 |
|------|---------|------|
| `BEFORE_LOOP` | 循环开始前 | 初始化检查、注入上下文 |
| `BEFORE_TOOL_CALL` | 工具调用前 | 参数修改、权限验证、用量检查 |
| `AFTER_TOOL_CALL` | 工具调用后 | 结果替换、副作用记录 |
| `BEFORE_RESPONSE` | 响应用户前 | 内容安全检查、风格校准 |
| `AFTER_RESPONSE` | 响应用户后 | 记录交互、触发后续任务 |
| `ON_ERROR` | 发生错误时 | 错误恢复、降级处理 |
| `ON_BUDGET_EXCEEDED` | 预算超限时 | 优雅降级、资源释放 |
| `ON_PLAN_CREATED` | 计划创建时 | 计划审核、优化建议 |
| `ON_STEP_COMPLETED` | 步骤完成时 | 进度追踪、中间结果持久化 |

#### V — Evaluation Interface 评分体系

```typescript
interface QualityScore {
  overall: number;       // 综合评分 (0-1)
  accuracy: number;      // 准确性：是否回答正确
  usefulness: number;    // 实用性：是否解决了用户问题
  friendliness: number;  // 友好度：交互体验
  efficiency: number;    // 效率：完成速度
  details: string;       // 评分说明
}

interface GoalProgress {
  achieved: boolean;              // 是否达成
  progress: number;               // 进度 (0-1)
  remainingSteps: string[];       // 剩余步骤
  suggestedAction: 'continue' | 'replan' | 'abort';  // 建议动作
}
```

#### 双写兼容机制

Harness 工具通过 [registerHarnessTools.ts](file:///c:/zy/jiabaixing/src/harness/tools/registerHarnessTools.ts) 中的同步机制，与旧版 SkillRegistry 保持兼容：

```
Harness ToolRegistry (25个新工具)
  │
  └─ syncToLegacySkillRegistry()
       │
       └─ 旧版 SkillRegistry
            └─ 两者并存，双写兼容
```

---

### 4.3 记忆引擎 (memory)

**路径**: `src/memory/` | **核心类**: `MemoryEngine`

全生命周期记忆引擎，提供瞬时、短期、长期三级记忆体系。对应 Harness 的 S — State Store 和 C — Context Manager 的记忆检索部分。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `MemoryEngine` | [MemoryEngine.ts](file:///c:/zy/jiabaixing/src/memory/MemoryEngine.ts) | 记忆引擎核心，协调所有记忆组件 |
| `BaseMemoryStore` | [BaseMemoryStore.ts](file:///c:/zy/jiabaixing/src/memory/BaseMemoryStore.ts) | 基础记忆存储抽象 |
| `ShortTermMemory` | [ShortTermMemory.ts](file:///c:/zy/jiabaixing/src/memory/ShortTermMemory.ts) | 短期记忆（会话级） |
| `LongTermMemory` | [LongTermMemory.ts](file:///c:/zy/jiabaixing/src/memory/LongTermMemory.ts) | 长期记忆（持久化） |
| `ChromaVectorDatabase` | [ChromaVectorDatabase.ts](file:///c:/zy/jiabaixing/src/memory/ChromaVectorDatabase.ts) | ChromaDB向量数据库实现 |
| `InMemoryVectorIndex` | [InMemoryVectorIndex.ts](file:///c:/zy/jiabaixing/src/memory/InMemoryVectorIndex.ts) | 内存向量索引 |
| `PersistentVectorDatabase` | [PersistentVectorDatabase.ts](file:///c:/zy/jiabaixing/src/memory/PersistentVectorDatabase.ts) | 持久化向量数据库 |
| `VectorDatabaseFactory` | [VectorDatabaseFactory.ts](file:///c:/zy/jiabaixing/src/memory/VectorDatabaseFactory.ts) | 向量数据库工厂 |
| `VectorDatabase` | [VectorDatabase.ts](file:///c:/zy/jiabaixing/src/memory/VectorDatabase.ts) | 向量数据库接口 |
| `VectorDatabaseInterface` | [VectorDatabaseInterface.ts](file:///c:/zy/jiabaixing/src/memory/VectorDatabaseInterface.ts) | 向量数据库接口定义 |
| `MemoryRetriever` | [MemoryRetriever.ts](file:///c:/zy/jiabaixing/src/memory/MemoryRetriever.ts) | 混合检索器（关键词+向量+RRF融合） |
| `MemoryTracker` | [MemoryTracker.ts](file:///c:/zy/jiabaixing/src/memory/MemoryTracker.ts) | 记忆验证+追踪 |
| `KnowledgeGraphBuilder` | [KnowledgeGraphBuilder.ts](file:///c:/zy/jiabaixing/src/memory/KnowledgeGraphBuilder.ts) | 知识图谱构建器 |
| `ConversationCompressor` | [ConversationCompressor.ts](file:///c:/zy/jiabaixing/src/memory/ConversationCompressor.ts) | 对话压缩器 |
| `PreferenceManager` | [PreferenceManager.ts](file:///c:/zy/jiabaixing/src/memory/PreferenceManager.ts) | 偏好管理器 |
| `PreferenceInjector` | [PreferenceInjector.ts](file:///c:/zy/jiabaixing/src/memory/PreferenceInjector.ts) | 偏好注入器 |
| `UserProfile` | [UserProfile.ts](file:///c:/zy/jiabaixing/src/memory/UserProfile.ts) | 用户画像 |
| `MemoryEncryption` | [MemoryEncryption.ts](file:///c:/zy/jiabaixing/src/memory/MemoryEncryption.ts) | 记忆加密 |
| `Database` | [Database.ts](file:///c:/zy/jiabaixing/src/memory/Database.ts) | 数据库基础类 |
| `ChineseTokenizer` | [ChineseTokenizer.ts](file:///c:/zy/jiabaixing/src/memory/ChineseTokenizer.ts) | 中文分词器 |

#### 三层记忆架构（对应 Harness S — State Store）

```
                     MemoryEngine
                          │
         ┌────────────────┼────────────────┐
         │                │                │
   瞬时记忆          短期记忆          长期记忆
   (API调用上下文)   (SQLite持久化)    (ChromaDB向量存储)
   单次请求生命周期   近期对话+工具结果   知识提取+语义检索
         │                │                │
         └────────┬───────┘                │
                  │                        │
         MemoryRetriever          KnowledgeGraphBuilder
         (混合检索:关键词+向量+RRF)   (知识图谱)
                  │
         (无 MemoryAssociationNetwork:已废弃)
```

---

### 4.4 模型层 (models)

**路径**: `src/models/` | **核心类**: `LLMProvider`

提供统一的LLM调用接口，支持OpenAI兼容协议的多种模型。对应 Harness 推理平面。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `LLMProvider` | [LLMProvider.ts](file:///c:/zy/jiabaixing/src/models/LLMProvider.ts) | LLM提供者，封装chatWithTools/chat |
| `MultiModelLLMProvider` | [MultiModelLLMProvider.ts](file:///c:/zy/jiabaixing/src/models/MultiModelLLMProvider.ts) | 多模型LLM提供者 |
| `ModelManager` | [ModelManager.ts](file:///c:/zy/jiabaixing/src/models/ModelManager.ts) | 模型管理器，动态切换模型 |
| `ModelSelector` | [ModelSelector.ts](file:///c:/zy/jiabaixing/src/models/ModelSelector.ts) | 模型选择器，按场景选择模型 |
| `OpenAICompatibleModel` | [OpenAICompatibleModel.ts](file:///c:/zy/jiabaixing/src/models/OpenAICompatibleModel.ts) | OpenAI兼容协议模型 |
| `LlamaCppModel` | [LlamaCppModel.ts](file:///c:/zy/jiabaixing/src/models/LlamaCppModel.ts) | LlamaCpp本地模型 |
| `ModelInterface` | [ModelInterface.ts](file:///c:/zy/jiabaixing/src/models/ModelInterface.ts) | 模型接口定义 |
| `LLMResponseCache` | [LLMResponseCache.ts](file:///c:/zy/jiabaixing/src/models/LLMResponseCache.ts) | LLM响应缓存 |
| `RequestQueue` | [RequestQueue.ts](file:///c:/zy/jiabaixing/src/models/RequestQueue.ts) | 请求队列管理 |
| `PromptOptimizer` | [PromptOptimizer.ts](file:///c:/zy/jiabaixing/src/models/PromptOptimizer.ts) | Prompt优化器 |
| `types` | [types.ts](file:///c:/zy/jiabaixing/src/models/types.ts) | 模型类型定义 |

---

## 5. 依赖关系图

Harness Agent Framework 各层依赖关系：
```
JiabaixingCore (核心控制)
    ↓
AgentHarness (六层组装)
    ↓
    ├─ Execution Loop (E)
    ├─ Tool Registry (T)
    ├─ Context Manager (C)
    ├─ State Store (S)
    ├─ Constraints Service (L)
    └─ Verification Service (V)
```

---

## 6. API端点总览

主要API路由位于 `src/server/routes/` 目录：
- `coreRoutes.ts` - 核心交互API
- `evolutionRoutes.ts` - 进化引擎API
- `memoryRoutes.ts` - 记忆系统API
- `securityRoutes.ts` - 安全管理API
- `skillRoutes.ts` - 技能系统API
- `performanceRoutes.ts` - 性能监控API
- `integrationRoutes.ts` - 集成网关API

---

## 7. 事件总线 (EventBus)

EventBus 位于 `src/shared/EventBus.ts`，主要事件包括：
- `response_ready` - 响应准备完成
- `brain_stage_update` - 大脑阶段更新
- `tool_trace` - 工具调用追踪
- `agent_execution_update` - Agent执行更新
- `evolution_event` - 进化事件
- `clarification_request` - 澄清请求
- `execution_preview` - 执行预览
- `skill_execution_update` - 技能执行更新
- `perception_update` - 感知更新
- `proactive_message` - 主动消息
- `weight_update` - 权重更新
- `server_log` - 服务器日志

---

## 8. 数据存储

主要数据存储在 `data/` 目录：
- SQLite数据库：`.db` 文件
- JSON配置：`.json` 文件
- 持久化数据：`persistence/`
- 进化数据：`evolution/`
- 反馈数据：`feedback/`
- 轨迹数据：`trajectory/`
- 评估数据：`eval/`

---

## 9. 项目运行方式

```bash
# 开发模式
npm start

# CLI模式
node src/cli.ts

# 构建生产版本
npm run build
```

---

## 10. 环境配置

配置文件位于 `src/config/`：
- `ConfigLoader.ts` - 配置加载器
- `default.config.ts` - 默认配置
- `server.config.ts` - 服务器配置

环境变量通过 `.env` 文件设置（参考 `.env.example`）。

---

## 11. 测试体系

测试文件位于 `tests/` 目录：
- `harness/` - Harness专项测试（132个用例）
- `unit/` - 单元测试
- `integration/` - 集成测试
- `e2e/` - 端到端测试
- `stress/` - 压力测试
- `acceptance/` - 验收测试
- `coordination/` - 协调测试
- `eval/` - 评估测试

---

## 12. CI/CD

### GitHub Actions工作流

| 工作流 | 描述 | 文件 |
|------|------|------|
| 后端CI/CD | 构建、测试、部署后端 | `.github/workflows/backend-ci-cd.yml` |
| 前端CI/CD | 构建、测试、部署前端 | `.github/workflows/frontend-ci-cd.yml` |

---

## 更新日志

### V5.0 (2026-05-27)
- ✅ 完成Harness Agent Framework 6层架构
- ✅ 删除约63,000行死代码（`src/tools/`、`src/ide/`等）
- ✅ 重构代码库，整合到统一架构
- ✅ 进程隔离网关架构
- ✅ 更新CODE_WIKI.md以匹配实际代码库

---

**文档版本**: 5.0 | **最后更新**: 2026-05-27 模型类型定义 |

#### LLM辅助模块 (`src/llm/`)

| 类名 | 文件 | 职责 |
|------|------|------|
| `ModelCapabilityDetector` | [ModelCapabilityDetector.ts](file:///c:/zy/jiabaixing/src/llm/ModelCapabilityDetector.ts) | 模型能力检测器 |
| `PromptTemplateEngine` | [PromptTemplateEngine.ts](file:///c:/zy/jiabaixing/src/llm/PromptTemplateEngine.ts) | Prompt模板引擎 |
| `StreamingResponseHandler` | [StreamingResponseHandler.ts](file:///c:/zy/jiabaixing/src/llm/StreamingResponseHandler.ts) | 流式响应处理 |
| `TokenBudgetManager` | [TokenBudgetManager.ts](file:///c:/zy/jiabaixing/src/llm/TokenBudgetManager.ts) | Token预算管理 |

---

### 4.5 交互引擎 (interaction)

**路径**: `src/interaction/` | **核心类**: `InteractionEngine`

管理对话流程和交互行为，包括语音、表情、连续对话等。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `InteractionEngine` | [InteractionEngine.ts](file:///c:/zy/jiabaixing/src/interaction/InteractionEngine.ts) | 交互引擎核心 |
| `SpeechSynthesizer` | [SpeechSynthesizer.ts](file:///c:/zy/jiabaixing/src/interaction/SpeechSynthesizer.ts) | 语音合成 |
| `EmojiManager` | [EmojiManager.ts](file:///c:/zy/jiabaixing/src/interaction/EmojiManager.ts) | 表情管理 |
| `ContinuousDialogManager` | [ContinuousDialogManager.ts](file:///c:/zy/jiabaixing/src/interaction/ContinuousDialogManager.ts) | 连续对话管理 |

---

### 4.6 人设引擎 (persona)

**路径**: `src/persona/` | **核心类**: `PersonaCore`

定义和管理代理人的个性与行为模式，实现拟人化交互。对应 Harness C — Context Manager 的宪法 Prompt 部分。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `PersonaCore` | [PersonaCore.ts](file:///c:/zy/jiabaixing/src/persona/PersonaCore.ts) | 人设核心，维护性格特征和行为规范 |
| `DialogueGenerator` | [DialogueGenerator.ts](file:///c:/zy/jiabaixing/src/persona/DialogueGenerator.ts) | 对话生成器（降级模式） |
| `PersonaRules` | [PersonaRules.ts](file:///c:/zy/jiabaixing/src/persona/PersonaRules.ts) | 人设规则守卫 |

---

### 4.7 技能系统 (skills)

**路径**: `src/skills/` | **核心类**: `SkillRegistry`

可扩展的技能注册与执行体系。与 Harness T — Tool Registry 双写兼容。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `SkillRegistry` | [SkillRegistry.ts](file:///c:/zy/jiabaixing/src/skills/SkillRegistry.ts) | 技能注册中心（单例） |
| `SkillInterface` | [SkillInterface.ts](file:///c:/zy/jiabaixing/src/skills/SkillInterface.ts) | 技能接口定义 |

---

### 4.8 进化引擎 (evolution)

**路径**: `src/evolution/` | **核心类**: `EvolutionOrchestrator`

四闭环进化编排系统，驱动智能体持续优化。对应 Harness V — Evaluation Interface 的进化反馈部分。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `EvolutionOrchestrator` | [EvolutionOrchestrator.ts](file:///c:/zy/jiabaixing/src/evolution/EvolutionOrchestrator.ts) | 进化编排器（单例），协调四闭环 |
| `EvolutionEngine` | [EvolutionEngine.ts](file:///c:/zy/jiabaixing/src/evolution/EvolutionEngine.ts) | 进化引擎，执行进化算法 |
| `FeedbackCollector` | [FeedbackCollector.ts](file:///c:/zy/jiabaixing/src/evolution/FeedbackCollector.ts) | 反馈收集器 |
| `StrategyOptimizer` | [StrategyOptimizer.ts](file:///c:/zy/jiabaixing/src/evolution/StrategyOptimizer.ts) | 策略优化器 |
| `OptimizationResultDispatcher` | [OptimizationResultDispatcher.ts](file:///c:/zy/jiabaixing/src/evolution/OptimizationResultDispatcher.ts) | 优化结果分发器 |
| `OptimizationAdvisor` | [decision/OptimizationAdvisor.ts](file:///c:/zy/jiabaixing/src/evolution/decision/OptimizationAdvisor.ts) | 优化顾问 |

#### 四闭环进化架构

```
EvolutionOrchestrator
    │
    ├── 进化引擎闭环 (EvolutionEngine)
    │     └── 行为分析 → 策略优化 → 效果验证
    │
    ├── 工具推荐闭环 (待实现)
    │
    ├── LLM提供者闭环 (LLMProvider)
    │     └── 响应质量 → 模型选择 → 参数调优
    │
    └── 人设调整闭环 (PersonaCore)
          └── 交互反馈 → 人设微调 → 效果评估
```

---

### 4.9 安全模块 (security)

**路径**: `src/security/` | **核心类**: `SecurityManager`

多层安全防护体系。对应 Harness L — Lifecycle Hooks 的安全拦截和 V — Evaluation Interface 的安全检查。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `SecurityManager` | [SecurityManager.ts](file:///c:/zy/jiabaixing/src/security/SecurityManager.ts) | 安全管理器（统一入口） |
| `SecurityGuard` | [SecurityGuard.ts](file:///c:/zy/jiabaixing/src/security/SecurityGuard.ts) | 安全守卫 |
| `NetworkGuard` | [NetworkGuard.ts](file:///c:/zy/jiabaixing/src/security/NetworkGuard.ts) | 网络守卫 |
| `AuthenticationManager` | [AuthenticationManager.ts](file:///c:/zy/jiabaixing/src/security/AuthenticationManager.ts) | JWT认证管理器 |
| `EncryptionManager` | [EncryptionManager.ts](file:///c:/zy/jiabaixing/src/security/EncryptionManager.ts) | 加密管理器 |
| `DataSovereigntyPipeline` | [DataSovereigntyPipeline.ts](file:///c:/zy/jiabaixing/src/security/DataSovereigntyPipeline.ts) | 数据主权管道（加密+脱敏） |
| `SecurityPolicyEngine` | [SecurityPolicyEngine.ts](file:///c:/zy/jiabaixing/src/security/SecurityPolicyEngine.ts) | 安全策略引擎 |
| `AuditLogger` | [AuditLogger.ts](file:///c:/zy/jiabaixing/src/security/AuditLogger.ts) | 审计日志 |
| `types` | [types.ts](file:///c:/zy/jiabaixing/src/security/types.ts) | 安全类型定义 |

---

### 4.10 多模态感知 (multimodal)

**路径**: `src/multimodal/` | **核心类**: `EnvironmentPerceptionEngine`

统一处理文本、图像等多种输入形式，增强系统感知能力。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `EmotionAnalyzer` | [EmotionAnalyzer.ts](file:///c:/zy/jiabaixing/src/multimodal/EmotionAnalyzer.ts) | 情感分析 |
| `SceneRecognizer` | [SceneRecognizer.ts](file:///c:/zy/jiabaixing/src/multimodal/SceneRecognizer.ts) | 场景识别 |
| `EnvironmentPerceptionEngine` | [EnvironmentPerceptionEngine.ts](file:///c:/zy/jiabaixing/src/multimodal/EnvironmentPerceptionEngine.ts) | 环境感知引擎 |
| `MultimodalInput` | [MultimodalInput.ts](file:///c:/zy/jiabaixing/src/multimodal/MultimodalInput.ts) | 多模态输入 |

---

### 4.11 桌面代理 (desktop)

**路径**: `src/desktop/` | **核心类**: `DesktopAgentLoop`

桌面级AI代理，实现屏幕截图、UI检查、鼠标键盘自动化等。对应 Harness T — Tool Registry 的 desktop 类工具。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `DesktopAgentLoop` | [DesktopAgentLoop.ts](file:///c:/zy/jiabaixing/src/desktop/DesktopAgentLoop.ts) | 桌面代理运行循环 |
| `DesktopActionExecutor` | [DesktopActionExecutor.ts](file:///c:/zy/jiabaixing/src/desktop/DesktopActionExecutor.ts) | 桌面动作执行器 |
| `DesktopUIInspector` | [DesktopUIInspector.ts](file:///c:/zy/jiabaixing/src/desktop/DesktopUIInspector.ts) | 桌面UI检查器 |
| `DesktopVisionEngine` | [DesktopVisionEngine.ts](file:///c:/zy/jiabaixing/src/desktop/DesktopVisionEngine.ts) | 桌面视觉引擎 |
| `StateSnapshotManager` | [StateSnapshotManager.ts](file:///c:/zy/jiabaixing/src/desktop/StateSnapshotManager.ts) | 状态快照管理器 |
| `ScreenCapture` | [ScreenCapture.ts](file:///c:/zy/jiabaixing/src/desktop/ScreenCapture.ts) | 屏幕截图 |
| `WindowManager` | [WindowManager.ts](file:///c:/zy/jiabaixing/src/desktop/WindowManager.ts) | 窗口管理器 |
| `SystemInput` | [SystemInput.ts](file:///c:/zy/jiabaixing/src/desktop/SystemInput.ts) | 系统输入 |
| `ElementMatcher` | [ElementMatcher.ts](file:///c:/zy/jiabaixing/src/desktop/ElementMatcher.ts) | 元素匹配器 |

---

### 4.12 集成网关 (integration)

**路径**: `src/integration/` | **核心类**: `IntegrationManager`, `GatewayBridge`

4平台统一消息网关，采用进程隔离架构。对应 Harness Gateway Layer。

#### 进程隔离架构 (V5.0)

```
主进程 (main.ts)
  │
  ├── GatewayBridge (IPC桥接器)
  │     ├── 自动重启（指数退避，最多5次）
  │     ├── 健康检查（30s间隔）
  │     ├── 请求超时（15s）
  │     └── 内联回退（Worker崩溃时降级到主进程运行）
  │
  └── GatewayWorker (子进程)
        ├── IntegrationManager (单例)
        ├── 5个平台适配器
        └── EventBus.on('integration_message') → IPC转发
```

**设计原则**: 网关崩溃 ≠ 系统崩溃。Worker 异常退出时，GatewayBridge 自动重启或降级到内联模式运行。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `GatewayBridge` | [GatewayBridge.ts](file:///c:/zy/jiabaixing/src/integration/GatewayBridge.ts) | IPC桥接器，管理Worker生命周期 |
| `IntegrationManager` | [IntegrationManager.ts](file:///c:/zy/jiabaixing/src/integration/IntegrationManager.ts) | 单例管理所有适配器 |
| `TRAEOptimizationIntegrator` | [TRAEOptimizationIntegrator.ts](file:///c:/zy/jiabaixing/src/integration/TRAEOptimizationIntegrator.ts) | TRAE优化集成器 |

---

### 4.13 共享基础设施 (shared)

**路径**: `src/shared/` | **核心类**: `EventBus`

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `EventBus` | [EventBus.ts](file:///c:/zy/jiabaixing/src/shared/EventBus.ts) | 事件总线（单例），类型安全的事件系统 |
| `contracts` | [contracts.ts](file:///c:/zy/jiabaixing/src/shared/contracts.ts) | 前后端共享契约（API端点+WS事件+数据模型） |

---

### 4.14 服务器层 (server)

**路径**: `src/server/` | **入口**: `bootstrap.ts`

Express + WebSocket服务器，提供REST API和实时通信。

#### 关键文件

| 文件 | 职责 |
|------|------|
| [bootstrap.ts](file:///c:/zy/jiabaixing/src/server/bootstrap.ts) | 系统启动引导（12步初始化） |
| [websocket.ts](file:///c:/zy/jiabaixing/src/server/websocket.ts) | WebSocket服务设置 |
| [eventBusSetup.ts](file:///c:/zy/jiabaixing/src/server/eventBusSetup.ts) | EventBus与WebSocket桥接（14个事件） |
| [shutdown.ts](file:///c:/zy/jiabaixing/src/server/shutdown.ts) | 优雅关闭 |

#### 路由模块 (`src/server/routes/`)

| 文件 | 路由前缀 | 职责 |
|------|----------|------|
| `coreRoutes.ts` | `/api/` | 核心API（健康检查、输入处理等） |
| `evolutionRoutes.ts` | `/api/evolution/` | 进化相关API |
| `memoryRoutes.ts` | `/api/memory/` | 记忆相关API |
| `securityRoutes.ts` | `/api/security/` | 安全相关API |
| `skillRoutes.ts` | `/api/skills/` | 技能相关API |
| `performanceRoutes.ts` | `/api/performance/` | 性能相关API |
| `integrationRoutes.ts` | `/api/integration/` | 集成面板API |
| `systemStateRoutes.ts` | `/api/system/` | 系统状态API |
| `debugRoutes.ts` | `/api/debug/` | 调试API |
| `traeRoutes.ts` | `/api/trae/` | TRAE API |

---

### 4.15 前端应用 (frontend)

**路径**: `src/frontend/` | **框架**: React + TypeScript | **架构**: V5.0三栏布局

#### 技术栈

| 技术 | 用途 |
|------|------|
| React 18 | UI框架 |
| TypeScript | 类型安全 |
| Zustand | 状态管理 |
| WebSocket | 实时通信 |
| axios | HTTP客户端 |
| craco | 构建工具（替代react-scripts，支持@shared别名） |

#### 前后端共享契约

前端通过 `@shared/contracts` 别名直接导入后端的 `src/shared/contracts.ts`，实现契约驱动开发：

```typescript
// 前端导入示例
import { WS_EVENTS, ConnectionStatus, type WsServerEventType } from '@shared/contracts';
```

**craco 配置** ([craco.config.js](file:///c:/zy/jiabaixing/src/frontend/craco.config.js)):
- 添加 webpack alias: `@shared` → `../shared`
- 移除 `ModuleScopePlugin` 允许跨目录导入
- 将 `../shared` 加入 TypeScript 编译的 include 范围

---

### 4.16 硬件接入 (hardware)

**路径**: `src/hardware/`

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `DeviceManager` | [DeviceManager.ts](file:///c:/zy/jiabaixing/src/hardware/DeviceManager.ts) | 设备管理器 |
| `DeviceDiscovery` | [DeviceDiscovery.ts](file:///c:/zy/jiabaixing/src/hardware/DeviceDiscovery.ts) | 设备发现 |
| `LocalDeviceAccess` | [LocalDeviceAccess.ts](file:///c:/zy/jiabaixing/src/hardware/LocalDeviceAccess.ts) | 本地设备访问 |
| `AudioVideoDeviceAccess` | [AudioVideoDeviceAccess.ts](file:///c:/zy/jiabaixing/src/hardware/AudioVideoDeviceAccess.ts) | 音视频设备访问 |
| `SmartHomeManager` | [SmartHomeManager.ts](file:///c:/zy/jiabaixing/src/hardware/SmartHomeManager.ts) | 智能家居管理器 |
| `DeviceProtocol` | [protocols/DeviceProtocol.ts](file:///c:/zy/jiabaixing/src/hardware/protocols/DeviceProtocol.ts) | 设备协议 |
| `HomeAssistantProtocol` | [protocols/HomeAssistantProtocol.ts](file:///c:/zy/jiabaixing/src/hardware/protocols/HomeAssistantProtocol.ts) | HomeAssistant协议 |
| `types` | [types.ts](file:///c:/zy/jiabaixing/src/hardware/types.ts) | 硬件类型定义 |

---

## 5. 依赖关系图

```
main.ts (入口)
  ├── bootstrap.ts (初始化)
  ├── Express + WebSocket Server
  └── GatewayBridge (进程隔离)
        └── GatewayWorker
            └── IntegrationManager

JiabaixingCore (核心)
  ├── LLMProvider (模型层)
  ├── MemoryEngine (记忆层)
  ├── AgentHarness (Harness六层)
  │     ├── LoopController (E)
  │     ├── ToolRegistry (T)
  │     ├── ContextManager (C)
  │     ├── PersistenceService (S)
  │     ├── VerificationService (V)
  │     └── ConstraintsService (L)
  ├── InteractionEngine (交互)
  ├── PersonaCore (人设)
  ├── SkillRegistry (技能)
  ├── EvolutionOrchestrator (进化)
  └── SecurityManager (安全)

React Frontend
  ├── Zustand Stores
  └── WebSocket → EventBus → JiabaixingCore
```

---

## 6. API端点总览

### 核心API (`/api/`)

| 端点 | 方法 | 描述 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/chat` | POST | 处理聊天输入 |
| `/status` | GET | 获取系统状态 |

### 进化API (`/api/evolution/`)

| 端点 | 方法 | 描述 |
|------|------|------|
| `/metrics` | GET | 获取进化指标 |
| `/feedback` | POST | 提交用户反馈 |
| `/optimize` | POST | 触发优化过程 |

### 记忆API (`/api/memory/`)

| 端点 | 方法 | 描述 |
|------|------|------|
| `/search` | POST | 搜索记忆 |
| `/store` | POST | 存储记忆 |
| `/user/:userId` | GET | 获取用户记忆 |

### 技能API (`/api/skills/`)

| 端点 | 方法 | 描述 |
|------|------|------|
| `/list` | GET | 列出所有技能 |
| `/execute` | POST | 执行技能 |

---

## 7. 事件总线 (EventBus)

### 前端WebSocket事件 (`eventBusSetup.ts`)

| EventBus事件 | WS事件名 | 描述 |
|-------------|---------|------|
| `response_ready` | `response_ready` | Agent响应准备就绪 |
| `brain_stage_update` | `brain_stage_update` | 思考阶段更新 |
| `tool_trace` | `tool_trace` | 工具调用追踪 |
| `agent_execution_update` | `agent_execution_update` | Agent执行更新 |
| `evolution_event` | `evolution_event` | 进化事件 |
| `clarification_request` | `clarification_request` | 澄清请求 |
| `execution_preview` | `execution_preview` | 执行预览 |
| `skill_execution_update` | `skill_execution_update` | 技能执行更新 |
| `perception_update` | `perception_update` | 感知更新 |
| `proactive_message` | `proactive_message` | 主动消息 |
| `weight_update` | `weight_update` | 权重更新 |
| `server_log` | `server_log` | 服务器日志 |

---

## 8. 数据存储

### SQLite数据库

| 数据库 | 位置 | 用途 |
|--------|------|------|
| `jiabaixing_memory.db` | `data/` | 记忆存储 |
| `event_bus.db` | `data/` | 事件总线数据 |
| `vectors.db` | `data/` | 向量索引数据 |
| `sovereignty_audit.db` | `data/` | 数据主权审计 |
| `weights.db` | `data/` | 进化权重数据 |

### ChromaDB向量存储

- 用于长期记忆的语义检索
- 混合检索：关键词匹配 + 向量相似度 + RRF融合

### 文件存储

| 路径 | 用途 |
|------|------|
| `data/persistence/` | 持久化任务状态 |
| `data/evolution/` | 进化数据 |
| `data/feedback/` | 用户反馈 |
| `data/keys/` | 密钥文件（加密） |
| `data/security/` | 安全相关数据 |
| `data/test-profiles/` | 测试配置 |
| `data/trajectory/` | 执行轨迹数据 |
| `data/eval/reports/` | 评估报告 |

---

## 9. 项目运行方式

### 开发模式

```bash
# 后端开发
npm run dev

# 前端开发
cd src/frontend
npm start
```

### 生产模式

```bash
# 构建
npm run build

# 启动
npm start
```

### CLI命令

```bash
# 查看帮助
npm run cli -- help

# 启动聊天
npm run cli -- chat

# 管理网关
npm run cli -- gateway

# 调度任务
npm run cli -- schedule
```

### 测试

```bash
# 运行所有测试
npm test

# 运行Harness专项测试
npm test -- tests/harness/

# 生成覆盖率报告
npm test -- --coverage
```

---

## 10. 环境配置

### 必需环境变量

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `NODE_ENV` | 环境 | `development` |
| `OPENAI_API_KEY` | OpenAI API密钥 | - |
| `OPENAI_API_BASE` | OpenAI API基础URL | - |
| `DATABASE_PATH` | SQLite数据库路径 | `./data/` |
| `CHROMA_DB_URL` | ChromaDB URL | - |
| `JWT_SECRET` | JWT密钥 | （随机生成） |
| `ENCRYPTION_KEY` | 加密密钥 | （随机生成） |
| `PORT` | 后端端口 | `3001` |
| `FRONTEND_PORT` | 前端端口 | `3000` |
| `CONSOLE_LOG_LEVEL` | 控制台日志级别 | `warn` |

### 可选环境变量

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `MODEL_NAME` | 默认模型名 | `gpt-4o` |
| `MAX_CONCURRENT_AGENTS` | 最大并发Agent数 | `10` |
| `LOG_LEVEL` | 文件日志级别 | `info` |

---

## 11. 测试体系

### 测试目录结构

```
tests/
├── harness/              # Harness专项测试（132个用例）
├── unit/                 # 单元测试
├── integration/          # 集成测试
├── e2e/                  # 端到端测试
├── stress/               # 压力测试
├── acceptance/           # 验收测试
├── coordination/         # 协调测试
├── eval/                 # 评估测试
├── reports/              # 测试报告
├── __mocks__/            # 测试模拟
└── setup.ts              # 测试设置
```

### 测试覆盖要求

- 核心模块：≥90%测试覆盖
- Harness模块：≥95%测试覆盖
- 安全模块：100%关键路径覆盖

---

## 12. CI/CD

### GitHub Actions工作流

| 工作流 | 描述 | 文件 |
|--------|------|------|
| 后端CI/CD | 构建、测试、部署后端 | `.github/workflows/backend-ci-cd.yml` |
| 前端CI/CD | 构建、测试、部署前端 | `.github/workflows/frontend-ci-cd.yml` |

---

## 更新日志

### V5.0 (2026-05-27)
- ✅ 完成Harness Agent Framework 6层架构
- ✅ 删除约63,000行死代码（`src/tools/`、`src/ide/`等）
- ✅ 重构代码库，整合到统一架构
- ✅ 进程隔离网关架构
- ✅ 更新CODE_WIKI.md以匹配实际代码库

---

**文档版本**: 5.0 | **最后更新**: 2026-05-27
| `LongTermMemory` | [LongTermMemory.ts](file:///c:/zy/jiabaixing/src/memory/LongTermMemory.ts) | 长期记忆（持久化） |
| `ChromaVectorDatabase` | [ChromaVectorDatabase.ts](file:///c:/zy/jiabaixing/src/memory/ChromaVectorDatabase.ts) | ChromaDB向量数据库实现 |
| `InMemoryVectorIndex` | [InMemoryVectorIndex.ts](file:///c:/zy/jiabaixing/src/memory/InMemoryVectorIndex.ts) | 内存向量索引 |
| `PersistentVectorDatabase` | [PersistentVectorDatabase.ts](file:///c:/zy/jiabaixing/src/memory/PersistentVectorDatabase.ts) | 持久化向量数据库 |
| `VectorDatabaseFactory` | [VectorDatabaseFactory.ts](file:///c:/zy/jiabaixing/src/memory/VectorDatabaseFactory.ts) | 向量数据库工厂 |
| `VectorDatabase` | [VectorDatabase.ts](file:///c:/zy/jiabaixing/src/memory/VectorDatabase.ts) | 向量数据库接口 |
| `VectorDatabaseInterface` | [VectorDatabaseInterface.ts](file:///c:/zy/jiabaixing/src/memory/VectorDatabaseInterface.ts) | 向量数据库接口定义 |
| `MemoryRetriever` | [MemoryRetriever.ts](file:///c:/zy/jiabaixing/src/memory/MemoryRetriever.ts) | 混合检索器（关键词+向量+RRF融合） |
| `MemoryTracker` | [MemoryTracker.ts](file:///c:/zy/jiabaixing/src/memory/MemoryTracker.ts) | 记忆验证+追踪 |
| `KnowledgeGraphBuilder` | [KnowledgeGraphBuilder.ts](file:///c:/zy/jiabaixing/src/memory/KnowledgeGraphBuilder.ts) | 知识图谱构建器 |
| `ConversationCompressor` | [ConversationCompressor.ts](file:///c:/zy/jiabaixing/src/memory/ConversationCompressor.ts) | 对话压缩器 |
| `PreferenceManager` | [PreferenceManager.ts](file:///c:/zy/jiabaixing/src/memory/PreferenceManager.ts) | 偏好管理器 |
| `PreferenceInjector` | [PreferenceInjector.ts](file:///c:/zy/jiabaixing/src/memory/PreferenceInjector.ts) | 偏好注入器 |
| `UserProfile` | [UserProfile.ts](file:///c:/zy/jiabaixing/src/memory/UserProfile.ts) | 用户画像 |
| `MemoryEncryption` | [MemoryEncryption.ts](file:///c:/zy/jiabaixing/src/memory/MemoryEncryption.ts) | 记忆加密 |
| `Database` | [Database.ts](file:///c:/zy/jiabaixing/src/memory/Database.ts) | 数据库基础类 |
| `ChineseTokenizer` | [ChineseTokenizer.ts](file:///c:/zy/jiabaixing/src/memory/ChineseTokenizer.ts) | 中文分词器 |

#### 三层记忆架构（对应 Harness S — State Store）

```
                     MemoryEngine
                          │
         ┌────────────────┼────────────────┐
         │                │                │
   瞬时记忆          短期记忆          长期记忆
   (API调用上下文)   (SQLite持久化)    (ChromaDB向量存储)
   单次请求生命周期   近期对话+工具结果   知识提取+语义检索
         │                │                │
         └────────┬───────┘                │
                  │                        │
         MemoryRetriever          KnowledgeGraphBuilder
         (混合检索:关键词+向量+RRF)   (知识图谱)
                  │
         MemoryAssociationNetwork (测试用)
         (记忆关联)
```

---

### 4.4 模型层 (models)

**路径**: `src/models/` | **核心类**: `LLMProvider`

提供统一的LLM调用接口，支持OpenAI兼容协议的多种模型。对应 Harness 推理平面。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `LLMProvider` | [LLMProvider.ts](file:///c:/zy/jiabaixing/src/models/LLMProvider.ts) | LLM提供者，封装chatWithTools/chat |
| `MultiModelLLMProvider` | [MultiModelLLMProvider.ts](file:///c:/zy/jiabaixing/src/models/MultiModelLLMProvider.ts) | 多模型LLM提供者 |
| `ModelManager` | [ModelManager.ts](file:///c:/zy/jiabaixing/src/models/ModelManager.ts) | 模型管理器，动态切换模型 |
| `ModelSelector` | [ModelSelector.ts](file:///c:/zy/jiabaixing/src/models/ModelSelector.ts) | 模型选择器，按场景选择模型 |
| `OpenAICompatibleModel` | [OpenAICompatibleModel.ts](file:///c:/zy/jiabaixing/src/models/OpenAICompatibleModel.ts) | OpenAI兼容协议模型 |
| `LlamaCppModel` | [LlamaCppModel.ts](file:///c:/zy/jiabaixing/src/models/LlamaCppModel.ts) | LlamaCpp本地模型 |
| `ModelInterface` | [ModelInterface.ts](file:///c:/zy/jiabaixing/src/models/ModelInterface.ts) | 模型接口定义 |
| `LLMResponseCache` | [LLMResponseCache.ts](file:///c:/zy/jiabaixing/src/models/LLMResponseCache.ts) | LLM响应缓存 |
| `RequestQueue` | [RequestQueue.ts](file:///c:/zy/jiabaixing/src/models/RequestQueue.ts) | 请求队列管理 |
| `PromptOptimizer` | [PromptOptimizer.ts](file:///c:/zy/jiabaixing/src/models/PromptOptimizer.ts) | Prompt优化器 |
| `types` | [types.ts](file:///c:/zy/jiabaixing/src/models/types.ts) | 模型类型定义 |

---

## 5. 依赖关系图

Harness Agent Framework 各层依赖关系：
```
JiabaixingCore (核心控制)
    ↓
AgentHarness (六层组装)
    ↓
    ├─ Execution Loop (E)
    ├─ Tool Registry (T)
    ├─ Context Manager (C)
    ├─ State Store (S)
    ├─ Constraints Service (L)
    └─ Verification Service (V)
```

---

## 6. API端点总览

主要API路由位于 `src/server/routes/` 目录：
- `coreRoutes.ts` - 核心交互API
- `evolutionRoutes.ts` - 进化引擎API
- `memoryRoutes.ts` - 记忆系统API
- `securityRoutes.ts` - 安全管理API
- `skillRoutes.ts` - 技能系统API
- `performanceRoutes.ts` - 性能监控API
- `integrationRoutes.ts` - 集成网关API

---

## 7. 事件总线 (EventBus)

EventBus 位于 `src/shared/EventBus.ts`，主要事件包括：
- `response_ready` - 响应准备完成
- `brain_stage_update` - 大脑阶段更新
- `tool_trace` - 工具调用追踪
- `agent_execution_update` - Agent执行更新
- `evolution_event` - 进化事件
- `clarification_request` - 澄清请求
- `execution_preview` - 执行预览
- `skill_execution_update` - 技能执行更新
- `perception_update` - 感知更新
- `proactive_message` - 主动消息
- `weight_update` - 权重更新
- `server_log` - 服务器日志

---

## 8. 数据存储

主要数据存储在 `data/` 目录：
- SQLite数据库：`.db` 文件
- JSON配置：`.json` 文件
- 持久化数据：`persistence/`
- 进化数据：`evolution/`
- 反馈数据：`feedback/`
- 轨迹数据：`trajectory/`
- 评估数据：`eval/`

---

## 9. 项目运行方式

```bash
# 开发模式
npm start

# CLI模式
node src/cli.ts

# 构建生产版本
npm run build
```

---

## 10. 环境配置

配置文件位于 `src/config/`：
- `ConfigLoader.ts` - 配置加载器
- `default.config.ts` - 默认配置
- `server.config.ts` - 服务器配置

环境变量通过 `.env` 文件设置（参考 `.env.example`）。

---

## 11. 测试体系

测试文件位于 `tests/` 目录：
- `harness/` - Harness专项测试（132个用例）
- `unit/` - 单元测试
- `integration/` - 集成测试
- `e2e/` - 端到端测试
- `stress/` - 压力测试
- `acceptance/` - 验收测试
- `coordination/` - 协调测试
- `eval/` - 评估测试

---

## 12. CI/CD

### GitHub Actions工作流

| 工作流 | 描述 | 文件 |
|------|------|------|
| 后端CI/CD | 构建、测试、部署后端 | `.github/workflows/backend-ci-cd.yml` |
| 前端CI/CD | 构建、测试、部署前端 | `.github/workflows/frontend-ci-cd.yml` |

---

## 更新日志

### V5.0 (2026-05-27)
- ✅ 完成Harness Agent Framework 6层架构
- ✅ 删除约63,000行死代码（`src/tools/`、`src/ide/`等）
- ✅ 重构代码库，整合到统一架构
- ✅ 进程隔离网关架构
- ✅ 更新CODE_WIKI.md以匹配实际代码库

---

**文档版本**: 5.0 | **最后更新**: 2026-05-27 模型类型定义 |

#### LLM辅助模块 (`src/llm/`)

| 类名 | 文件 | 职责 |
|------|------|------|
| `ModelCapabilityDetector` | [ModelCapabilityDetector.ts](file:///c:/zy/jiabaixing/src/llm/ModelCapabilityDetector.ts) | 模型能力检测器 |
| `PromptTemplateEngine` | [PromptTemplateEngine.ts](file:///c:/zy/jiabaixing/src/llm/PromptTemplateEngine.ts) | Prompt模板引擎 |
| `StreamingResponseHandler` | [StreamingResponseHandler.ts](file:///c:/zy/jiabaixing/src/llm/StreamingResponseHandler.ts) | 流式响应处理 |
| `TokenBudgetManager` | [TokenBudgetManager.ts](file:///c:/zy/jiabaixing/src/llm/TokenBudgetManager.ts) | Token预算管理 |

---

### 4.5 交互引擎 (interaction)

**路径**: `src/interaction/` | **核心类**: `InteractionEngine`

管理对话流程和交互行为，包括语音、表情、连续对话等。

#### 关键类

| 类名 | 文件 | 职责 |
|------|------|------|
| `InteractionEngine` | [InteractionEngine.ts](file:///c:/zy/jiabaixing/src/interaction/InteractionEngine.ts) | 交互引擎核心 |
| `SpeechSynthesizer` | [SpeechSynthesizer.ts](file:///c:/zy/jiabaixing/src/interaction/SpeechSynthes