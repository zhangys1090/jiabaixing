# Jiabaixing V5.0 — 开发者指南

## 目录

1. [快速开始](#1-快速开始)
2. [架构概览](#2-架构概览)
3. [主循环架构（双循环引擎）](#3-主循环架构双循环引擎)
4. [Agent 三层核心运行层级](#4-agent-三层核心运行层级)
5. [七大核心能力维度](#5-七大核心能力维度)
6. [技术底座](#6-技术底座)
7. [MCP + A2A 协议层](#7-mcp--a2a-协议层)
8. [模块参考](#8-模块参考)
9. [API 参考](#9-api-参考)
10. [工具系统](#10-工具系统)
11. [事件系统](#11-事件系统)
12. [配置参考](#12-配置参考)
13. [开发指南](#13-开发指南)
14. [故障排查](#14-故障排查)
15. [改进项追踪](#15-改进项追踪)

---

## 1. 快速开始

### 环境要求

- Node.js >= 20.x
- Python >= 3.11
- Windows 10+（主平台；Linux/macOS 部分支持）
- 至少一个 LLM 提供商 API Key

### 安装

```bash
npm install
npm run fix:native      # 重编译 better-sqlite3
pip install -r requirements.txt  # Python 依赖
```

### 配置 LLM

编辑 `.env` 或 `data/providers.json`：

```bash
# .env
DEEPSEEK_API_KEY=sk-你的key
LLM_MODEL=deepseek-chat
OPENAI_API_BASE=https://api.deepseek.com
AGENT_BACKEND=python   # 默认值，核心AI逻辑走Python端
```

或使用 providers.json（优先级更高）：

```json
{
  "providers": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "enabled": true,
      "priority": 0
    }
  ],
  "primary": "deepseek"
}
```

### 启动

```bash
npm run start           # 后端 + 前端（TS网关:3111 + Python AI核心:3112）
npm run cli             # CLI 交互模式
npm run daemon          # 后台守护模式
```

### 验证

```bash
curl http://localhost:3111/api/health   # TS网关健康检查
curl http://localhost:3112/health       # Python AI核心健康检查
npm test                                 # 运行测试
```

---

## 2. 架构概览

### 核心理念

```
Agent = (LLM 推理 + 能力组件) × Harness 六层控制
```

LLM 负责认知（推理、工具选择、表达）。Harness 负责工程（预算、权限、验证、状态）。

### 混合架构总览

**核心设计原则：Python 端承载 Agent 核心AI逻辑，TS 端作为薄网关层。**

```
┌─────────────────────────────────────────────────────────┐
│                   前端层 (React/Electron)                │
│  React 18 + Zustand + WebSocket (14个面板)               │
└────────────────────────────┬────────────────────────────┘
                             │ HTTP/WS
┌────────────────────────────▼────────────────────────────┐
│              TS 网关层 (Express :3111)                   │
│  Express + WebSocket + PythonAgentBridge + ACP Server    │
│  · 请求路由/转发 · 桌面自动化 · 前端静态服务             │
│  · EventBus双向桥接 · 会话管理 · 多平台网关              │
└────────────────────────────┬────────────────────────────┘
                             │ HTTP/WS (PythonAgentBridge)
┌────────────────────────────▼────────────────────────────┐
│            Python AI 核心层 (FastAPI :3112)              │
│  AgentEngine → LoopController → Planner → Executor      │
│  → Evaluator → Reporter → MemoryEngine → EvolutionEngine│
│  · MCP协议 · A2A协议 · 反思引擎 · 因果建模              │
└─────────────────────────────────────────────────────────┘
```

### Python 端 vs TS 端职责划分

| 维度           | Python 端 (FastAPI :3112)                                        | TS 端 (Express :3111)      |
| -------------- | ---------------------------------------------------------------- | -------------------------- |
| **定位**       | AI 核心引擎                                                      | 薄网关/基础设施层          |
| **执行循环**   | LoopController + Planner + Executor + Evaluator + Reporter       | ProcessInputLoop（仅回退） |
| **LLM 调用**   | LLMProvider + CredentialPool + CostGuard + PromptCache           | @deprecated，已迁移        |
| **记忆系统**   | MemoryEngine + EpisodicMemory + Curator + RedisCache             | @deprecated，已迁移        |
| **进化引擎**   | EvolutionEngine + V2Engine + FeedbackLoop + StrategyAdapter      | @deprecated，已迁移        |
| **反思系统**   | ReflectionEngine + ReflectionKB + ReflectionApplier              | 无                         |
| **MCP/A2A**    | MCPServerManager + A2AProtocolManager                            | 无                         |
| **工具注册**   | ToolRegistry + ToolCallGuard + PermissionGuard + SchemaValidator | ToolRegistry（回退）       |
| **上下文管理** | UnifiedContextOrchestrator + ContextPipeline + ContextCompressor | ContextManager（回退）     |
| **安全**       | SecurityGuard + OutputGuardrail + PathSecurity                   | SecurityFacade             |
| **可观测性**   | OpenTelemetry + StructuredLogger + ProductionMetrics             | Logger (winston)           |
| **HTTP/WS**    | FastAPI 路由                                                     | Express + WebSocket        |
| **桌面自动化** | 无                                                               | nut.js + Playwright        |
| **前端**       | 无                                                               | React + Electron           |
| **多平台网关** | 无                                                               | 微信/QQ/飞书/钉钉          |

> **关键说明**：当 `AGENT_BACKEND=python`（默认）时，TS 端的 LoopController/MemoryEngine/EvolutionEngine 等组件**不会被使用**，请求通过 PythonAgentBridge 转发到 Python 后端。设置 `AGENT_BACKEND=local` 可回退到 TS 本地实现（已废弃，V6.0 移除）。

### 六层 Harness (E-T-C-S-L-V)

> 六层架构的核心组件（E层 LoopController/Planner/Executor 等）实际位于 **Python 端** `agent/loop/` 目录。
> TS 端 `src/harness/` 仅保留工具注册、上下文管理、持久化等基础设施层的回退实现。

| 层    | 名称         | 职责                                              | Python 端关键文件                       | TS 端关键文件                 |
| ----- | ------------ | ------------------------------------------------- | --------------------------------------- | ----------------------------- |
| **E** | 执行循环     | Plan-Execute-Evaluate-Report 状态机               | `agent/loop/controller.py`              | `ProcessInputLoop.ts`（回退） |
| **T** | 工具注册表   | 57+ 声明式工具，JSON Schema + 4 级权限            | `agent/tools/registry.py`               | `ToolRegistry.ts`             |
| **C** | 上下文管理器 | 宪法 prompt → 记忆 → 动态上下文 → 历史            | `agent/context/unified_orchestrator.py` | `ContextManager.ts`           |
| **S** | 状态存储     | 瞬时(LoopContext) / 短期(SQLite) / 长期(ChromaDB) | `agent/persistence/service.py`          | `PersistenceService.ts`       |
| **L** | 生命周期钩子 | 9 个钩子: before_loop 到 after_response           | `agent/core/hooks.py`                   | `ConstraintsService.ts`       |
| **V** | 验证层       | 输出安全 + 结果验证 + 5 维质量评分                | `agent/verification/service.py`         | `VerificationService.ts`      |

### 请求流（默认 AGENT_BACKEND=python）

```
用户输入
  │
  ▼
TS 网关 (Express :3111)
  │
  ├─ AGENT_BACKEND=python ──────────────────────────────┐
  │                                                     │
  │  PythonAgentBridge.processInput()                   │
  │    ├─ 优先 WS 流式通道 (ws://localhost:3112/stream)  │
  │    └─ 回退 HTTP (POST http://localhost:3112/v1/chat) │
  │                                                     │
  ▼                                                     ▼
TS 本地回退 (已废弃)                    Python AI 核心 (FastAPI :3112)
  │                                     │
  ▼                                     ▼
ProcessInputLoop                      AgentEngine.process_input()
                                        │
                                        ▼
                                      LoopController.run()
                                        ├─ Planner.plan()          [层 E]
                                        ├─ Executor.execute()      [层 E + T]
                                        │   ├─ ToolCallGuard.check()
                                        │   ├─ ToolRegistry.execute()
                                        │   ├─ SchemaValidator.validate()
                                        │   └─ PermissionGuard.check()
                                        ├─ Evaluator.evaluate()    [层 E + V]
                                        └─ Reporter.report()       [层 E]
```

### PythonAgentBridge 通信机制

```
TS (Express :3111)  ←── HTTP/WS ──→  Python (FastAPI :3112)
     │                                      │
     ├── HTTP 连接池 (keepAlive + maxSockets)    │
     ├── WS 流式聊天 (优先，回退 HTTP)           │
     ├── EventBus 双向桥接 (TS↔Python 事件同步)  │
     └── 流式事件类型:                           │
         stream_start, stream_chunk, stream_done,│
         thinking, tool_start, tool_end,         │
         progress, error, task_cancelled,         │
         clarification_request                   │
```

---

## 3. 主循环架构（双循环引擎）

> jiabaixing 采用**双循环引擎**架构：`ConversationLoop`（对话循环）+ `LoopController`（编排循环）。
> 两者协同工作，前者管理单次对话的 ReAct 工具调用循环，后者管理复杂任务的 Plan→Exec→Eval→Report 状态机。

### 3.0.1 ConversationLoop — 对话主循环

> 文件：`agent/core/conversation_loop.py`

**职责**：管理用户输入到最终响应的完整对话循环，ReAct 模式的多轮工具调用。

**核心流程**：

```
用户输入
  │
  ▼
构建消息序列 (system_prompt + history + user_input)
  │
  ▼
┌─ while 预算未耗尽 ─────────────────────────────────────────┐
│                                                             │
│  ① PromptCaching.mark_cache_breakpoints(messages)           │
│     → Anthropic/OpenAI 前缀缓存断点标记                     │
│                                                             │
│  ② LLMProvider.chat(messages, tools)                        │
│     → 调用 LLM 生成响应                                     │
│                                                             │
│  ③ except → ErrorClassifier.classify_llm_error(e)           │
│     → 中文友好提示 + 智能退避（指数递增 delay）              │
│     → is_retryable? → 重试 / 终止                           │
│                                                             │
│  ④ ThinkScrubber.scrub(content)                             │
│     → 分离 <think> 思考过程与可见输出                        │
│                                                             │
│  ⑤ 检测 tool_calls → 逐一执行：                             │
│     SchemaValidator → ToolCallGuard → PermissionGuard        │
│     → ApprovalManager → HookManager → ToolRegistry.execute   │
│     → 失败时 _reflect_on_failure → 修正参数重试              │
│                                                             │
│  ⑥ 无 tool_calls → 退出循环                                 │
└─────────────────────────────────────────────────────────────┘
  │
  ▼
TurnFinalizer.finalize(output, tool_results, metadata)
  → 工具结果摘要 + 状态检测 + 后置 Hook
  │
  ▼
ConversationResult (content + metadata + turn_status + tool_summary)
```

**已集成模块**：

| 模块            | 集成点                           | UX 效果                                      |
| --------------- | -------------------------------- | -------------------------------------------- |
| ErrorClassifier | `run()`/`run_stream()` except 块 | 中文友好错误提示 + 智能退避重试              |
| TurnFinalizer   | `run()` 循环结束后               | 工具结果摘要 + 状态检测 + 后置 Hook          |
| PromptCaching   | `run()` LLM 调用前               | Anthropic/OpenAI 前缀缓存 → token 成本 -90%  |
| ThinkScrubber   | LLM 响应后                       | `<think>` 标签清洗，分离思考过程             |
| TurnRetryState  | LLM 调用失败时                   | 指数退避重试状态机                           |
| PermissionGuard | 工具执行前                       | 4 级权限检查                                 |
| SchemaValidator | 工具执行前                       | JSON Schema 参数校验                         |
| ToolCallGuard   | 工具执行前/后                    | 去重 + 缓存 + 限速                           |
| ApprovalManager | 工具执行前                       | 高风险工具审批流                             |
| HookManager     | 工具执行前后                     | beforeToolCall / afterToolCall / onToolError |

**流式模式** (`run_stream`)：

```
yield {"type": "thinking", "content": "..."}   ← 思考过程
yield {"type": "token", "content": "..."}      ← 输出 token
yield {"type": "tool_start", "tool_name": ...} ← 工具调用开始
yield {"type": "tool_end", "tool_name": ...}   ← 工具调用结束
yield {"type": "error", "content": "...", "category": "..."} ← 分类错误
yield {"type": "done", "trace_id": ...}        ← 完成
```

### 3.0.2 LoopController — 编排主循环

> 文件：`agent/loop/controller.py`

**职责**：复杂任务的 Plan→Exec→Eval→Report 状态机调度。

**核心流程**：

```
用户输入
  │
  ▼
_should_use_react(input_text)?
  ├─ 简单任务 → run_react_loop()        [ReAct 模式]
  └─ 复杂任务 → run() 状态机            [Plan→Exec→Eval→Report]
      │
      ▼
  IDLE → PLANNING → EXECUTING → EVALUATING → REPORTING → DONE
           ↑              ↓
           └──── REPLAN ──┘ (最多3次)
      │
      ▼
  Planner.plan()                [任务拆解 + 复杂度分析]
      │
      ▼
  Executor.execute(step)        [ReAct 循环执行]
    → ToolCallGuard.check()
    → PermissionGuard.check()
    → ToolRegistry.execute()
    → ReflectionEngine.reflect() [失败时反思重试]
      │
      ▼
  Evaluator.evaluate()          [规则 + LLM 双模式评估]
    → BuiltInQualityScorer      [5 维质量评分]
    → if 评估不通过:
        → IncrementalPlanner.replan()  [增量重规划]
        → CausalModeler.analyze()      [因果分析]
      │
      ▼
  Reporter.report()             [响应提取 + 质量评分]
      │
      ▼
  ImplicitFeedbackCollector.detect()  [隐式反馈检测]
  ReflectionApplicationManager.apply() [反思结果应用]
```

**已集成模块**：

| 模块                         | 集成点                 | UX 效果                        |
| ---------------------------- | ---------------------- | ------------------------------ |
| Planner                      | 状态机 PLANNING 阶段   | 任务拆解 + 复杂度分析          |
| Executor                     | 状态机 EXECUTING 阶段  | ReAct 循环 + 反思重试          |
| Evaluator                    | 状态机 EVALUATING 阶段 | 规则 + LLM 双模式评估          |
| Reporter                     | 状态机 REPORTING 阶段  | 响应提取 + 5 维质量评分        |
| IncrementalPlanner           | 评估不通过时           | 增量重规划                     |
| CausalModeler                | 重规划时               | 因果依赖 + 并行机会 + 失败传播 |
| ReflectionEngine             | Executor 失败时        | 错误诊断 + 修正策略            |
| ReflectionApplicationManager | 循环结束后             | 反思结果应用                   |
| ImplicitFeedbackCollector    | 循环结束后             | 隐式反馈检测                   |
| AttentionFocusManager        | 消息构建时             | 注意力聚焦 + token 预算        |
| CanaryReleaseManager         | LLM 调用前             | 金丝雀版本选择                 |
| LoopObserver                 | 全阶段                 | OpenTelemetry 可观测性         |

### 3.0.3 双循环协作关系

```
用户请求
  │
  ▼
LoopController.run()
  ├─ 简单任务 → run_react_loop()
  │     → 内部使用 ConversationLoop.run()
  │
  └─ 复杂任务 → Plan→Exec→Eval→Report 状态机
        → Executor 内部使用 ConversationLoop 处理每个 step
        → Evaluator 评估结果质量
        → IncrementalPlanner 必要时重规划
```

**关键区别**：

| 维度         | ConversationLoop           | LoopController                |
| ------------ | -------------------------- | ----------------------------- |
| **粒度**     | 单次对话                   | 复杂任务（多步）              |
| **模式**     | ReAct（think→act→observe） | Plan→Exec→Eval→Report 状态机  |
| **工具调用** | 直接执行                   | 通过 Executor 执行            |
| **错误处理** | ErrorClassifier + 重试     | ReflectionEngine + 重规划     |
| **质量保证** | TurnFinalizer              | Evaluator + QualityScorer     |
| **缓存**     | PromptCaching              | 无（委托给 ConversationLoop） |

---

## 4. Agent 三层核心运行层级

> 对应业内成熟 Agent 架构：执行层 → 编排层 → 反思层，自下而上构建。

### 4.1 执行层（底层动作）

> 调用 LLM、外部 API、数据库操作、代码执行、文件读写、工具函数调用

| 组件                  | Python 端实现                         | 职责                                   |
| --------------------- | ------------------------------------- | -------------------------------------- |
| **Executor**          | `agent/loop/executor.py`              | ReAct 循环执行器，工具调用 FC 循环     |
| **LLMProvider**       | `agent/llm/provider.py`               | 统一 LLM 调用入口，支持 litellm 多模型 |
| **ToolRegistry**      | `agent/tools/registry.py`             | 57+ 工具注册与执行                     |
| **ToolCallGuard**     | `agent/tools/tool_call_guard.py`      | 去重 + 缓存 + 限速                     |
| **PermissionGuard**   | `agent/tools/permission_guard.py`     | 4 级权限检查                           |
| **SchemaValidator**   | `agent/tools/schema_validator.py`     | JSON Schema 参数验证                   |
| **SandboxExecutor**   | `agent/sandbox/executor.py`           | 沙箱代码执行                           |
| **CodeExecutor**      | `agent/tools/code_execution_tool.py`  | 代码执行工具                           |
| **DesktopController** | `agent/desktop/desktop_controller.py` | 桌面自动化控制                         |

**执行层调用链**：

```
Executor.execute(plan_step)
  → ToolCallGuard.check()           [去重+缓存+限速]
  → PermissionGuard.check()         [4级权限]
  → SchemaValidator.validate()      [参数校验]
  → ToolRegistry.execute(tool)      [工具执行]
  → ReflectionEngine.reflect()      [失败时反思重试]
  → RobustnessManager.handle()      [错误分类+降级]
```

### 4.2 编排层（核心调度）

> 任务拆解、流程分支/循环、子任务调度、多 Agent 分工、MCP 上下文传输、A2A 跨智能体通信

| 组件                   | Python 端实现                              | 职责                                     |
| ---------------------- | ------------------------------------------ | ---------------------------------------- |
| **LoopController**     | `agent/loop/controller.py`                 | 状态机调度，Plan→Exec→Eval→Report 循环   |
| **Planner**            | `agent/loop/planner.py`                    | 任务规划器，复杂度分析 + 任务分解        |
| **IncrementalPlanner** | `agent/loop/incremental_planner.py`        | 增量重规划，动态调整执行计划             |
| **ToTPlanner**         | `agent/loop/tot_planner.py`                | Tree-of-Thought 思维树规划               |
| **CausalModeler**      | `agent/loop/causal.py`                     | 因果建模，步骤依赖 + 并行机会 + 失败传播 |
| **OrchestratorAgent**  | `agent/orchestration/agent_factory.py`     | 多 Agent 编排 + 场景路由                 |
| **TaskDispatcher**     | `agent/orchestration/task_dispatcher.py`   | 子任务分发                               |
| **FanOut**             | `agent/orchestration/fanout.py`            | 扇出并行执行                             |
| **ResultAggregator**   | `agent/orchestration/result_aggregator.py` | 结果聚合                                 |
| **BatchProcessor**     | `agent/loop/batch_processor.py`            | 批处理并发控制                           |
| **MCPToolBridge**      | `agent/tools/mcp_tool_bridge.py`           | MCP 工具桥接                             |
| **A2AProtocolManager** | `agent/a2a/protocol.py`                    | A2A 跨 Agent 通信                        |

**LoopController 状态机**：

```
IDLE → PLANNING → EXECUTING → EVALUATING → REPORTING → DONE
         ↑              ↓
         └──── REPLAN ──┘ (最多3次)
```

**编排层闭环**：

```
LoopController.run()
  → Planner.plan()                    [任务拆解]
  → Executor.execute(step)            [逐步执行]
  → Evaluator.evaluate()              [结果评估]
  → if goal_progress < threshold:
      → IncrementalPlanner.replan()   [重规划]
      → CausalModeler.analyze()       [因果分析]
  → Reporter.report()                 [生成响应]
```

### 4.3 反思层（闭环优化）

> 结果校验、错误识别、重新规划、复盘修正、长期记忆沉淀、自我迭代

| 组件                             | Python 端实现                             | 职责                          |
| -------------------------------- | ----------------------------------------- | ----------------------------- |
| **ReflectionEngine**             | `agent/loop/reflection.py`                | 反思引擎，错误诊断 + 修正策略 |
| **ReflectionKnowledgeBase**      | `agent/loop/reflection_knowledge_base.py` | 反思经验知识库                |
| **ReflectionApplicationManager** | `agent/loop/reflection_applier.py`        | 反思结果应用管理              |
| **Evaluator**                    | `agent/loop/evaluator.py`                 | 步骤评估，规则 + LLM 双模式   |
| **QualityScorer**                | `agent/loop/quality_scorer.py`            | 5 维质量评分                  |
| **PlanQualityChecker**           | `agent/loop/plan_quality_checker.py`      | 规划质量预检                  |
| **Debater**                      | `agent/loop/debater.py`                   | 辩论式推理，多方案对比        |
| **FeedbackLoops**                | `agent/loop/feedback_loops.py`            | 反馈循环                      |
| **EvolutionEngine**              | `agent/evolution/engine.py`               | V1 进化引擎                   |
| **EvolutionEngineV2**            | `agent/evolution/v2_engine.py`            | V2 LLM 驱动自我进化           |
| **ContinuousFeedbackLoop**       | `agent/evolution/feedback_loop.py`        | 持续反馈闭环                  |
| **ImplicitFeedbackCollector**    | `agent/evolution/implicit_feedback.py`    | 隐式反馈收集                  |
| **FewShotGeneralizer**           | `agent/evolution/fewshot_generalizer.py`  | FewShot 泛化                  |
| **StrategyAdapter**              | `agent/evolution/strategy_adapter.py`     | 策略自适应                    |

**反思闭环**：

```
执行完成
  → Evaluator.evaluate()               [结果校验]
  → if 评估不通过:
      → ReflectionEngine.reflect()     [错误诊断]
      → ReflectionKB.query_similar()   [历史经验检索]
      → ReflectionApplier.apply()      [修正策略应用]
      → IncrementalPlanner.replan()    [重新规划]
  → EvolutionEngine.collect_feedback() [反馈收集]
  → ImplicitFeedbackCollector.detect() [隐式反馈检测]
  → FewShotGeneralizer.generalize()    [经验泛化]
  → 持久化到 ReflectionKB              [长期记忆沉淀]
```

---

## 5. 七大核心能力维度

> 三层运转需要全覆盖的七大能力维度，jiabaixing 实际覆盖情况：

### 5.1 感知记忆 ✅ 完整覆盖

| 能力         | Python 端实现                                           | 状态 |
| ------------ | ------------------------------------------------------- | ---- |
| 短期会话记忆 | `agent/memory/engine.py` (MemoryEngine) + SessionStore  | ✅   |
| 长期知识库   | `agent/memory/store.py` (SQLite FTS5) + ChromaDB        | ✅   |
| 情景记忆     | `agent/memory/episodic_memory.py` (EpisodicMemoryStore) | ✅   |
| 状态持久化   | `agent/persistence/service.py` + TrajectoryDatabase     | ✅   |
| 记忆策展     | `agent/memory/curator.py` (Curator，质量筛选)           | ✅   |
| 向量检索     | `agent/memory/engine.py` (ChromaDB 语义搜索)            | ✅   |
| 中文分词     | `agent/memory/tokenizer.py` (jieba)                     | ✅   |
| Redis 缓存   | `agent/memory/redis_cache.py`                           | ✅   |
| 多模态编码   | `agent/memory/multimodal_encoder.py`                    | ✅   |

### 5.2 规划拆解 ✅ 完整覆盖

| 能力            | Python 端实现                                            | 状态 |
| --------------- | -------------------------------------------------------- | ---- |
| 复杂任务拆分    | `agent/loop/planner.py` (Planner)                        | ✅   |
| 步骤排序        | `agent/loop/controller.py` (LoopController 状态机)       | ✅   |
| 优先级分配      | `agent/core/dynamic_priority.py` (DynamicPriorityScorer) | ✅   |
| 增量重规划      | `agent/loop/incremental_planner.py`                      | ✅   |
| 规划质量预检    | `agent/loop/plan_quality_checker.py`                     | ✅   |
| Tree-of-Thought | `agent/loop/tot_planner.py`                              | ✅   |
| 因果依赖分析    | `agent/loop/causal.py` (CausalModeler)                   | ✅   |
| 注意力聚焦      | `agent/loop/attention.py` (AttentionFocusManager)        | ✅   |

### 5.3 工具调用 ✅ 完整覆盖

| 能力           | Python 端实现                                            | 状态 |
| -------------- | -------------------------------------------------------- | ---- |
| 函数调用       | `agent/tools/registry.py` (57+ 工具)                     | ✅   |
| 第三方系统     | MCP Tool Bridge + A2A Client                             | ✅   |
| 数据读写       | file_tools + memory_tools + code_tools                   | ✅   |
| 去重/缓存/限速 | `agent/tools/tool_call_guard.py`                         | ✅   |
| 权限控制       | `agent/tools/permission_guard.py` (4级)                  | ✅   |
| 参数校验       | `agent/tools/schema_validator.py`                        | ✅   |
| 审批管理       | `agent/tools/approval_manager.py`                        | ✅   |
| 工具集管理     | `agent/tools/toolset_registry.py` + SceneToToolsetMapper | ✅   |

### 5.4 逻辑推理 ✅ 完整覆盖

| 能力       | Python 端实现                                 | 状态 |
| ---------- | --------------------------------------------- | ---- |
| CoT 思维链 | Executor ReAct 循环 (think→act→observe)       | ✅   |
| 多方案对比 | `agent/loop/debater.py` (辩论式推理)          | ✅   |
| 逻辑推导   | `agent/loop/tot_planner.py` (Tree-of-Thought) | ✅   |
| 因果推理   | `agent/loop/causal.py` (CausalModeler)        | ✅   |
| 反思推导   | `agent/loop/reflection.py` (ReflectionEngine) | ✅   |

### 5.5 行动执行 ✅ 完整覆盖

| 能力       | Python 端实现                                   | 状态 |
| ---------- | ----------------------------------------------- | ---- |
| 外部操作   | Executor + ToolRegistry                         | ✅   |
| 输出结果   | `agent/loop/reporter.py` (Reporter)             | ✅   |
| 桌面自动化 | `agent/desktop/desktop_controller.py`           | ✅   |
| 代码执行   | `agent/sandbox/executor.py` + CodeExecutor      | ✅   |
| 文件操作   | file_tools (read/write/edit/search/grep)        | ✅   |
| 网络操作   | network_tools + web_search + browser_automation | ✅   |

### 5.6 反思纠错 ✅ 完整覆盖

| 能力       | Python 端实现                                            | 状态 |
| ---------- | -------------------------------------------------------- | ---- |
| 自检输出   | `agent/loop/evaluator.py` (Evaluator)                    | ✅   |
| 修正流程   | `agent/loop/reflection.py` + reflection_applier.py       | ✅   |
| 二次重规划 | `agent/loop/incremental_planner.py` (IncrementalPlanner) | ✅   |
| 错误分类   | `agent/loop/robustness.py` (ErrorType)                   | ✅   |
| 鲁棒性管理 | `agent/loop/robustness.py` (RobustnessManager)           | ✅   |
| 隐式反馈   | `agent/evolution/implicit_feedback.py`                   | ✅   |
| 自我迭代   | `agent/evolution/v2_engine.py` (EvolutionEngineV2)       | ✅   |

### 5.7 多端协作 ✅ 完整覆盖

| 能力           | Python 端实现                                            | 状态 |
| -------------- | -------------------------------------------------------- | ---- |
| A2A 智能体互通 | `agent/a2a/protocol.py` (A2AProtocolManager)             | ✅   |
| A2A 任务委派   | `agent/a2a/protocol.py` (A2ATaskManager)                 | ✅   |
| A2A 发现与信任 | `agent/a2a/protocol.py` (A2ADiscovery + A2ATrustManager) | ✅   |
| MCP 标准化交互 | `agent/mcp/server_manager.py` (MCPServerManager)         | ✅   |
| MCP 工具桥接   | `agent/tools/mcp_tool_bridge.py`                         | ✅   |
| 多 Agent 编排  | `agent/orchestration/agent_factory.py`                   | ✅   |
| 多平台网关     | TS 端: 微信/QQ/飞书/钉钉                                 | ✅   |

---

## 6. 技术底座

### 6.1 存储层

| 存储     | 用途                             | Python 端                                            | TS 端          |
| -------- | -------------------------------- | ---------------------------------------------------- | -------------- |
| SQLite   | 短期记忆、会话、轨迹、事件持久化 | `agent/persistence/database.py` (aiosqlite, WAL模式) | better-sqlite3 |
| ChromaDB | 长期向量记忆、语义搜索           | `agent/memory/engine.py`                             | chromadb       |
| Redis    | 缓存层、会话快照、分布式状态     | `agent/memory/redis_cache.py`                        | ioredis        |
| 文件系统 | 进化状态、轨迹DB、配置           | `agent/persistence/workspace.py`                     | fs             |

### 6.2 异步调度

| 能力           | Python 端实现                                              | 说明                      |
| -------------- | ---------------------------------------------------------- | ------------------------- |
| 消息队列       | `agent/infrastructure/message_queue.py`                    | 异步消息处理              |
| 定时任务       | `agent/scheduler/cron.py` (CronJobScheduler + APScheduler) | Cron 任务调度             |
| 重试/熔断/超时 | `agent/core/resilience.py` (CircuitState + RetryConfig)    | 三态熔断器 + 指数退避重试 |
| 请求队列       | `agent/llm/queue.py` (RequestQueue)                        | LLM 并发控制              |
| 限速           | `agent/llm/rate_limit_tracker.py`                          | API 限速追踪              |
| 成本守卫       | `agent/llm/credential_pool.py` (CostGuard)                 | Token 成本控制            |

### 6.3 分布式能力

| 能力       | 实现状态 | 说明                                                                                                                                                                 |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 多实例部署 | ✅       | Docker Compose三服务(Gateway+Python+Redis) + K8s双Deployment+HPA+PDB+Ingress                                                                                         |
| 分布式锁   | ✅       | `agent/infrastructure/distributed_lock.py` (DistributedLock + LockManager + ConcurrencyLimiter)，Redis SET NX PX + Lua 原子释放 + 自动续期看门狗 + 降级 asyncio.Lock |
| 并发限流   | ✅       | ToolCallGuard + RateLimitTracker + RequestQueue + ConcurrencyLimiter(分布式信号量)                                                                                   |
| 分片任务   | ✅       | BatchProcessor + FanOut + TaskDispatcher                                                                                                                             |

### 6.4 状态管理

| 能力           | Python 端实现                           | 说明             |
| -------------- | --------------------------------------- | ---------------- |
| 持久化记忆     | MemoryEngine + EpisodicMemoryStore      | 三层记忆体系     |
| 多轮上下文快照 | LoopContext + SessionStore              | 会话级状态快照   |
| 会话隔离       | SessionStore (session_id 隔离)          | 会话间完全隔离   |
| 执行轨迹       | TrajectoryDatabase + TrajectoryFlywheel | 完整执行记录     |
| 检查点         | `agent/persistence/checkpoint.py`       | 长任务检查点恢复 |

---

## 7. MCP + A2A 协议层

> 2026 行业分水岭：MCP 统一上下文交互标准，A2A 实现跨智能体协作。

### 7.1 MCP 模型上下文协议

| 组件               | Python 端实现                    | 职责                    |
| ------------------ | -------------------------------- | ----------------------- |
| MCPServerManager   | `agent/mcp/server_manager.py`    | MCP 服务器生命周期管理  |
| MCPToolBridge      | `agent/tools/mcp_tool_bridge.py` | MCP 工具→Agent 工具桥接 |
| MCPTransport       | `agent/mcp/transport.py`         | STDIO / HTTP+SSE 传输层 |
| MCPProgressManager | `agent/mcp/progress.py`          | 进度通知                |
| MCPLoggingManager  | `agent/mcp/logging.py`           | 日志通知                |
| MCPSamplingManager | `agent/mcp/sampling.py`          | 采样控制                |
| MCP API            | `agent/api/mcp.py`               | REST API 端点           |

**MCP 配置** (`data/mcp-servers.json`)：

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "transport": "stdio",
      "enabled": true
    }
  ]
}
```

### 7.2 A2A Agent 互操作协议

| 组件               | Python 端实现           | 职责                                           |
| ------------------ | ----------------------- | ---------------------------------------------- |
| A2AProtocolManager | `agent/a2a/protocol.py` | 协议管理器，任务委派+发现+信任                 |
| A2ATaskManager     | `agent/a2a/protocol.py` | 跨 Agent 任务委派与结果收集                    |
| A2ADiscovery       | `agent/a2a/protocol.py` | Agent 注册发现与健康检查                       |
| A2ATrustManager    | `agent/a2a/protocol.py` | 信任等级(UNTRUSTED/LOW/MEDIUM/HIGH) + 操作权限 |
| A2AServer          | `agent/a2a/server.py`   | A2A 服务端                                     |
| A2AClient          | `agent/a2a/client.py`   | A2A 客户端                                     |
| A2AAuthInterceptor | `agent/a2a/auth.py`     | 入站校验 + 出站凭据注入                        |
| A2AAgentCard       | `agent/a2a/types.py`    | Agent 能力声明卡片                             |

**A2A 信任等级**：

```
UNTRUSTED → 仅 discover + health_check
LOW       → + delegate_task + get_task_status
MEDIUM    → + cancel_task + collect_results
HIGH      → + register_agent + set_trust (全部操作)
```

---

## 8. 模块参考

### 8.1 Python AI 核心模块 (`python-backend/agent/`)

#### 8.1.1 核心引擎 (`agent/core/`)

| 文件                                 | 职责                                     |
| ------------------------------------ | ---------------------------------------- |
| `engine.py`                          | AgentEngine 中央编排器，初始化所有子系统 |
| `conversation_loop.py`               | 对话循环，ReAct 模式                     |
| `context_pipeline.py`                | 上下文构建管道                           |
| `context_compressor.py`              | 上下文压缩器                             |
| `persona.py`                         | 人格核心                                 |
| `security.py`                        | 安全守卫                                 |
| `hooks.py`                           | 生命周期钩子管理 (9个)                   |
| `resilience.py`                      | 熔断器 + 重试策略 + 鲁棒性               |
| `canary_release.py`                  | 金丝雀发布管理                           |
| `logger.py`                          | 结构化日志 (StructuredLogger)            |
| `otel_tracer.py` / `otel_metrics.py` | OpenTelemetry 可观测性                   |
| `production_metrics.py`              | 生产级埋点采集                           |
| `dependencies.py`                    | 子系统依赖声明与检查                     |
| `registry.py`                        | 子系统注册表                             |
| `error_classifier.py`                | LLM 错误分类 + 中文友好提示 + 智能退避   |
| `turn_finalizer.py`                  | Turn 结束后处理（摘要+状态检测+Hook）    |

**AgentEngine 初始化顺序**：

1. OTel 可观测性 → 2. Redis 缓存 → 3. LLM Provider → 4. Memory Engine → 5. Trajectory DB → 6. Tool Registry → 7. MCP Bridge → 8. Permission/Schema/Guard → 9. Canary Manager → 10. Constraints → 11. Loop Controller → 12. Evolution Engine → 13. Context Pipeline → 14. Persona/Security/Verification → 15. Skill Registry → 16. Hook Manager → 17. Feedback Loops → 18. A2A Protocol → 19. Agent Registry → 20. Cron Scheduler → 21. Sandbox → 22. Batch Processor → 23. Production Metrics

#### 8.1.2 Loop 模块 (`agent/loop/`)

| 文件                           | 职责                                    |
| ------------------------------ | --------------------------------------- |
| `controller.py`                | LoopController 状态机调度               |
| `planner.py`                   | 任务规划器（正则快跳 + LLM 分解 + ToT） |
| `executor.py`                  | ReAct 执行器（含反思重试+鲁棒性）       |
| `evaluator.py`                 | 步骤评估（规则 + 可选 LLM）             |
| `reporter.py`                  | 响应提取 + 5 维质量评分                 |
| `reflection.py`                | 反思引擎（错误诊断+修正策略）           |
| `reflection_knowledge_base.py` | 反思经验知识库                          |
| `reflection_applier.py`        | 反思结果应用管理                        |
| `causal.py`                    | 因果建模（依赖+并行+失败传播）          |
| `attention.py`                 | 注意力聚焦管理                          |
| `quality_scorer.py`            | 内置质量评分器                          |
| `incremental_planner.py`       | 增量重规划                              |
| `plan_quality_checker.py`      | 规划质量预检                            |
| `feedback_loops.py`            | 反馈循环                                |
| `batch_processor.py`           | 批处理并发控制                          |
| `tot_planner.py`               | Tree-of-Thought 思维树规划              |
| `debater.py`                   | 辩论式推理                              |
| `robustness.py`                | 鲁棒性管理（错误分类+降级+重试）        |
| `observer.py`                  | 循环观察者（可观测性）                  |

#### 8.1.3 LLM 模块 (`agent/llm/`)

| 文件                    | 职责                                 |
| ----------------------- | ------------------------------------ |
| `provider.py`           | LLMProvider 统一调用入口             |
| `router.py`             | 多提供商管理 + 路由 + 自动降级       |
| `cache.py`              | LLM 响应缓存                         |
| `prompt_cache.py`       | Prompt 智能缓存 + Anthropic 前缀缓存 |
| `queue.py`              | 请求队列，并发控制                   |
| `credential_pool.py`    | API Key 凭据池 + 轮换 + CostGuard    |
| `rate_limit_tracker.py` | 限速追踪                             |
| `stream.py`             | 流式响应处理                         |
| `transports.py`         | 传输层抽象 (OpenAI/Anthropic/...)    |

#### 8.1.4 记忆模块 (`agent/memory/`)

| 文件                    | 职责                            |
| ----------------------- | ------------------------------- |
| `engine.py`             | MemoryEngine 统一入口           |
| `store.py`              | SQLite 记忆存储 (FTS5 全文检索) |
| `episodic_memory.py`    | 情景记忆存储                    |
| `curator.py`            | 记忆策展人，质量筛选            |
| `tokenizer.py`          | 中文分词器 (jieba)              |
| `redis_cache.py`        | Redis 缓存层                    |
| `multimodal_encoder.py` | 多模态编码器                    |

#### 8.1.5 进化模块 (`agent/evolution/`)

| 文件                     | 职责                |
| ------------------------ | ------------------- |
| `engine.py`              | V1 进化引擎         |
| `v2_engine.py`           | V2 LLM 驱动自我进化 |
| `orchestrator.py`        | 进化编排器          |
| `feedback_loop.py`       | 持续反馈闭环        |
| `implicit_feedback.py`   | 隐式反馈收集        |
| `fewshot_generalizer.py` | FewShot 泛化        |
| `strategy_adapter.py`    | 策略自适应          |
| `skill_engine.py`        | 技能进化引擎        |
| `monitor.py`             | 性能监控            |
| `trigger.py`             | 进化触发器          |

#### 8.1.6 安全模块 (`agent/security/`)

| 文件                    | 职责         |
| ----------------------- | ------------ |
| `output_guardrail.py`   | 输出安全护栏 |
| `sensitive_detector.py` | 敏感信息检测 |
| `path_security.py`      | 路径安全守卫 |
| `url_safety.py`         | URL 安全检查 |
| `redact.py`             | 数据脱敏     |
| `osv_check.py`          | OSV 漏洞扫描 |
| `ssl_guard.py`          | SSL 安全守卫 |
| `security_guidance.py`  | 安全指导     |

#### 8.1.7 上下文模块 (`agent/context/`)

| 文件                      | 职责                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `unified_orchestrator.py` | 统一上下文编排器                                                       |
| `base.py`                 | 上下文构建基类                                                         |
| `cache.py`                | 上下文缓存                                                             |
| `models.py`               | 上下文数据模型                                                         |
| `coding_context.py`       | 编码上下文                                                             |
| `attention_focus.py`      | 注意力聚焦引擎                                                         |
| `adapters/`               | 上下文适配器（SystemPrompt/Persona/Memory/File/TokenBudget/Assembler） |

### 8.2 TS 网关层模块 (`src/`)

#### 8.2.1 网关与桥接 (`src/ide/`)

| 文件                    | 职责                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `PythonAgentBridge.ts`  | TS ↔ Python 通信桥（HTTP连接池 + WS流式 + EventBus双向桥接） |
| `ACPServer.ts`          | Agent Communication Protocol 服务                            |
| `ACPActivityTracker.ts` | ACP 活动追踪                                                 |

#### 8.2.2 核心模块 (`src/core/`) — 回退/基础设施

| 文件                            | 职责                                     | 状态 |
| ------------------------------- | ---------------------------------------- | ---- |
| `JiabaixingCore.ts`             | 主引擎入口（AGENT_BACKEND=python时转发） | 活跃 |
| `ConstitutionPromptBuilder.ts`  | 构建系统 prompt                          | 活跃 |
| `ConversationHistoryManager.ts` | 对话历史管理                             | 活跃 |
| `TreeOfThought.ts`              | Tree-of-Thought 推理                     | 回退 |
| `MemoryAssistant.ts`            | 知识提取                                 | 回退 |
| `FeedbackCollector.ts`          | 反馈收集                                 | 回退 |

#### 8.2.3 Harness 模块 (`src/harness/`) — 回退/基础设施

| 文件                                  | 职责                               | 状态        |
| ------------------------------------- | ---------------------------------- | ----------- |
| `AgentHarness.ts`                     | 六层组装点（python模式时仅做转发） | 活跃(网关)  |
| `ProcessInputLoop.ts`                 | 本地执行循环（回退）               | @deprecated |
| `loop/AutonomousTrigger.ts`           | 自主循环触发器                     | 活跃        |
| `loop/CausalModeler.ts`               | 因果建模器（回退）                 | @deprecated |
| `tools/registry/ToolRegistry.ts`      | 工具注册                           | 回退        |
| `context/ContextManager.ts`           | 上下文管理                         | 回退        |
| `persistence/PersistenceService.ts`   | 状态持久化                         | 回退        |
| `verification/VerificationService.ts` | 验证层                             | 回退        |
| `constraints/ConstraintsService.ts`   | 生命周期钩子                       | 回退        |

> **注意**：TS 端 `src/harness/loop/` 目录下**不存在** LoopController.ts、Planner.ts、Executor.ts、Evaluator.ts、Reporter.ts。这些组件仅存在于 Python 端 `agent/loop/`。

#### 8.2.4 已废弃模块（V6.0 移除）

| TS 端文件                          | Python 端对应               | 说明         |
| ---------------------------------- | --------------------------- | ------------ |
| `src/models/LLMProvider.ts`        | `agent/llm/provider.py`     | LLM 调用     |
| `src/models/ProviderManager.ts`    | `agent/llm/router.py`       | 多提供商路由 |
| `src/models/RequestQueue.ts`       | `agent/llm/queue.py`        | 请求队列     |
| `src/models/PromptCacheManager.ts` | `agent/llm/prompt_cache.py` | Prompt 缓存  |
| `src/models/LLMResponseCache.ts`   | `agent/llm/cache.py`        | 响应缓存     |
| `src/models/SqliteCacheStore.ts`   | `agent/llm/prompt_cache.py` | SQLite 缓存  |
| `src/memory/MemoryEngine.ts`       | `agent/memory/engine.py`    | 记忆引擎     |
| `src/memory/ChineseTokenizer.ts`   | `agent/memory/tokenizer.py` | 中文分词     |
| `src/evolution/EvolutionEngine.ts` | `agent/evolution/engine.py` | 进化引擎     |

### 8.3 记忆体系总览

| 层   | 存储           | 生命周期 | 用途               | Python 端            | TS 端          |
| ---- | -------------- | -------- | ------------------ | -------------------- | -------------- |
| 瞬时 | 内存数组       | 1 小时   | 请求级上下文       | LoopContext.messages | LoopContext    |
| 短期 | SQLite         | 会话     | 对话、工具结果     | MemoryStore (FTS5)   | better-sqlite3 |
| 长期 | ChromaDB(向量) | 永久     | 知识提取、语义搜索 | MemoryEngine         | chromadb       |

### 8.4 集成模块 (`src/integration/`)

支持平台：微信（QR+API）、QQ（Mirai）、飞书、钉钉

架构：双模式 — fork 子进程（隔离）+ 主进程内联（降级）

---

## 9. API 参考

### TS 网关端点 (Express :3111)

| 方法 | 路径           | 说明                                      |
| ---- | -------------- | ----------------------------------------- |
| GET  | `/api/health`  | 健康检查                                  |
| POST | `/api/process` | 文本/图片处理（→ PythonAgentBridge 转发） |
| POST | `/api/chat`    | 聊天接口（→ PythonAgentBridge 转发）      |

### Python AI 核心端点 (FastAPI :3112)

| 方法 | 路径                     | 说明               |
| ---- | ------------------------ | ------------------ |
| GET  | `/health`                | Python 端健康检查  |
| POST | `/v1/chat`               | 聊天（核心入口）   |
| WS   | `/stream/{session_id}`   | 流式聊天 WebSocket |
| GET  | `/v1/memory/search`      | 记忆搜索           |
| POST | `/v1/memory/store`       | 记忆存储           |
| GET  | `/v1/memory/stats`       | 记忆统计           |
| GET  | `/v1/skills`             | 技能列表           |
| POST | `/v1/skills/execute`     | 技能执行           |
| POST | `/v1/evolution/feedback` | 提交反馈           |
| GET  | `/v1/evolution/status`   | 进化状态           |
| POST | `/v1/evolution/trigger`  | 手动触发进化       |
| GET  | `/v1/cron/jobs`          | Cron 任务列表      |
| POST | `/v1/cron/jobs`          | 注册 Cron 任务     |

### WebSocket 事件

连接 `ws://localhost:3111`（TS 网关）或 `ws://localhost:3112/stream/{sid}`（Python 流式）：

| 事件                     | 说明            |
| ------------------------ | --------------- |
| `stream_start`           | 流式响应开始    |
| `stream_chunk`           | 流式 token 片段 |
| `stream_done`            | 流式响应完成    |
| `thinking`               | 思考过程        |
| `tool_start`             | 工具调用开始    |
| `tool_end`               | 工具调用结束    |
| `progress`               | 任务进度        |
| `error`                  | 错误            |
| `task_cancelled`         | 任务已取消      |
| `clarification_request`  | 澄清请求        |
| `agent_execution_update` | 执行进度更新    |
| `response_ready`         | 响应就绪        |
| `tool_trace`             | 工具调用追踪    |

---

## 10. 工具系统

### 工具类别（57+ 工具，8 类别）

| 类别 | 工具数 | 工具                                                                                                                                                                                         |
| ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 记忆 | 4      | memory_recall, memory_store, memory_search, knowledge_query                                                                                                                                  |
| 认知 | 3      | emotion_detect, analyze_scene, self_reflect                                                                                                                                                  |
| 桌面 | 2      | desktop_automate, desktop_screenshot                                                                                                                                                         |
| 文件 | 8      | file_read, file_list, file_search, file_grep, get_active_file, incremental_edit, multi_file_edit, subdirectory_hints                                                                         |
| 代码 | 4      | code_analyze, code_fix, code_generate, code_review                                                                                                                                           |
| 日常 | 12     | task_manage, task_priority, task_dependency, batch_task, task_analytics, calendar, reminder_set, note_take, system_status, morning_brief, natural_schedule, batch_task                       |
| 网络 | 7      | web_search, web_fetch, skill_create, image_generate, tts_speak, chart_generate, message_push                                                                                                 |
| 系统 | 12     | ask_clarification, preview_execution, rollback_changes, shell_exec, execute_code, context_manage, budget_manage, voice_interact, log_view, delegate_task, security_guidance, project_manager |
| LSP  | 6      | lsp_completion, lsp_definition, lsp_diagnostics, lsp_hover, lsp_references, lsp_symbols                                                                                                      |

### 添加新工具

1. 在 Python 端创建 `agent/tools/<类别>/my_tool.py`
2. 在 TS 端创建 `src/harness/tools/<类别>/my_tool.ts`（回退）
3. 定义 `ToolDefinition` + 执行函数
4. 在 `register_default_tools()` 中注册
5. 运行测试 `npm test && pytest`

### 工具调用守卫 (ToolCallGuard)

- **去重**：30 秒内相同工具+参数 → 返回缓存结果
- **缓存**：5 分钟 TTL，避免重复网络请求
- **限速**：同一工具每轮最多 2 次
- **意图过滤**：根据用户输入自动过滤相关工具子集

---

## 11. 事件系统

EventBus 是单例 EventEmitter，支持：

- SQLite 持久化（选定事件）
- 批量持久化（100ms 间隔，每批最多 50 条）
- 追踪跟踪（start/complete/fail）
- 重启后事件恢复
- **Python↔TS 双向桥接**（PythonAgentBridge 转发事件）

### 事件类别

- **核心**: user*input, task_completed, response_ready, stream*\*
- **调度**: scheduler_started, environment_update, project_change, git_status
- **主动**: proactive_schedule, proactive_briefing, proactive_reminder
- **记忆**: memory_stored, memory_context_ready, memory_update
- **进化**: evolution_started, evolution_update, weight_update
- **执行**: agent_execution_update, tool_trace
- **集成**: integration_connected, integration_message

---

## 12. 配置参考

### 环境变量 (.env)

| 变量                             | 默认值                   | 说明                                            |
| -------------------------------- | ------------------------ | ----------------------------------------------- |
| `PORT`                           | 3111                     | TS 网关端口                                     |
| `AGENT_BACKEND`                  | python                   | 后端选择：python（默认）/ local（回退，已废弃） |
| `LLM_MODEL`                      | deepseek-chat            | 主 LLM 模型                                     |
| `DEEPSEEK_API_KEY`               | —                        | DeepSeek API Key                                |
| `OPENAI_API_BASE`                | https://api.deepseek.com | OpenAI 兼容基础 URL                             |
| `TAVILY_API_KEY`                 | —                        | Tavily 搜索 API Key                             |
| `ENABLE_AUTO_OPTIMIZE`           | true                     | 启用自动优化                                    |
| `HARNESS_LOOP`                   | true                     | 启用执行循环层                                  |
| `HARNESS_TOOLS`                  | true                     | 启用工具层                                      |
| `HARNESS_CONTEXT`                | true                     | 启用上下文层                                    |
| `LOG_LEVEL`                      | info                     | 日志级别                                        |
| `TOT_PLANNER_ENABLED`            | true                     | 启用 Tree-of-Thought 规划                       |
| `REFLECTION_APPLICATION_ENABLED` | true                     | 启用反思应用管理器                              |
| `ENABLE_ROBUSTNESS`              | true                     | 启用鲁棒性管理                                  |
| `TOOL_TIMEOUT`                   | 30                       | 单个工具调用超时(秒)                            |
| `LLM_TIMEOUT`                    | 60                       | LLM 调用超时(秒)                                |
| `AGENT_WS_TIMEOUT_SEC`           | 120                      | WS 流式聊天超时(秒)                             |
| `A2A_REMOTE_AGENTS`              | —                        | 远程 A2A Agent 端点(逗号分隔)                   |

### 提供商配置 (data/providers.json)

```json
{
  "providers": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "enabled": true,
      "priority": 0
    }
  ],
  "primary": "deepseek",
  "routingEnabled": true,
  "routing": {
    "simpleTaskProviders": ["local"],
    "complexTaskProviders": ["deepseek"],
    "simpleTaskMaxLength": 200
  }
}
```

---

## 13. 开发指南

### 项目结构

```
jiabaixing/
  python-backend/agent/     — Python AI 核心引擎
    core/                   — 中央编排器、上下文、人格、安全、钩子
    loop/                   — 执行循环 (Controller/Planner/Executor/Evaluator/Reporter/Reflection)
    llm/                    — LLM 调用 (Provider/Router/Cache/Queue/CredentialPool)
    memory/                 — 三层记忆 (Engine/Store/Episodic/Curator)
    evolution/              — 进化引擎 (V1/V2/FeedbackLoop/StrategyAdapter)
    tools/                  — 57+ 工具 (Registry/Guard/Validator/MCPBridge)
    context/                — 上下文管理 (UnifiedOrchestrator/Adapters)
    persistence/            — 持久化 (Service/Trajectory/Session/Flywheel)
    orchestration/          — 多Agent编排 (AgentFactory/TaskDispatcher/FanOut)
    a2a/                    — A2A 协议 (Protocol/Server/Client/Auth)
    mcp/                    — MCP 协议 (ServerManager/Transport/Progress)
    security/               — 安全 (Guardrail/Detector/PathSecurity/Redact)
    verification/           — 验证层
    constraints/            — 约束服务 (Budget/Hooks)
    evaluation/             — 评估 (EvalRunner/GoldenSet/ABComparator)
    sandbox/                — 沙箱执行
    desktop/                — 桌面自动化
    scheduler/              — 定时任务 (Cron)
    skills/                 — 技能注册
    api/                    — FastAPI 路由 (chat/memory/evolution/cron/mcp/...)
    main.py                 — Python 入口 (FastAPI app)
  src/
    core/                   — TS 核心引擎（回退/基础设施）
    harness/                — TS Harness（回退/基础设施）
    ide/                    — PythonAgentBridge + ACP Server
    evolution/              — TS 进化引擎（@deprecated）
    memory/                 — TS 记忆系统（@deprecated）
    security/               — TS 安全模块
    models/                 — TS LLM 提供商（@deprecated）
    persona/                — TS 人格系统
    server/                 — Express + WebSocket (TS 网关)
    integration/            — 多平台网关 (微信/QQ/飞书/钉钉)
    frontend/               — React 前端
    shared/                 — EventBus, 事件类型
    main.ts                 — TS 入口
    cli.ts                  — CLI 入口
  data/
    providers.json          — LLM 配置
    mcp-servers.json        — MCP 服务器配置
    trajectory/             — 执行轨迹
    evolution/              — 进化状态
  tests/
    harness/                — Harness 测试
    unit/                   — 单元测试
    integration/            — 集成测试
```

### 初始化序列

**TS 端 (main.ts)**：

1. 日志初始化 → 2. 安全和加密 → 3. 数据库 → 4. 工具注册 → 5. 模型初始化 → 6. 核心引擎 → 7. PythonAgentBridge 连接 → 8. EventBus 双向桥接 → 9. 场景感知调度器

**Python 端 (main.py → AgentEngine)**：

1. OTel 可观测性 → 2. Redis → 3. LLM → 4. Memory → 5. Trajectory → 6. Tools → 7. MCP → 8. Constraints → 9. LoopController → 10. Evolution → 11. Context → 12. Persona → 13. Hooks → 14. A2A → 15. Cron → 16. Sandbox

### 测试

```bash
npm test                    # TS 端全量测试
pytest                      # Python 端全量测试 (2028+ 用例)
npm run test:coverage       # 带覆盖率
npm run eval                # 评估套件（30 个 golden case）
```

### 代码风格

- TypeScript ES2022, CommonJS 模块
- Python 3.11+, ruff 格式化
- ESLint + Prettier 强制 (TS)
- 中文注释（项目语言约定）
- 依赖注入 via 接口
- EventBus 跨模块通信
- Logger 带 traceId 关联
- StructuredLogger (Python)

---

## 14. 故障排查

### 常见问题

**better-sqlite3 编译失败**：

```bash
npm run fix:native
npm rebuild better-sqlite3
```

**端口 3111/3112 被占用**：
系统自动尝试释放。不行则 `.env` 中设置 `PORT=3113`。

**Python 后端不可用**：

```bash
# 检查 Python 进程是否启动
curl http://localhost:3112/health
# TS 端会自动降级到本地实现 (AGENT_BACKEND=local)
```

**LLM 不可用**：

```bash
# 检查 providers.json 中的 API Key
# Python 端会自动降级：主 → 次 → 本地
# 熔断器：5+ 次失败触发熔断，30s 后半开恢复
```

**TypeScript 编译错误**：

```bash
npx tsc --noEmit    # 检查类型错误
```

**前端连不上后端**：

- 确认 TS 网关在 3111 端口运行
- 确认 Python AI 核心在 3112 端口运行
- 检查 WebSocket: `ws://localhost:3111`
- 检查 `.env` 中 `CORS_ORIGIN`

**PythonAgentBridge 连接失败**：

- 检查 `AGENT_BACKEND=python` 是否设置
- 检查 Python 进程: `curl http://localhost:3112/health`
- WS 流式通道失败会自动回退 HTTP
- 指数退避重连（1s → 2s → 4s → ... → 30s）

### 日志文件

| 文件                               | 内容       |
| ---------------------------------- | ---------- |
| `logs/app.log`                     | 应用日志   |
| `logs/error.log`                   | 错误日志   |
| `data/trajectory/trajectory.db`    | 执行轨迹   |
| `data/event_bus.db`                | 事件持久化 |
| `data/evolution/engine-state.json` | 进化状态   |

---

## 15. 改进项追踪

### P0 (紧急) — 已完成

| 项目                   | 状态    | 实现文件                                   | 说明                                                                                                                                                                |
| ---------------------- | ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分布式锁全面集成       | ✅ 完成 | `agent/infrastructure/distributed_lock.py` | DistributedLock (Redis SET NX PX + Lua原子释放 + 自动续期看门狗 + 降级asyncio.Lock)、LockManager (统一管理)、ConcurrencyLimiter (分布式信号量)                      |
| Python后端内存泄漏防护 | ✅ 完成 | `agent/infrastructure/memory_guard.py`     | BufferGuard (通用LRU缓冲区守卫)、TrajectoryBufferGuard (轨迹缓冲区专用)、EventListenerGuard (弱引用监听器泄漏检测)、MemoryMonitor (psutil/tracemalloc内存监控+告警) |
| AgentEngine集成        | ✅ 完成 | `agent/core/engine.py`                     | lock_manager + trajectory_guard + listener_guard + memory_monitor 已注入AgentEngine初始化流程                                                                       |

### P1 (重要) — 已完成

| 项目             | 状态    | 实现文件                                                                   | 说明                                                                                   |
| ---------------- | ------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| TS端废弃组件标记 | ✅ 完成 | ProcessInputLoop.ts, CausalModeler.ts, MemoryEngine.ts, EvolutionEngine.ts | 全部添加 @deprecated V6.0移除 注释，明确Python端对应文件                               |
| 水平扩展能力     | ✅ 完成 | docker-compose.yml, deploy/kubernetes/\*                                   | Docker Compose三服务+K8s双Deployment+HPA+PDB+Ingress，ConfigMap含分布式锁/内存监控变量 |

### P2 (优化) — 已验证

| 项目                 | 状态      | 实现文件                                  | 说明                                                                                                                                                                                   |
| -------------------- | --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2A远程Agent联调     | ✅ 已验证 | `tests/test_a2a_e2e.py` (32 tests passed) | 完整闭环验证：Agent Card发布/发现、Task全生命周期(创建→WORKING→COMPLETED)、取消、跨Agent委派、API-Key/Bearer鉴权(出站+入站+HTTP 401)、信任等级权限控制、FastAPI HTTP端点直连、事件订阅 |
| TS端废弃组件V6.0清理 | 📋 计划   | —                                         | V6.0版本移除所有@deprecated TS端组件                                                                                                                                                   |

### 新增环境变量

| 变量                      | 默认值 | 说明                 |
| ------------------------- | ------ | -------------------- |
| `TRAJECTORY_MAX_ENTRIES`  | 500    | 轨迹缓冲区最大条目数 |
| `TRAJECTORY_MAX_STEPS`    | 20     | 每轮最大步骤数       |
| `MAX_LISTENERS_PER_EVENT` | 200    | 每事件最大监听器数   |
| `MEMORY_THRESHOLD_MB`     | 512    | 内存告警阈值 (MB)    |
| `MEMORY_MONITOR_INTERVAL` | 60     | 内存监控间隔 (秒)    |
