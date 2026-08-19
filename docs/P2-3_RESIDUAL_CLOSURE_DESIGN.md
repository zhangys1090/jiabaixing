# P2-3 残留项收口设计稿（本地 LLM Provider 桥壳化 + 12 调用点收敛）

> 版本: 1.0 | 日期: 2026-08-03（接续 P2-3 第一轮 `initEvolution` 门控）
> 目标: 彻底消除 `AGENT_BACKEND=python` 默认模式下 TS 侧仍「实例化 / 运行」Agent 核心（LLM 客户端、进化编排器）的残留漏点，使架构符合 `AGENTS.md` §0.1「Python 主实现、TS 仅桥接」。

---

## 0. 现状事实核查（动手前）

### 0.1 第一轮已收口（2026-08-03 早些）
- `src/server/init/initEvolution.ts` 已加 `isPythonBackend()` 门控：python 模式**不** `new EvolutionEngineV2`、不 `orchestrator.start()`、不跑 TS V2 触发循环。
- `src/evolution/EvolutionOrchestrator.ts`、`EvolutionEngineV2.ts`、`index.ts` 已加 `@deprecated`（local 回退）。
- `src/llm/` 目录已删除（辅助工具，非 §0.1 违项）。

### 0.2 本轮残留漏点（python 模式仍触达 TS 核心）
1. **本地 LLM Provider 仍被实例化**：`LLMProviderBridge` 构造函数无条件 `new OpenAICompatibleModel(...)`（及智谱降级模型），即便 `getActivePythonBridge()` 可用。python 模式虽经 bridge 委派真实调用，但 TS 本地 LLM 客户端仍被构造（属 §0.1 残留实现足迹）。
2. **12 处 `EvolutionOrchestrator.getInstance()`** 中，除 `initEvolution.ts`（已在 local 分支）与 `bootstrap.ts:292`（`evolution.status` 已门控）外，**7 个文件 11 处**在 python 模式仍会实例化 TS 编排器：
   - `JiabaixingCore.ts:202`（字段赋值，私有未读）
   - `WsProcessor.ts:170` / `OrchestratorAgent.ts:718` / `FeedbackLoops.ts:137`（均 `recordInteraction`）
   - `systemStateRoutes.ts:490`（getUnifiedMetrics）
   - `evolutionRoutes.ts:85,98,115,146,168,190`（metrics + trigger*）
   - `initHarness.ts:1011`（getEvolutionStats）

### 0.3 bridge 已具备的委派方法（`src/ide/PythonAgentBridge.ts`）
- `getEvolutionStatus()` → GET /v1/evolution/status
- `getEvolutionMetrics()` → GET /v1/evolution/metrics
- `getInsights()` → GET /v1/evolution/insights
- `triggerEvolution()` → POST /v1/evolution/trigger
- `submitFeedback(feedback)` → POST /v1/evolution/feedback
- LLM: `llmChat / llmChatWithTools / llmStreamChat / llmHealthCheck / llmGetModelName / llmMarkUnavailable / llmResetAvailability / multimodal* / code* / devGenerateCode`

---

## 1. 残留项 1：本地 LLM Provider 桥壳化

### 1.1 设计
- 新增 `src/models/PythonBackedModel.ts`：实现 `Model` 接口，**不持有任何本地 LLM 客户端**。`generate/stream/chat` 经 `getActivePythonBridge()` 委派 Python `agent.llm`；`initialize/shutdown` 为 no-op；`isCircuitOpen` 返回 false。作为 python 模式下 `LLMProviderBridge.this.model` 的占位，满足 `Model` 契约。
- 修改 `src/models/LLMProviderBridge.ts` 构造函数：当 `getActivePythonBridge()` 可用且**未显式注入外部 model** 时，用 `new PythonBackedModel(modelName)` 替代 `new OpenAICompatibleModel(...)`；`zhipuModel` 置 null；`initialize()` 跳过 zhipu 初始化。`serviceAvailable` 在 python 模式直接置 true。
- 给 `OpenAICompatibleModel` 类与 `src/models/transports/*`（5 文件）加 `@deprecated`：标注「AGENT_BACKEND=python 经 PythonAgentBridge 委派；仅 local 回退」。

### 1.2 不改动范围（本轮外，记录为观察项）
- `MultiModelProvider.ts:93`、`MultiModelLLMProviderBridge.ts:210`、`ModelManager.ts:115` 仍 `new OpenAICompatibleModel`。这些是多模型路由/管理实现，非主聊天路径；python 模式是否实例化取决于其上游调用链，留作后续专项（不扩大本轮爆炸半径）。
- ✅ **已于 2026-08-03 收口（C 项）**：上述三处 + `ModelInterface.ts` 的 `ModelFactory.createModel` 第 4 处站点，统一加 `if (getActivePythonBridge()) return new PythonBackedModel(...)` 门控，python 模式不再实例化 `OpenAICompatibleModel`；local 模式回退不变。详见 §5。

### 1.3 风险与验证
- `PythonBackedModel` 永不在 python 模式执行真实本地 LLM 调用（所有高层方法已被 bridge 拦截），仅作为占位；`selectModel().generate()` 即便被调用也会经 bridge 委派，不会抛「未实现」。
- 验证：`tsc --noEmit` 0 errors；无法在本机跑真实 Python 后端 E2E，需 K8s/本地联调 smoke test。

---

## 2. 残留项 2：11 处调用点收敛到 PythonAgentBridge

### 2.1 通用模式
每个调用点改为：
```ts
const bridge = getActivePythonBridge();
if (bridge) {
  // python 模式：经 bridge 委派 Python agent.evolution；不触碰 TS EvolutionOrchestrator
  return await bridge.<对应方法>(...);   // 只读/触发
  // 或 void bridge.submitFeedback({ kind:'interaction', ... }).catch(()=>{}); // recordInteraction
}
const orchestrator = EvolutionOrchestrator.getInstance();
// ... 原 local 逻辑 ...
```

### 2.2 调用点映射表

| # | 文件:行 | 原 orchestrator 方法 | python 模式委派 | 类型 |
|---|---------|----------------------|------------------|------|
| 1 | JiabaixingCore:202 | `getInstance()`（字段） | python 模式不赋值（字段改 `EvolutionOrchestrator \| null`，无内部读引用） | 字段 |
| 2 | WsProcessor:170 | `recordInteraction` | `bridge.submitFeedback({kind:'interaction',...})`（fire-and-forget） | 写(信号) |
| 3 | OrchestratorAgent:718 | `recordInteraction` | 同上 | 写(信号) |
| 4 | FeedbackLoops:137 | `recordInteraction` | 同上 | 写(信号) |
| 5 | systemStateRoutes:490 | `getUnifiedMetrics()` | `bridge.getEvolutionMetrics()`（defensive map） | 读 |
| 6 | evolutionRoutes:85 | `getUnifiedMetrics()` | `bridge.getEvolutionMetrics()` | 读 |
| 7 | evolutionRoutes:98 | `triggerOptimizationCycle` | `bridge.triggerEvolution()` | 触发 |
| 8 | evolutionRoutes:115 | `triggerOptimizationCycle` | `bridge.triggerEvolution()` | 触发 |
| 9 | evolutionRoutes:146 | `triggerOptimizationCycleWithVerification` | `bridge.triggerEvolution()` | 触发 |
| 10 | evolutionRoutes:168 | `triggerOptimizationCycleWithVerification` | `bridge.triggerEvolution()` | 触发 |
| 11 | evolutionRoutes:190 | `triggerOptimizationCycleWithVerification` | `bridge.triggerEvolution()` | 触发 |
| 12 | initHarness:1011 | `getUnifiedMetrics()`（getEvolutionStats） | `bridge.getEvolutionMetrics()`（改 async） | 读 |

### 2.3 特殊点
- **`bootstrap.ts:292`**：已在 `evolution.status` case 的 `else`（local）分支内，python 走 `pythonBridge!.getEvolutionStatus()`，**无需改**。
- **`initHarness.getEvolutionStats`**：原为 sync `() => {...}`，被 `system_status.ts:127` 同步消费。改为 `async () => {...}`：python 模式 `await bridge.getEvolutionMetrics()`；local 模式 `orchestrator.getUnifiedMetrics()`。同步更新 `SystemStatusDeps` 接口（`getEvolutionStats: () => Promise<Record<string, unknown>>`）与调用点 `await deps.getEvolutionStats()`。

### 2.4 风险与验证
- python 模式**永不**调用 `EvolutionOrchestrator.getInstance()` → TS 进化引擎完全休眠，彻底满足 §0.1。
- `recordInteraction` 在 python 模式转发为 `submitFeedback`（Python 进化引擎自有遥测，TS 不再双写）。
- `triggerEvolution` 不含 `reason`/`verification` 语义差异，python 侧为权威实现，TS 触发端点仅做转发。
- 验证：`tsc --noEmit` 0 errors；后端决策锁定（`isPythonBackend()`）保证不运行时漂移。

---

## 3. 验证清单
- [ ] `tsc --noEmit` → 0 errors（两项残留全改完）
- [ ] `python/scripts/check_static_defects.py` 与 `check_import_scan.py` 仍全绿（仅改 TS）
- [ ] 文档同步：`Agent_Comprehensive_Audit_2026-08-01.md` P2-3 标 ✅ 完成
- [ ] 本机无 Python 后端，无法 E2E；建议 K8s/本地联调 smoke test（chat + /api/evolution/status + 手动触发进化）

## 4. 残留观察（本轮外）
- ~~`MultiModelProvider` / `MultiModelLLMProviderBridge` / `ModelManager` 仍可能实例化 `OpenAICompatibleModel`（多模型路由路径），建议下一轮统一桥壳化。~~ ✅ **已完成（C 项，2026-08-03）**：4 处站点全部门控为 `PythonBackedModel`，见 §5。
- `OpenAICompatibleModel` 的 `@deprecated` 仅为标注；其实现仍被 local 模式使用，不删除。

---

## 5. C 项收口：多模型 Provider/Manager 桥壳化（2026-08-03）

**目标**：消除最后一处 TS 实例化本地 LLM 客户端（`OpenAICompatibleModel`）的可能——即便多模型路由/管理路径在 python 模式被触达，也只走 `PythonBackedModel` 占位壳，经 `PythonAgentBridge` 委派 Python `agent.llm`。

### 5.1 改动清单（4 处 `new OpenAICompatibleModel` 站点）
| # | 文件 | 站点 | 门控后 python 模式 | local 模式 |
|---|------|------|---------------------|-----------|
| 1 | `src/core/ModelInterface.ts` | `ModelFactory.createModel` (case `openai`/`openai_compatible`) | `new PythonBackedModel(config.modelName)` | `new OpenAICompatibleModel(config)` |
| 2 | `src/models/MultiModelProvider.ts` | `createModel(config)` | `new PythonBackedModel(config.model)` | `new OpenAICompatibleModel({...})` |
| 3 | `src/models/MultiModelLLMProviderBridge.ts` | `registerModel(name, config)` | `new PythonBackedModel(name)` | `new OpenAICompatibleModel({...})` |
| 4 | `src/models/ModelManager.ts` | `registerDefaultModels()` | `new PythonBackedModel(llmModel)` 并 `initialize()` 后 `return` | 原 local 注册逻辑 |

- 配套：`MultiModelProvider` 的 `instances: Map<string, Model>`、`getModelsForInput` 返回类型、`executeWithFallback` 的 `operation` 参数类型由 `OpenAICompatibleModel` 改为 `Model`（消除 TS2740）。
- 门控统一用 `getActivePythonBridge()`（`src/ide/bridgeRegistry.ts`），与 P2-3 §1 同源。

### 5.2 验证
- ✅ `tsc --noEmit` → 0 errors（`MultiModelProvider.ts` 由 `Model` 类型承载，`PythonBackedModel` 满足 `Model` 契约）。
- ✅ 单测 `tests/unit/models/pythonModeBridgeShell.test.ts` → 6/6（python 模式 4 站点均返回 `PythonBackedModel` 且非 `OpenAICompatibleModel`；local 模式回退 `OpenAICompatibleModel`）。
- ✅ 联调脚本 `scripts/e2e_smoke_python_backend.sh` 就绪（验证 TS 网关 + Python 后端 + 进化状态 + orchestrator optimize + chat 闭环）；本机 Python 后端因 `agent` 包未装入 venv（`PYTHONPATH` 问题）未实跑，留待联调/K8s 环境执行。
- 注意：运行单测时若开启全局覆盖率阈值会报「coverage threshold not met」（`JEST_EXIT=1`），此为单文件隔离运行产物，**测试本身全绿**；以 `--coverage=false` 验证 EXIT=0。
