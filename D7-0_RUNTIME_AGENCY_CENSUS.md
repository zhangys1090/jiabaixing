# D7-0: Runtime / Agency Census

**日期**: 2026-09-10
**性质**: 只读审计，未修改任何代码
**目的**: 为D7-1建立source-level基线

---

## A. Production Runtime

### A1. Entry Point

```text
src/main.ts
  ↓ startServer()
  ↓ core = await bootstrap()        [src/server/bootstrap.ts:585]
  ↓ server = http.createServer(app)
  ↓ setupWebSocket(server, core)
  ↓ server.listen(PORT)
```

### A2. Bootstrap Chain

```text
bootstrap()
  ↓ new JiabaixingCore()            [src/core/JiabaixingCore.ts:149]
  ↓ core.initialize()
  ↓   → AgentHarness.initialize()   [src/harness/AgentHarness.ts]
  ↓   → CronJobScheduler.start()    [src/cron/CronJobScheduler.ts:335]
  ↓ new ScenarioAwareScheduler()     [src/core/ScenarioAwareScheduler.ts:90]
  ↓ scenarioScheduler.start()       [30s setInterval tick]
  ↓ initEvolution(core, memoryEngine) [src/server/init/initEvolution.ts]
  ↓   → EvolutionOrchestrator.start()
  ↓   → 5min setInterval quality check
  ↓ Python bridge health check
  ↓ MemoryAuthority.registerBridge()  [E3-1 新增]
  ↓ setupEventBus()
```

### A3. Runtime Loop

```text
HTTP Request / WebSocket Message
  ↓ WsProcessor.processInputOnce()  [src/server/websocket/WsProcessor.ts:61]
  ↓ core.processInput()             [src/core/JiabaixingCore.ts:552]
  ↓   → Python bridge (if available)
  ↓   → OR AgentHarness.processInput()
  ↓   → OR DesktopExecutionAgent.executeViaDecisionAuthority()
```

### A4. Python vs TS Backend

| 条件 | 路径 | Authority经过 |
|------|------|--------------|
| `AGENT_BACKEND=python` (默认) + bridge可用 | `core.processInput()` → `bridge.processInput()` → Python HTTP | ❌ Python端不经过TS Authority |
| `AGENT_BACKEND=python` + bridge不可用 | 降级到 `harness.processInput()` | ✅ 经过TS Authority |
| `AGENT_BACKEND=local` | `harness.processInput()` | ✅ 经过TS Authority |

**⚠️ 关键发现：默认Python backend路径完全绕过TS Authority链。**

### A5. Scheduler Production Instances

| 实例 | 创建位置 | 长期运行 | 频率 |
|------|---------|---------|------|
| ScenarioAwareScheduler | bootstrap.ts:624 | ✅ 是 | 30s setInterval |
| CronJobScheduler | AgentHarness.initialize() | ✅ 是 | 60s setInterval |
| EvolutionOrchestrator定时器 | initEvolution.ts:98 | ✅ 是 | 5min setInterval |
| EvolutionOrchestrator.autoDetection | EvolutionOrchestrator.start() | ✅ 是 | AUTO_DETECTION_INTERVAL_MS |
| EvolutionOrchestrator.optimizationScheduler | EvolutionOrchestrator.startAutoDetection() | ✅ 是 | 10min setInterval |
| OptimizationScheduler.watchAnalysisReport | JiabaixingCore.initialize() | ✅ 是 | 10s fs.watchFile |

**6个长期运行的定时器/调度器实例。**

---

## B. Scheduler Census

### B1. ScenarioAwareScheduler

| 属性 | 值 |
|------|-----|
| 文件 | `src/core/ScenarioAwareScheduler.ts:90` |
| 创建 | `bootstrap.ts:624` → `new ScenarioAwareScheduler()` |
| 启动 | `scenarioScheduler.start()` → 30s setInterval |
| production caller | ✅ bootstrap.ts |
| frequency | 30秒 |
| executes actions? | **⚠️ YES — 通过 `this.llmCore.processInput()`** |

**Scheduler具体做什么：**

```text
读取: DesktopVisionEngine (前台窗口), Git状态, 文件变更(fs.watch)
判断: 环境类型(coding/browser/idle), 用户沉默时间, 文件变更规则匹配
产生: EventBus事件(environment_update, git_status, file_changed, proactive_interaction, scheduled_task_completed)
调用: ⚠️ this.llmCore.processInput() — 4处!
执行: ⚠️ 自然语言任务, auto_fix, run_tests, custom规则动作
写入: task.lastRun, task.nextRun, task.executionCount, fileChangeLog
```

**⚠️ CRITICAL: ScenarioAwareScheduler有4处直接调用`llmCore.processInput()`：**

1. **L715**: 自然语言定时任务 → `this.llmCore.processInput(nlInput)`
2. **L1386**: `auto_fix`规则 → `this.llmCore.processInput("请检查并自动修复")`
3. **L1406**: `run_tests`规则 → `this.llmCore.processInput("请运行相关测试")`
4. **L1430**: `custom`规则 → `this.llmCore.processInput(prompt)`

这些调用**完全绕过DecisionAuthority/ActionAuthority**。

### B2. CronJobScheduler

| 属性 | 值 |
|------|-----|
| 文件 | `src/cron/CronJobScheduler.ts:235` |
| 创建 | `AgentHarness.initialize()` → `CronJobScheduler.getInstance()` |
| 启动 | `cronScheduler.start()` → 60s setInterval |
| production caller | ✅ AgentHarness |
| frequency | 60秒 |
| executes actions? | **🔴 YES — 通过 `child_process.exec()`** |

**CronJobScheduler.runJob()直接执行shell命令：**

```text
L460: const { exec } = await import('child_process');
L478: const child = exec(safeCommand, { timeout, cwd: process.cwd() }, ...)
```

**🔴 CRITICAL: CronJobScheduler完全绕过所有Authority，直接执行系统命令。**

### B3. EvolutionOrchestrator

| 属性 | 值 |
|------|-----|
| 文件 | `src/evolution/EvolutionOrchestrator.ts:123` |
| 创建 | `initEvolution.ts` → `EvolutionOrchestrator.getInstance()` |
| 启动 | `orchestrator.start()` → 多个setInterval |
| production caller | ✅ initEvolution.ts |
| frequency | 5min + autoDetection + 10min optimization |
| executes actions? | ⚠️ 触发优化周期，但E2-3 BLOCK了自修改 |

EvolutionOrchestrator定时触发`triggerOptimizationCycle()`，但：
- `EvolutionEngineV2.executePlan()` 检查 `isAuthorityAvailable()` → 无authority时BLOCK
- `EvolutionOrchestrator` 自身也BLOCK自动自修改

**状态：SAFE（E2-3已闭合），但triggerOptimizationCycle本身仍被定时调用。**

### B4. OptimizationScheduler

| 属性 | 值 |
|------|-----|
| 文件 | `src/core/OptimizationScheduler.ts:29` |
| 创建 | `JiabaixingCore.initialize()` → `new OptimizationScheduler()` |
| 启动 | `watchAnalysisReport()` → 10s fs.watchFile |
| production caller | ✅ JiabaixingCore |
| frequency | 10秒文件变更检测 |
| executes actions? | ❌ NO — 只读取报告，不执行 |

### B5. DesktopAgentLoop

| 属性 | 值 |
|------|-----|
| 文件 | `src/desktop/DesktopAgentLoop.ts:81` |
| 创建 | `DesktopAgentLoop.getInstance()` |
| 启动 | 按需调用，非自动启动 |
| production caller | DesktopExecutionAgent |
| frequency | 按需 |
| executes actions? | ✅ YES — 通过 `this.authority.execute(actions)` |

**DesktopAgentLoop走DesktopActionAuthority → SAFE。**

---

## C. Active Goal

### C1. Goal存储

```text
存储位置: GoalAuthority.goals — Map<string, Goal>
类型: in-memory
持久化: ❌ 无
```

| 属性 | 值 |
|------|-----|
| write location | `GoalAuthority.createGoal()` → `this.goals.set()` |
| read location | `GoalAuthority.getGoal()` → `this.goals.get()` |
| owner | GoalAuthority (singleton) |
| lifetime | 进程生命周期 |
| restart behavior | **❌ 进程重启后所有Goal消失** |

### C2. Goal在生产中被谁创建？

| 调用者 | 文件 | 行号 | 场景 |
|--------|------|------|------|
| OrchestratorAgent | `harness/orchestration/OrchestratorAgent.ts` | L175, L489 | Harness模式 |
| DesktopExecutionAgent | `desktop/DesktopExecutionAgent.ts` | L314 | 桌面任务执行 |

**⚠️ Goal只在用户主动请求时创建。没有任何Scheduler/Daemon创建Goal。**

### C3. Goal在生产中被谁更新？

| 调用者 | 文件 | 行号 | 方法 |
|--------|------|------|------|
| OrchestratorAgent | `harness/orchestration/OrchestratorAgent.ts` | L631 | `updateFromEvidence()` |
| DesktopExecutionAgent | `desktop/DesktopExecutionAgent.ts` | L424, L522 | `updateFromEvidence()` |

### C4. Goal是否可能因LLM停止输出而消失？

**是。** Goal存储在`Map<string, Goal>`中，进程重启即丢失。LLM停止输出不直接删除Goal，但如果进程因任何原因重启，所有Goal消失。

---

## D. Goal Lifecycle

### D1. 状态机（源码证据）

```text
Goal
 ├─ ACTIVE     [初始状态: GoalAuthority.ts:55, createGoal()]
 ├─ PAUSED     [枚举存在: types.ts:16, 但无pauseGoal()方法]
 ├─ COMPLETED  [GoalAuthority.ts:209, markCompleted(); 或updateFromEvidence()中progress>=1自动完成]
 └─ ABANDONED  [GoalAuthority.ts:222, markAbandoned()]
```

### D2. 状态转换方法

| 方法 | 文件:行 | 存在 | production caller |
|------|---------|------|-------------------|
| `createGoal()` | GoalAuthority.ts:49 | ✅ | OrchestratorAgent, DesktopExecutionAgent |
| `updateFromEvidence()` | GoalAuthority.ts:128 | ✅ | OrchestratorAgent, DesktopExecutionAgent |
| `markCompleted()` | GoalAuthority.ts:208 | ✅ | ❌ 无production caller |
| `markAbandoned()` | GoalAuthority.ts:221 | ✅ | ❌ 无production caller |
| `replan()` | GoalAuthority.ts:233 | ✅ | ❌ 无production caller |
| `evaluateStatus()` | GoalAuthority.ts:244 | ✅ | ❌ 无production caller |
| `updateStage()` | GoalAuthority.ts:201 | ✅ | ❌ 无production caller |
| `pauseGoal()` | — | ❌ 不存在 | — |
| `resumeGoal()` | — | ❌ 不存在 | — |

### D3. 关键发现

1. **`markCompleted()`和`markAbandoned()`没有production caller** — Goal永远不会被显式完成或放弃
2. **`replan()`没有production caller** — Replan功能存在但从未被调用
3. **`evaluateStatus()`没有production caller** — Goal状态评估从未被触发
4. **没有`pauseGoal()`/`resumeGoal()`** — PAUSED状态无法进入

> Goal是否存在明确的completion / abandonment authority？
> **❌ 否。方法存在但无production caller。Goal只能通过updateFromEvidence()中progress>=1自动完成。**

---

## E. World Observation

### E1. 已实现的World Observer

| observer | source | detects | production caller | output |
|----------|--------|---------|-------------------|--------|
| ScenarioAwareScheduler.senseEnvironment() | DesktopVisionEngine | 前台窗口、进程名 | ✅ bootstrap启动 | EventBus `environment_update` |
| ScenarioAwareScheduler.scanGitRepos() | git CLI | 分支、commit、uncommitted | ✅ 30min间隔 | EventBus `git_status` |
| ScenarioAwareScheduler.startFileWatching() | fs.watch | 文件创建/修改/删除 | ✅ bootstrap启动 | EventBus `file_changed` |
| ScenarioAwareScheduler.getProactiveTriggers() | lastUserActivity | 用户沉默30min+ | ✅ 90s间隔 | EventBus `proactive_interaction` |
| OptimizationScheduler.watchAnalysisReport() | fs.watchFile | feedback报告变更 | ✅ JiabaixingCore | applyOptimizationsFromReport() |

### E2. 当前Jiabaixing是否能够发现"世界发生变化"？

**✅ 是。** ScenarioAwareScheduler已经实现了：
- 桌面环境变化检测（前台窗口切换）
- Git仓库变化检测
- 文件变更检测（fs.watch）
- 用户沉默检测

**但：这些观察结果只emit EventBus事件，不连接到Goal<GoalAuthority。**

---

## F. Goal Impact

### F1. World Change → Goal Impact

```text
MISSING
```

当前不存在任何代码将World Change映射到Goal Impact。

- `file_changed`事件 → 只触发`executeRuleAction()`（auto_fix/run_tests/custom）
- `environment_update`事件 → 无消费者
- `git_status`事件 → 无消费者
- `proactive_interaction`事件 → 无消费者

**没有任何EventBus事件的handler会检查"这个变化是否影响某个Active Goal"。**

---

## G. Replan

### G1. Replan现状

| 问题 | 答案 |
|------|------|
| 是否存在真正production replan？ | ❌ 否。`GoalAuthority.replan()`无production caller |
| replan是否只是函数存在但没人调用？ | ✅ 是 |
| replan是否可以修改Goal identity？ | ❌ 否。只增加planVersion |
| replan是否增加planVersion？ | ✅ 是。`goal.planVersion += 1` |
| replan后是否必须重新进入DecisionAuthority？ | ⚠️ 未定义。replan()只改planVersion，不触发Decision |

### G2. Scheduler → Planner → Action路径

```text
ScenarioAwareScheduler
  ↓ file_changed
  ↓ executeRuleAction()
  ↓ auto_fix / run_tests / custom
  ↓ this.llmCore.processInput()

⚠️ POSSIBLE AUTHORITY BYPASS
```

这是当前唯一的Scheduler→Action路径，绕过DecisionAuthority。

---

## H. DecisionAuthority Connection

### H1. Scheduler → DecisionAuthority

```text
NO PRODUCTION LINK
```

ScenarioAwareScheduler **不读取** GoalAuthority。
ScenarioAwareScheduler **不调用** DecisionAuthority.decide()。
CronJobScheduler **不调用** DecisionAuthority。
EvolutionOrchestrator **不调用** DecisionAuthority.decide()（只检查isAuthorityAvailable）。

### H2. 谁调用DecisionAuthority.decide()？

| 调用者 | 文件 | 场景 |
|--------|------|------|
| OrchestratorAgent | `harness/orchestration/OrchestratorAgent.ts:191,487` | Harness模式 |
| DesktopExecutionAgent | `desktop/DesktopExecutionAgent.ts:310` | 桌面任务执行 |

**DecisionAuthority只在用户主动请求时被调用。Scheduler从不触发Decision。**

---

## I. ActionAuthority Connection

### I1. Scheduler → ActionAuthority

| Scheduler | 路径 | 分类 |
|-----------|------|------|
| ScenarioAwareScheduler | → `llmCore.processInput()` → Python bridge / Harness | **BYPASS** |
| CronJobScheduler | → `child_process.exec()` | **BYPASS** |
| EvolutionOrchestrator | → `triggerOptimizationCycle()` → E2-3 BLOCK | **SAFE** |
| OptimizationScheduler | → 只读取报告 | **SAFE** |
| DesktopAgentLoop | → `authority.execute(actions)` | **DECISION_MEDIATED** |

### I2. 完整Scheduler→Action路径

```text
路径1: ScenarioAwareScheduler → llmCore.processInput() → Python bridge
  分类: BYPASS
  危险度: ⚠️ HIGH — 自然语言任务、auto_fix、run_tests、custom

路径2: CronJobScheduler → child_process.exec()
  分类: BYPASS
  危险度: 🔴 CRITICAL — 直接执行shell命令，无任何authority检查

路径3: DesktopAgentLoop → DesktopActionAuthority.execute()
  分类: DECISION_MEDIATED
  危险度: SAFE
```

---

## J. Evidence / Learning Feedback

### J1. Evidence回流链

```text
DesktopExecutionAgent.executeViaDecisionAuthority()
  ↓ DecisionAuthority.decide()
  ↓ DesktopActionAuthority.execute()
  ↓ 观察结果
  ↓ GoalAuthority.updateFromEvidence()
  ↓ LearningAuthority.learn() (内部调用)
  ↓ BeliefUpdate → goal.metadata['learning_xxx']
```

**状态：COMPLETE（在DesktopExecutionAgent路径中）**

### J2. Harness路径

```text
OrchestratorAgent
  ↓ DecisionAuthority.decide()
  ↓ 执行
  ↓ GoalAuthority.updateFromEvidence()
  ↓ LearningAuthority.learn() (内部调用)
```

**状态：COMPLETE（在OrchestratorAgent路径中）**

### J3. Python Backend路径

```text
core.processInput() → bridge.processInput() → Python HTTP
  ↓
❌ 不经过TS GoalAuthority
❌ 不经过TS LearningAuthority
❌ Evidence回流在Python端，TS端不可见
```

**状态：MISSING（Python backend路径无Evidence回流到TS Authority）**

---

## K. Autonomous Continuation Chain

```text
Active Goal          ⚠️ implemented (GoalAuthority), 但无Scheduler读取
Scheduler tick       ✅ production (ScenarioAwareScheduler 30s)
Goal observation     ❌ Scheduler不读取GoalAuthority
World observation    ✅ production (env/git/file/user silence)
Goal impact          ❌ MISSING — World Change不映射到Goal
Replan event         ❌ MISSING — repl5an()无caller，无ReplanEvent
DecisionAuthority    ❌ Scheduler不调用DecisionAuthority.decide()
ActionAuthority      ❌ Scheduler绕过ActionAuthority (走llmCore.processInput)
Observation          ⚠️ Desktop3DreVisionEngine存在，但Scheduler不消费
Evidence             ⚠️ updateFromEvidence存在，但Scheduler不触发
Goal progress        ⚠️ progress字段存在，但无Scheduler检查
Learning             ⚠️ LearningAuthority.learn存在，但Scheduler不触发
Next tick            ✅ setInterval循环存在
```

---

## L. Authority Bypass Census

### L1. 🔴 CRITICAL: CronJobScheduler → child_process.exec()

```text
文件: src/cron/CronJobScheduler.ts:460
调用: const { exec } = await import('child_process');
      const child = exec(safeCommand, ...)
绕过: DecisionAuthority, ActionAuthority, GoalAuthority, MemoryAuthority
触发: 用户通过API注册cron job → AgentHarness.initialize()自动启动
危险: 任何注册的cron job直接执行shell命令，无authority审计
```

**CRITICAL D7 AUTHORITY BYPASS**

### L2. ⚠️ HIGH: ScenarioAwareScheduler → llmCore.processInput()

```text
文件: src/core/ScenarioAwareScheduler.ts
调用点:
  L715:  自然语言定时任务 → this.llmCore.processInput(nlInput)
  L1386: auto_fix规则 → this.llmCore.processInput("请检查并自动修复")
  L1406: run_tests规则 → this.llmCore.processInput("请运行相关测试")
  L1430: custom规则 → this.llmCore.processInput(prompt)
绕过: DecisionAuthority, ActionAuthority
触发: 30s定时tick + 文件变更规则匹配
危险: Scheduler可以自动触发LLM执行任意任务
```

**CRITICAL D7 AUTHORITY BYPASS**

### L3. ⚠️ HIGH: MemoryEngineBridge — Python不可用时静默降级

```text
文件: src/memory/MemoryEngineBridge.ts:137-138
行为: Python不可用时返回空id MemoryItem，不报错
违反: fail-closed原则
对比: MemoryAuthority在Python不可用时返回failed_closed
```

**⚠️ D7 MEMORY SILENT DEGRADATION**

### L4. ⚠️ MEDIUM: Python Backend路径绕过TS Authority

```text
文件: src/core/JiabaixingCore.ts:576
行为: AGENT_BACKEND=python时，core.processInput() → bridge.processInput()
绕过: TS DecisionAuthority, GoalAuthority, LearningAuthority, MemoryAuthority
现状: Python端有自己的authority实现，但TS端不可见
```

**⚠️ D7 CROSS-BOUNDARY AUTHORITY GAP**

### L5. ✅ SAFE: EvolutionOrchestrator

```text
E2-3 BLOCK: EvolutionEngineV2.executePlan()检查isAuthorityAvailable()
EvolutionOrchestrator自身也BLOCK自动自修改
状态: SAFE
```

### L6. ✅ SAFE: DesktopAgentLoop

```text
DesktopAgentLoop → DesktopActionAuthority.execute()
状态: DECISION_MEDIATED, SAFE
```

---

## M. D7-1 Exact Missing Pieces

只列源码层面真实缺口：

### M1. Scheduler不读取GoalAuthority

```text
缺口: ScenarioAwareScheduler无GoalAuthority引用
证据: grep "GoalAuthority" src/core/ScenarioAwareScheduler.ts → 无结果
影响: Scheduler无法知道有哪些Active Goal，无法判断"事情没做完"
```

### M2. World Change不映射到Goal Impact

```text
缺口: 无GoalImpact计算
证据: grep "GoalImpact|goalImpact|affectedGoal" src/ → 无结果
影响: 文件变更/环境变化不会触发"这个Goal需要replan"
```

### M3. ReplanEvent不存在

```text
缺口: 无ReplanEvent类型和emit
证据: grep "ReplanEvent" src/ → 无结果
影响: 即使检测到Goal需要replan，也无法emit事件通知
```

### M4. Goal无持久化

```text
缺口: GoalAuthority.goals是Map<string, Goal>，纯内存
证据: src/authority/GoalAuthority.ts:37 — private readonly goals: Map<string, Goal>
影响: 进程重启后所有Goal丢失，无法实现"长期存在的主体"
```

### M5. Goal lifecycle方法无production caller

```text
缺口: markCompleted/markAbandoned/replan/evaluateStatus 无production caller
证据: grep显示只在测试中调用
影响: Goal永远不会被显式完成/放弃/replan
```

### M6. Scheduler→Action Authority Bypass

```text
缺口: ScenarioAwareScheduler直接调用llmCore.processInput()
证据: src/core/ScenarioAwareScheduler.ts L715, L1386, L1406, L1430
影响: Scheduler自动执行绕过DecisionAuthority
```

---

## N. Production Proof Gaps

| gap | 当前状态 | 需要什么 |
|-----|---------|---------|
| real Python bridge | E3-1 bridge注册代码存在(bootstrap.ts) | 真实启动后确认registerBridge()被调用 |
| real startup | bootstrap()链完整 | 端到端启动测试 |
| real scheduler | ScenarioAwareScheduler在bootstrap中启动 | 确认30s tick正常运行 |
| real goal persistence | ❌ 纯内存 | 需要持久化方案 |
| real authority replay | E3-2测试通过 | 真实任务端到端replay |

---

## O. D7-1 禁止修改项

以下模块**此次不能碰**：

```text
❌ GoalAuthority.ts          — 不改接口，只加调用者
❌ DecisionAuthority.ts      — 不改接口
❌ ActionAuthority.ts        — 不改接口
❌ MemoryAuthority.ts        — 不改接口
❌ LearningAuthority.ts      — 不改接口
❌ StateAuthority.ts         — 不改接口
❌ SelfModificationEngine.ts — 不改接口
❌ types.ts                  — 不改Goal/Decision/Evidence类型
❌ EvolutionOrchestrator.ts  — 不改E2-3闭合
❌ EvolutionEngineV2.ts      — 不改E2-3闭合
```

D7-1只允许**新增**：

```text
✅ ScenarioAwareScheduler中新增Goal观察逻辑（只读GoalAuthority）
✅ 新增ReplanEvent类型
✅ 新增GoalImpact计算（纯函数，无副作用）
✅ 新增EventBus handler（只emit事件，不执行action）
✅ 新增Goal持久化（如果需要）
```

---

## P. 总结

### P1. 当前Jiabaixing的"自主性"现状

```text
✅ 能观察世界 (env/git/file/user silence)
✅ 能做决策 (DecisionAuthority, 但只在用户请求时)
✅ 能执行动作 (ActionAuthority, 但只在DecisionAuthority之后)
✅ 能学习 (LearningAuthority, 但只在Evidence回流时)
✅ 能记忆 (MemoryAuthority, 但生产中MemoryEngineBridge绕过它)

❌ 不知道自己有未完成的Goal (Scheduler不读GoalAuthority)
❌ 不知道世界变化是否影响Goal (无GoalImpact)
❌ 不会主动replan (replan()无caller)
❌ 不会自主继续 (无Active Goal → Scheduler → Decision循环)
```

### P2. Authority Bypass现状

```text
🔴 CronJobScheduler → child_process.exec()     CRITICAL
⚠️ ScenarioAwareScheduler → llmCore.processInput()  HIGH (4处)
⚠️ MemoryEngineBridge → 静默降级               MEDIUM
⚠️ Python backend → 绕过TS Authority           MEDIUM
```

### P3. D7-1需要做的（精确边界）

```text
D7-1 ONLY:
  1. ScenarioAwareScheduler新增Goal观察（只读GoalAuthority.getActiveGoals()）
  2. 新增GoalImpact计算（World Change → 是否影响Active Goal）
  3. 新增ReplanEvent emit（只emit，不执行）
  4. 修复ScenarioAwareScheduler的llmCore.processInput() bypass
  5. Goal持久化（最小方案：JSON文件或Python memory）

D7-1 FORBIDDEN:
  ❌ 自动执行任何action
  ❌ 自动调用任何tool
  ❌ 自动触发桌面操作
  ❌ 自动触发自修改
  ❌ 修改任何Authority接口
```
