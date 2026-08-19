# Jiabaixing V5.0 Code Wiki

> **版本**: V5.0 | **架构**: Python AI 核心 + TS 薄网关 混合架构 | **更新日期**: 2026-07-09

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [技术栈](#3-技术栈)
4. [核心模块详解](#4-核心模块详解)
5. [关键类与函数](#5-关键类与函数)
6. [依赖关系图](#6-依赖关系图)
7. [数据流与调用链](#7-数据流与调用链)
8. [项目运行方式](#8-项目运行方式)
9. [测试体系](#9-测试体系)
10. [配置管理](#10-配置管理)
11. [开发规范](#11-开发规范)
12. [部署与运维](#12-部署与运维)

---

## 1. 项目概述

### 1.1 项目定位

**家百星 (Jiabaixing)** 是一个本地运行的 AI Agent 框架，核心理念：

```
Agent = (LLM 推理 + 能力组件) × Harness 六层管控
```

LLM 负责认知（推理、选工具、表达），Harness 负责工程（预算、权限、验证、状态）。

### 1.2 核心特性

| 特性              | 说明                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| 六层 Harness 管控 | E-T-C-S-L-V 六层可独立开关                                               |
| 57+ 工具          | 8 大分类：memory, cognition, desktop, file, code, system, daily, network |
| 三层记忆体系      | 瞬时 / 短期(SQLite) / 长期(ChromaDB)                                     |
| 进化引擎 V2       | LLM 驱动的自我进化 + 代码自修改                                          |
| 多模型路由        | ProviderManager 管理，自动降级 + 熔断感知                                |
| 混合架构          | TS 前端 + Python AI 核心引擎                                             |
| 多平台网关        | 微信/QQ/飞书/钉钉                                                        |
| 桌面自动化        | nut.js + Playwright                                                      |

### 1.3 项目版本与规模

- **版本**: 5.0.0
- **TypeScript 文件**: ~350 个 .ts 文件
- **Python 文件**: ~100 个 .py 文件
- **Manager/Service/Engine 类**: ~140 个
- **测试用例**: 2000+ (Python 2028 + TS 数百个)

---

## 2. 整体架构

### 2.1 混合架构总览

```
┌─────────────────────────────────────────────────────────┐
│                   前端层 (React/Electron)                │
│  React 18 + Zustand + WebSocket (6个面板)               │
└────────────────────────────┬────────────────────────────┘
                             │ HTTP/WS
┌────────────────────────────▼────────────────────────────┐
│              TS 网关层 (Express :3111)                   │
│  Express + WebSocket + PythonAgentBridge + ACP Server    │
└────────────────────────────┬────────────────────────────┘
                             │ HTTP/WS Bridge
┌────────────────────────────▼────────────────────────────┐
│            Python AI 核心层 (FastAPI :3112)              │
│  AgentEngine + LoopController + LLM + Memory + Evolution │
└─────────────────────────────────────────────────────────┘
```

### 2.2 架构原则

| 原则                | 说明                                                     |
| ------------------- | -------------------------------------------------------- |
| **Python 核心优先** | Agent 核心功能（LLM/记忆/Loop/进化）以 Python 端为主实现 |
| **TS 薄网关**       | TS 端仅做 HTTP/WS 入口路由、桌面自动化、前端 UI          |
| **约束而不指令**    | Harness 设边界，不告诉模型怎么思考                       |
| **状态外部化**      | LoopContext 承载全部状态，Agent 无内部状态               |
| **可剥离架构**      | 6 层独立开关，模型提升后可逐层剥离                       |

### 2.3 六层 Harness 架构

```
┌─────────────────────────────────────────┐
│  E — Execution Loop (执行循环层)         │
│  Planner→Executor→Evaluator→Reporter    │
├─────────────────────────────────────────┤
│  T — Tool Registry (工具注册层)          │
│  57+ 声明式工具, JSON Schema + 四级权限  │
├─────────────────────────────────────────┤
│  C — Context Manager (上下文管理层)      │
│  宪法Prompt→记忆→动态上下文→Token分配   │
├─────────────────────────────────────────┤
│  S — State Store (状态持久化层)          │
│  瞬时/SQLite/ChromaDB 三层状态          │
├─────────────────────────────────────────┤
│  L — Lifecycle Hooks (生命周期钩子层)    │
│  9 个钩子: before_loop ~ after_response  │
├─────────────────────────────────────────┤
│  V — Verification (验证层)               │
│  输出安全 + 结果验证 + 五维质量评分      │
└─────────────────────────────────────────┘
```

---

## 3. 技术栈

### 3.1 TypeScript 端

| 类别         | 技术                         | 版本                      |
| ------------ | ---------------------------- | ------------------------- |
| 运行时       | Node.js                      | >= 20.x                   |
| 语言         | TypeScript                   | ^5.7.0 (ES2022, CommonJS) |
| Web 框架     | Express                      | ^4.21.0                   |
| WebSocket    | ws                           | 8.20.1                    |
| 前端         | React                        | 18                        |
| 状态管理     | Zustand                      | -                         |
| 数据库       | better-sqlite3               | ^12.9.0                   |
| 向量数据库   | ChromaDB                     | ^1.10.5                   |
| 桌面自动化   | @nut-tree/nut.js             | 3.1.2                     |
| 浏览器自动化 | Playwright                   | ^1.59.1                   |
| 缓存         | ioredis                      | 5.11.1                    |
| 安全         | bcrypt, jsonwebtoken, helmet | -                         |
| 日志         | winston                      | ^3.19.0                   |
| 测试         | Jest                         | ^29.7.0                   |
| 构建         | tsc + tsx                    | -                         |

### 3.2 Python 端

| 类别        | 技术                    | 版本      |
| ----------- | ----------------------- | --------- |
| 运行时      | Python                  | >= 3.11   |
| Web 框架    | FastAPI                 | >=0.115.0 |
| ASGI 服务器 | uvicorn[standard]       | >=0.34.0  |
| LLM 调用    | litellm                 | >=1.60.0  |
| 数据验证    | Pydantic                | >=2.10.0  |
| 数据库      | SQLAlchemy + aiosqlite  | -         |
| 向量数据库  | ChromaDB                | >=1.0.0   |
| 中文分词    | jieba                   | >=0.42.1  |
| 向量编码    | sentence-transformers   | >=3.3.0   |
| 定时任务    | APScheduler             | >=3.11.0  |
| 缓存        | Redis[hiredis]          | >=5.0.0   |
| 可观测性    | OpenTelemetry           | >=1.28.0  |
| 测试        | pytest + pytest-asyncio | >=8.0.0   |
| 代码检查    | ruff                    | >=0.8.0   |

### 3.3 核心依赖

```
TypeScript 端核心依赖树:
├── express (HTTP 服务)
├── ws (WebSocket)
├── better-sqlite3 (关系型数据库)
├── chromadb (向量数据库)
├── zustand (前端状态)
├── winston (日志)
└── @nut-tree/nut.js (桌面自动化)

Python 端核心依赖树:
├── fastapi + uvicorn (HTTP 服务)
├── litellm (LLM 统一接口)
├── sqlalchemy + aiosqlite (数据库)
├── chromadb (向量数据库)
├── jieba (中文分词)
├── sentence-transformers (向量编码)
├── apscheduler (定时任务)
└── opentelemetry (可观测性)
```

---

## 4. 核心模块详解

### 4.1 Python 后端模块

#### 4.1.1 核心引擎 (agent/core/)

| 模块                 | 文件                                                              | 职责                         |
| -------------------- | ----------------------------------------------------------------- | ---------------------------- |
| AgentEngine          | [engine.py](file:///c:/zy/jiabaixing/python/agent/core/engine.py) | 中央编排器，初始化所有子系统 |
| ConversationLoop     | conversation_loop.py                                              | 对话循环，ReAct 模式         |
| ContextManager       | context_pipeline.py                                               | 上下文构建管道               |
| ContextCompressor    | context_compressor.py                                             | 上下文压缩器                 |
| PersonaCore          | persona.py                                                        | 人格核心                     |
| SecurityGuard        | security.py                                                       | 安全守卫                     |
| HookManager          | hooks.py                                                          | 生命周期钩子管理             |
| CanaryReleaseManager | canary_release.py                                                 | 金丝雀发布管理               |
| StructuredLogger     | logger.py                                                         | 结构化日志                   |

**AgentEngine 初始化顺序**:

1. OTel 可观测性
2. Redis 缓存层
3. LLM Provider
4. Memory Engine + EpisodicMemoryStore
5. Trajectory Database
6. Tool Registry + Toolset Registry
7. MCP Tool Bridge
8. Permission Guard / Schema Validator / Tool Call Guard
9. Approval Manager
10. Canary Release Manager
11. Constraints Service
12. Loop Controller
13. Evolution Engine
14. Performance Monitor + Evolution Trigger
15. Conversation Loop
16. Context Pipeline
17. Persona / Security / Verification
18. Skill Registry / Session Store
19. Persistence Service
20. Hook Manager
21. Feedback Loops
22. A2A Protocol
23. Agent Registry + Orchestrator
24. Cron Job Scheduler
25. Sandbox Executor
26. Batch Processor
27. Production Metrics + Continuous Feedback Loop

#### 4.1.2 LLM 模块 (agent/llm/)

| 模块                        | 文件                                                                 | 职责                              |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------- |
| LLMProvider                 | [provider.py](file:///c:/zy/jiabaixing/python/agent/llm/provider.py) | 主 LLM 接口，统一调用入口         |
| LLMCache                    | cache.py                                                             | LLM 响应缓存                      |
| CredentialPool              | credential_pool.py                                                   | API Key 凭据池 + 轮换             |
| CostGuard                   | credential_pool.py                                                   | 成本守卫                          |
| PromptCacheManager          | prompt_cache.py                                                      | Prompt 智能缓存                   |
| RequestQueue                | queue.py                                                             | 请求队列，并发控制                |
| ProviderManager             | router.py                                                            | 多提供商管理 + 路由               |
| AnthropicPrefixCacheBuilder | prompt_cache.py                                                      | Anthropic 前缀缓存优化            |
| BaseTransport               | transports.py                                                        | 传输层抽象 (OpenAI/Anthropic/...) |
| TransportFactory            | transports.py                                                        | 传输层工厂                        |

**LLM 调用路径**:

```
LLMProvider.chat()
  ├── CanaryReleaseManager.select_version()  [灰度选择]
  ├── LLMCache.get() / .set()               [缓存检查]
  ├── CredentialPool.next_credential()      [凭据轮换]
  ├── CostGuard.check_and_record()          [成本控制]
  ├── RequestQueue.add()                    [并发控制]
  └── litellm.acompletion() / Transport     [实际调用]
```

#### 4.1.3 Loop 模块 (agent/loop/)

| 模块                  | 文件                                                                      | 职责                   |
| --------------------- | ------------------------------------------------------------------------- | ---------------------- |
| LoopController        | [controller.py](file:///c:/zy/jiabaixing/python/agent/loop/controller.py) | 循环控制器，状态机调度 |
| Planner               | planner.py                                                                | 任务规划器，任务分解   |
| Executor              | executor.py                                                               | 执行器，ReAct 循环     |
| Evaluator             | evaluator.py                                                              | 评估器，结果质量评估   |
| Reporter              | reporter.py                                                               | 报告器，响应生成       |
| ReflectionEngine      | reflection.py                                                             | 反思引擎，经验总结     |
| CausalModeler         | causal.py                                                                 | 因果建模，依赖分析     |
| AttentionFocusManager | attention.py                                                              | 注意力聚焦             |
| QualityScorer         | quality_scorer.py                                                         | 质量评分器             |
| IncrementalPlanner    | incremental_planner.py                                                    | 增量重规划             |
| PlanQualityChecker    | plan_quality_checker.py                                                   | 规划质量预检           |
| FeedbackLoops         | feedback_loops.py                                                         | 反馈循环               |
| BatchProcessor        | batch_processor.py                                                        | 批处理，并发控制       |
| ToTPlanner            | tot_planner.py                                                            | 思维树规划             |
| Debater               | debater.py                                                                | 辩论式推理             |

**LoopController 状态机**:

```
IDLE → PLANNING → EXECUTING → EVALUATING → REPORTING → DONE
         ↑              ↓
         └──── REPLAN ──┘ (最多3次)
```

#### 4.1.4 记忆模块 (agent/memory/)

| 模块                | 文件                                                                | 职责                            |
| ------------------- | ------------------------------------------------------------------- | ------------------------------- |
| MemoryEngine        | [engine.py](file:///c:/zy/jiabaixing/python/agent/memory/engine.py) | 记忆引擎，统一入口              |
| MemoryStore         | store.py                                                            | SQLite 记忆存储 (FTS5 全文检索) |
| EpisodicMemoryStore | episodic_memory.py                                                  | 情景记忆存储                    |
| Curator             | curator.py                                                          | 记忆策展人，质量筛选            |
| Tokenizer           | tokenizer.py                                                        | 中文分词器 (jieba)              |
| RedisCache          | redis_cache.py                                                      | Redis 缓存层 (可选)             |
| MultimodalEncoder   | multimodal_encoder.py                                               | 多模态编码器                    |

**三层记忆体系**:

```
┌─────────────────────────────────┐
│  瞬时记忆 (Instant)              │
│  LoopContext.messages           │
│  生命周期: 请求级别              │
├─────────────────────────────────┤
│  短期记忆 (Short-term)          │
│  SQLite (better-sqlite3)        │
│  生命周期: 对话/天级别           │
│  检索: FTS5 全文检索            │
├─────────────────────────────────┤
│  长期记忆 (Long-term)           │
│  ChromaDB 向量数据库            │
│  生命周期: 永久                  │
│  检索: 语义向量检索             │
└─────────────────────────────────┘
```

#### 4.1.5 进化模块 (agent/evolution/)

| 模块                      | 文件                   | 职责                    |
| ------------------------- | ---------------------- | ----------------------- |
| EvolutionEngine           | engine.py              | 进化引擎 V1，反馈学习   |
| EvolutionEngineV2         | v2_engine.py           | 进化引擎 V2，代码自修改 |
| EvolutionOrchestrator     | orchestrator.py        | 进化编排器              |
| EvolutionTrigger          | trigger.py             | 进化触发器              |
| PerformanceMonitor        | monitor.py             | 性能监控器              |
| StrategyAdapter           | strategy_adapter.py    | 策略适配器              |
| FewShotGeneralizer        | fewshot_generalizer.py | 少样本泛化器            |
| LearningSignalCollector   | learning_signals.py    | 学习信号收集器          |
| FeedbackLoop              | feedback_loop.py       | 持续反馈闭环            |
| ImplicitFeedbackCollector | implicit_feedback.py   | 隐式反馈收集            |
| SkillEngine               | skill_engine.py        | 技能引擎                |
| SkillUsageTracker         | skill_usage_tracker.py | 技能使用追踪            |

**进化触发条件**:

- 性能指标低于阈值
- 任务成功率下降
- 用户负面反馈累积
- 定时触发（最小间隔 300 秒）

#### 4.1.6 工具模块 (agent/tools/)

| 分类      | 工具数量 | 示例工具                                        |
| --------- | -------- | ----------------------------------------------- |
| memory    | 3+       | memory_recall, memory_store, memory_search      |
| cognition | 3+       | emotion_detect, analyze_scene, self_reflect     |
| desktop   | 2+       | desktop_automate, desktop_screenshot            |
| file      | 5+       | file_list, file_search, incremental_edit        |
| code      | 3+       | code_analyze, code_fix, code_generate           |
| system    | 4+       | ask_clarification, shell_exec, rollback_changes |
| daily     | 9+       | task_manage, reminder_set, calendar             |
| network   | 4+       | web_search, web_fetch, image_generate           |
| lsp       | -        | lsp_hover, lsp_definition                       |
| browser   | -        | browser_automation                              |

**工具守卫链**:

```
Tool Call → PermissionGuard → SchemaValidator → ToolCallGuard → ApprovalManager → Tool Executor
```

#### 4.1.7 A2A 协议模块 (agent/a2a/)

| 模块               | 文件        | 职责                                           |
| ------------------ | ----------- | ---------------------------------------------- |
| A2AProtocolManager | protocol.py | A2A 协议管理器（任务委派+发现+信任）           |
| A2ATaskManager     | protocol.py | 跨 Agent 任务委派与结果收集                    |
| A2ADiscovery       | protocol.py | Agent 注册发现与健康检查                       |
| A2ATrustManager    | protocol.py | 信任等级(UNTRUSTED/LOW/MEDIUM/HIGH) + 操作权限 |
| A2AAgentCard       | types.py    | Agent 能力声明卡片                             |
| A2AAuthInterceptor | auth.py     | 入站校验 + 出站凭据注入                        |
| A2AClient          | client.py   | A2A 客户端                                     |
| A2AServer          | server.py   | A2A 服务端                                     |

#### 4.1.8 MCP 模块 (agent/mcp/)

| 模块             | 文件                     | 职责             |
| ---------------- | ------------------------ | ---------------- |
| MCPServerManager | server_manager.py        | MCP 服务器管理器 |
| MCPTransport     | transport.py             | MCP 传输层       |
| MCP Sampling     | sampling.py              | MCP 采样原语     |
| MCP Logging      | logging.py               | MCP 日志原语     |
| MCP Progress     | progress.py              | MCP 进度原语     |
| MCPToolBridge    | tools/mcp_tool_bridge.py | MCP 工具桥接     |

### 4.2 TypeScript 端模块

#### 4.2.1 核心层 (src/core/)

| 模块                      | 文件                                                                     | 职责                  |
| ------------------------- | ------------------------------------------------------------------------ | --------------------- |
| JiabaixingCore            | [JiabaixingCore.ts](file:///c:/zy/jiabaixing/src/core/JiabaixingCore.ts) | 核心引擎，TS 端主入口 |
| ConstitutionPromptBuilder | ConstitutionPromptBuilder.ts                                             | 宪法提示词构建器      |
| MemoryAssistant           | MemoryAssistant.ts                                                       | 记忆助手              |
| ScenarioAwareScheduler    | ScenarioAwareScheduler.ts                                                | 场景感知调度器        |
| OptimizationScheduler     | OptimizationScheduler.ts                                                 | 优化调度器            |
| StreamResponseService     | StreamResponseService.ts                                                 | 流式响应服务          |
| UnifiedContextPipeline    | UnifiedContextPipeline.ts                                                | 统一上下文管道        |
| DAGTask                   | DAGTask.ts                                                               | 有向无环图任务        |

#### 4.2.2 网关与桥接 (src/ide/)

| 模块               | 文件                                                                          | 职责                              |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------- |
| PythonAgentBridge  | [PythonAgentBridge.ts](file:///c:/zy/jiabaixing/src/ide/PythonAgentBridge.ts) | TS ↔ Python 通信桥                |
| ACPServer          | ACPServer.ts                                                                  | Agent Communication Protocol 服务 |
| ACPActivityTracker | ACPActivityTracker.ts                                                         | ACP 活动追踪                      |

**PythonAgentBridge 通信方式**:

- **HTTP 连接池**: keepAlive + maxSockets 减少握手开销
- **WebSocket 流式通道**: 优先 WS，回退 HTTP
- **支持 streaming callback 和 cancel**
- **事件类型**: stream_start, stream_chunk, stream_done, thinking, tool_start, tool_end, progress, error

#### 4.2.3 服务端 (src/server/)

| 模块            | 文件                                                             | 职责                 |
| --------------- | ---------------------------------------------------------------- | -------------------- |
| bootstrap       | [bootstrap.ts](file:///c:/zy/jiabaixing/src/server/bootstrap.ts) | 启动编排，10步初始化 |
| websocket       | websocket.ts                                                     | WebSocket 服务       |
| eventBusSetup   | eventBusSetup.ts                                                 | 事件总线设置         |
| shutdown        | shutdown.ts                                                      | 优雅关闭             |
| SystemInitState | SystemInitState.ts                                               | 系统初始化状态       |

**bootstrap 初始化 10 步**:

1. 日志系统
2. 安全与加密
3. 数据库 (SQLite, Chroma)
4. 表情、语音、环境感知
5. 工具注册与推荐引擎
6. 模型初始化 (OpenAI 兼容接口)
7. 核心推理引擎
8. 交互引擎
9. 学习循环 (热监视、自动优化)
10. 场景感知调度器

#### 4.2.4 Harness 层 (src/harness/)

> **注意**: TS 端 Harness 核心组件已迁移至 Python 端。
> TS 端 `src/harness/loop/` 目录下**不存在** LoopController.ts、Planner.ts、Executor.ts、Evaluator.ts、Reporter.ts。
> 这些组件仅存在于 Python 端 `agent/loop/`。当 `AGENT_BACKEND=python`（默认）时，请求通过 PythonAgentBridge 转发。

| 模块                             | 职责                               | 状态                  |
| -------------------------------- | ---------------------------------- | --------------------- |
| AgentHarness                     | 六层组装点（python模式时仅做转发） | 活跃(网关)            |
| ProcessInputLoop                 | 本地执行循环                       | @deprecated，V6.0移除 |
| loop/AutonomousTrigger           | 自主循环触发器                     | 活跃                  |
| loop/CausalModeler               | 因果建模器                         | @deprecated，V6.0移除 |
| tools/registry/ToolRegistry      | 工具注册                           | 回退                  |
| context/ContextManager           | 上下文管理                         | 回退                  |
| persistence/PersistenceService   | 持久化                             | 回退                  |
| verification/VerificationService | 验证                               | 回退                  |
| constraints/ConstraintsService   | 生命周期钩子                       | 回退                  |

#### 4.2.5 前端 (src/frontend/)

| 模块               | 说明             |
| ------------------ | ---------------- |
| App.tsx            | 主应用组件       |
| api/apiService.ts  | API 服务         |
| stores/index.ts    | Zustand 状态管理 |
| hooks/useSSE.ts    | SSE 钩子         |
| styles/aion-ui.css | UI 样式          |

**14 个面板**:

1. ChatInterface - 聊天界面
2. DesktopPanel - 桌面自动化
3. EvolutionPanel - 进化监控
4. SecurityPanel - 安全面板
5. MemoryPanel - 记忆管理
6. SkillConsole - 技能控制台
7. MonitorPanel - 监控面板
8. PerformancePanel - 性能面板
9. AgentExecutionPanel - Agent 执行
10. LogPanel - 日志面板
11. SettingsPanel - 设置面板
12. AutomationPanel - 自动化面板
13. IntegrationPanel - 集成面板
14. VibeCodingPanel - 氛围编码

#### 4.2.6 其他模块

| 模块       | 路径             | 职责                       |
| ---------- | ---------------- | -------------------------- |
| 记忆系统   | src/memory/      | 三层记忆 (TS 端遗留)       |
| 模型管理   | src/models/      | LLM 提供商管理 (TS 端遗留) |
| 安全系统   | src/security/    | 安全审计、权限控制         |
| 进化引擎   | src/evolution/   | 进化引擎 (TS 端遗留)       |
| 桌面自动化 | src/desktop/     | 桌面 Agent、UI 检测        |
| CLI 系统   | src/cli/         | REPL / pipe / daemon 模式  |
| 技能系统   | src/skills/      | 技能注册与管理             |
| 人格系统   | src/persona/     | 人格核心与对话生成         |
| 多模态     | src/multimodal/  | 语音、图像、情绪识别       |
| 集成网关   | src/integration/ | 微信/QQ/飞书/钉钉          |

---

## 5. 关键类与函数

### 5.1 Python 端核心类

#### AgentEngine

**文件**: [agent/core/engine.py](file:///c:/zy/jiabaixing/python/agent/core/engine.py)

**核心方法**:

| 方法                     | 签名                                                         | 说明              |
| ------------------------ | ------------------------------------------------------------ | ----------------- |
| `initialize()`           | `async def initialize() -> None`                             | 初始化所有子系统  |
| `process_input()`        | `async def process_input(message, session_id, ...) -> dict`  | 主处理入口        |
| `process_input_stream()` | `async def process_input_stream(...) -> AsyncIterator`       | 流式处理入口      |
| `build_context()`        | `async def build_context(...) -> ContextBuildResult \| None` | 构建上下文        |
| `_should_use_loop()`     | `def _should_use_loop(message: str) -> bool`                 | 判断是否使用 Loop |

**处理路径选择**:

```
message → _should_use_loop()?
  ├── True → MultiAgentOrchestrator? (超复杂)
  │          └── _process_with_loop()
  ├── False → conversation available?
  │          ├── Yes → _process_with_conversation()
  │          └── No → _process_simple()
```

#### LLMProvider

**文件**: [agent/llm/provider.py](file:///c:/zy/jiabaixing/python/agent/llm/provider.py)

**核心方法**:

| 方法                | 签名                                                   | 说明       |
| ------------------- | ------------------------------------------------------ | ---------- |
| `chat()`            | `async def chat(messages, tools, stream, ...) -> dict` | 聊天完成   |
| `chat_stream()`     | `async def chat_stream(...) -> AsyncIterator`          | 流式聊天   |
| `check_available()` | `async def check_available() -> bool`                  | 检查可用性 |
| `embed()`           | `async def embed(texts) -> list`                       | 向量嵌入   |

#### LoopController

**文件**: [agent/loop/controller.py](file:///c:/zy/jiabaixing/python/agent/loop/controller.py)

**核心方法**:

| 方法              | 签名                                               | 说明             |
| ----------------- | -------------------------------------------------- | ---------------- |
| `run()`           | `async def run(goal, context, ...) -> AgentResult` | 运行循环         |
| `register_hook()` | `def register_hook(hook, callback) -> None`        | 注册生命周期钩子 |

**属性**:

- `planner: Planner` - 规划器
- `executor: Executor` - 执行器
- `evaluator: Evaluator` - 评估器
- `reporter: Reporter` - 报告器
- `reflection: ReflectionEngine` - 反思引擎
- `MAX_REPLAN_COUNT = 3` - 最大重规划次数

#### MemoryEngine

**文件**: [agent/memory/engine.py](file:///c:/zy/jiabaixing/python/agent/memory/engine.py)

**核心方法**:

| 方法                    | 签名                                                | 说明         |
| ----------------------- | --------------------------------------------------- | ------------ |
| `initialize()`          | `async def initialize() -> None`                    | 初始化       |
| `store()`               | `async def store(content, memory_type, ...) -> str` | 存储记忆     |
| `search()`              | `async def search(query, limit, ...) -> list`       | 检索记忆     |
| `search_with_context()` | `async def search_with_context(...) -> list`        | 带上下文检索 |
| `store_instant()`       | `async def store_instant(content, scene) -> None`   | 瞬时记忆     |
| `store_short_term()`    | `async def store_short_term(...) -> str`            | 短期记忆     |
| `store_long_term()`     | `async def store_long_term(...) -> str`             | 长期记忆     |
| `set_episodic_store()`  | `def set_episodic_store(store) -> None`             | 设置情景记忆 |

### 5.2 TypeScript 端核心类

#### JiabaixingCore

**文件**: [src/core/JiabaixingCore.ts](file:///c:/zy/jiabaixing/src/core/JiabaixingCore.ts)

**核心方法**:

| 方法                | 说明                   |
| ------------------- | ---------------------- |
| `processInput()`    | 处理用户输入（主入口） |
| `initialize()`      | 初始化核心引擎         |
| `getMemoryEngine()` | 获取记忆引擎           |

**Python 后端模式**: 当 `AGENT_BACKEND=python` 时，所有 AI 请求通过 `PythonAgentBridge` 转发。

#### PythonAgentBridge

**文件**: [src/ide/PythonAgentBridge.ts](file:///c:/zy/jiabaixing/src/ide/PythonAgentBridge.ts)

**核心方法**:

| 方法                   | 签名                                          | 说明     |
| ---------------------- | --------------------------------------------- | -------- |
| `processInput()`       | `async processInput(message, sessionId, ...)` | 处理输入 |
| `processInputStream()` | `async processInputStream(..., onStream)`     | 流式处理 |
| `cancelTask()`         | `cancelTask(sessionId)`                       | 取消任务 |
| `getHealth()`          | `async getHealth()`                           | 健康检查 |

**事件类型** (`StreamEventType`):

- `stream_start` - 流开始
- `stream_chunk` - 流式 token
- `stream_done` - 流完成
- `thinking` - 思考过程
- `tool_start` - 工具调用开始
- `tool_end` - 工具调用结束
- `progress` - 任务进度
- `error` - 错误
- `task_cancelled` - 任务已取消
- `clarification_request` - 澄清请求

### 5.3 关键数据结构

#### LoopContext (Python)

```python
@dataclass
class LoopContext:
    goal: str                    # 目标
    plan: ExecutionPlan | None   # 执行计划
    state: LoopState            # 当前状态
    messages: list[dict]        # 消息历史
    tool_results: list          # 工具结果
    budget: BudgetState         # 预算状态
    session_id: str             # 会话ID
    trace_id: str               # 追踪ID
```

#### AgentResult (Python)

```python
@dataclass
class AgentResult:
    content: str                # 最终响应
    success: bool               # 是否成功
    steps_completed: int        # 完成步数
    steps_total: int            # 总步数
    tool_activities: list       # 工具活动记录
    quality_score: float        # 质量评分
    trace_id: str               # 追踪ID
```

---

## 6. 依赖关系图

### 6.1 Python 端模块依赖

```
AgentEngine (core/engine.py)
├── LLMProvider (llm/provider.py)
│   ├── LLMCache (llm/cache.py)
│   ├── CredentialPool (llm/credential_pool.py)
│   ├── CostGuard (llm/credential_pool.py)
│   ├── PromptCacheManager (llm/prompt_cache.py)
│   ├── RequestQueue (llm/queue.py)
│   ├── ProviderManager (llm/router.py)
│   └── TransportFactory (llm/transports.py)
├── MemoryEngine (memory/engine.py)
│   ├── MemoryStore (memory/store.py)
│   ├── EpisodicMemoryStore (memory/episodic_memory.py)
│   ├── Curator (memory/curator.py)
│   └── RedisCache (memory/redis_cache.py)
├── LoopController (loop/controller.py)
│   ├── Planner (loop/planner.py)
│   ├── Executor (loop/executor.py)
│   ├── Evaluator (loop/evaluator.py)
│   ├── Reporter (loop/reporter.py)
│   ├── ReflectionEngine (loop/reflection.py)
│   ├── CausalModeler (loop/causal.py)
│   └── BatchProcessor (loop/batch_processor.py)
├── ToolRegistry (tools/registry.py)
│   ├── PermissionGuard (tools/permission_guard.py)
│   ├── SchemaValidator (tools/schema_validator.py)
│   ├── ToolCallGuard (tools/tool_call_guard.py)
│   └── ApprovalManager (tools/approval_manager.py)
├── EvolutionEngine (evolution/engine.py)
│   ├── EvolutionOrchestrator (evolution/orchestrator.py)
│   ├── EvolutionTrigger (evolution/trigger.py)
│   └── PerformanceMonitor (evolution/monitor.py)
├── ConversationLoop (core/conversation_loop.py)
├── ContextManager (core/context_pipeline.py)
├── HookManager (core/hooks.py)
├── PersistenceService (persistence/service.py)
│   ├── SessionStore (persistence/session_store.py)
│   └── TrajectoryDatabase (persistence/trajectory.py)
├── VerificationService (verification/service.py)
├── ConstraintsService (constraints/service.py)
├── SecurityGuard (core/security.py)
├── PersonaCore (core/persona.py)
├── A2AProtocolManager (a2a/manager.py)
├── MCPServerManager (mcp/server_manager.py)
└── CronJobScheduler (scheduler/cron.py)
```

### 6.2 TS 端模块依赖

```
main.ts (入口)
├── express app
├── bootstrap (server/bootstrap.ts)
│   ├── JiabaixingCore (core/JiabaixingCore.ts)
│   ├── PythonAgentBridge (ide/PythonAgentBridge.ts) [可选]
│   ├── initSecurity()
│   ├── initMemory()
│   ├── initHarness()
│   ├── initEvolution()
│   ├── initGateway()
│   └── initInteraction()
├── WebSocket 服务
│   └── WsProcessor (server/websocket/)
├── 路由系统 (server/routes/)
│   ├── chatRoutes
│   ├── coreRoutes
│   ├── mcpRoutes
│   ├── memoryRoutes
│   ├── evolutionRoutes
│   ├── securityRoutes
│   └── ...
└── 前端 (src/frontend/)
    └── React 应用
```

### 6.3 跨语言依赖

```
TS 端 (Express :3111)
    │
    ├─ HTTP REST → Python FastAPI (:3112)
    │   └── PythonAgentBridge.axios
    │
    ├─ WebSocket → Python WebSocket (:3112)
    │   └── PythonAgentBridge.chatWs
    │
    └─ 事件转发
        └── EventBus → WebSocket broadcast

Python 端 (FastAPI :3112)
    │
    └── 回调通知 → TS 端 (可选)
```

---

## 7. 数据流与调用链

### 7.1 主处理流程 (Python 后端模式)

```
用户输入
  ↓
TS Express 路由 (chat.ts)
  ↓
PythonAgentBridge.processInput()
  ↓
HTTP/WS 请求 → Python FastAPI /v1/chat
  ↓
AgentEngine.process_input()
  ├─ SecurityGuard.check_command()         [安全检查]
  ├─ ContextFileRegistry.load_all()        [文件上下文]
  ├─ ContextReferenceResolver.resolve()    [@引用解析]
  ├─ _should_use_loop()?                   [路径选择]
  │   ├─ True → _process_with_loop()
  │   │       ↓
  │   │   LoopController.run()
  │   │       ├─ Planner.plan()            [规划]
  │   │       ├─ Executor.execute()        [执行 ReAct]
  │   │       │   └─ ToolRegistry          [调用工具]
  │   │       ├─ Evaluator.evaluate()      [评估]
  │   │       └─ Reporter.report()         [报告]
  │   └─ False → _process_with_conversation()
  │           ↓
  │       ConversationLoop.run()           [对话模式]
  ├─ FeedbackLoops.run_all()               [反馈学习]
  └─ HookManager.trigger(AFTER_LOOP)       [生命周期钩子]
  ↓
响应结果
  ↓
WebSocket 流式推送 → 前端展示
```

### 7.2 工具调用链

```
LLM 生成 tool_call
  ↓
ToolCallGuard.pre_check()                  [调用前守卫]
  ↓
PermissionGuard.check()                    [权限检查]
  ↓
SchemaValidator.validate()                 [参数校验]
  ↓
ApprovalManager.request_approval()         [审批检查]
  ↓
HookManager.trigger(BEFORE_TOOL_CALL)      [前置钩子]
  ↓
Tool Executor 执行工具
  ├─ file_tools / code_tools
  ├─ memory_tools / cognition_tools
  ├─ desktop_tools / network_tools
  └─ system_tools / daily_tools
  ↓
HookManager.trigger(AFTER_TOOL_CALL)       [后置钩子]
  ↓
VerificationService.verify()               [结果验证]
  ↓
返回工具结果给 LLM
```

### 7.3 记忆写入流程

```
用户输入 / 工具结果 / 响应
  ↓
MemoryEngine.store()
  ├─ 类型判断 (instant / short_term / long_term)
  ├─ MemoryStore.store()                  [写入 SQLite]
  ├─ RedisCache.set()                     [写入 Redis 缓存]
  └─ (long_term) → ChromaDB 向量存储
  ↓
Curator.quality_check()                   [质量策展]
```

---

## 8. 项目运行方式

### 8.1 环境要求

| 组件     | 要求                    |
| -------- | ----------------------- |
| Node.js  | >= 20.x                 |
| Python   | >= 3.11 (推荐 3.13)     |
| npm      | 随 Node.js              |
| pip      | 随 Python               |
| 操作系统 | Windows / macOS / Linux |

### 8.2 快速开始

#### 安装

```bash
# 方式 1: 一键安装 (Linux/macOS)
bash install.sh

# 方式 2: 手动安装
# 1. 安装 TS 依赖
npm install

# 2. 安装 Python 依赖
cd python
pip install -e .

# 3. 配置 LLM
npm run setup
```

#### 启动 (TS 单后端模式)

```bash
# 启动后端 + 前端
npm start

# 或分别启动
npm run start:backend    # 后端 :3111
npm run start:frontend   # 前端 :3000 (代理到 :3111)
```

#### 启动 (Python + TS 混合模式)

```bash
# 1. 启动 Python AI 后端
cd python
python -m uvicorn agent.main:app --port 8765 --reload

# 2. 设置环境变量切换到 Python 后端
$env:AGENT_BACKEND = "python"
$env:PYTHON_AGENT_URL = "http://localhost:8765"

# 3. 启动 TS 网关 + 前端
npm start
```

#### CLI 模式

```bash
# REPL 模式
npm run cli

# Daemon 模式
npm run daemon
```

### 8.3 验证安装

```bash
# 健康检查
curl http://localhost:3111/api/health

# 测试 LLM 连接
npm run setup:test

# 运行测试
npm test                    # TS 测试
cd python && python -m pytest tests/ -v   # Python 测试
```

### 8.4 配置向导

```bash
npm run setup            # 交互式配置向导
npm run setup:list       # 查看当前配置
npm run setup:test       # 测试所有 Provider 连接
```

支持多 Provider（DeepSeek/小米MiMo/OpenAI/智谱/本地），自动导入 `.env`。

---

## 9. 测试体系

### 9.1 Python 测试

**测试框架**: pytest + pytest-asyncio

**运行命令**:

```bash
# 运行全部 Python 测试（必须使用 Python 3.13）
cd python
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/ -v

# 运行特定模块测试
python -m pytest tests/test_llm.py -v
python -m pytest tests/test_memory.py -v
python -m pytest tests/test_loop.py -v

# 运行特定测试用例 (-k 关键字过滤)
python -m pytest tests/ -k "test_credential" -v

# 运行测试并显示详细输出
python -m pytest tests/ -v --tb=long

# 运行测试并生成覆盖率报告
python -m pytest tests/ --cov=agent --cov-report=term-missing
```

**测试文件对应关系**:

| 测试文件                   | 覆盖模块                                   |
| -------------------------- | ------------------------------------------ |
| test_api.py                | API 基础端点                               |
| test_llm.py                | LLM Provider/Cache/Queue/Router            |
| test_memory.py             | Memory Engine/Store/Tokenizer              |
| test_loop.py               | Loop Controller/Planner/Executor/Evaluator |
| test_evolution.py          | Evolution Engine                           |
| test_phase5.py             | Skill/Cron/Session                         |
| test_phase6.py             | Context/Persona/Security                   |
| test_phase7.py             | Tool Registry                              |
| test_phase8_e2e.py         | 端到端集成                                 |
| test_core_loop.py          | ConversationLoop/Compressor/Curator        |
| test_baseline_e2e.py       | 基线端到端测试                             |
| test_p1_credential_cost.py | CredentialPool/CostGuard/PromptCache       |

### 9.2 TypeScript 测试

**测试框架**: Jest

**运行命令**:

```bash
# 运行所有 TS 测试
npm test

# 运行特定测试
npm test -- --grep "LLMProvider"

# 运行测试并生成覆盖率报告
npm test -- --coverage

# 运行测试并监听文件变化
npm test -- --watch
```

### 9.3 混合架构测试

```bash
# 1. 启动 Python Agent 后端
cd python
python -m uvicorn agent.main:app --port 8765

# 2. 设置环境变量切换到 Python 后端
$env:AGENT_BACKEND = "python"
$env:PYTHON_AGENT_URL = "http://localhost:8765"

# 3. 启动 TS 服务并验证 Bridge 通信
npm start
```

### 9.4 测试规范

#### Python 测试规范

- **测试文件命名**: `test_<模块名>.py`，放在 `python/tests/` 目录
- **测试类命名**: `Test<功能名>`，如 `TestCredentialPool`
- **测试方法命名**: `test_<行为描述>`
- **数据库隔离**: 涉及 SQLite 的测试使用独立临时数据库
- **资源清理**: 测试结束前必须关闭数据库连接
- **异步测试**: 使用 `@pytest.mark.asyncio` 装饰器

#### TypeScript 测试规范

- **测试文件命名**: `<模块名>.test.ts`，放在对应模块的 `__tests__/` 目录
- **测试框架**: Jest
- **Mock 外部依赖**: 使用 `jest.mock()` 模拟 API 调用

---

## 10. 配置管理

### 10.1 环境变量

主要配置通过 `.env` 文件管理，示例见 `.env.example`。

**关键配置项**:

| 变量                      | 默认值                | 说明                      |
| ------------------------- | --------------------- | ------------------------- |
| `PORT`                    | 3111                  | TS 后端端口               |
| `AGENT_BACKEND`           | -                     | 后端类型 (python 或 留空) |
| `PYTHON_AGENT_URL`        | http://localhost:3112 | Python 后端 URL           |
| `LLM_MODEL`               | openai/gpt-4o-mini    | 默认 LLM 模型             |
| `LLM_API_KEY`             | -                     | LLM API Key               |
| `LLM_BASE_URL`            | -                     | LLM 基础 URL              |
| `LLM_TEMPERATURE`         | 0.7                   | 温度参数                  |
| `LLM_MAX_TOKENS`          | 4096                  | 最大 Token 数             |
| `REDIS_ENABLED`           | false                 | 是否启用 Redis            |
| `OTEL_ENABLED`            | false                 | 是否启用 OpenTelemetry    |
| `USE_UNIFIED_CONTEXT`     | true                  | 是否使用统一上下文编排器  |
| `ANTHROPIC_CACHE_ENABLED` | true                  | Anthropic 前缀缓存        |
| `MCP_CIRCUIT_THRESHOLD`   | 5                     | MCP 熔断阈值              |
| `TOOL_EXECUTE_TIMEOUT`    | 120                   | 工具执行超时 (秒)         |

### 10.2 Provider 配置

存储位置: `data/providers.json`

支持多 Provider 并行，自动降级和熔断感知。

---

## 11. 开发规范

### 11.1 核心开发原则

1. **不重复造轮子** - 优先使用和扩展现有组件
2. **直接集成到系统** - 禁止独立的、未集成的组件
3. **测试 100% 通过** - 所有测试必须通过才能提交
4. **端到端验证** - 验证完整的用户流程
5. **Python 核心优先** - Agent 核心功能以 Python 端为主

### 11.2 命名规范

| 元素类型          | 命名风格                              | 示例                                 |
| ----------------- | ------------------------------------- | ------------------------------------ |
| 类名/接口名       | PascalCase                            | `UserService`, `HttpRequestHandler`  |
| 方法名/函数名     | camelCase                             | `getUserById`, `calculateTotalPrice` |
| 变量名/参数名     | camelCase                             | `userId`, `orderList`, `isActive`    |
| 常量名            | UPPER_SNAKE_CASE                      | `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT` |
| 枚举值            | UPPER_SNAKE_CASE                      | `OrderStatus.PENDING`                |
| 包名/模块名       | snake_case (Python) / kebab-case (TS) | `user_service`                       |
| 数据库表名/字段名 | snake_case                            | `users`, `order_items`, `created_at` |

### 11.3 代码风格

#### Python

- 使用 4 空格缩进
- 每行不超过 100 字符
- 遵循 ruff 规范
- 所有类、公共方法必须有 docstring

#### TypeScript

- 使用 2 空格缩进
- 每行不超过 120 字符
- 遵循 ESLint + Prettier
- 所有公共方法必须有 JSDoc 注释

### 11.4 Git 提交规范

```
type(scope): subject

类型: feat, fix, docs, style, refactor, test, chore
示例:
  feat(llm): 添加响应缓存功能
  fix(intent): 修复代码生成意图识别问题
```

### 11.5 分支策略

- `main` - 生产分支
- `develop` - 开发分支
- `feature/*` - 功能分支
- `fix/*` - 修复分支

---

## 12. 部署与运维

### 12.1 Docker 部署

```bash
# TS 端 Docker
docker build -t jiabaixing .
docker run -p 3111:3111 jiabaixing

# Python 端 Docker
cd python
docker build -t jiabaixing-python .
docker run -p 3112:3112 jiabaixing-python
```

### 12.2 Docker Compose

```bash
docker-compose up -d
```

### 12.3 Kubernetes 部署

部署文件位于 `deploy/kubernetes/`:

| 文件              | 说明         |
| ----------------- | ------------ |
| `namespace.yaml`  | 命名空间     |
| `deployment.yaml` | 部署配置     |
| `service.yaml`    | 服务配置     |
| `ingress.yaml`    | Ingress 配置 |
| `configmap.yaml`  | 配置映射     |
| `secret.yaml`     | 密钥管理     |
| `hpa.yaml`        | 水平自动扩缩 |
| `pdb.yaml`        | Pod 中断预算 |

### 12.4 监控与可观测性

**OpenTelemetry 集成**:

- Trace: 分布式追踪
- Metrics: 指标收集 (Prometheus exporter)
- Logs: 结构化日志

**关键指标**:

- 请求总数 / 错误率 / 平均延迟
- LLM Token 用量 / 成本
- 工具调用成功率
- 活跃会话数
- 进化触发次数

### 12.5 日志管理

- 使用 `winston` (TS) / `StructuredLogger` (Python)
- 日志级别: DEBUG, INFO, WARN, ERROR, FATAL
- 结构化 JSON 格式
- 敏感信息自动脱敏

---

## 附录

### A. 常用命令速查

```bash
# 开发
npm start                  # 启动后端+前端
npm run cli                # CLI 模式
npm run dev                # 开发模式 (nodemon)

# 测试
npm test                   # TS 测试
npm run test:coverage      # TS 覆盖率
cd python && python -m pytest tests/ -v  # Python 测试

# 代码质量
npm run lint               # ESLint
npm run format             # Prettier 格式化
npm run check:all          # 完整检查

# 构建
npm run build              # TypeScript 编译
npm run build:fast         # 快速编译

# 配置
npm run setup              # 配置向导
npm run setup:test         # 测试 LLM 连接
```

### B. 相关文档

- [README.md](file:///c:/zy/jiabaixing/README.md) - 项目说明
- [PROJECT.md](file:///c:/zy/jiabaixing/PROJECT.md) - 项目全景
- [ARCHITECTURE.md](file:///c:/zy/jiabaixing/ARCHITECTURE.md) - 架构分析
- [AGENTS.md](file:///c:/zy/jiabaixing/AGENTS.md) - 多 Agent 开发手册
- [DEVELOPER_GUIDE.md](file:///c:/zy/jiabaixing/DEVELOPER_GUIDE.md) - 开发者指南
- [QUICKSTART.md](file:///c:/zy/jiabaixing/QUICKSTART.md) - 快速开始

### C. 故障排查

**常见问题**:

| 问题                    | 可能原因                | 解决方案                       |
| ----------------------- | ----------------------- | ------------------------------ |
| better-sqlite3 编译失败 | 缺少构建工具            | `npm run fix:native`           |
| LLM 连接超时            | 网络问题 / API Key 错误 | 检查 `.env` 配置               |
| Python 后端连接失败     | 未启动 Python 服务      | 确认 `uvicorn` 运行在正确端口  |
| 测试数据库锁            | 测试未关闭连接          | 确保测试中显式关闭数据库       |
| 内存占用过高            | ChromaDB / 向量模型     | 调整内存限制或使用外部向量服务 |

---

**文档维护**: 本文档随代码迭代更新，如有疑问请参考源码。
