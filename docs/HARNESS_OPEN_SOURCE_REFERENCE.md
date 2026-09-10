# 开源 Harness 参考文档：DeepSeek Harness & Codex Harness

> **文档版本**: 2026-08-22 | **适用**: jiabaixing V6.0 混合架构
> **目的**: 深度解析两大开源 Agent Harness 的架构设计，明确 jiabaixing 已借鉴和可继续借鉴的方法论

---

## 一、Codex Harness（OpenAI）

### 1.1 项目概况

| 属性              | 值                                                         |
| ----------------- | ---------------------------------------------------------- |
| **仓库**          | [github.com/openai/codex](https://github.com/openai/codex) |
| **语言**          | Rust（核心运行时）+ TypeScript（CLI/App 层）               |
| **协议**          | Apache-2.0                                                 |
| **Star**          | ~110k（2026-08）                                           |
| **定位**          | Agent 运行时底层框架，驱动 Codex App、CLI、IDE 扩展        |
| **核心论文/文章** | OpenAI 工程博客 2026 年多篇拆解文章                        |

### 1.2 核心架构

Codex Harness 的架构可概括为 **"Agent Loop + Approval + Sandbox"** 三位一体：

```
┌─────────────────────────────────────────────┐
│              Codex Harness                   │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Agent    │  │ Approval │  │ Sandbox   │ │
│  │ Loop     │──│ Policy   │──│ Isolation │ │
│  │ (Rust)   │  │ (3级)    │  │ (容器级)  │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│       │              │              │        │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Context  │  │ Trace    │  │ Rollback  │ │
│  │ Window   │  │ Log      │  │ Manager   │ │
│  │ Manager  │  │ (OTel)   │  │           │ │
│  └──────────┘  └──────────┘  └───────────┘ │
└─────────────────────────────────────────────┘
```

### 1.3 六大核心设计

#### ① Agent Loop（代理循环）

**设计理念**：Agent 不是单次调用，而是持续推理-行动循环，直到任务完成或预算耗尽。

```rust
// Codex Harness 伪代码
loop {
    let response = llm.chat(messages, tools).await;
    if !response.has_tool_calls {
        break;  // 任务完成
    }
    for tool_call in response.tool_calls {
        let approval = approval_policy.check(tool_call);
        if !approval.approved { continue; }
        let result = sandbox.execute(tool_call).await;
        messages.push(result);
    }
}
```

**关键特性**：

- **Iteration Budget**：最大轮次 + Token 预算双重约束，防止无限循环
- **Failure Budget**：连续失败 N 次自动终止，避免死循环
- **Streaming**：每步结果实时流式输出，用户可随时中断
- **Checkpoint**：每轮状态可序列化，支持暂停/恢复

#### ② Approval Policy（三级审批策略）

| 策略        | 行为                                 | 适用场景              |
| ----------- | ------------------------------------ | --------------------- |
| `suggest`   | 只建议不执行，所有工具调用需人工确认 | 开发调试、高风险环境  |
| `auto-edit` | 低风险工具自动执行，高风险需确认     | 日常开发（**默认**）  |
| `full-auto` | 所有工具自动执行，仅 critical 需确认 | CI/CD、评测、受信环境 |

**风险分级**（5 级）：

| 风险等级  | 典型工具                     | suggest | auto-edit | full-auto |
| --------- | ---------------------------- | ------- | --------- | --------- |
| READ_ONLY | memory_search, file_read     | ❌阻止  | ✅自动    | ✅自动    |
| LOW       | web_fetch, list_files        | ❌阻止  | ✅自动    | ✅自动    |
| MEDIUM    | file_write(非系统)           | ❌阻止  | ✅需确认  | ✅自动    |
| HIGH      | file_write(系统), shell_exec | ❌阻止  | ✅需确认  | ✅需确认  |
| CRITICAL  | rm -rf, sudo, format         | ❌阻止  | ❌阻止    | ✅需确认  |

#### ③ Sandbox Isolation（沙箱隔离）

**四级沙箱策略**：

| 级别     | 文件写入   | Shell      | 网络   | 适用     |
| -------- | ---------- | ---------- | ------ | -------- |
| `none`   | ✅         | ✅         | ✅     | 开发环境 |
| `eval`   | ❌         | ❌         | ✅只读 | 评测系统 |
| `tool`   | 仅工具目录 | 仅白名单   | ✅     | 受限执行 |
| `strict` | ❌完全禁止 | ❌完全禁止 | ❌     | 安全审计 |

**实现方式**：

- Rust 层使用 `landlock`/`seccomp` 实现内核级沙箱
- 文件变更追踪：记录所有写入操作，支持一键回滚
- 进程级隔离：每个工具调用在独立子进程中执行

#### ④ Context Window Management（上下文窗口管理）

**核心问题**：长对话中 Token 超限导致 LLM 调用失败。

**Codex 方案**：

- **Token Budget**：为 system/user/assistant/tool 分配独立 Token 预算
- **优先级衰减**：越早的消息优先级越低，超预算时优先截断早期消息
- **关键信息保留**：system prompt 和最近 N 轮始终保留
- **摘要压缩**：被截断的消息生成摘要，保留关键信息

#### ⑤ pass@k 指标

**定义**：同一任务运行 k 次，至少 1 次通过的概率。

```
pass@k = 1 - C(n-c, k) / C(n, k)
```

其中 n=总运行次数，c=通过次数，k=采样数。

**意义**：

- k=1：单次通过率（最严格）
- k=3：3 次尝试至少 1 次通过（更宽容，反映 Agent 的"运气"）
- k=10：10 次尝试至少 1 次通过（几乎只要有可能通过就能通过）

#### ⑥ Deterministic Grader（确定性评分器）

**核心理念**：评分方差来自人工判断的主观性，程序化断言消除方差。

**断言类型**（9 种）：

| 断言类型          | 说明             | 示例                                           |
| ----------------- | ---------------- | ---------------------------------------------- |
| `exact_match`     | 精确匹配         | 输出 == "42"                                   |
| `contains`        | 包含子串         | "北京" in 输出                                 |
| `regex`           | 正则匹配         | re.match(r"\d{4}", 输出)                       |
| `json_schema`     | JSON Schema 验证 | 输出符合 {"type":"object","required":["name"]} |
| `tool_call`       | 工具调用验证     | 调用了 memory_search                           |
| `tool_call_order` | 工具调用顺序     | memory_search → file_read → file_write         |
| `no_tool_call`    | 未调用工具       | 未调用 shell_exec                              |
| `latency`         | 延迟约束         | latency < 5000ms                               |
| `output_length`   | 输出长度         | len(输出) < 1000                               |

---

## 二、DeepSeek Harness（DSH）

### 2.1 项目概况

| 属性         | 值                                                                       |
| ------------ | ------------------------------------------------------------------------ |
| **仓库**     | [github.com/deepseek-ai/harness](https://github.com/deepseek-ai/harness) |
| **语言**     | Python + TypeScript（Cordis 元框架）                                     |
| **协议**     | MIT                                                                      |
| **Star**     | ~156k（2026-08，GitHub 史上最快涨星纪录）                                |
| **定位**     | 高度可定制的 AI 编程工具，对标 Claude Code 和 Codex                      |
| **核心理念** | **一切皆插件（Everything is a Plugin）**                                 |

### 2.2 核心架构

DeepSeek Harness 建立在 **Cordis 元框架** 之上，采用插件化架构：

```
┌──────────────────────────────────────────────────┐
│              DeepSeek Harness (DSH)               │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │           Cordis 元框架                      │ │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │ │
│  │  │ Plugin  │ │ Event   │ │ Config  │       │ │
│  │  │ Registry│ │ Bus     │ │ Manager │       │ │
│  │  └─────────┘ └─────────┘ └─────────┘       │ │
│  └─────────────────────────────────────────────┘ │
│       │         │         │         │            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────┐ │
│  │ Model   │ │ Tool    │ │ Sandbox │ │ UI   │ │
│  │ Plugin  │ │ Plugin  │ │ Plugin  │ │Plugin│ │
│  └─────────┘ └─────────┘ └─────────┘ └──────┘ │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────┐ │
│  │ Session │ │ SubAgent│ │ Memory  │ │ LLM  │ │
│  │ Plugin  │ │ Plugin  │ │ Plugin  │ │Plugin│ │
│  └─────────┘ └─────────┘ └─────────┘ └──────┘ │
└──────────────────────────────────────────────────┘
```

### 2.3 六大核心设计

#### ① Everything is a Plugin（一切皆插件）

**核心理念**：模型、工具、沙箱、会话、子 Agent、界面都能替换或重新组合。

**插件生命周期**：

```
register → validate → activate → [running] → deactivate → unregister
                              ↑                    ↓
                              └── hot_swap ────────┘
```

**插件元数据**：

```python
@dataclass
class PluginSpec:
    name: str                    # 唯一标识
    version: str                 # 语义版本
    category: str                # 分类: model/tool/sandbox/session/subagent/ui
    dependencies: list[str]      # 依赖的其他插件
    priority: int = 0            # 加载优先级
    hot_swappable: bool = False  # 是否支持热插拔
    config_schema: dict = {}     # 配置 Schema
```

**官方预置四种 Agent 模式**：

1. **Standard**（标准模式）：全能型编程助手
2. **Planner**（规划模式）：先规划后执行
3. **Coder**（编码模式）：专注代码生成
4. **Reviewer**（审查模式）：代码审查与优化

#### ② 三维评分系统（Outcome / Compliance / Process）

**设计理念**：单一分数无法区分"结果对但过程错"和"结果错但过程对"。

| 维度           | 含义         | 权重 | 评估内容                               |
| -------------- | ------------ | ---- | -------------------------------------- |
| **Outcome**    | 任务是否完成 | 0.40 | 结果正确性、golden匹配、断言通过率     |
| **Compliance** | 是否遵守约束 | 0.35 | 安全合规、工具权限、输出格式、人设一致 |
| **Process**    | 过程是否合理 | 0.25 | 工具调用效率、步骤合理性、无冗余操作   |

**三个独立 Verifier**：

```python
class OutcomeVerifier:
    """结果验证器：任务是否完成"""
    def verify(self, output, golden, assertions) -> float: ...

class ComplianceVerifier:
    """合规验证器：是否遵守约束"""
    def verify(self, output, constraints, persona) -> float: ...

class ProcessVerifier:
    """过程验证器：过程是否合理"""
    def verify(self, tool_calls, expected_tools, latency) -> float: ...
```

**加权公式**：

```
weighted = outcome × 0.40 + compliance × 0.35 + process × 0.25
```

**按分类动态权重**：

| 分类     | Outcome  | Compliance | Process  | 理由             |
| -------- | -------- | ---------- | -------- | ---------------- |
| safety   | 0.20     | **0.50**   | 0.30     | 安全类合规最重要 |
| memory   | **0.45** | 0.25       | 0.30     | 记忆类结果最重要 |
| tool_use | 0.30     | 0.20       | **0.50** | 工具类过程最重要 |
| planning | 0.30     | 0.15       | **0.55** | 规划类过程最重要 |
| persona  | 0.20     | **0.55**   | 0.25     | 人设类合规最重要 |

#### ③ 日志即唯一真相源（TraceLog）

**核心理念**：所有执行轨迹、评分结果、状态变更都记录到 TraceLog，作为唯一数据源。

```python
class TraceLog:
    def record(self, trace_id, session_id, event_type, data, duration_ms=0):
        """记录一条轨迹事件"""

    def get_tool_trace(self, trace_id) -> list[dict]:
        """获取某次执行的工具调用轨迹"""

    def get_score_trace(self, session_id) -> list[dict]:
        """获取某次评测的评分轨迹"""

    def rebuild_state(self, trace_id) -> dict:
        """从轨迹重建执行状态（可回放）"""
```

**事件类型**：

- `SESSION_START` / `SESSION_END`：会话生命周期
- `TOOL_CALL`：工具调用（含参数、结果、耗时）
- `SCORE`：评分事件（含三维分数、断言结果）
- `APPROVAL`：审批决策（含策略、风险等级、决策结果）

**持久化**：支持内存 + JSONL 文件双写，进程重启后可回放历史轨迹。

#### ④ Verifier Reward（程序化奖励信号）

**设计理念**：借鉴 RLHF 的 reward signal，但用程序化验证替代人工标注。

```
reward = outcome_verifier(output, golden) × w1
       + compliance_verifier(output, constraints) × w2
       + process_verifier(tool_calls, expected) × w3
```

**与 RLHF 的区别**：

- RLHF：人工标注 → 训练 reward model → 近似奖励
- DSH Verifier：程序化断言 → 精确奖励 → 零方差

**应用**：

- 评测系统：直接用作评分
- 强化学习：作为 reward signal 训练 Agent
- 在线学习：根据 reward 调整 Agent 策略

#### ⑤ 热插拔与可回溯

**热插拔**：运行时替换插件，无需重启服务。

```python
registry.hot_swap("model_plugin", new_model_plugin)
# 旧插件自动 deactivate，新插件 activate
# 变更历史记录到 TraceLog
```

**可回溯**：每次插件变更记录到历史，支持回退。

```python
registry.rollback("model_plugin", version=2)
# 回退到 v2 版本
```

#### ⑥ Cordis 元框架

**定位**：DSH 的底层元框架，提供插件系统、事件总线、配置管理等基础设施。

**核心组件**：

- **PluginRegistry**：插件注册、依赖解析、生命周期管理
- **EventBus**：异步事件总线，插件间通信
- **ConfigManager**：分层配置（全局 → Profile → Bundle → 运行时覆盖）
- **HookSystem**：before/after 钩子，支持插件注入逻辑

**Profile 机制**：

- 预定义配置模板（如 `coding`、`research`、`review`）
- Bundle：多个 Profile 的组合
- 用户可自定义 Profile 和 Bundle

---

## 三、两大 Harness 对比

| 维度           | Codex Harness                      | DeepSeek Harness                       |
| -------------- | ---------------------------------- | -------------------------------------- |
| **语言**       | Rust（性能优先）                   | Python（灵活优先）                     |
| **协议**       | Apache-2.0                         | MIT                                    |
| **Star**       | ~110k                              | ~156k                                  |
| **核心理念**   | 安全优先（Approval+Sandbox）       | 灵活优先（Everything is Plugin）       |
| **审批策略**   | 3级（suggest/auto-edit/full-auto） | 无内置（通过插件实现）                 |
| **沙箱**       | 内核级（landlock/seccomp）         | 插件级（可替换）                       |
| **评分**       | Deterministic Grader（9种断言）    | 三维评分（Outcome/Compliance/Process） |
| **上下文管理** | Token Budget + 优先级衰减          | 插件实现（可替换）                     |
| **插件系统**   | 无内置                             | Cordis 元框架                          |
| **评测指标**   | pass@k                             | Verifier Reward                        |
| **轨迹追踪**   | OTel 集成                          | TraceLog（自研）                       |
| **配置**       | 硬编码 + 环境变量                  | Profile + Bundle + 运行时覆盖          |
| **子Agent**    | 无内置                             | SubAgent Plugin                        |
| **热插拔**     | 不支持                             | 支持 + 可回溯                          |
| **适用场景**   | 生产环境、安全敏感                 | 开发环境、高度定制                     |

---

## 四、jiabaixing 已借鉴的方法论

| 来源      | 方法论                    | jiabaixing 实现                            | 文件                              | 状态 |
| --------- | ------------------------- | ------------------------------------------ | --------------------------------- | ---- |
| **Codex** | Agent Loop                | ConversationLoop + IterationBudget         | conversation_loop.py              | ✅   |
| **Codex** | Approval Policy (3级)     | ApprovalManager + RiskTier(5级)            | harness/approval.py               | ✅   |
| **Codex** | Sandbox Isolation (4级)   | SandboxGuard + 文件回滚                    | harness/sandbox.py                | ✅   |
| **Codex** | Context Window Management | ContextWindowManager + TokenBudget         | harness/context_window.py         | ✅   |
| **Codex** | pass@k                    | AgentEvalSystem.\_eval_case_with_pass_at_k | evaluation/agent_eval_system.py   | ✅   |
| **Codex** | Deterministic Grader      | AssertionValidator (9种断言)               | evaluation/assertion_validator.py | ✅   |
| **Codex** | Regression Guard          | RegressionGuard + 基线对比                 | evaluation/agent_eval_system.py   | ✅   |
| **Codex** | Approval 异步适配         | ApprovalManager.request_approval()         | harness/approval.py               | ✅   |
| **DSH**   | Everything is a Plugin    | PluginRegistry + 热插拔                    | harness/plugin_registry.py        | ✅   |
| **DSH**   | 三维评分                  | ThreeAxisScorer + 动态权重                 | harness/three_axis.py             | ✅   |
| **DSH**   | TraceLog 唯一真相源       | TraceLog + JSONL持久化                     | harness/trace_log.py              | ✅   |
| **DSH**   | Verifier Reward           | Outcome/Compliance/Process Verifier        | harness/three_axis.py             | ✅   |
| **DSH**   | 热插拔与可回溯            | PluginRegistry.hot_swap + 变更历史         | harness/plugin_registry.py        | ✅   |
| **DSH**   | 按分类动态权重            | \_CATEGORY_WEIGHTS                         | harness/three_axis.py             | ✅   |
| **DSH**   | HTML可视化报告            | \_save_html_report                         | evaluation/agent_eval_system.py   | ✅   |

---

## 五、jiabaixing 可继续借鉴的方法论

| 优先级 | 来源  | 方法论               | 当前差距                       | 建议实现                                   |
| ------ | ----- | -------------------- | ------------------------------ | ------------------------------------------ |
| P0     | Codex | 内核级沙箱           | 当前 SandboxGuard 是逻辑层隔离 | 集成 Docker/landlock 实现进程级隔离        |
| P0     | Codex | Checkpoint 暂停/恢复 | ConversationLoop 无状态序列化  | 添加 TurnContext.serialize()/deserialize() |
| P0     | DSH   | Cordis 元框架        | PluginRegistry 较简单          | 扩展 EventBus + ConfigManager + HookSystem |
| P1     | Codex | OTel 原生集成        | 自研 TraceLog                  | 添加 OTel Exporter，统一到现有 tracing     |
| P1     | DSH   | SubAgent Plugin      | MultiAgentOrchestrator 硬编码  | 改为 SubAgent 插件，支持动态注册           |
| P1     | DSH   | Profile + Bundle     | 配置硬编码                     | 添加 Profile 机制，支持场景切换            |
| P2     | Codex | Streaming 中断       | 用户无法中途取消工具执行       | 添加 CancellationToken 到 ConversationLoop |
| P2     | DSH   | 插件市场             | 无                             | 添加 dsh-plugin 兼容层，复用社区插件       |
| P2     | Codex | 文件变更 Diff        | SandboxGuard 只记录不展示      | 添加 diff 视图，展示工具执行的文件变更     |
| P3     | DSH   | 在线学习             | Verifier Reward 未闭环到策略   | 根据 reward 信号调整 Agent 工具选择策略    |

---

## 六、jiabaixing V6.0 混合架构总览

### 架构定位

jiabaixing V6.0 采用 **Python 后端 + TypeScript 网关** 混合架构，融合 Codex Harness 的安全优先和 DeepSeek Harness 的灵活优先两种方法论：

```
┌─────────────────────────────────────────────────────────┐
│                    jiabaixing V6.0                       │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              TypeScript 网关层 (3100)             │   │
│  │  Electron UI ←→ WS ←→ API Proxy ←→ Python 后端  │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Python 后端层 (3112)                  │   │
│  │                                                    │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │   │
│  │  │ AgentEngine │  │ Harness     │  │ Eval     │ │   │
│  │  │ (13域容器)  │  │ (Codex+DSH) │  │ System   │ │   │
│  │  └─────────────┘  └─────────────┘  └──────────┘ │   │
│  │       │                  │               │        │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │   │
│  │  │ ConvLoop    │  │ Approval    │  │ ThreeAxis│ │   │
│  │  │ +TraceLog   │  │ +Sandbox    │  │ Scorer   │ │   │
│  │  │ +CtxWindow  │  │ +PluginReg  │  │ +Assert  │ │   │
│  │  └─────────────┘  └─────────────┘  └──────────┘ │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 13 域容器

| 域            | 职责       | 关键组件                                     |
| ------------- | ---------- | -------------------------------------------- |
| core          | 核心推理   | LLMProvider, ConversationLoop                |
| tool          | 工具管理   | ToolRegistry, ApprovalManager                |
| context       | 上下文管理 | UnifiedContextPipeline, ContextWindowManager |
| security      | 安全防护   | SecurityPolicyEngine, PermissionGuard        |
| persistence   | 持久化     | SessionStore, MemoryStore                    |
| orchestration | 编排调度   | MultiAgentOrchestrator, LoopController       |
| evolution     | 自我进化   | EvolutionOrchestrator, EvolutionEngine       |
| integration   | 外部集成   | MCPBridge, A2AProtocol                       |
| presentation  | 展示层     | StreamingPipeline, OutputFormatter           |
| observability | 可观测性   | TraceLog, OTel, Metrics                      |
| session       | 会话管理   | SessionManager, SessionTokenQuota            |
| cache         | 缓存       | PromptCaching, ResultCache                   |
| utility       | 工具函数   | ConfigLoader, I18nManager                    |

### Harness 集成点

| 集成点                            | Harness 组件                     | 集成方式                                     |
| --------------------------------- | -------------------------------- | -------------------------------------------- |
| Engine.**init**                   | TraceLog + ContextWindowManager  | 初始化并传入 ConversationLoop                |
| ConversationLoop.run()            | TraceLog                         | SESSION_START/TOOL_CALL/SESSION_END 事件记录 |
| ConversationLoop.run()            | ContextWindowManager             | len(msgs)>20 时自动截断                      |
| ConversationLoop.\_execute_tool() | TraceLog                         | TOOL_CALL 事件记录                           |
| ConversationLoop.\_execute_tool() | ApprovalManager                  | request_approval() 审批                      |
| AgentEvalSystem                   | ThreeAxisScorer                  | 三维评分 + 动态权重                          |
| AgentEvalSystem                   | PluginRegistry                   | 插件化架构                                   |
| AgentEvalSystem                   | SandboxGuard                     | 评测隔离                                     |
| Eval API                          | ApprovalManager + PluginRegistry | /approval + /plugins 端点                    |
