# 家百星（Jiabaixing）业务逻辑文档

> **版本**：V5.0（审计配套版，2026-07-10）
> **适用范围**：本文档描述审计修复后的目标业务语义；凡与代码现状不一致处，以"⚠️ 待修复"标注，并在 `docs/BUSINESS_LOGIC_AUDIT.md` 中跟踪。
> **架构**：TypeScript 薄网关（Express :3111）+ Python FastAPI 后端（:3112，通过 `AGENT_BACKEND=python` 启用）。Agent 核心能力以 Python 端为主实现（见 `AGENTS.md` 架构原则）。

---

## 1. 核心业务流程与模块交互

### 1.1 总体交互拓扑

```
                ┌─────────────────┐         ┌──────────────────────────┐
 用户/TS 网关 ──▶│  FastAPI 入口   │────────▶│  agent/core/engine.py     │
 (HTTP/WS/MCP)  │  (main.py)      │         │  JiabaixingCore          │
                └─────────────────┘         └────────────┬─────────────┘
                                                         │
                  ┌──────────────┬───────────┬────────────┼───────────┬────────────┐
                  ▼              ▼           ▼            ▼           ▼            ▼
            ┌──────────┐  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
            │ Loop     │  │ Memory   │ │ Tools    │ │ Persist. │ │ Evolution│ │ Scheduler│
            │ Controller│ │ Engine    │ │ Registry │ │ Service  │ │ Engine   │ │ (cron)   │
            └────┬─────┘  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
                 │             │            │             │            │            │
            Planner→      search/store  execute()    trajectory   collect_feedback  register
            Executor→      curate        permission    session      should_evolve   tick
            Evaluator→    recall        approval      memory       execute_evolution
            Reporter      embed         sandbox       workspace    rollback
```

### 1.2 计划-执行-评估-报告主流程（Plan-Execute-Evaluate-Report）

入口：`LoopController.run(user_input, session_id, messages, ...)`

```
run()
 ├─ 构建 LoopContext（含 BudgetState: max_rounds=5, max_tool_calls=20, max_tokens=8000, max_duration_ms）
 ├─ BEFORE_LOOP 钩子
 └─ while True:
     ├─ 取消检查 → break
     ├─ 预算检查：rounds_used ≥ max_rounds → break
     │            tool_calls_used ≥ max_tool_calls → break
     │            elapsed_ms > max_duration_ms (max_duration_ms>0) → break   ✅ 修复 L-04
     ├─ PLANNING：若 plan is None 或 replan_count>0 → planner.plan()；非 simple 则注入计划上下文
     ├─ EXECUTING：executor.execute(plan, ctx)
     │     └─ 每步：skip status=="completed"；否则 _execute_step → 工具/LLM → 写 ctx.step_results
     ├─ EVALUATING：evaluator.evaluate(ctx) → EvaluatorOutput(goal_progress, suggested_action)
     ├─ 决策：
     │     continue：progress≥0.8 → break；否则连续 continue 超过阈值 → 强制 replan ✅ 修复 L-05
     │     replan：replan_count++；达 MAX_REPLAN_COUNT → break；否则 planner.replan()
     │     abort / 其他 → break
     └─ REPORTING：reporter.report(ctx) → ReporterOutput(response, quality_score)
```

### 1.3 ReAct 循环（Thought→Action→Observation）

入口：`LoopController.run_react_loop(...)`。适用于简单/对话类任务。每轮：LLM 产出 Thought + Action（工具调用或 FinalAnswer）；执行 Observation 回填；达 `max_iterations` 或无 FinalAnswer 时以最后有效 assistant 消息作为兜底（⚠️ 待修复 L-08：应合成综合回答而非返回系统观察串）。

### 1.4 记忆与上下文流水线

```
用户消息 → ContextPipeline 组装（system + persona + dynamic + memory检索 + history[-N] + @引用）
                              ↓
                   MemoryEngine.search_with_context（FTS + 语义 + 情景 + 时效衰减）
                              ↓
                   ContextWindowManager.check_and_compress()  ⚠️ 待修复 M-05/M-13
                              ↓
                          LLM.chat()
```

### 1.5 工具执行链路

```
LLM 返回 tool_calls
  → conversation_loop._execute_tool(tool_call)         ⚠️ 守卫层待接线 T-01~T-04
      ├─ permission_guard.check(...)   （4 参，需修复调用）
      ├─ approval_manager.request_approval(...)
      ├─ tool_registry.execute(name, params)           （超时保护，timeout>0 才生效 ✅ 修复 T-07）
      │     └─ executor(params) → ToolResult（含 metadata: truncated/exit_code）
      └─ 返回 ToolResult（应透传 metadata ✅ 建议 T-08）
```

### 1.6 MCP / A2A

- **MCP**：`api/mcp.py → MCPServerManager.start_server → _initialize_server`（发送带 `id` 的 `initialize` JSON-RPC，等待 `initialized` ✅ 修复 A-01）→ `call_tool`/`list_resources`。
- **A2A**：`A2AProtocolManager`（内存存储 task）→ `client.delegate_task` 远程调用；`server` 暴露 `create_task/cancel_task/publish` ⚠️ publish 鉴权与 `/a2a/push` 状态同步待修复 A-05/A-06。

---

## 2. 关键业务规则及其实现方式

| 规则编号 | 业务规则                                       | 实现位置                                         | 现状                                                          |
| -------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| R-01     | 评估门控不通过则阻断发布                       | `EvalGate.check_ab`                              | ✅ 修复 L-01（`check()` 现返回 `EvalGateResult`）             |
| R-02     | 工具调用超时保护                               | `ToolRegistry.execute` `asyncio.wait_for`        | ✅ 修复 T-07（timeout≤0 视为不超时）                          |
| R-03     | 凭据失败 3 次隔离，限流按时长隔离              | `CredentialPool.is_available`                    | ✅ 修复 T-05（`report_rate_limit` 正确解析相对秒数）          |
| R-04     | 循环时间预算上限                               | `LoopController` 主循环                          | ✅ 修复 L-04（elapsed > max_duration_ms 中止）                |
| R-05     | 持续失败步骤应升级重规划                       | `LoopController` 决策                            | ✅ 修复 L-05（连续 continue 超阈值强制 replan）               |
| R-06     | 规划质量反馈注入进化                           | `LoopController` 学习信号                        | ✅ 修复 L-07（用 `context.plan.steps` 计算 completion_ratio） |
| R-07     | 错误恢复评分反映真实重试成功率                 | `Reporter._score_error_recovery`                 | ✅ 修复 L-09（从 PlanStep.retry_count 映射）                  |
| R-08     | 空记忆查询不崩溃                               | `MemoryStore.search`                             | ✅ 修复 M-01（空/`*` 查询返回 `[]`）                          |
| R-09     | 轨迹记录 ID 唯一，避免级联删除                 | `TrajectoryDatabase.record_execution`            | ✅ 修复 M-07/M-10（ID 加长至 16 位）                          |
| R-10     | 更新执行状态不清空已有响应                     | `TrajectoryDatabase.update_execution_status`     | ✅ 修复 M-08（仅当 response 非 None 才更新）                  |
| R-11     | JSON 持久化原子写，损坏不静默丢                | `SessionStore/Workspace/Checkpoint._save`        | ✅ 修复 M-09（临时文件 + rename）                             |
| R-12     | 定时任务支持 every/daily/hourly/cron           | `CronJobScheduler._parse_interval`               | ✅ 修复 S-01（新增 daily/hourly/weekly/cron 解析）            |
| R-13     | 崩溃后定时任务不应永久卡死 running             | `CronJobScheduler._load`                         | ✅ 修复 S-02（加载时重置 running→idle）                       |
| R-14     | 调度命令注入应被扫描                           | `CronJobScheduler._scan_injection`               | ✅ 修复 S-03（args 一并扫描）                                 |
| R-15     | LLM 缓存键须含 system_prompt/tools/temperature | `LLMCache._key`                                  | ✅ 修复 L-12（键纳入三个维度）                                |
| R-16     | 目标进度评估无 LLM 时不得误判成功              | `VerificationService.evaluate_goal_progress`     | ✅ 修复 V-01（无 LLM 时返回 achieved=False）                  |
| R-17     | LLM 进度解析异常不得默认成功                   | `VerificationService._llm_evaluate_goal`         | ✅ 修复 V-02（缺字段默认 achieved=False）                     |
| R-18     | 进化回滚须在优化后 N 次交互验证                | `EvolutionOrchestrator._check_pending_rollbacks` | ✅ 修复 E-01（用 interaction_count 差值）                     |
| R-19     | MCP 握手须完成初始化                           | `MCPServerManager._initialize_server`            | ✅ 修复 A-01（initialize 带 id）                              |

⚠️ **待修复规则（文档定义目标语义，实现见审计表）**：

- R-20 权限/审批/沙箱/约束守卫须真实接入工具执行路径（T-01~T-04, C-01, C-02）。
- R-21 成本/预算守卫须事前拦截而非仅统计（T-06）。
- R-22 上下文压缩须真实生效并避免悬空 tool_call（M-05, M-06）。
- R-23 记忆写后须失效搜索缓存、Curator 须真正执行遗忘/巩固（M-02, M-03）。
- R-24 A2A publish 须鉴权且不回显密钥；`/a2a/push` 须更新 task 状态（A-05, A-06）。
- R-25 V2 自修改引擎须调用 `assess_action_safety` 并真实校验（E-02, E-03, E-04）。

---

## 3. 数据流转路径与状态转换

### 3.1 核心状态对象

| 对象                       | 生产者           | 消费者                              | 关键字段                                                                                      |
| -------------------------- | ---------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `LoopContext`              | `LoopController` | Planner/Executor/Evaluator/Reporter | `messages, plan, step_results, budget, metadata`                                              |
| `ExecutionPlan`/`PlanStep` | Planner          | Executor                            | `steps[].tool_name, tool_params, retry_count, max_retries, status`                            |
| `StepResult`               | Executor         | Evaluator, Reporter                 | `step_id, success, content, tool_name, error, duration_ms` (+ `retry_count` 由 PlanStep 映射) |
| `EvaluatorOutput`          | Evaluator        | `LoopController` 决策               | `goal_progress, suggested_action(continue/replan/abort)`                                      |
| `ReporterOutput`           | Reporter         | 包装为 `AgentResult`                | `response, quality_score, quality_breakdown`                                                  |
| `AgentResult`              | `LoopController` | `engine` → 网关                     | `response, success, metadata`                                                                 |

### 3.2 状态转换（LoopState）

```
IDLE ──▶ PLANNING ──▶ EXECUTING ──▶ EVALUATING ──▶ (continue→EXECUTING / replan→PLANNING / abort→REPORTING)
                                                          │
                                                          ▼
                                                     REPORTING ──▶ COMPLETED/FAILED
```

### 3.3 轨迹持久化状态机（TrajectoryDatabase）

```
record_execution(status="running")
   → update_execution_status(status="success"|"failed", response)   ✅ 修复 M-08（response 非 None 才更新）
   → record_state_transition(from, to, reason)
   → record_tool_invocation(...) / record_llm_output(...)
```

⚠️ 待修复：execution ID 应使用足够长度的 UUID（`exec_{uuid4().hex}` 16 位），避免 `INSERT OR REPLACE` 级联删除子表（M-07 已修复）。

### 3.4 记忆数据流

```
MemoryEngine.store(content, memory_type, scene, emotion)
   → MemoryStore.store（memories + memories_fts 外部内容表）
   → （可选）Redis 搜索缓存回填
MemoryEngine.search_with_context(query)
   → MemoryStore.search（FTS5 MATCH + JOIN）  ✅ 修复 M-01（空查询安全返回）
   → EpisodicMemoryStore.retrieve（情景）
   → 时效衰减重排 → 合并去重 → 返回
⚠️ 待修复：写后须失效搜索缓存（M-02）；Curator 须执行遗忘/巩固（M-03）。
```

### 3.5 进化反馈闭环

```
collect_feedback / record_signal(LearningSignal)
   → EvolutionEngine._process_feedback_signal（更新工具权重/趋势）
   → should_evolve(cause) → EvolutionPlan → execute_evolution
   → Orchestrator 拍快照 → 待验证队列 → _check_pending_rollbacks（N 次交互后）
        ├─ 质量下降 ≥ 阈值 → _rollback_evolution（恢复工具权重）  ✅ 修复 E-01
        └─ 质量未降 → 移除验证
⚠️ 待修复：V2 自修改引擎方法名/安全评估/校验（E-02~E-04）；反馈 cause 词汇对齐（E-06）。
```

---

## 4. 异常处理机制与边界条件定义

### 4.1 通用异常原则

1. **可恢复错误**（网络/超时/限流）→ 指数退避重试（不调 LLM），封顶 `max_retries`。
2. **参数/语法错误** → LLM 反思修正参数后重试。
3. **工具不可用** → 降级替代工具。
4. **不可恢复错误**（权限拒绝、审批拒绝、超过预算）→ 终止并上报。

### 4.2 边界条件定义（目标语义）

| 边界                                            | 定义                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| 空/星号记忆查询                                 | 返回空列表 `[]`，不抛异常（✅ M-01）                                             |
| `TOOL_EXECUTE_TIMEOUT ≤ 0`                      | 视为不设置超时（✅ T-07）                                                        |
| 凭据 `retry_after`                              | 视为相对秒数；`rate_limited_until = now + retry_after`（✅ T-05）                |
| `max_duration_ms ≤ 0`                           | 不启用时间预算中止（✅ L-04）                                                    |
| 连续 `continue` 超阈值（默认 3 轮且进度无提升） | 强制升级为 `replan`（✅ L-05）                                                   |
| `StepResult` 无 `retry_count` 字段              | 由 `context.plan.steps[step_id].retry_count` 映射计算错误恢复（✅ L-09）         |
| 执行状态更新 `response=None`                    | 不覆盖已有响应（✅ M-08）                                                        |
| 定时任务 schedule 不支持                        | 解析失败 → 记录 warning 并拒绝注册，而非静默 `next_run=None`（✅ S-01）          |
| 任务 `status=="running"` 加载                   | 重置为 `idle` 以便重新调度（✅ S-02）                                            |
| 调度命令/参数含危险模式                         | 拒绝执行（✅ S-03 扫描 args）                                                    |
| LLM 缓存键                                      | 必须包含 `model + temperature + system_prompt + tools签名 + messages`（✅ L-12） |
| 目标进度评估无 LLM                              | `achieved=False, progress=0.0`（✅ V-01）                                        |
| 进化回滚验证                                    | 以 `interaction_count` 差值 ≥ `_VERIFICATION_INTERACTIONS` 触发（✅ E-01）       |
| MCP `initialize`                                | 必须带 `id` 字段，等待 `notifications/initialized`（✅ A-01）                    |

### 4.3 未覆盖异常流（⚠️ 待修复，文档记录目标）

- **T-01/T-02**：权限/高危命令执行异常须被捕获并据策略拒绝，不得 `except: pass` 吞掉。
- **M-09 延伸**：所有 JSON/DB 持久化须原子写 + 损坏备份而非静默丢弃。
- **A-02**：网关入站消息须有消费循环；sync 模式 Future 须被 resolve，否则返回明确错误而非 504 空等。
- **A-03**：跨 TS/Python 的 `trace_id` 须统一字段名并贯穿整条链路。

---

## 5. 修复与文档一致性说明

本次审计共修复 **19** 项确定性缺陷（见 `docs/BUSINESS_LOGIC_AUDIT.md` 第七章"修复状态总览"，✅ 项），并为其编写回归测试 `python/tests/test_business_logic_audit_fixes.py`。上述规则表中标注 ✅ 的条目即为已落地并验证通过的业务语义；标注 ⚠️ 待修复的条目为架构/安全级重构，其目标语义已在本文档第 2、4 节明确定义，将作为后续迭代的验收标准。

> **一致性保证**：本文档描述的目标语义与代码修复后的实际行为保持一致；任何后续对 ✅ 项的修改都必须同步更新本文档对应规则编号与边界定义。
