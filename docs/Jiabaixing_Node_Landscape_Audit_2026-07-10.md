# 家百星 (Jiabaixing) V5.0 — 节点全景审计

> **梳理对象**：`C:\zy\jiabaixing`（TypeScript 薄网关 + Python FastAPI 后端 混合架构）
> **梳理时间**：2026-07-10
> **数据来源**：对 `src/`、`python/agent/`、`src/frontend/`、`src/integration/`、`src/ide/`、`src/mcp/`、`src/cli/`、`src/desktop/`、`src/security/`、`deploy/` 等目录的实际代码探查（双探查代理交叉验证 + 关键结论文件级复核）
> **对照基准**：Hermes Agent v0.18.0 节点全景审计（用户提供）

---

## 一、版本与架构确认

| 项         | 值                                                                                                    | 来源                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 项目名称   | 家百星 Jiabaixing                                                                                     | ARCHITECTURE.md / package             |
| 版本号     | V5.0（`.env` 标注 `APP_VERSION=2.0.0`，**版本号不一致**）                                             | ARCHITECTURE.md；`.env`               |
| 运行时     | TS(Node) 薄网关 `:3111` + Python(FastAPI) 后端 `:3112`                                                | `src/main.ts`；`python/agent/main.py` |
| 后端激活   | `AGENT_BACKEND=python`（⚠️ 仓库**未默认设置**，见第六节风险）                                         | `JiabaixingCore.ts:544`               |
| 真后端规模 | `python/agent/` 约 300 个 `.py`，六层 Harness + ReAct + CausalModeler + ReflectionEngine 均经文件确认 | `python/agent/loop/*.py` 等           |

**结论**：项目确为 V5.0 混合架构；Python 后端（`python/agent/`）是当前功能完整的"真后端"，TS 侧大量模块已 `@deprecated` 仅做转发，但**仍有若干活跃 TS 模块在 `AGENT_BACKEND=python` 时被短路绕过**。

---

## 二、节点分层地图

家百星采用"**TS 入口网关 + Python 窄腰核心**"架构，节点可归为四层：

```
┌─────────────────────────────────────────────────────────────┐
│  用户使用性节点（入口层 / Usability Nodes）                  │
│  CLI · 桌面App · Web · Gateway通道(8平台) · MCP Serve ·      │
│  ACP(IDE) · 配置/引导 · ⚠️TUI(缺失)                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ 调用（AGENT_BACKEND=python 桥接）
┌───────────────────────────┴─────────────────────────────────┐
│  核心编排层（Core / Python）                                 │
│  loop/controller.py (ReAct) → planner → executor →           │
│  evaluator → reporter + causal + reflection                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ 装配
┌───────────────────────────┴─────────────────────────────────┐
│  能力节点层（Functional / Business-Logic Nodes）              │
│  Provider · Memory · Skills · Plugins · Tools · SubAgent ·   │
│  Cron · Compression · Logging/State · Security · Evolution   │
└───────────────────────────┬─────────────────────────────────┘
                            │ 支撑
┌───────────────────────────┴─────────────────────────────────┐
│  分发 / 集成层                                               │
│  toolset_registry · llm/router(providers.json) · plugins/ ·  │
│  gateway adapters · api/ 路由(mcp/openai/cron/skills/...)    │
└─────────────────────────────────────────────────────────────┘
```

**状态图例**：🟢 完整　🟡 部分　🔴 缺失　⚫ 弃用（TS 转发，Python 接管）　⚠️ 风险

---

## 三、功能节点（Functional / Business-Logic Nodes）

即系统"能做什么"的业务能力模块。每个节点标注核心实现位置与实测状态。

### 1. Provider / 模型抽象

| 节点                         | 职责                                                            | 位置                                                                                                                 | 状态         |
| ---------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------ |
| `LLMProvider`                | 统一 LLM 客户端（基于 litellm）                                 | `python/agent/llm/provider.py`(543行)                                                                                | 🟢 Python 主 |
| `ProviderManager` + `router` | 数据驱动注册表（primary/fallback/health-check）                 | `python/agent/llm/router.py`(131行)                                                                                  | 🟢           |
| 传输/队列/缓存/限流/预算     | 多传输层、并发队列、prompt 缓存、错误分类、限流、成本预算、流式 | `python/agent/llm/{transports,queue,cache,prompt_cache,error_classifier,rate_limit_tracker,budget_config,stream}.py` | 🟢           |
| TS 旧实现                    | 转发/迁移到 Python                                              | `src/models/LLMProvider.ts`、`ProviderManager.ts`                                                                    | ⚫ 弃用      |

> 注：Hermes 的"27 家硬编码 Provider"在家百星中为 **litellm 动态注册表**（等效且更灵活），"Hermes" 在此项目是迁移代号而非模型商。

### 2. 记忆系统（对话 + 长期）

| 节点                   | 职责                                            | 位置                                                    | 状态    |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------- | ------- |
| `MemoryEngine`         | 三层记忆引擎 + 知识图谱构建                     | `python/agent/memory/engine.py`(676行)                  | 🟢      |
| `SemanticSearchEngine` | SQLite + **FTS5 全文** + LLM 嵌入向量余弦相似度 | `python/agent/memory/store.py`(548行)                   | 🟢      |
| 情节记忆 / 策展        | episodic memory、记忆策展                       | `python/agent/memory/{episodic_memory,curator}.py`      | 🟢      |
| 中文分词 / 多模态      | tokenizer（中文）、multimodal_encoder           | `python/agent/memory/{tokenizer,multimodal_encoder}.py` | 🟢      |
| TS 旧实现              | ChromaDB 实现，已弃用                           | `src/memory/MemoryEngine.ts`                            | ⚫ 弃用 |

> 注：家百星记忆后端为 **SQLite+FTS5+向量**，**无 ChromaDB**（与早期 ARCHITECTURE.md 描述不同，已演进）。

### 3. Skills 技能系统

| 节点            | 职责                      | 位置                                     | 状态                        |
| --------------- | ------------------------- | ---------------------------------------- | --------------------------- |
| `SkillRegistry` | 技能发现/注册             | `python/agent/skills/registry.py`(568行) | 🟡 Python 仅注册层          |
| TS 技能层       | 技能注册/中间件/索引/策展 | `src/skills/*`、`src/curator/`           | 🟡 活跃但 Python 路径被绕过 |

> 注：**缺技能 Hub 同步、打包、optional-skills 预置目录**（见第四节对比）。

### 4. Plugins 插件系统

| 节点                | 职责                  | 位置                                     | 状态    |
| ------------------- | --------------------- | ---------------------------------------- | ------- |
| `PluginBase` / 接口 | 插件接口定义          | `python/agent/plugins/base.py`(168行)    | 🟢      |
| `PluginManager`     | 加载/生命周期         | `python/agent/plugins/manager.py`(266行) | 🟢      |
| TS 插件层           | 管理/加载/接口/上下文 | `src/plugins/*`                          | 🟢 活跃 |

### 5. Model Tools / 工具集执行

| 节点              | 职责                                                                                             | 位置                                              | 状态        |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ----------- |
| `ToolRegistry`    | 工具注册（745行）+ 默认注册                                                                      | `python/agent/tools/registry.py`                  | 🟢          |
| `ToolsetRegistry` | 工具集分发（380行）                                                                              | `python/agent/tools/toolset_registry.py`          | 🟢          |
| 权限/校验/审批    | `PermissionGuard`(444行)、`SchemaValidator`、`ToolCallGuard`、`ApprovalManager`、`McpToolBridge` | `python/agent/tools/*.py`                         | 🟢          |
| 30+ 具体工具      | file/code/network/browser/memory/lsp/desktop/voice/homeassistant 等                              | `python/agent/tools/*.py`                         | 🟢          |
| 并发/串行执行     | `Executor` + `BatchProcessor`                                                                    | `python/agent/loop/{executor,batch_processor}.py` | 🟢          |
| TS 旧实现         | 集中注册（转发）                                                                                 | `src/harness/tools/registry/*`                    | ⚫ 部分弃用 |

### 6. 子 Agent 委派

| 节点                     | 职责                                              | 位置                                                  | 状态 |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------------- | ---- |
| `SubAgentDelegator`      | 子 agent 委派执行                                 | `python/agent/tools/delegate_tool.py`(321行)          | 🟢   |
| `MultiAgentOrchestrator` | 多智能体编排                                      | `python/agent/orchestration/agent_factory.py`(1257行) | 🟢   |
| `BatchProcessor`         | fanout 批处理（parallel/sequential/**adaptive**） | `python/agent/loop/batch_processor.py`                | 🟢   |

### 7. Cron / 定时任务

| 节点               | 职责                             | 位置                                                       | 状态    |
| ------------------ | -------------------------------- | ---------------------------------------------------------- | ------- |
| `CronJobScheduler` | 调度主循环（694行）              | `python/agent/scheduler/cron.py`                           | 🟢      |
| REST 路由 / 数据   | cron API、数据目录               | `python/agent/api/cron.py`、`python/data/{cron,schedules}` | 🟢      |
| TS 实现            | 活跃但未确认 Python 路径是否复用 | `src/cron/CronJobScheduler.ts`                             | 🟢 活跃 |

### 8. 上下文压缩

| 节点                | 职责                                                                       | 位置                                      | 状态    |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------- | ------- |
| `ContextCompressor` | 轨迹压缩 + 窗口管理（948行）                                               | `python/agent/core/context_compressor.py` | 🟢      |
| 上下文管线          | 上下文组装（643行）                                                        | `python/agent/core/context_pipeline.py`   | 🟢      |
| 统一编排 / 注意力   | `UnifiedContextOrchestrator`、`attention_focus`、adapters(token_budget 等) | `python/agent/context/*`                  | 🟢      |
| TS 旧实现           | 转发                                                                       | `src/harness/context/ContextManager.ts`   | ⚫ 弃用 |

### 9. 日志 / 状态 / 配置 / 持久化

| 节点                 | 职责                        | 位置                                                      | 状态    |
| -------------------- | --------------------------- | --------------------------------------------------------- | ------- |
| `StructuredLogger`   | 结构化日志                  | `python/agent/core/logger.py`                             | 🟢      |
| `SessionStore`       | 会话状态（427行）           | `python/agent/persistence/session_store.py`               | 🟢      |
| `TrajectoryDatabase` | 轨迹数据库（967行）         | `python/agent/persistence/trajectory.py`                  | 🟢      |
| 飞轮/服务/库         | flywheel、service、database | `python/agent/persistence/{flywheel,service,database}.py` | 🟢      |
| 配置/常量/时间       | `config.py`、utils          | `python/agent/{config,utils}/*`                           | 🟢      |
| TS 实现              | 活跃但 Python 路径被绕过    | `src/persistence/*`、`src/shared/*`                       | 🟢 活跃 |

### 10. 安全 / 权限

| 节点                           | 职责                                                         | 位置                                        | 状态    |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------- | ------- |
| `SecurityGuard`                | 安全守卫                                                     | `python/agent/core/security.py`             | 🟢      |
| `OutputGuardrailEngine`        | 输出护栏（9 子文件）                                         | `python/agent/security/output_guardrail.py` | 🟢      |
| 工具权限/审批                  | `PermissionGuard`(444行)、`ApprovalManager`、`ToolCallGuard` | `python/agent/tools/*`                      | 🟢      |
| `CredentialPool` + `CostGuard` | 凭证池 + 成本护栏 + 定价估算                                 | `python/agent/llm/credential_pool.py`       | 🟢      |
| `HookManager`                  | 生命周期钩子（safe mode/注入防护入口）                       | `python/agent/core/hooks.py`                | 🟢      |
| TS 实现                        | 18 文件纵深防御，活跃                                        | `src/security/*`                            | 🟢 活跃 |

### 11. Evolution 进化引擎

| 节点              | 职责                                                                                                                                                                                                                      | 位置                                  | 状态    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------- |
| `EvolutionEngine` | 反馈学习（880行）                                                                                                                                                                                                         | `python/agent/evolution/engine.py`    | 🟢      |
| `v2_engine`       | **代码级自我修改**（815行）                                                                                                                                                                                               | `python/agent/evolution/v2_engine.py` | 🟢      |
| 反馈/学习/策略    | `ContinuousFeedbackLoop`、`ImplicitFeedback`、`LearningSignals`、`StrategyAdapter`(含 RL reward)、`FewshotGeneralizer`、`Monitor`、`Trigger`、`Orchestrator`、`SkillEngine`、`SkillUsageTracker`、`LLMCapabilityDetector` | `python/agent/evolution/*.py`         | 🟢      |
| TS 旧实现         | 弃用                                                                                                                                                                                                                      | `src/evolution/EvolutionEngine.ts`    | ⚫ 弃用 |

---

## 四、用户使用性节点（User-Usability / Entry Nodes）

即"用户从哪里、用什么方式"触达系统。

### 1. CLI 命令树

| 节点        | 用途                                                                                                                                      | 位置                                             | 状态 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| TS CLI 入口 | 薄代理：daemon/pipe/subcommand/REPL 四模式                                                                                                | `src/cli.ts`、`src/cli/{index,modes,commands}/*` | 🟢   |
| 20+ 子命令  | ask/skill/schedule/status/memory/evolution/gateway/context/model/security/performance/mcp/system/conversations/docs/search/curator/hermes | `src/cli/commands/*.ts`                          | 🟢   |
| Python CLI  | chat/goal/status/observer/feedback                                                                                                        | `python/agent/cli.py`                            | 🟢   |

### 2. TUI 终端界面

| 节点 | 用途                                  | 位置               | 状态    |
| ---- | ------------------------------------- | ------------------ | ------- |
| TUI  | 终端 UI（bubbletea/textual/inquirer） | 全仓搜索**无实现** | 🔴 缺失 |

> `src/cli/repl.ts` 为普通 readline REPL，**非**真正的 TUI 框架。

### 3. 桌面 App（Electron）

| 节点           | 用途                                     | 位置                                                                                              | 状态        |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------- |
| Electron 外壳  | 拉起 Python uvicorn `:3112` + 健康检查   | `src/frontend/electron/{main,preload,backend/BackendLauncher}.js`                                 | 🟢 已构建   |
| React UI       | 聊天/工件/会话/设置/Profile/Gateway 状态 | `src/frontend/`                                                                                   | 🟢          |
| 桌面自动化引擎 | 截图/UI 检测/输入模拟/窗口管理           | `src/desktop/{DesktopAgentLoop,DesktopMCPServer,DesktopUIInspector,SystemInput,WindowManager}.ts` | 🟢 独有优势 |

### 4. Web Dashboard

| 节点       | 用途                   | 位置                                                 | 状态 |
| ---------- | ---------------------- | ---------------------------------------------------- | ---- |
| Web 控制台 | React build 托管为站点 | `src/main.ts:setupStaticFiles`、`src/frontend/build` | 🟢   |

### 5. Gateway 消息平台通道

| 节点            | 平台                                                              | 位置                                                      | 状态      |
| --------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | --------- |
| 内置适配器(8)   | 微信、企业微信(QR)、钉钉、飞书/Lark、QQ、Slack、Telegram、Discord | `src/integration/adapters/*.ts` + `IntegrationManager.ts` | 🟢 8 平台 |
| Python 通用网关 | api_server_adapter、webhook_adapter（base/dispatcher）            | `python/agent/gateway/*`                                  | 🟢 通用   |
| 缺失平台        | **email、WhatsApp**                                               | 代码零引用                                                | 🔴 缺失   |

### 6. MCP 服务

| 节点       | 作用                              | 位置                                                           | 状态      |
| ---------- | --------------------------------- | -------------------------------------------------------------- | --------- |
| Python MCP | stdio + HTTP_SSE 传输，挂载 `/v1` | `python/agent/mcp/{server_manager,transport}.py`、`api/mcp.py` | 🟢 主实现 |
| TS MCP     | 门面转发（@deprecated）           | `src/mcp/MCPServerManager.ts`、`server/routes/mcpRoutes.ts`    | ⚫ 弃用   |

### 7. ACP（IDE 集成）

| 节点          | 作用                             | 位置                                                         | 状态 |
| ------------- | -------------------------------- | ------------------------------------------------------------ | ---- |
| ACP HTTP 服务 | VS Code/Zed/JetBrains 集成       | `src/ide/ACPServer.ts`                                       | 🟢   |
| ACP stdio     | JSON-RPC 传输层（`--acp-stdio`） | `src/ide/ACPStdioServer.ts`                                  | 🟢   |
| TS↔Python 桥  | ACP 请求转发 `:3112`             | `src/ide/PythonAgentBridge.ts`、`server/routes/acpRoutes.ts` | 🟢   |

### 8. 服务器 / 服务入口

| 节点        | 作用                                                        | 位置                   | 状态    |
| ----------- | ----------------------------------------------------------- | ---------------------- | ------- |
| TS 服务     | Express `:3111`，统一 bootstrap                             | `src/main.ts`          | 🟢      |
| Python 服务 | FastAPI `:3112`，`/ws`、`/v1/events`、A2A、指标             | `python/agent/main.py` | 🟢      |
| 启动脚本    | start.sh/run.sh/install.sh/\*.bat/docker-compose/Dockerfile | 根目录 + `deploy/`     | 🟢      |
| ⚠️ 一键启动 | **无统一脚本同时启 TS+Python**（除桌面内嵌）                | —                      | ⚠️ 缺口 |

### 9. 配置 / 引导流程

| 节点        | 作用                                              | 位置                     | 状态                |
| ----------- | ------------------------------------------------- | ------------------------ | ------------------- |
| 配置加载    | ConfigLoader / YamlConfigParser / 默认配置        | `src/config/*`           | 🟡                  |
| 交互向导    | LLM Provider 配置（`/config` 或 `npm run setup`） | `src/config/setup.ts`    | 🟡 偏 TS 且底层弃用 |
| 环境变量    | `.env`（**未设 AGENT_BACKEND**，版本号不符）      | `.env`、`.env.example`   | ⚠️                  |
| Python 配置 | `AGENT_HOST/PORT` 默认                            | `python/agent/config.py` | 🟢                  |

### 10. OpenAI 兼容 API

| 节点        | 作用                                                                             | 位置                                          | 状态    |
| ----------- | -------------------------------------------------------------------------------- | --------------------------------------------- | ------- |
| Python 实现 | `/v1/chat/completions`(真 SSE)、`/v1/embeddings`、`/v1/models`、function calling | `python/agent/api/openai_compat.py`           | 🟢 主   |
| TS 门面     | 转发 `core.processInput`                                                         | `src/server/routes/openaiCompatibleRoutes.ts` | ⚫ 门面 |

---

## 五、完整节点总表（按类型归类）

`F` = 功能节点　`U` = 用户使用性节点　`F+U` = 兼具

| #   | 节点                                | 类型 | 路径 / 命令                                                               | 职责简述                                           | 状态    |
| --- | ----------------------------------- | ---- | ------------------------------------------------------------------------- | -------------------------------------------------- | ------- |
| 1   | 核心编排 ReAct                      | F    | `python/agent/loop/controller.py`                                         | 核心运行时（Plan-Execute-Evaluate-Report + ReAct） | 🟢      |
| 2   | Planner/Executor/Evaluator/Reporter | F    | `python/agent/loop/*.py`                                                  | 六层编排子节点                                     | 🟢      |
| 3   | CausalModeler / ReflectionEngine    | F    | `loop/{causal,reflection}.py`                                             | 因果建模 / 自我反思                                | 🟢      |
| 4   | Provider 抽象                       | F    | `python/agent/llm/{provider,router}.py`                                   | 统一模型客户端（litellm 动态）                     | 🟢      |
| 5   | Memory 系统                         | F    | `python/agent/memory/*`                                                   | 三层记忆 + FTS5 + 向量 + KG                        | 🟢      |
| 6   | Skills 系统                         | F+U  | `python/agent/skills/registry.py` + `src/skills/*`                        | 技能发现/注册/策展                                 | 🟡      |
| 7   | Plugins 系统                        | F    | `python/agent/plugins/*`                                                  | 插件扩展（通用）                                   | 🟢      |
| 8   | 工具定义/执行                       | F    | `python/agent/tools/*`                                                    | 工具注册/权限/审批/30+工具                         | 🟢      |
| 9   | Toolsets 分发                       | F    | `python/agent/tools/toolset_registry.py`                                  | 工具集组合/分发                                    | 🟢      |
| 10  | 子 Agent 委派                       | F    | `tools/delegate_tool.py` + `orchestration/agent_factory.py`               | 任务委派 + 多智能体                                | 🟢      |
| 11  | Cron 调度                           | F+U  | `python/agent/scheduler/cron.py`                                          | 定时任务                                           | 🟢      |
| 12  | 上下文压缩                          | F    | `core/context_compressor.py`                                              | 轨迹/上下文压缩                                    | 🟢      |
| 13  | 状态/日志/配置                      | F    | `python/agent/{core/logger,persistence/*,config}.py`                      | 持久化/日志/常量                                   | 🟢      |
| 14  | 安全/权限                           | F    | `core/security.py`、`tools/permission_guard.py`、`llm/credential_pool.py` | 守卫/护栏/审批/凭证池/成本护栏                     | 🟢      |
| 15  | Evolution 进化                      | F    | `python/agent/evolution/*`                                                | 反馈学习 + 代码自修改 + RL 信号                    | 🟢      |
| 16  | 桌面 App                            | U    | `src/frontend/electron/*` + `src/desktop/*`                               | Electron 客户端 + 桌面自动化                       | 🟢      |
| 17  | Web Dashboard                       | U    | `src/frontend/build`                                                      | 管理控制台                                         | 🟢      |
| 18  | 文档站                              | U    | `docs/`（174 md，非 Docusaurus 站点）                                     | 文档                                               | 🟡      |
| 19  | CLI 命令树                          | U    | `src/cli/*` + `python/agent/cli.py`                                       | 终端入口                                           | 🟢      |
| 20  | setup/auth 流程                     | U    | `src/config/setup.ts`、`.env`                                             | 引导配置                                           | 🟡      |
| 21  | Gateway 通道                        | U    | `src/integration/adapters/*`                                              | 8 个 IM 平台                                       | 🟢      |
| 22  | Gateway 编排                        | F    | `src/integration/IntegrationManager.ts`                                   | 入站→agent→出站                                    | 🟢      |
| 23  | TUI                                 | U    | —                                                                         | 终端界面                                           | 🔴 缺失 |
| 24  | ACP(IDE)                            | U    | `src/ide/*`                                                               | IDE 集成                                           | 🟢      |
| 25  | MCP Serve                           | F+U  | `python/agent/mcp/*`                                                      | MCP 服务器(stdio+SSE)                              | 🟢      |
| 26  | 服务入口                            | U    | `src/main.ts` + `python/agent/main.py`                                    | 双进程启动                                         | 🟢      |
| 27  | OpenAI 兼容 API                     | F+U  | `python/agent/api/openai_compat.py`                                       | OpenAI 兼容端点                                    | 🟢      |
| 28  | Providers 动态目录                  | F    | `python/agent/llm/router.py`                                              | litellm 动态注册表                                 | 🟢      |

---

## 六、小结与关键风险

- **版本**：确认 V5.0 混合架构（`.env` 版本号标注不一致，需统一）。
- **功能节点（业务能力）**：约 15 大类、28+ 节点，Python 后端覆盖完整且多为 🟢；相对 Hermes 在 **Evolution 自修改、桌面自动化、中文优先、SubAgent 三策略、统一 HookManager、六层 Harness 独立开关** 上更具优势。
- **用户使用性节点（入口）**：覆盖 7 大类（CLI、桌面、Web、Gateway 8 平台、ACP、MCP、配置），**TUI 完全缺失**，IM 缺 email/WhatsApp。

### ⚠️ 关键风险（审计重点）

1. **`AGENT_BACKEND` 默认未激活**（最高优先级）：文档称"Python 为默认"，但 `.env`/启动脚本均未设置，且 `JiabaixingCore.ts:544` 为严格 `=== 'python'` 判断、无默认回退 → **开箱默认走 TS 本地（大量已弃用）实现**。用户/部署者极易在"残缺旧实现"上运行而不自知。
2. **双实现并存、职责边界模糊**：Skills/Plugins/Cron/Security/Persistence 在 TS 与 Python 均存在，Python 路径下 TS 版被绕过但未标记弃用 → 维护歧义与"假完成"风险。
3. **无统一一键启动脚本**：TS+Python 双进程需手动协调（仅桌面应用内嵌自动拉起）。
4. **版本号/文档与代码脱节**：ARCHITECTURE.md 仍描述 TS 中心架构与 ChromaDB，实际已演进为 Python 中心 + SQLite/FTS5。
