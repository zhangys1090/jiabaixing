# 文档派生审计报告（Doc-Derived Audit）

> 日期: 2026-07-14
> 方法: 把项目文档里的"断言"当规格 → 派生可执行探针 → 跑一遍 → 用失败点反推真问题
> 探针: `scripts/doc-derived-audit.mjs`（只读，可复跑，接 CI）
> 原始结果: `docs/doc-derived-audit-result.json`
> 本轮策略: **只报告，不改代码、不改文档**（按用户选择）

---

## 0. 方法论声明（为什么这份报告可信）

传统审计的毛病是"先凭感觉列一堆怀疑，再去改"，结论无法证伪、容易改错地方。本轮反过来：

```
文档断言(规格) ──派生──▶ 可执行探针 ──运行──▶ 失败点 ──判定根因──▶ 建议
     ▲                                                          │
     └────────────  失败=文档与代码不一致的客观事实  ◀──────────┘
```

- 每条 FAIL 都对应文档里一句明确的话 + 代码里一处客观事实（文件/行/引用），**不是主观猜测**。
- 探针索引了 **TS 550 文件 / Python 310 文件 / 测试 206 文件**（已排除 `frontend/release` 发布副本、`node_modules`、`dist`、`coverage`）。
- 探针可随时复跑：`node scripts/doc-derived-audit.mjs`。

**本轮结论：34 条断言，13 PASS / 21 FAIL。**

---

## 1. 结果总览

| 规格源                                               | 断言数 | PASS   | FAIL   |
| ---------------------------------------------------- | ------ | ------ | ------ |
| AGENTS.md §0.1 模块归属表（TS 不得独立实现核心）     | 11     | 2      | 9      |
| ARCHITECTURE.md §1.5 功能对齐表（✅ 须存在且被挂载） | 19     | 10     | 9      |
| AGENTS.md §0.3 完成标准（无假绿）                    | 2      | 1      | 1      |
| ARCHITECTURE.md 全局架构描述（指向/端口/存储）       | 3      | 0      | 3      |
| **合计**                                             | **34** | **13** | **21** |

**21 个失败按根因归为 5 类**，这是判定"改代码还是改文档"的关键：

| 类别 | 根因                                                | 数量 | 该改谁                             |
| ---- | --------------------------------------------------- | ---- | ---------------------------------- |
| 一   | 代码违规：TS 侧活跃独立实现 Agent 核心（违反 §0.1） | 5    | **改代码**（迁 Python 或降级为壳） |
| 二   | 注释脱节：标"已迁移/默认不用"却仍在核心调用路径     | 3    | **改代码 + 改注释**                |
| 三   | 死代码/未挂载：文档标 ✅ 但生产链路没装配           | 7    | **改代码（挂载或删）+ 降级 ✅**    |
| 四   | 文档过期：点名了 Python 组件/已删文件/过期宏观描述  | 5    | **改文档**                         |
| 五   | 假绿：空体 `test.skip` 冒充覆盖                     | 1    | **改测试**                         |

---

## 2. 类别一 · 代码违规（TS 侧活跃独立实现核心，违反 §0.1）——改代码

> §0.1 明文："Agent 核心功能必须以 Python 端为主实现，TS 端不得独立实现"。以下 TS 类**连 `@deprecated` 都没标**，是活跃真实实现，直接与规格冲突。

| 探针ID             | 类                      | 文件                                         | 证据（生产引用）                                                                                            | 建议                                                        |
| ------------------ | ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A-LLM-MultiModel   | `MultiModelLLMProvider` | `src/models/MultiModelLLMProvider.ts`        | `OpenAICompatibleModel.ts` / `coreRoutes.ts` / `performanceRoutes.ts`                                       | 迁移到 `python/agent/llm/router.py` 路径，TS 仅保留路由入口 |
| A-Memory-ShortTerm | `ShortTermMemory`       | `src/memory/ShortTermMemory.ts`              | `ConversationCompressor.ts` / `MemoryEngine.ts` / `MemoryRetriever.ts`                                      | 记忆主实现应在 `python/agent/memory`，TS 去实现化           |
| A-Memory-LongTerm  | `LongTermMemory`        | `src/memory/LongTermMemory.ts`               | `MemoryEngine.ts` / `MemoryRetriever.ts`                                                                    | 同上                                                        |
| A-Memory-VectorDB  | `VectorDatabase`        | `src/memory/VectorDatabase.ts`               | `ChromaVectorDatabase.ts` / `InMemoryVectorIndex.ts` / `MemoryEngine.ts` / `MemoryRetriever.ts`             | 向量存储主实现应在 Python，TS 侧收敛                        |
| A-MCP              | `MCPServerManager`      | `src/mcp/MCPServerManager.ts`（**1193 行**） | 文件头注释自称"仅 HTTP 路由入口"，实为完整业务逻辑（进程 spawn / JSON-RPC / tools·resources·prompts / SSE） | 把业务逻辑迁 `python/agent/mcp`，TS 真正瘦成路由            |

**为什么重要**：这不是"文档写错了"，而是代码欠了架构债。§0.1 是硬规则，`MCPServerManager` 尤其典型——挂着"仅路由"的注释招牌，底下是 1193 行真实现，属于"注释在骗人 + 代码违规"双重问题。

---

## 3. 类别二 · 注释脱节（标"已迁移"却仍在核心路径）——改代码 + 改注释

> 这些 TS 类**标了 `@deprecated`**、注释称"已迁移 Python、`AGENT_BACKEND=python` 默认不用"，但探针发现它们**仍被核心生产代码直接实例化**。注释与现实矛盾。

| 探针ID             | 类                | 文件                               | 仍在引用它的核心代码                                                                                                                                                            |
| ------------------ | ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-LLM-Provider     | `LLMProvider`     | `src/models/LLMProvider.ts`        | `core/JiabaixingCore.ts`、`core/TreeOfThought.ts`、`desktop/DesktopAgentLoop.ts`、`desktop/DesktopExecutionAgent.ts`、`desktop/DesktopVisionEngine.ts`                          |
| A-Memory-Engine    | `MemoryEngine`    | `src/memory/MemoryEngine.ts`       | `core/ConstitutionPromptBuilder.ts`、`core/ScenarioAwareScheduler.ts`、`core/UnifiedContextPipeline.ts`、`harness/AgentHarness.ts`、`harness/persistence/PersistenceService.ts` |
| A-Evolution-Engine | `EvolutionEngine` | `src/evolution/EvolutionEngine.ts` | `core/JiabaixingCore.ts`、`evolution/EvolutionEngineV2Adapter.ts`、`evolution/EvolutionOrchestrator.ts`、`evolution/FeedbackCollector.ts`、`evolution/SkillUsageTracker.ts`     |

**根因判定**：迁移只做了一半——注释宣布"完工"，但 TS 调用方没切干净。这解释了记忆里"文档脱节"的根源。
**建议**：要么真正把这些调用方切到 Python 桥并删除 TS 引用；要么至少把注释从"默认不用"改成"仍作为 fallback 被 X 引用"，别让注释继续骗后来人。

---

## 4. 类别三 · 死代码/未挂载（文档标 ✅ 但生产没装配）——改代码 + 降级 ✅

> ARCHITECTURE.md §1.5 把下列组件标为 ✅（功能已对齐），但探针发现它们**只有定义、没被任何生产代码 import/实例化**（仅自身/仅测试/仅 CLI 可达）。

| 探针ID                | 组件                  | 文件                                           | 说明                                                           |
| --------------------- | --------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| B-CheckpointService   | `CheckpointService`   | `src/harness/persistence/CheckpointService.ts` | TS 死代码；真实实现在 `python/agent/persistence/checkpoint.py` |
| B-ObsidianProvider    | `ObsidianProvider`    | `src/memory/external/ObsidianProvider.ts`      | 定义了但从未被 `new`                                           |
| B-Mem0Provider        | `Mem0Provider`        | `src/memory/external/Mem0Provider.ts`          | `implements` 基类但未被装配                                    |
| B-ThemeManager        | `ThemeManager`        | `src/cli/themes/ThemeManager.ts`               | 无任何 import                                                  |
| B-VoiceSessionManager | `VoiceSessionManager` | `src/multimodal/VoiceSessionManager.ts`        | "全双工语音 ✅" 实为未挂载                                     |
| B-PluginManager       | `PluginManager`       | `src/plugins/PluginManager.ts`                 | `main.ts`/`bootstrap.ts`/`cli.ts` 均无装配                     |
| B-PluginLoader        | `PluginLoader`        | `src/plugins/PluginLoader.ts`                  | 插件系统整体未接入生产                                         |

**根因判定**："✅"名不副实——写了类没接线。
**建议**：逐个决策"接入生产装配"或"删除+把 §1.5 该项从 ✅ 降级为 🟡/移除"。按 §0.3，未端到端联通不算"已完成"。

> ⚠️ 探针口径说明：`CuratorService` 被判 PASS，因为它在 `src/cli/commands/curator.ts` 有引用；但更细看它**只挂在 CLI 子命令、未接入"技能渐进披露"主链路**。属"CLI 可达但主链路未接"的灰色项，建议人工复核（探针的 prodRefs 口径较粗，未区分 CLI 与 harness 链路）。

---

## 5. 类别四 · 文档过期（点名 Python 组件/已删文件/过期宏观描述）——改文档

> 这些 FAIL 的根因在**文档**，不在代码。代码已演进，文档没跟上。

| 探针ID                | 断言                                                                                   | 事实                                                                                           | 建议                              |
| --------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| B-TTSProviderRegistry | §1.5 把 `TTSProviderRegistry` 当 TS 组件标 ✅                                          | TS 侧无此定义，是 Python 端组件                                                                | 文档改标为 Python 组件            |
| B-PromptCacheManager  | §1.5/§3.4 把 `PromptCacheManager` 当 TS 组件                                           | TS 侧无此定义，实现在 `python/agent/llm/prompt_cache.py`                                       | 同上                              |
| D-dangling-path       | §3.4 点名 `src/models/{SqliteCacheStore,PromptCacheManager,PromptCache,RedisCache}.ts` | **四个文件均已不存在**（缓存整体迁 `python/agent/llm`）                                        | 删除 §3.4 的 TS 路径点名          |
| D-storage             | 全局称 "SQLite + ChromaDB 双向量存储"（TS 中心）                                       | 实际运行为 **Python 中心 SQLite/FTS5**；`ChromaVectorDatabase.ts` 仅 TS 遗留、生产未直接实例化 | 宏观架构描述改为 Python 中心存储  |
| D-port                | §1.1 只写 "端口 3111"                                                                  | 实际是 **TS 网关 3111 + Python 后端 3112** 双端                                                | 补 3112 与 `AGENT_BACKEND=python` |

---

## 6. 类别五 · 假绿（空体 skip 冒充覆盖）——改测试

| 探针ID      | 位置                                       | 事实                                                                                                 | 建议                                                       |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| C-stub-skip | `tests/e2e/HermesFeatures.e2e.test.ts:129` | `test.skip('19. LLM 能力探测集成到进化编排器（已迁移到 Python）', async () => {})` —— 空体 skip 存根 | 删除存根，或对"迁移到 Python 后的等价行为"补真实端到端断言 |

> 好消息：`C-tautology`（恒真断言守卫）**PASS**——2026-07-14 上线的 `check-no-tautology-tests.mjs` 生效，全仓无 `expect(true).toBe(true)` 类空壳。这条防线是有效的。
> 中性说明：Python 端 `test_redis_cache.py` / `test_redis_memory_pipeline.py` 用的是 `skipif(REDIS_ENABLED != true)` 环境门控，属**合理**跳过，非假绿，探针未计入违规。

---

## 7. 建议的处置顺序（若后续要动手）

按"改动风险 × 价值"排序，仅供参考，**本轮不执行**：

1. **改文档（零风险、立刻做）**：类别四 5 条 + 类别三的 ✅ 降级。让文档先不再骗人。
2. **改测试（低风险）**：类别五 1 条。删空体 skip 或补真实断言。
3. **改注释（低风险）**：类别二把"默认不用"改成事实描述，消除误导。
4. **改代码（需排期、按 §0.1 迁移）**：类别一 5 条 + 类别二的真正切换。其中 `MCPServerManager`(1193行) 价值最高、也最重。
5. **死代码决策（中风险）**：类别三逐个"接线 or 删除"，别再挂空 ✅。

---

## 8. 复跑方式

```bash
node scripts/doc-derived-audit.mjs          # 控制台报告 + 退出码(有FAIL=1)
cat docs/doc-derived-audit-result.json      # 机器可读结果
```

探针是**活的规格守卫**：每次改完代码或文档后复跑，FAIL 数应单调下降。当某条从 FAIL 变 PASS，就是"文档与代码重新对齐"的客观证据——而不是拍脑袋说"应该修好了"。

---

## 9. 后续轮次更新（2026-07-14 第二轮：进代码层）

> 第一轮（改文档+测试）后 FAIL 21→15。第二轮进入代码层，先做类别二"改注释"。

### 9.1 类别二诚实修正（已完成，零功能风险）

对 `src/models/LLMProvider.ts`、`src/memory/MemoryEngine.ts`、`src/evolution/EvolutionEngine.ts`：

- **删除了所有虚假 `@deprecated` 标签**（这些文件在默认 `AGENT_BACKEND=python` 下仍被核心代码引用，根本没废弃）。
- 头部注释改写为事实：仍是 ACTIVE TS 实现 + Python 后端不可用时的回退角色 + §0.1 待迁移。

### 9.2 关键发现：探针是"结构性守卫"，注释/文档文字改不了 FAIL

复跑后 FAIL 仍为 **15**，类别二 3 条从"注释脱节"**重分类为"代码违规（类别一）"**，FAIL 数不变。

原因（已用代码验证）：

- 探针类别二判定 `hasDeprecated` 只做正则 `/@deprecated/i` **字面匹配** + 数生产引用，**完全不读注释里的"默认不用"等文字**。注释写得再真，只要还有 `@deprecated` 字面 token + 生产引用，就 FAIL。（踩坑实录：第一轮改写注释时误把"@deprecated 标签已移除"写进注释，字面 token 仍在，探针照样判 FAIL，剔除字面 token 后才重分类成功。）
- 探针类别三判定只查"类是否在生产代码被引用"，**不读 ARCHITECTURE.md 的 ✅**。所以"删文件 + 把文档 ✅ 降级"降不了 FAIL（删文件只会重分类为"文档过期"型 FAIL）。

**结论：剩余 15 条 FAIL 全部需要真实代码改动才能下降，没有"改注释/改文档"的免费降分。**

- 原类别二 3 条 + 原类别一 5 条 = **8 条"代码违规"**，需 TS→Python 迁移（去掉生产引用）。
- 类别三 7 条"死代码"，需**真接线**（让类被生产引用）才能 PASS；仅删或仅降级文档无效。

### 9.3 下一步（需真实代码改动，等用户拍板）

- 路线 A：类别三选一个低风险组件真接线（翻 1 条 PASS 作试点）。
- 路线 B：类别一从最轻的 TS 类起步迁移（重）。
- 路线 C：暂停降 FAIL，先产出迁移/接线方案再排期。
