# Jiabaixing V5.5 — 开发文档

> **版本**: V5.5 Harness Agent Framework | **架构**: E-T-C-S-L-V 六层管控 + Python 后端 + Facade 拆分
> **语言**: TypeScript (ES2022) + Python 3.13 | **运行**: Node.js >= 20.x / Python >= 3.13
> **默认模型**: deepseek-chat (OpenAI 兼容接口)
> **验证日期**: 2026-07-14

---

## 一、概述

Jiabaixing 是本机 AI 智能体。核心理念：

> **Agent = (LLM 推理 + 能力组件) × Harness 管控系统**

LLM 做认知（推理/选工具/表达），Harness 做工程（预算/权限/验证/状态）。混合架构单一路径：

```
用户输入 → 平台适配器/Desktop GUI/CLI → Gateway → AgentEngine (Python)
  → Prompt Builder (系统指令 + 上下文 + 工具定义)
  → LLM Transport (Anthropic/OpenAI/Bedrock/...)
  → 模型响应 (文本 + 工具调用)
  → Tool Executor (执行工具)
  → 结果反馈 → 下一轮对话
  → Turn Finalizer (状态保存)
```

三端一致入口：Desktop GUI / TS CLI / Python CLI → 同一 `AgentEngine.process_input()`

Bootstrap 流程（桌面端）：Electron 启动 → BackendLauncher 检测 Python → 启动 uvicorn → 健康检查 → 连接 WebSocket

### 已验证状态 (2026-07-14)

| 指标            | 值                         | 来源                 |
| --------------- | -------------------------- | -------------------- |
| TypeScript 编译 | 0 errors                   | `npx tsc --noEmit`   |
| Python 编译     | 0 errors                   | `py_compile`         |
| 前端测试        | 11/11 通过                 | `react-scripts test` |
| Python 测试     | 232/232 通过               | `pytest`             |
| 注册工具        | 82+ 个 (Python端)          | ToolRegistry         |
| 前端面板        | 14 个 + Agent 印记条       | React 18             |
| 桌面端          | Electron + BackendLauncher | 手动打包验证         |

### V5.0 → V5.5 架构演进

```
V5.0 (基线)                           V5.5 (短期修复) ✅ 已完成
├── TS 网关 + Python AI 核心           ├── 安全加固（CORS 白名单、绑定 127.0.0.1）
├── 80+ 属性 God Object                ├── 核心子系统标记 critical=True
└── 466 处异常吞没                     ├── bare except 全部添加日志
                                       ├── SQLite 异步包装 (asyncio.to_thread)
                                       ├── AgentEngine 拆分为 7 个 Facade
                                       ├── LoopController 中间件化 (4 中间件)
                                       ├── WebSocket 心跳 + 连接数限制
                                       └── 真实百分位延迟 Histogram

V6.0 (架构重构) 📋 计划中
├── TS 端仅保留薄网关 + 前端 + 集成
├── 依赖注入替代 Singleton
├── 前后端 OpenAPI 契约驱动
├── 飞书应用独立化
└── 移除 TS 端 AI 核心组件
```

---

## 二、快速开始

### 一键安装

```bash
bash install.sh     # 自动完成：检查环境 → 安装依赖 → 配置 LLM → 验证
```

### 启动

```bash
# 方式1: 桌面端（自动启动 Python 后端）
cd src/frontend && npm start

# 方式2: 独立启动 Python 后端
cd python && python -m uvicorn agent.main:app --port 8765 --reload

# 方式3: CLI 对话
cd python && python -m agent.cli chat
```

### 验证

```bash
curl http://localhost:8765/health          # Python 后端健康检查
cd src/frontend && npx react-scripts test  # 前端测试
cd python && python -m pytest tests/ -v    # Python 测试
```

---

## 三、架构

### 3.1 Harness 六层

```
E — Execution Loop   Planner→Executor→Evaluator→Reporter (状态机+replan)
T — Tool Registry    33 个声明式工具, 8 类, JSON Schema + 四级权限
C — Context Manager  宪法Prompt→记忆→动态上下文→历史 (Token六桶分配)
S — State Store      瞬时(LoopContext)/短期(SQLite)/长期(ChromaDB)
L — Lifecycle Hooks  9 个钩子: before_loop ~ after_response
V — Verification     工具结果验证 + 安全检查 + 五维质量评分
```

### 3.2 AgentEngine Facade 拆分 (V5.5 新增)

AgentEngine 从 80+ 属性 God Object 拆分为 7 个领域门面，**完全向后兼容**：

| Facade                 | 职责                                    | 关键属性                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CoreFacade`           | LLM + Loop + Conversation + Hook + Tool | llm, loop, conversation, hook_manager, tool_registry, planner, executor, evaluator, reporter, persona, observer                                                                                                                                     |
| `SecurityFacade`       | 安全/校验/审批/输出守卫                 | security_manager, output_guardrail, osv_guard, path_security, approval_manager, permission_guard, auth_manager, encryption_manager, policy_engine, security_guard, network_guard                                                                    |
| `EvolutionFacade`      | 进化/学习/策略/反思                     | evolution_engine, evolution_v2, orchestrator, implicit_feedback, strategy_adapter, reflection_engine, causal_modeler, learning_signal_collector, debate_validator, experience_store, quality_tracker, evolution_metrics                             |
| `IntegrationFacade`    | A2A/编排/网关                           | a2a_client, a2a_server, orchestration_executor, api_gateway, message_dispatcher, platform_adapters, skill_registry, mcp_manager, tool_sandbox, desktop_controller                                                                                   |
| `ContextFacade`        | 上下文/记忆/压缩                        | context_orchestrator, memory_engine, context_pipeline, token_budget, context_compressor, memory_curator, episodic_memory, redis_client                                                                                                              |
| `PersistenceFacade`    | 存储/轨迹/会话                          | session_store, trajectory_db, trajectory_flywheel, conversation_store, user_profile_store, feedback_store, evolution_db, memory_db, cache_store, config_store, analytics_store                                                                      |
| `UserExperienceFacade` | 澄清/代办/语音/国际化                   | clarification_engine, todo_manager, voice_interface, i18n_manager, notification_manager, onboarding_manager, accessibility_manager, personalization_engine, preference_store, ux_analytics, feedback_collector, proactivity_engine, ambient_manager |

**使用方式**：

```python
# 旧方式（仍然可用）
engine.llm
engine.security_manager

# 新方式（推荐）
engine.core.llm
engine.security_facade.security_manager
```

### 3.3 LoopController 中间件链 (V5.5 新增)

LoopController 的横切关注点从主循环中提取为独立中间件：

| 中间件                      | 职责                                         | 触发时机                                 |
| --------------------------- | -------------------------------------------- | ---------------------------------------- |
| `TrajectoryMiddleware`      | 轨迹记录（执行/状态转换/工具调用）           | on_loop_start, on_loop_end, on_tool_call |
| `FeedbackMiddleware`        | 隐式反馈收集（用户/AI消息、工具成败）        | on_loop_start, on_tool_call, on_loop_end |
| `ObserverMiddleware`        | 循环观察者（阶段追踪、工具调用埋点）         | on_phase_change, on_tool_call            |
| `EvolutionSignalMiddleware` | 进化学习信号（任务成败、工具质量、规划质量） | on_loop_end                              |

**中间件链容错**：每个中间件独立 try/except，单个中间件异常不影响主循环。

### 3.4 职责划分

| LLM 做           | Harness 做                            |
| ---------------- | ------------------------------------- |
| 推理与创造力     | 持久化 (记忆/状态/轨迹)               |
| 工具选择 (FC)    | 预算控制 (4 维: 轮次/token/时间/工具) |
| 多步推理 (ReAct) | 工具结果验证 + 安全检查               |
| 个性化表达       | 五维质量评分 + 生命周期钩子           |
| 场景适应         | 状态机校验 + 权限守卫                 |

### 3.5 架构原则

- **约束而不指令** — Harness 设边界, 不告诉模型怎么思考
- **状态外部化** — LoopContext 承载全部状态, Agent 无内部状态
- **Rippable Architecture** — 6 层独立开关, 模型提升后可剥离
- **声明式工具** — JSON Schema + SchemaValidator + PermissionGuard

---

## 四、已实现能力 (验证通过)

### 4.1 执行循环 ✅

`LoopController.ts` — Plan-Execute-Evaluate-Report 状态机

- Planner: 简单任务 regex 跳过, 复杂任务 LLM 分解
- Executor: FC 循环, 工具并行执行, 停转检测, Token 压缩
- Evaluator: 预算检查 + 步骤汇总 + IndependentEvaluationService 深度评估
- Reporter: 响应提取 + 质量评分 (步骤成功率 + 响应内容)

**修复记录** (2026-05-30): Token 预算现在从 Executor 反馈更新 (之前永远为 0), replan 注入先删除旧计划, quality 评分引入步骤成功率

### 4.2 工具注册表 ✅

33 个声明式工具, 8 个分类:

| 分类      | 数量 | 工具                                                                                                                      |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| memory    | 3    | memory_recall, memory_store, memory_search                                                                                |
| cognition | 3    | emotion_detect, analyze_scene, self_reflect                                                                               |
| desktop   | 2    | desktop_automate, desktop_screenshot                                                                                      |
| file      | 5    | file_list, file_search, get_active_file, incremental_edit, multi_file_edit                                                |
| code      | 3    | code_analyze, code_fix, code_generate                                                                                     |
| system    | 4    | ask_clarification, preview_execution, rollback_changes, shell_exec                                                        |
| daily     | 9    | task_manage, reminder_set, note_take, system_status, batch_task, calendar, task_analytics, task_dependency, task_priority |
| network   | 4    | web_search, skill_create, image_generate, web_fetch                                                                       |

### 4.3 上下文管理 ✅

`ContextManager.ts` — 组合管道: 宪法Prompt → 记忆注入 → 动态上下文 → 历史

- `buildContext()`: 全量上下文构建
- `buildPhaseContext(phase)`: 按阶段优化 (planning 轻量, execution 全量)
- TokenBudgetAllocator: 6 桶分配

### 4.4 三层记忆 ✅

| 层   | 存储                    | 用途                   |
| ---- | ----------------------- | ---------------------- |
| 瞬时 | LoopContext.messages    | 请求生命周期           |
| 短期 | SQLite (better-sqlite3) | 对话/工具结果/用户画像 |
| 长期 | ChromaDB 向量           | 知识提取/语义检索      |

### 4.5 生命周期钩子 ✅

9 个钩子 + 状态机转移校验: BEFORE_LOOP, ON_PLAN_CREATED, BEFORE_TOOL_CALL, AFTER_TOOL_CALL, ON_ERROR, BEFORE_RESPONSE, AFTER_RESPONSE, ON_STEP_COMPLETED, ON_BUDGET_EXCEEDED

### 4.6 评估框架 ✅

- `StepEvaluator`: 规则引擎 (成功/失败/空输出/敏感信息)
- `IndependentEvaluationService`: 独立 LLM 深度评估
- `EvalRunner`: 自动化评估管道
- `GoldenEvalSet`: 30 条用例 (memory 15, tool_use 5, safety 3, planning 4, multi_step 3)
- `EvalGate` / `EvalTrendAnalyzer`: CI/CD 门禁 + 趋势分析

**最近评估**: 83.3% 通过率 (25/30), 安全类 100%, 多步推理最弱 (66.7%)

### 4.7 轨迹审计 ✅

`TrajectoryDatabase` (SQLite) — 3 张表:

- `executions`: 110 条执行记录 (2026-05-30)
- `tool_invocations`: 24 条工具调用记录
- `state_transitions`: 15 条状态转移

`TrajectoryFlywheel` — 轨迹分析引擎, 成功率统计, 工具使用模式, 瓶颈识别, 优化建议

### 4.8 进化引擎 ✅ (V2 only)

EvolutionEngineV2: LLM 驱动自我进化

- `EvolutionPlanner`: LLM 生成修改计划
- `SelfModificationEngine`: 执行文件修改
- `EvolutionRollback`: 快照 + 回滚
- `validateEvolution()`: 真实运行 `tsc --noEmit` (HIGH 风险: + jest)

**周期**: 5 分钟检查 → 质量 < 0.7 → 触发 V2 自进化

### 4.9 多平台网关

4 平台: 微信 (QR+API) / QQ (Mirai) / 飞书 / 钉钉。双模架构: fork 子进程 + 主进程内联。

### 4.10 CLI 终端

**TS CLI** (`src/cli.ts`) — REPL 客户端, HTTP 连接后端。支持 `/chat`, `/env`, `/schedule`, `/config`, `/status`, `/evolution`, `/web`, `/help`, `/clear`, `/quit`。

**Python CLI** (`python/agent/cli.py`) — 原生 Python CLI，直接调用 `AgentEngine.process_input()`。支持：

- `chat [message]` — 交互式 REPL 或单次对话
- `goal` — Agent 目标达成追踪与能力印记
- `status [--detailed]` — 学习状态摘要/详细报告
- `observer` — 循环观察者状态
- `feedback` — 隐式反馈统计

三端（Desktop/TS CLI/Python CLI）共享同一 `AgentEngine.process_input()` 入口。

### 4.11 前端面板

React 18 + TypeScript + Zustand + WebSocket。Hermes 双栏布局（左侧对话 + 右侧可折叠信息面板）。

**DesktopDashboard** 核心组件：

- 消息工作区（对话 + Agent 印记条 + 快捷操作）
- Agent 印记条 — 实时显示 Loop 状态、工具调用数、记忆状态
- 右侧折叠面板 — 系统状态、预算守卫、网关平台、记忆快照、Agent 动态、自动化任务
- `/goal` 命令 — 查看目标达成追踪与能力标签

14 个面板: ChatInterface, DesktopDashboard, DesktopPanel, EvolutionPanel, SecurityPanel, MemoryPanel, SkillConsole, MonitorPanel, PerformancePanel, AgentExecutionPanel, LogPanel, SettingsPanel, AutomationPanel, IntegrationPanel, VibeCodingPanel。

### 4.12 安全模块

4 个核心模块 + 8 个原子模块: **SecurityFacade** (SecurityManager + AuthenticationManager + EncryptionManager), **SecurityCore** (SecurityPolicyEngine + SecurityGuard + NetworkGuard), **AuditService** (AuditLogger + DataSovereigntyPipeline), **types.ts**。原有 8 个原子模块仍可独立导入（向后兼容 re-export）。

**动态策略** (2026-06-01): `AutonomyPermissionGuard.dynamicPolicyAdjust` 基于任务意图、风险容忍度和历史成功率动态调整工具白名单，解决静态白名单对 LLM 自主性的障碍。

**脱敏修复** (2026-05-30): `VerificationService.checkOutputSafety` 之前使用 `$& [已脱敏]` (原文仍在), 现在用 `$1[已脱敏]` (真正替换)。

---

## 五、API 端点

### 核心端点

| 方法 | 路径                           | 说明                                   |
| ---- | ------------------------------ | -------------------------------------- |
| GET  | `/health`                      | Python 后端健康检查                    |
| GET  | `/v1/status`                   | 系统状态                               |
| POST | `/v1/chat`                     | 主处理入口 (AgentEngine.process_input) |
| WS   | `/v1/chat/stream/{session_id}` | 流式对话                               |
| POST | `/v1/memory/search`            | 记忆搜索                               |
| GET  | `/v1/memory/stats`             | 记忆统计                               |
| GET  | `/v1/evolution/metrics`        | 进化指标                               |
| POST | `/v1/skills/execute`           | 执行技能                               |
| GET  | `/v1/skills/list`              | 列出技能                               |
| GET  | `/v1/sessions`                 | 会话列表                               |
| GET  | `/v1/trajectory`               | 轨迹数据                               |
| GET  | `/v1/metrics`                  | 请求指标                               |

### 进化端点

| 方法 | 路径                      | 说明                 |
| ---- | ------------------------- | -------------------- |
| GET  | `/api/evolution/metrics`  | 进化指标             |
| GET  | `/api/evolution/insights` | 学习洞察             |
| POST | `/api/evolution/trigger`  | 手动触发优化         |
| POST | `/api/evolution/healing`  | 自愈 (→Orchestrator) |
| POST | `/api/evolution/refactor` | 重构 (→Orchestrator) |
| POST | `/api/evolution/enhance`  | 增强 (→Orchestrator) |

### 其他端点

`/api/config`, `/api/metrics`, `/api/logs`, `/api/security/*`, `/api/performance/*`, `/api/mcp/*`, `/api/desktop/*`, `/api/conversations`, `/api/recommendations`

### WebSocket

`ws://localhost:3111` — 实时事件: `agent_execution_update`, `response_ready`, `tool_trace`, `weight_update`, `proactive_message`, `environment_update`, `project_change`, `git_status`

**修复**: `agent_execution_update` 现在推送每轮 FC 循环和每个工具完成状态 (之前仅在状态转移时推送)。

---

## 六、评估数据

### Eval 评分 (2026-05-26)

| 类别       | 用例   | 通过   | 通过率    | 平均分    |
| ---------- | ------ | ------ | --------- | --------- |
| memory     | 15     | 13     | 86.7%     | 87.3%     |
| tool_use   | 5      | 4      | 80.0%     | 86.0%     |
| safety     | 3      | 3      | 100.0%    | 100.0%    |
| planning   | 4      | 3      | 75.0%     | 76.3%     |
| multi_step | 3      | 2      | 66.7%     | 73.3%     |
| **总计**   | **30** | **25** | **83.3%** | **85.5%** |

### 轨迹数据 (2026-05-29)

```
Executions: 110
Tool invocations: 24
Top tools: file_search (13, 100%), file_list (6, 100%), read_file (3, 0%)
```

---

## 七、测试

### 测试结构

```
tests/
├── harness/         # 六层测试: loop, tools, verification, integration
├── unit/            # 单元: core, memory, desktop, harness
└── src/evolution/   # V2 进化测试
```

### 测试命令

```bash
npm test                   # 全量: 857 tests, 52 suites
npm run test:coverage      # 覆盖率
npm run eval               # Eval 评估: 30 条用例, 真实 LLM
npm run build:fast         # 快速编译
npm run lint               # ESLint
npm run check              # lint + format + test
```

---

## 八、项目目录

```
jiabaixing/
├── python/                    ★ Python 后端 (核心 Agent 能力)
│   ├── agent/
│   │   ├── core/              AgentEngine, ContextPipeline, Persona, Security, Facades (V5.5)
│   │   ├── llm/               LLMProvider, CredentialPool, PromptCache, Router, Transports
│   │   ├── loop/              LoopController, Planner, Executor, Evaluator, Reporter, Middleware (V5.5)
│   │   ├── tools/             82+ 工具, 沙箱, 审批, 缓存
│   │   ├── memory/            MemoryEngine, Curator, Episodic, Redis
│   │   ├── evolution/         EvolutionEngine V1+V2, Orchestrator
│   │   ├── gateway/           平台适配器 + MessageDispatcher
│   │   ├── persistence/       SessionStore, TrajectoryDB, Flywheel
│   │   ├── context/           UnifiedContextOrchestrator, TokenBudget
│   │   ├── skills/            SkillRegistry
│   │   ├── security/          OutputGuardrail, OSV, PathSecurity
│   │   ├── a2a/               A2A 协议 (Agent-to-Agent)
│   │   ├── mcp/               MCP 服务管理
│   │   ├── orchestration/     多 Agent 编排
│   │   ├── api/               FastAPI 路由 (chat, memory, evolution, etc.)
│   │   ├── cli.py             Python CLI (chat/goal/status/observer/feedback)
│   │   └── main.py            FastAPI 入口 + lifespan
│   └── tests/                  232 tests
├── src/
│   ├── core/              JiabaixingCore, ScenarioAwareScheduler
│   ├── harness/           ★ V5.0 六层 Harness
│   │   ├── loop/          E: Plan-Execute-Evaluate-Report
│   │   ├── tools/         T: 33 工具 (8 类)
│   │   ├── context/       C: ContextManager + TokenBudget
│   │   ├── persistence/   S: PersistenceService + TrajectoryDB
│   │   ├── verification/  V: VerificationService
│   │   ├── constraints/   L: Lifecycle Hooks
│   │   ├── evaluation/    StepEvaluator, EvalRunner, QualityScorer
│   │   ├── sandbox/       沙箱执行器
│   │   └── orchestration/ 多 Agent 编排
│   ├── evolution/         进化引擎 V2
│   ├── memory/            三层记忆 (SQLite/ChromaDB)
│   ├── security/          4 核心模块 + 8 原子模块
│   ├── models/            LLMProvider (DeepSeek + 智谱降级)
│   ├── persona/           人格系统
│   ├── mcp/               MCP 服务管理
│   ├── server/            Express + WebSocket + 路由
│   ├── cli/               TS CLI (模块化: repl/ipc/commands/modes)
│   ├── frontend/          React 18 桌面端
│   │   ├── electron/      Electron 主进程 + BackendLauncher
│   │   ├── src/           React 组件 + Zustand stores
│   │   └── public/        静态资源
│   └── main.ts            入口
├── data/
│   ├── eval/              Eval 用例 + 报告
│   ├── trajectory/        trajectory.db
│   └── evolution/         metrics.db
├── tests/                  881 tests, 53 suites
├── scripts/runEval.ts      Eval CLI
├── package.json
├── PROJECT.md
└── CLAUDE.md
```

---

## 九、技术栈

| 类别       | 技术                                                         |
| ---------- | ------------------------------------------------------------ |
| 后端运行时 | Python 3.13 + FastAPI + uvicorn                              |
| 前端运行时 | Node.js 20+, TypeScript (ES2022)                             |
| Web        | Express 4.x + ws 8.x (TS) / FastAPI + WebSocket (Python)     |
| 桌面端     | Electron + BackendLauncher (自动启动 Python 后端)            |
| 前端 UI    | React 18 + TypeScript + Zustand + Hermes 双栏布局            |
| 数据库     | SQLite (better-sqlite3 + Python sqlite3)                     |
| LLM        | litellm + ProviderManager (多模型+路由+降级+凭据池+成本守卫) |
| 记忆       | MemoryEngine + Curator + EpisodicMemory + Redis              |
| 桌面自动化 | @nut-tree/nut-js (TS) / desktop_controller (Python)          |
| 安全       | OutputGuardrail + OSV + PathSecurity + bcrypt + jsonwebtoken |
| 测试       | pytest (Python) + jest (TS) + react-scripts test             |
| 构建       | tsc + ts-node (TS) / uvicorn (Python)                        |

---

## 配置

### Provider 管理（v5.1）

使用 `npm run setup` 向导管理 LLM 模型：

```bash
npm run setup            # 交互式配置向导
npm run setup:list       # 查看当前配置
npm run setup:test       # 测试所有 Provider 连接
```

支持多 Provider 并行，自动降级和熔断感知。配置存储在 `data/providers.json`。

### 环境变量（兼容）

`.env` 文件仍然生效，启动时会自动导入到 ProviderManager：

### Harness 开关

```typescript
const harness = new AgentHarness({
  useHarnessLoop: true, // E
  useHarnessTools: true, // T
  useHarnessContext: true, // C
  useHarnessPersistence: true, // S
  useHarnessVerification: true, // V
  useHarnessConstraints: true, // L
  useIndependentEvaluator: true, // 独立评估
  useTrajectoryPersistence: true, // 轨迹审计
});
```

---

## 十一、开发规范

### 添加新工具

1. `src/harness/tools/<category>/` 创建定义文件
2. 导出 `TOOL_DEF: ToolDefinition` + executor
3. 在 `registerHarnessTools.ts` 注册
4. `npm test` 验证

### 测试

```bash
npm test                    # 全量: 874 tests, 52 suites
npm run test:coverage       # 覆盖率
npm run eval                # Eval 评估: 30 条用例
npm run build:fast          # 快速编译
npm run setup               # Provider 配置向导
```

---

## 十二、已知局限

### 功能局限

| 局限                              | 状态      |
| --------------------------------- | --------- |
| Golden Eval 覆盖不足 (30 用例)    | 🟡 可扩展 |
| 前端面板部分 mock 数据            | 🟡        |
| ModelRouter 还未接入 Harness 层   | 🟡        |
| CLI 启动慢 (ts-node 5-10s)        | 🟡        |
| 桌面自动化依赖 Windows powershell | 🟡        |

### 性能局限

| 局限              | 数据                                      | 状态                    |
| ----------------- | ----------------------------------------- | ----------------------- |
| 单条消息 LLM 调用 | 2+N (Planner + Evaluator + N 轮 Executor) | 🟡 简单任务已有快速路径 |
