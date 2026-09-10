# 剩余 15 条 FAIL 逐条处置方案（ADR）

> 日期: 2026-07-14（第二轮后续）
> 依据: `scripts/doc-derived-audit.mjs` 当前 19 PASS / 15 FAIL；探查代理对 15 条的代码核实（见正文证据）
> 方法: 文档断言 → 探针 → FAIL → 逐条定处置（代码/文档/探针改动），复跑验证 FAIL 单调下降
> 状态: **本文件是方案，待用户审批后执行。本轮不改任何代码/文档/探针。**

---

## 0. 关键约束（来自探针机制，决定处置能否真降 FAIL）

探针是**结构性守卫**，不是文档合规检查器。两条断言的"PASS 条件"不同：

| 类别           | 探针断言                      | 真降 FAIL 的唯一条件                                                                                                                                           |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一（代码违规） | `TS 侧不得独立实现「X」`      | **完整迁移**：删 TS 实现 + 去掉所有生产引用 → `defs.length===0` → PASS「已迁移 Python」                                                                        |
| 三（死代码）   | `✅「X」应被 TS 生产代码挂载` | **二选一**：(a) 真接线到生产（`mounted=true`）；或 (b) 删 TS + 把 ARCHITECTURE §1.5 该条改指 Python + 把探针 `COMPONENTS` 项移到 `PY_COMPONENTS`（或移除断言） |

⚠️ **纠正先前误判**：类别三"只删 TS 文件"不够——`defExists=false` 会让探针重分类成"文档过期型 FAIL"，FAIL 数不变。必须同步改文档 + 改探针断言，才能真降 FAIL（见 §2 阶段划分）。

---

## 1. 处置总表（15 条）

> 风险: L=低 / M=中 / H=高。阶段: P1=低风险删除批次 / P2=中高风险迁移批次。

| #   | 探针ID                | 组件 (TS 路径)                                                | 类别 | 处置              | Python 等价 (路径:类, 已挂载)                                                        | 探针影响                | 风险 | 阶段 |
| --- | --------------------- | ------------------------------------------------------------- | ---- | ----------------- | ------------------------------------------------------------------------------------ | ----------------------- | ---- | ---- |
| 1   | A-LLM-Provider        | `LLMProvider` `src/models/LLMProvider.ts`                     | 一   | migrate           | `python/agent/llm/provider.py:70` (core/engine.py:14)                                | 删TS+去引用→PASS        | M    | P2   |
| 2   | A-LLM-MultiModel      | `MultiModelLLMProvider` `src/models/MultiModelLLMProvider.ts` | 一   | migrate           | `python/agent/llm/router.py:66` ProviderManager + `moa_aggregator.py` MoAAggregator  | 删TS+去引用→PASS        | M    | P2   |
| 3   | A-Memory-Engine       | `MemoryEngine` `src/memory/MemoryEngine.ts`                   | 一   | migrate           | `python/agent/memory/engine.py:32` (core/engine.py:20)                               | 删TS+去引用→PASS        | H    | P2   |
| 4   | A-Memory-ShortTerm    | `ShortTermMemory` `src/memory/ShortTermMemory.ts`             | 一   | migrate(随#3)     | `python/agent/memory/store.py:71` MemoryStore(short_term)                            | 随#3消亡→PASS           | H    | P2   |
| 5   | A-Memory-LongTerm     | `LongTermMemory` `src/memory/LongTermMemory.ts`               | 一   | migrate(随#3)     | `python/agent/memory/store.py` MemoryStore(long_term)                                | 随#3消亡→PASS           | H    | P2   |
| 6   | A-Memory-VectorDB     | `VectorDatabase` `src/memory/VectorDatabase.ts`               | 一   | migrate(随#3)     | `python/agent/memory/store.py:71`+`SemanticSearchEngine`(SQLite+语义,Chroma为TS遗留) | 随#3消亡→PASS           | H    | P2   |
| 7   | A-Evolution-Engine    | `EvolutionEngine` `src/evolution/EvolutionEngine.ts`          | 一   | migrate           | `python/agent/evolution/engine.py:34` (core/engine.py:22)                            | 删TS+去引用→PASS        | M    | P2   |
| 8   | A-MCP                 | `MCPServerManager` `src/mcp/MCPServerManager.ts`(1193行)      | 一   | migrate           | `python/agent/mcp/server_manager.py:81`+`transport.py:591`(spawn/JSON-RPC/SSE)       | 删TS+去引用→PASS        | H    | P2   |
| 9   | B-CheckpointService   | `src/harness/persistence/CheckpointService.ts`                | 三   | delete+repoint→Py | `python/agent/persistence/checkpoint.py:41`(system_tools/evolution v2 在用)          | 删TS+PY_COMPONENTS→PASS | L    | P1   |
| 10  | B-ObsidianProvider    | `src/memory/external/ObsidianProvider.ts`                     | 三   | delete+drop断言   | Python **无**(providers.py 仅 builtin/honcho/mem0)                                   | 删TS+移除断言→不FAIL    | L    | P1   |
| 11  | B-Mem0Provider        | `src/memory/external/Mem0Provider.ts`                         | 三   | delete+repoint→Py | `python/agent/memory/providers.py:260`(工厂注册)                                     | 删TS+PY_COMPONENTS→PASS | L    | P1   |
| 12  | B-ThemeManager        | `src/cli/themes/ThemeManager.ts`                              | 三   | delete+drop断言   | Python **无**(TS-CLI cosmetic)                                                       | 删TS+移除断言→不FAIL    | L    | P1   |
| 13  | B-VoiceSessionManager | `src/multimodal/VoiceSessionManager.ts`                       | 三   | delete+repoint→Py | `python/agent/tools/voice_mode_tool.py:79` VoiceModeManager(core/engine.py 挂载)     | 删TS+PY_COMPONENTS→PASS | L    | P1   |
| 14  | B-PluginManager       | `src/plugins/PluginManager.ts`                                | 三   | delete+repoint→Py | `python/agent/plugins/manager.py:22`(已挂载)                                         | 删TS+PY_COMPONENTS→PASS | L    | P1   |
| 15  | B-PluginLoader        | `src/plugins/PluginLoader.ts`                                 | 三   | delete+repoint→Py | `python/agent/plugins/manager.py:71` load_plugin(无独立类)                           | 删TS+PY_COMPONENTS→PASS | L    | P1   |

**预期**: P1 执行后 FAIL 15→8（7 条类别三全消：5 条转 PASS + 2 条移除断言）；P2 执行后 8→0。

---

## 2. 分阶段执行

### Phase 1 — 低风险删除批次（预期 FAIL 15 → 8）

目标：清掉 7 个 TS 死代码副本（Python 等价已挂载或在产，删除零行为变化）。

对每条 P1 项做三步：

1. **删 TS 文件**（git tracked，回滚=revert）。
2. **改 ARCHITECTURE.md §1.5**：
   - #9/#11/#13/#14/#15 → 该行 ✅ 改为指向 Python 实现（与已 PASS 的 `B-PY-TTS`/`B-PY-PromptCacheManager` 同格式）。
   - #10/#12 → 该行 ✅ 降级/移除（Python 无等价、无需求）。
3. **改探针 `scripts/doc-derived-audit.mjs`**：
   - #9/#11/#13/#14/#15 → 从 `COMPONENTS` 数组移除，加入 `PY_COMPONENTS`（路径+类名，断言 Python 实现存在）→ 复跑 PASS。
   - #10/#12 → 从 `COMPONENTS` 移除（不再断言）→ 复跑不再计入 FAIL。

验证：`node scripts/doc-derived-audit.mjs` → 预期 26 PASS / 8 FAIL（类别三清零）。

### Phase 2 — 中高风险迁移批次（预期 8 → 0，需排期 + 灰度 + 回归）

每条 = 删 TS 实现 + 把所有生产调用方改走 Python 桥（或确认 `AGENT_BACKEND=python` 下本就不走 TS）。调用方面积大/已接 server 入口的项必须灰度。

| #       | 调用方（需改/确认）                                                                                                                                                     | Python 入口                                         | 灰度策略                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 3+4+5+6 | MemoryEngine/MemoryRetriever/ConversationCompressor 及 core/\*(ConstitutionPromptBuilder/ScenarioAwareScheduler/UnifiedContextPipeline/AgentHarness/PersistenceService) | `python/agent/memory/engine.py`+`store.py`          | 整层迁移；先确保 Python 记忆层覆盖所有 TS 调用语义，保留 `AGENT_BACKEND=local` 回退至验证通过                     |
| 1       | JiabaixingCore/TreeOfThought/DesktopAgentLoop/DesktopExecutionAgent/DesktopVisionEngine                                                                                 | `python/agent/llm/provider.py`                      | 分模块切；Electron 桌面循环涉延迟，先非桌面路径                                                                   |
| 2       | coreRoutes.ts/performanceRoutes.ts/OpenAICompatibleModel                                                                                                                | `python/agent/llm/router.py`+`moa_aggregator.py`    | 先把多模型能力经 Python API 暴露，TS 路由改接                                                                     |
| 7       | JiabaixingCore/EvolutionOrchestrator/FeedbackCollector/EvolutionEngineV2Adapter/SkillUsageTracker                                                                       | `python/agent/evolution/engine.py`                  | 与 #3 协同排期                                                                                                    |
| 8       | bootstrap.ts/shutdown.ts/mcpRoutes.ts（server 入口）                                                                                                                    | `python/agent/mcp/server_manager.py`+`transport.py` | **最高风险**：重路由 server 的 MCP 入口到 Python，须保证 JSON-RPC/SSE 行为一致；先处理 L6 虚假 `@deprecated` 注释 |

验证：每完成一项复跑探针；全部完成后 34 PASS / 0 FAIL。

---

## 3. 低风险先动 vs 谨慎排期（来自探查）

- **可低风险先动（P1）**：#9/#10/#11/#12/#13/#14/#15 —— TS 死代码，Python 等价已挂载或在产，删除零功能损失；#4/#5/#6 随 #3 迁移自然消亡。
- **必须谨慎排期（P2）**：#8（1193 行、已接 server 入口）、#2、#1、#3、#7 —— 调用面大或涉架构/延迟，需灰度 + 回归 + 保留回退。

---

## 4. 验证与回滚

- 每阶段结束：`node scripts/doc-derived-audit.mjs`（有 FAIL 退码 1，可作 CI 门禁）。
- 删 TS 死代码：零行为变化，回滚 = `git revert`。
- 迁移：须保证 Python 桥覆盖所有 TS 调用点并通过回归；保留 `AGENT_BACKEND=local` 回退开关至验证通过。

---

## 5. 待用户审批的决策点

1. 是否同意 P1 七条"删 TS + 改文档 + 改探针"的处置（预期 FAIL 15→8）？
2. P2 八条迁移是否同意按上表排期，还是先只做其中最低风险的一条（如 #7 EvolutionEngine）作试点？
3. #10 ObsidianProvider / #12 ThemeManager：确认"无需求、直接删 + 移除断言"，还是你其实想要这两个功能（那样应改为在 Python 实现 Obsidian provider / 在 cli.ts 接线 ThemeManager，而非删）？

---

## 6. 执行记录（P1 已落地，2026-07-14）

> 用户"可以一个个做"授权，按 ADR 逐条执行。全部走"删 TS + 改探针 + 改文档 + 复跑验证"，FAIL 单调下降。

### 6.1 执行流水（7 条类别三）

| #   | 组件                | 处置                      | 探针变化                                      | 文档改动                            | 结果                          |
| --- | ------------------- | ------------------------- | --------------------------------------------- | ----------------------------------- | ----------------------------- |
| 9   | CheckpointService   | 删 TS + 指 Python         | COMPONENTS→PY_COMPONENTS(checkpoint.py)       | ARCH§1.5/特性点                     | B-PY-CheckpointService PASS   |
| 11  | Mem0Provider        | 删 TS + 指 Python         | COMPONENTS→PY_COMPONENTS(providers.py)        | external/ 树/特性点                 | B-PY-Mem0Provider PASS        |
| 13  | VoiceSessionManager | 删 TS + 指 Python         | COMPONENTS→PY_COMPONENTS(voice_mode_tool.py)  | multimodal/ 树/§1.5/特性点          | B-PY-VoiceSessionManager PASS |
| 14  | PluginManager       | 删 TS+测试 + 指 Python    | COMPONENTS→PY_COMPONENTS(manager.py)          | plugins/ 树/比较表146/239/特性点386 | B-PY-PluginManager PASS       |
| 15  | PluginLoader        | 删 TS + 指 Python         | COMPONENTS→PY_COMPONENTS(manager.py,cls=null) | plugins/ 树/§1.5 行173              | B-PY-PluginLoader PASS        |
| 10  | ObsidianProvider    | 删 TS + **移除断言**      | 从 COMPONENTS 移除(无 Python 等价)            | external/ 树/特性点385/§1.5 行168   | 不再计入 FAIL                 |
| 12  | ThemeManager        | 删 TS+测试 + **移除断言** | 从 COMPONENTS 移除(无 Python 等价)            | cli/ 树/§1.5 行171(❌)/特性点393    | 不再计入 FAIL                 |

### 6.2 验证结果

- **探针**：34 断言 20 PASS/14 FAIL（P1 前）→ 32 断言 **24 PASS / 8 FAIL**（P1 后）。注：#10/#12 是"移除断言"类，断言总数由 34 降至 32。
- **tsc**：每次删除后复跑 `npx tsc --noEmit`，除 1 条**预存无关错误**（`src/harness/AgentHarness.ts:779` `Property 'content' does not exist on type 'never'`，harness 层，与本次无关）外，0 处指向被删类的引用。删除零功能回归。
- **机制再验证**：类别三"删 TS + 降级✅"无法降 FAIL（会重分类为文档过期型）；必须同步"删 TS + §1.5 改指 Python/移除断言 + 探针 COMPONENTS→PY_COMPONENTS(或移除)"才真降 FAIL。本轮 7 条全部据此闭环。

### 6.3 待办（P2）

剩余 8 条 FAIL 全部为**类别一代码违规**（TS 活跃独立实现核心能力，违 AGENTS.md §0.1），需 TS→Python 迁移（删 TS 实现 + 把所有生产调用方改走 Python 桥）。最高风险：#8 MCPServerManager(1193 行，已接 server 入口)。逐项见 §2 Phase 2。

---

### 6.4 P2 试点 #7 EvolutionEngine（2026-07-14，已落地并验证）

> 用户决策：**只做 #7 作试点**，验证"删 TS 实现 + 生产调用方改走 Python 桥"这一种模式可不可行，再决定其余 7 条。

**模式**：删 `src/evolution/EvolutionEngine.ts` → 所有生产引用改走 `PythonAgentBridge`（→ Python FastAPI `/v1/evolution/*`）。

**改动清单**：

| 文件                                                  | 改动                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/evolution/EvolutionEngine.ts`                    | **删除**（类别一违规实现）                                                                                                                                                                                                                    |
| `src/core/JiabaixingCore.ts`                          | 移除 `evolutionEngine` 属性与无条件 `new EvolutionEngine()`；`feedbackCollector` 保留                                                                                                                                                         |
| `src/evolution/index.ts`                              | 移除 `export { EvolutionEngine }`                                                                                                                                                                                                             |
| `src/ide/PythonAgentBridge.ts`                        | 新增 `getInsights()`→`/v1/evolution/insights`、`getEvolutionMetrics()`→`/v1/evolution/metrics`（修正初版误指向 `/api/...` 的 404 路径）                                                                                                       |
| `python/agent/api/evolution.py`                       | **新增** `GET /v1/evolution/metrics`、`GET /v1/evolution/insights` 两端点（Python 主实现，包 `engine.get_metrics()` / `get_insights()` / `get_tool_recommendations()`）                                                                       |
| `src/server/routes/evolutionRoutes.ts`                | `/api/evolution/{metrics,insights,trigger}` 三路由由 `core.evolutionEngine` 改为 `getBridge(core)` 桥接；`/trigger`→`triggerEvolution()`                                                                                                      |
| `src/server/init/initEvolution.ts`                    | Loop B 权重同步 `core.evolutionEngine.getToolWeights()` → `bridge.getEvolutionMetrics().tool_weights`（异步化）                                                                                                                               |
| `src/server/init/initHarness.ts`                      | 删 `core.evolutionEngine` 绑定；`evolutionEngine` deps 改写：collectFeedback→`bridge.submitFeedback`，assessQuality/generateSkill/nudgeKnowledgePersistence 改为 Python 侧承接的无操作说明                                                    |
| `src/evolution/EvolutionOrchestrator.ts`              | 移除 V1 `EvolutionEngine` 字段/import/`driveEvolutionEngine`/`triggerOptimizationCycle` 内 V1 触发块/`getEvolutionMetricsSafe`；`evolution` 指标复用 V2 `codeEvolutionMetrics`；`UnifiedEvolutionMetrics.evolution` 改 `CodeEvolutionMetrics` |
| `src/evolution/LearningStatusReporter.ts`             | 删除 V1-only 字段报告块（totalFeedback 等已随 V1 消亡）                                                                                                                                                                                       |
| `tests/unit/core/ToTReasoning.test.ts`                | 移除对已删模块的 `jest.mock`                                                                                                                                                                                                                  |
| `tests/learning_features.test.ts`                     | 删除 V1 few-shot 测试块（导入已删模块）                                                                                                                                                                                                       |
| `tests/integration/EvolutionLoopVerification.test.ts` | 重写为桥接契约测试（验证 bridge 方法 + 路由装配，无需 Python 运行）                                                                                                                                                                           |
| `python/tests/test_api.py`                            | 新增 `/v1/evolution/metrics`、`/v1/evolution/insights` 端点测试                                                                                                                                                                               |

**关键发现（避坑）**：初版在 bridge 加的 `getInsights/getEvolutionMetrics` 误指向 `/api/evolution/*`，但 Python 进化路由实际挂载在 `/v1/evolution/*`（main.py:186 `prefix="/v1/evolution"`），会 404。已修正为 `/v1/evolution/metrics` / `/v1/evolution/insights`，并补 Python 端点兜底。

**验证结果**：

- **探针**：`A-Evolution-Engine` **FAIL → PASS**。总数 **24 PASS / 8 FAIL → 25 PASS / 7 FAIL**（8 条类别一减为 7 条）。
- **tsc**：`npx tsc --noEmit` 仅剩 1 条**预存无关错误**（`AgentHarness.ts:779`），其余全部转绿（V1 引用全清）。
- **TS 测试**：`EvolutionLoopVerification` / `ToTReasoning` / `learning_features` 三套件 **79 passed**。
- **Python 测试**：新增 2 端点测试 + 既有 + `test_evolution`/`test_evolution_orchestrator` 共 **60 passed**（3 new + 57）。

**结论**：试点模式**可行**。删 TS + 桥接 Python 的范式在本项验证通过，可推广到其余 7 条（#1/#2/#3+4+5+6/#8）。#8 MCPServerManager 调用面最大、已接 server 入口，仍建议最后做并保留 `AGENT_BACKEND=local` 回退开关。

### 6.5 待办（P2 剩余 7 条）

`A-LLM-Provider` / `A-LLM-MultiModel` / `A-Memory-Engine`(+ShortTerm/LongTerm/VectorDB) / `A-MCP` 共 7 条类别一违规，待按 §2 Phase 2 排期或继续试点。

### 6.6 探针精度修正 + 范围校正 (2026-07-14 续10)

**问题**: 原 `tsModuleIsInert` 用宽泛 `\bX\b` 匹配,把 `interface X` **类型注解**也判为违规;且 `A-Memory-VectorDB` 误指向 `src/memory/VectorDatabase.ts`(仅含 `class VectorDatabaseFactory`),而非真正 `class VectorDatabase` 所在的 `src/memory/VectorDatabaseFactory.ts`。

**修正(对齐 §0.1 真意: TS 不得*实现*核心,但可*声明* interface/type 契约用于桥接)**:

1. 新增 `activeClassRefs()`: 仅统计 `new X` / `X.method()` 的**活跃实例化/调用**,排除 interface 类型注解与测试文件。
2. `tsModuleIsInert` 改为仅以 `class` 实现判定违规; `interface`/`type` 契约保留不阻塞 PASS。
3. `A-Memory-VectorDB` 断言改指向 `src/memory/VectorDatabaseFactory.ts`。

**效果**: 探针 25/7 → **26 PASS / 6 FAIL**。`A-Memory-VectorDB` 原已合规(`class VectorDatabase` 已 `@deprecated` 且零外部实例化),现合法 PASS。

**校正后的真实范围**: 剩余 6 条均为**活跃实现**,且**全部耦合到枢纽、无孤立可删叶**:

- 记忆枢纽: `MemoryEngine`(含 `ShortTermMemory`/`LongTermMemory` 叶,仅被 MemoryEngine 实例化)
- LLM 枢纽: `LLMProvider`(含 `MultiModelLLMProvider`)
- MCP 入口: `MCPServerManager`(1193 行,已接 server)

**迁移顺序(按枢纽整体重路由,非删单文件)**: ① 记忆枢纽 → ② LLM 枢纽 → ③ MCP 入口。CI 门禁已接入,6 FAIL 期间 CI 红线。

### 6.7 类别一 Python 覆盖评估报告 (2026-07-14 续11)

- 用户选择"先看覆盖评估再动手"。已完成三枢纽 TS→Python 覆盖矩阵(见 `docs/CategoryOne_Python_Coverage_Report_2026-07-14.md`)。
- **就绪度反转结论**: 原定"记忆→LLM→MCP"应反转为 **`MCP → LLM → Memory`**:
  - **MCP 入口 🟢 高**: Python `server_manager.py` 已实现 TS 全部 ~30 方法(含 stdio 子进程生命周期),**仅缺 4 个 HTTP 路由**(register/start-all/list-tools/send-message)。TS 改 HTTP 转发薄壳即可,风险最低。
  - **LLM 枢纽 🟡 中**: chat/工具/健康/流式(SSE/WS)已就绪;缺多模态/代码助手/多模型路由策略。先切 ~60% 调用点,其余留第二批。
  - **记忆枢纽 🔴 低**: Python 仅 ~35% 覆盖,`storeFeedbackSignal`/`getUserProfile`/`getKnowledgeGraph`/`calculateDecayScore`/做梦/加密/traceId 等 ~20 方法缺失,需先写 Python 引擎逻辑。调用点最散(~48 处/9 文件)。
- **契约建议**: `LLMProvider`/`IMemoryEngine`/`MCPServerManager` 的 interface/type 保留为 TS 桥接契约(实现委托 Python),不整删,控下游类型改动。
- 待用户定: 采纳反转顺序 / 仍原顺序 / 只先做 MCP 一条。

### 6.8 MCP 枢纽迁移完成 (2026-07-14 续12)

- 用户采纳反转顺序 A: **MCP → LLM → Memory**,从风险最低、Python 最完整的 MCP 入手。
- **动作**:
  - Python `python/agent/api/mcp.py` 新增 4 路由(挂载 `/v1`): `POST /mcp/servers/start-all`→`start_all_servers()`、`GET /mcp/servers/{name}/tools`→`list_tools()`、`POST /mcp/servers/{name}/message`→`send_message()`、`POST /mcp/register`→`register_server(MCPServerConfig)`;新增 pydantic `RegisterServerRequest`/`SendMessageRequest`;从 `server_manager` 引入 `MCPServerConfig`。
  - 新增 `src/ide/bridgeRegistry.ts`(单例 `getActivePythonBridge`/`setActivePythonBridge`),`bootstrap.ts` 创建/销毁 pythonBridge 时登记,规避从 bootstrap 引回的循环依赖。
  - `src/ide/PythonAgentBridge.ts` 新增 16 个 MCP 桥接方法(`getMcpServersStatus`/`getMcpServerStatus`/`startMcpServer`/`stopMcpServer`/`startAllMcpServers`/`getRunningMcpServers`/`getRunningMcpServerCount`/`getMcpServerCount`/`listMcpTools`/`callMcpTool`/`sendMcpMessage`/`registerMcpServer`/`listMcpResources`/`readMcpResource`/`listMcpPrompts`/`getMcpPrompt`/`stopAllMcpServers`)。
  - 6 个 TS 调用方重路由至桥接: `mcpRoutes.ts`、`shutdown.ts`、`bootstrap.ts`(MCP Host 启动)、`MultiPlatformGateway.ts`、`TRAEOptimizationIntegrator.ts`、`MCPToolBridge.ts`。
  - 删除类别一违规 `src/mcp/MCPServerManager.ts`;`src/mcp/types.ts` 保留 `MCPServerConfig` 作为 TS 桥接契约;`src/mcp/index.ts` 仅导出契约。
  - 测试: `MCPServerManager.test.ts` 删除(测已删类=死测试);`MultiPlatformGateway.test.ts`/`MCPToolBridge.test.ts` 的 `jest.mock('MCPServerManager')` 改为 `jest.mock('bridgeRegistry')` 并补 `await` 异步修正。
- **验证**:
  - 探针 **A-MCP FAIL → PASS**: 总数 **26 PASS / 6 FAIL → 26 PASS / 5 FAIL**(余 5 条 = LLM×2 + Memory×3)。
  - `npx tsc --noEmit` 仅剩预存 `AgentHarness.ts:779`,MCP 迁移零新错误。
  - jest 两件套 **33/33 passed**。
  - Python: 系统 Python(3.13.0,含 fastapi/pytest*asyncio)下 `test_mcp*\*` 共 **179 passed**(163 单元 + 16 集成),`mcp.py` 改动仅新增路由(py_compile OK,零回归)。(注: managed venv 缺 fastapi/pytest_asyncio,跑 Python 套件须用系统 Python。)
- **范式沉淀**: 删 TS 实现类 + 保留 interface/type 契约 + 经 `bridgeRegistry` 统一取 `PythonAgentBridge` 代理 `/v1/*`。后续 LLM/Memory 枢纽按此范式推广。
