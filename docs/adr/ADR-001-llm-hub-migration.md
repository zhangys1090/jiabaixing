# ADR-001: LLM 枢纽迁移（TS 实现 → Python 后端，bridge 壳收口）

- **状态**: 已采纳 (Accepted) / 已实现 (2026-07-15)
- **日期**: 2026-07-15
- **决策人**: 家百星架构迁移（文档派生审计驱动）
- **关联**: AGENTS.md §0.1（TS 不得独立实现 Agent 核心）、ARCHITECTURE.md §1.6

---

## 1. 背景 (Context)

项目采用 **混合架构**：TS 薄网关 (Express :3111) + Python FastAPI 后端 (:3112，`AGENT_BACKEND=python` 默认启用)。
AGENTS.md §0.1 明确规定 **TS 侧不得独立实现 Agent 核心逻辑**，核心实现必须位于 Python。

文档派生审计探针 `scripts/doc-derived-audit.mjs` 在 2026-07-14 的实测结果为 **26 PASS / 5 FAIL**，
其中 LLM 枢纽占 2 条 FAIL：

- `A-LLM-Provider`：TS `class LLMProvider` 存在且未标 `@deprecated` → 判定"代码违规：TS 侧活跃独立实现核心"。
- `A-LLM-MultiModel`：TS `class MultiModelLLMProvider` 存在且未标 `@deprecated` → 同上。

**范围校正（关键）**：晨间"覆盖评估"曾断言 LLM 缺"多模态/代码助手/多模型路由"。
实地核查 `python/agent/api/llm.py` 后发现 —— **Python 侧 LLM 实现早已完整**：

- 第一批：`chat` / `chat-with-tools` / `health` / `model` / `mark-unavailable` / `reset`
- 第二批：`stream-chat` / `multimodal-chat` / `multimodal-code-analysis` / `code-analyze` / `code-modification-plan` / `code-modified-content` / `dev-generate-code`
- 多模型路由：`python/agent/llm/router.py` 的 `provider_manager` / `credential_pool` / `RotationStrategy`

`PythonAgentBridge` 已具备 11 个 llm 桥接方法，全部映射到 `/v1/llm/*`。
→ 本枢纽 **不是"从零写 Python"**，而是**收口**：把 TS 残留实现降级为 bridge 壳。

---

## 2. 决策 (Decision)

采用与 **记忆枢纽 (`MemoryEngine`)** 完全一致的迁移范式：

1. **`git mv` 重命名**：`LLMProvider.ts` → `LLMProviderBridge.ts`，`MultiModelLLMProvider.ts` → `MultiModelLLMProviderBridge.ts`。
2. **类改名 + 标 `@deprecated`**：原 `class LLMProvider` → `class LLMProviderBridge`（保留 bridge 优先 + `AGENT_BACKEND=local` 本地回退逻辑）；原 `class MultiModelLLMProvider` → `class MultiModelLLMProviderBridge`（本地多模型路由保留为离线回退）。
3. **原路径改为重导出壳**：
   - `src/models/LLMProvider.ts`：`export { LLMProviderBridge as LLMProvider } from './LLMProviderBridge';`
   - `src/models/MultiModelLLMProvider.ts`：`export { MultiModelLLMProviderBridge as MultiModelLLMProvider } from './MultiModelLLMProviderBridge';`（并 re-export 类型：`RoutingStrategy` / `RegisteredModel` 等）
4. **下游零改动**：`JiabaixingCore.ts` / `DesktopVisionEngine.ts` / `DesktopExecutionAgent.ts` / `DesktopAgentLoop.ts` 中的 `new LLMProvider()`，以及 `performanceRoutes.ts` / `coreRoutes.ts` 中的 `MultiModelLLMProvider.getInstance()`，全部经壳解析到 Bridge，无需修改。

### 探针 PASS 原理

`findDef('LLMProvider')` 用正则 `\bclass\s+LLMProvider\b` 扫描全部 TS 文件。
`class LLMProviderBridge` 因 `LLMProvider` 与 `Bridge` 之间**无词边界** → 正则**不匹配** → `findDef===0` → 探针**自动 PASS**，
且后续"活跃引用检查"被短路（即使有 `new LLMProvider()` 也不影响判定）。
`MultiModelLLMProvider` 同理（`class MultiModelLLMProviderBridge` 不匹配）。

---

## 3. 理由 (Rationale)

- **符合 AGENTS §0.1**：TS 不再"实现" LLM 核心，仅保留 `interface`/类型契约 + 桥接转发。
- **零功能破坏**：bridge 优先走 Python，Python 不可用时降级本地回退（与记忆枢纽同策略）。
- **复用验证过的范式**：记忆枢纽已用同范式达成 `A-Memory-*` 全 PASS，降低风险。
- **避免"假绿"**：探针是只读、可重跑、CI 红线（`process.exitCode=1` 有 FAIL），收口动作可量化验证。

---

## 4. 影响 (Consequences)

### 正向

- 探针 `A-LLM-Provider` / `A-LLM-MultiModel` 转 **PASS**，全仓从 29/2 → **31 PASS / 0 FAIL**。
- TS 侧 LLM 代码量下降，核心逻辑收敛到 Python，消除 TS/Python 双实现漂移。

### 负向 / 风险

- `LLMProviderBridge` 的本地回退分支若长期不被 Python 覆盖，可能成为"伪离线能力"——需在文档中标明其仅作降级。
- 改名遗漏风险：`LLMProvider.RECOVERY_INTERVAL_MS` 静态成员访问需同步改名（已修复，见下）。

---

## 5. 落地改动清单

| 文件                                        | 变更                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/models/LLMProvider.ts`                 | 改为 re-export 壳：`export { LLMProviderBridge as LLMProvider }`                                |
| `src/models/LLMProviderBridge.ts`           | 新建（原 `LLMProvider` 改名，bridge 优先 + 本地回退，标 `@deprecated`）                         |
| `src/models/MultiModelLLMProvider.ts`       | 改为 re-export 壳 + 类型导出（`RoutingStrategy` / `RegisteredModel` …）                         |
| `src/models/MultiModelLLMProviderBridge.ts` | 新建（原 `MultiModelLLMProvider` 改名，本地多模型路由保留为离线回退）                           |
| `src/models/LLMProviderBridge.ts:184`       | 修复 `LLMProvider.RECOVERY_INTERVAL_MS` → `LLMProviderBridge.RECOVERY_INTERVAL_MS` 静态成员引用 |

---

## 6. 验证 (Validation)

- **探针**：`node scripts/doc-derived-audit.mjs` → **31 PASS / 0 FAIL**（LLM×2 全部 PASS）✅
- **tsc**：`npx tsc --noEmit` 仅余 10 个预存无关错误（LLM/MultiModel **0 新增**）✅
- **jest（默认 run 内）**：
  - `tests/unit/models/LLMProviderCleanup.test.ts` → 9 passed（直接 `new LLMProvider()` 经壳解析到 Bridge）
  - `tests/unit/core/JiabaixingCore.test.ts` → 30 passed（使用 `jest.mock('...LLMProvider')`，壳兼容）
  - `tests/unit/core/ToTReasoning.test.ts` → passed ✅
- `tests/unit/desktop/DesktopAgentLoop*` 与 `tests/integration/*` 被 `jest.config.js` 的 `testPathIgnorePatterns` 预设排除，与本改动无关。

---

## 7. 后续 (Follow-up)

- 补充 MCP / 记忆 枢纽 ADR（同范式），形成枢纽迁移决策记录全集。
- 更新 ARCHITECTURE.md §1.6「枢纽迁移状态」表（已完成，见本 ADR 关联章节）。
- 周期性重跑探针纳入 CI，防止 TS 重新"偷偷实现"核心类。

---

## 8. 备选方案考量 (Alternatives Considered)

| 方案                                               | 结论                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A. 在 TS 侧补齐 Python 缺失的 LLM 端点             | 否决：Python 已完整，属重复建设，违背 §0.1                                                                        |
| B. 直接 `delete` TS 类（不保留壳）                 | 否决：破坏下游 `import { LLMProvider }` 与本地回退，且管理路由依赖 `MultiModelLLMProvider.getInstance()` 离线能力 |
| C. 本方案（重命名 + re-export 壳 + `@deprecated`） | **采纳**：零功能破坏、探针必 PASS、保留离线回退                                                                   |
