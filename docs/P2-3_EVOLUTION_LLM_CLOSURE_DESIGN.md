# P2-3 收口设计：TS `src/llm` + `src/evolution` 与 Python 主实现对齐

> 状态：设计评审稿 + 部分落地（2026-08-03）
> 关联：审计文档 `Agent_Comprehensive_Audit_2026-08-01.md` §3.3 P2-3（原标 🟡 待专项轮）
> 架构约束：`AGENTS.md` §0.1（LLM 调用/路由/缓存、进化引擎 **必须** Python 主实现；TS 仅 HTTP/WS 入口路由，禁止独立实现）

---

## 0. 执行摘要（先纠偏）

**P2-3 的实际性质与审计文档定性有出入，必须先澄清：**

| 目录 | 审计定性 | 实测真实状态 | 结论 |
|---|---|---|---|
| `src/llm` | "TS 独立 LLM 实现，§0.1 违规" | 仅含 **prompt 模板 / token 预算 / 模型能力探测 / 流式响应处理** 四类**辅助工具**；**无 Provider/Cache/Router 调用实现**；全 `src/` **零外部 import**、**零测试依赖** → 已是 orphan | **不构成 §0.1 违规**（§0.1 禁的是"独立 LLM Provider/Cache/Router"，不是辅助工具）。作为死代码清理即可 |
| `src/evolution` | "TS 独立进化引擎，§0.1 违规" | 含真实 `EvolutionOrchestrator`（V1，31KB）+ `EvolutionEngineV2`（`SelfModificationEngine` 会**直接改文件**）。被 `JiabaixingCore`/`WsProcessor`/harness/多条路由/`initEvolution.ts` 等 **12+ 处**实例化。**这才是真正的 §0.1 违规** | 需收口：python 默认模式下禁止 TS 自进化引擎启动写文件，改走 Python bridge |

**关键发现：架构其实已基本迁移，问题是一个"漏网"的判断分支。**

- `AGENT_BACKEND=python` 已是默认值（`JiabaixingCore.ts:229/562-566`，TS local 标"已废弃"）；生产路径本就走 `PythonAgentBridge`。
- `PythonAgentBridge` **早已具备** evolution 委派：`getEvolutionStatus→/v1/evolution/status`、`triggerEvolution→/v1/evolution/trigger`、`getEvolutionMetrics`/`getEvolutionInsights`/`postEvolutionFeedback`，以及全套 `llmChat*`。
- `python/agent/api/evolution.py` + `compat.py` 已暴露全套 `/api/evolution/*` 端点；`python/agent/api/llm.py` + `openai_compat.py` 暴露 `/api/llm/*` 与 `/v1/chat/completions`。
- `initEvolution.ts:52` 注释已承认"权重来源已从 TS EvolutionEngine 迁移到 Python 后端"，且 `syncEvolutionWeights` 已调 `bridge.getEvolutionMetrics()`。
- **但 `initEvolution.ts` 没有像 `JiabaixingCore.initialize()`（228-239 行）那样做 `isPythonBackend()` 判断**，仍在 python 默认模式下 `new EvolutionEngineV2(...)` 并 `orchestrator.start()` → **TS 在默认 python 模式下仍自写文件**，违反 §0.1 最危险的一条。

---

## 1. 收口目标

1. **`src/evolution`**：python 默认模式下，**TS 自进化引擎（会写文件）绝不启动**；所有进化执行/数据走 Python 后端（`PythonAgentBridge` → `/api/evolution/*`）。TS 引擎仅作为 `AGENT_BACKEND=local` 的**废弃回退存根**保留（文件不删，因 `EvolutionEngineV2.test.ts` 依赖）。
2. **`src/llm`**：作为已确认 orphan 的死代码删除，消除误导性的 §0.1 标记（其本身不构成违规）。
3. **调用点收敛（后续阶段，非本轮硬改）**：`src/evolution` 的 12+ 处只读调用点（status/metrics/insights）逐步改为直接查 Python bridge，彻底移除对 TS `EvolutionOrchestrator` 单例的数据依赖。本轮先保证"python 模式下不写文件、不双重进化"，调用点读取降级为 TS 本地空数据（真实数据在 Python），属可接受退化。

---

## 2. 实现方案

### 2.1 `initEvolution.ts` 门控（核心修复，本轮落地）

复用 `JiabaixingCore.ts:228-230` 与 `WsProcessor.ts:137-141` 的同一 `isPythonBackend()` 判定模式：

```ts
const isPythonBackend =
  (process.env.AGENT_BACKEND ?? 'python') === 'python' &&
  !!core?.getPythonBridgeResolver?.();
```

- **`isPythonBackend === true`（默认）**：
  - **不** `new EvolutionEngineV2(...)`（SelfModificationEngine 写文件 → 禁止）。
  - **不** `orchestrator.start()`、**不**启动 TS V2 触发循环。
  - **保留** `syncEvolutionWeights` 定时任务（它本就走 `bridge.getEvolutionMetrics()` 拉取 Python 权重注入 TS 工具可靠性追踪器）——这是 python 模式下 TS 侧唯一需要的进化相关行为。
  - 打印弃用日志，指向 Python 后端。
- **`isPythonBackend === false`（`AGENT_BACKEND=local`，废弃路径）**：保留现有完整 TS 引擎初始化（作为回退存根），但顶部加 `Logger.warn` 弃用提示。

### 2.2 `src/evolution` 弃用标注（本轮落地）

- `src/evolution/index.ts`：在已存在的"V1 已 deprecated"注释基础上，给 `EvolutionEngineV2`/`EvolutionRollback`/`SelfModificationEngine`/`EvolutionPlanner` 加 `@deprecated` JSDoc，明确"Python `agent.evolution` 为主实现，本模块仅 local 回退"。
- `src/evolution/EvolutionOrchestrator.ts`：类上加 `@deprecated` JSDoc，说明 python 模式下由 `PythonAgentBridge` 接管。
- 不改变任何公共方法签名，保证 12+ 调用点与 `EvolutionEngineV2.test.ts` 编译通过。

### 2.3 `src/llm` 删除（本轮落地）

- 仓级扫描确认 `src/llm` 仅被 `dist/`（编译产物）与 `coverage/lcov.info` 引用，无任何 `.ts` 源文件 import（含测试）。
- 删除 `src/llm/` 整个目录（index.ts + 5 个辅助工具 + prompt-templates.ts）。
- 重新 `tsc --noEmit` 验证无新增错误。

### 2.4 调用点收敛（后续阶段，建议独立风险评审）

将下列调用点从 `EvolutionOrchestrator.getInstance()` 改为 `PythonAgentBridge` 对应方法，彻底消除 TS 引擎数据依赖：

- `src/core/JiabaixingCore.ts:158/162/202`
- `src/server/websocket/WsProcessor.ts:170`
- `src/harness/orchestration/OrchestratorAgent.ts:718`
- `src/harness/loops/FeedbackLoops.ts:137`
- `src/server/routes/systemStateRoutes.ts:490`
- `src/server/routes/evolutionRoutes.ts`（8 处）
- `src/server/bootstrap.ts:290`
- `src/server/init/initHarness.ts:1011`

> 此项改动面广、需运行时验证 Python 端点契约，故列为**后续专项轮**，不在本轮硬改（避免无运行时验证下的回归风险）。

---

## 3. 验证计划

| 验证项 | 方法 | 通过标准 |
|---|---|---|
| TS 编译 | `npx tsc --noEmit -p tsconfig.json` | 无因本次改动新增的错误 |
| `src/llm` 删除无遗漏引用 | 删除后 `grep -rn "src/llm" src/` | 零命中 |
| `initEvolution` 门控逻辑 | 静态走查 + `AGENT_BACKEND=python`/`local` 两分支 | python 下不出现 `new EvolutionEngineV2`；local 下保留 |
| `EvolutionEngineV2.test.ts` 仍编译 | `tsc` 通过即证 | 类型可解析 |
| 红线 | `python scripts/check_static_defects.py` + `check_import_scan.py` | 仍 PASS（仅改 TS，不影响） |

---

## 4. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| python 模式下进化"无触发"导致能力退化的观感 | 低 | 真实进化执行/数据在 Python 后端；TS 仅不再自写文件。需在文档与监控中明确"进化已迁 Python" |
| `syncEvolutionWeights` 依赖 `core.getPythonBridgeResolver()` 可用性 | 低 | 已有 `if (!bridge) return` 保护；bridge 不可用时静默跳过 |
| 删除 `src/llm` 误伤（隐藏动态引用） | 极低 | 仓级 grep 已证零源引用；`tsc` 二次确认 |
| 12 调用点收敛引入回归 | 中 | 列为后续专项轮，本轮不碰；当前调用点在 python 模式下读取本地空数据，属可接受降级 |

---

## 5. 落地状态（2026-08-03）

- [x] §2.1 `initEvolution.ts` 门控（python 默认不启动 TS 自进化引擎）
- [x] §2.2 `src/evolution` `@deprecated` 标注
- [x] §2.3 `src/llm` 删除
- [x] §3 编译验证通过
- [ ] §2.4 调用点收敛（后续专项轮，需风险评审 + 运行时验证）

> 审计文档 P2-3 由 🟡 待专项轮 → **✅ 已实现（门控+弃用+清理）/ 🟡 调用点收敛待专项轮**。
