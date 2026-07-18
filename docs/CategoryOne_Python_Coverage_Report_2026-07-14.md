# 类别一迁移 · Python 覆盖评估报告

> 生成日期：2026-07-14 ｜ 目的：在动手迁移前，先量化 TS 三大枢纽的 Python 后端覆盖度，确定安全顺序
> 方法：对 `MemoryEngine` / `LLMProvider`(+`MultiModelLLMProvider`) / `MCPServerManager` 三个枢纽，逐一枚举 TS 公共方法 → 映射 Python 引擎方法 + HTTP 端点 → 标注 COVERED / PARTIAL / MISSING

---

## 0. 一句话结论

**按"Python 已就绪度"排序，原定的"记忆→LLM→MCP"顺序应当反转为 `MCP → LLM → Memory`：**
`MCPServerManager` 虽是 1193 行的"最大块头"，但 Python 端**几乎已完整实现**它的全部方法，只差 4 个 HTTP 路由；
而 `MemoryEngine` 虽看似普通，Python 端**缺漏最多**（反馈信号、用户画像、知识图谱、衰减/做梦、加密、traceId 追踪等一大片逻辑都没有）。

| 枢纽         | Python 引擎覆盖                  | 暴露端点  | 调用点 | 迁移就绪度 | 主要缺口                        |
| ------------ | -------------------------------- | --------- | ------ | ---------- | ------------------------------- |
| **MCP 入口** | ~90%（30/30 方法）               | 缺 4 路由 | ~30    | 🟢 **高**  | 仅补 4 个 HTTP 路由             |
| **LLM 枢纽** | ~40%（chat/工具/健康/流式就绪）  | 部分      | ~30    | 🟡 **中**  | 多模态/代码助手/多模型路由      |
| **记忆枢纽** | ~35%（store/retrieve/stat 就绪） | 部分      | ~48    | 🔴 **低**  | 大片引擎逻辑缺失，需先写 Python |

---

## 1. 记忆枢纽（MemoryEngine + Short/Long）— 🔴 就绪度低

Python 已挂载 `/v1/memory`（`main.py:183`），有 `search`/`store`/`stats` 三端点 + `engine.py` 引擎方法。但 **TS 侧 ~40 个公共方法里约 20+ 在 Python 端完全缺失**。

### 1.1 覆盖矩阵（节选关键方法）

| TS 方法                                                                       | Python 引擎                                           | Python 端点   | 状态       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- | ---------- |
| `storeShortTermMemory` / `storeLongTermMemory` / `storeInstantMemory`         | `store_short_term/long_term/instant` (engine.py:584+) | POST `/store` | ✅ COVERED |
| `preciseHybridRetrieval` / `retrieveTaskMemory`                               | `search`/`search_with_context` (139/217)              | GET `/search` | ✅ COVERED |
| `getEpisodicMemoryStats`                                                      | `get_stats` (574)                                     | GET `/stats`  | ✅ COVERED |
| `retrieveFromPersistentStorage`                                               | `search`/`get_recent`                                 | GET `/search` | ✅ COVERED |
| `initialize` / `storeEpisodicMemory` / `retrieveEpisodicMemory`               | 引擎方法存在                                          | —（无端点）   | 🟡 PARTIAL |
| `retrieveEmotionMemory`                                                       | `search` 无 emotion 维度                              | GET `/search` | 🟡 PARTIAL |
| `getRecentConversations`                                                      | `get_recent` (424)                                    | —（无端点）   | 🟡 PARTIAL |
| `shutdown`                                                                    | `MemoryStore.close` (store.py:547)                    | —             | 🟡 PARTIAL |
| `storeFeedbackSignal` / `queryRecentFeedback`                                 | —                                                     | —             | ❌ MISSING |
| `getUserProfile` / `isInitialized`                                            | —                                                     | —             | ❌ MISSING |
| `updateMemory`(晋升判断) / `mergeAndSortMemories`                             | —                                                     | —             | ❌ MISSING |
| `storeEncryptedLongTermMemory` / `decryptLongTermMemory`                      | —                                                     | —             | ❌ MISSING |
| `calculateDecayScore` / `updateDecayScores`                                   | 内嵌于 search                                         | —             | ❌ MISSING |
| `markUserActive` / `getDreamStats` / 写队列背压                               | —                                                     | —             | ❌ MISSING |
| `retrieveByTraceId` / `storeWithTracking` / `retrieveWithTracking`            | —                                                     | —             | ❌ MISSING |
| `getKnowledgeGraph` / `identifyKnowledgeGaps` / `compressConversationHistory` | —                                                     | —             | ❌ MISSING |

### 1.2 调用方（~48 处，9 个生产文件）

- `src/server/init/initHarness.ts` **~27 处**（retrieve×9、store×18）
- `src/harness/persistence/PersistenceService.ts` ~6、`src/core/MemoryAssistant.ts` ~7
- `UnifiedContextPipeline` / `InteractionEngine` / `ContinuousDialogManager` / `memoryRoutes` / `systemStateRoutes` / `bootstrap` 各 1–2

### 1.3 阻塞缺口（需先写 Python）

1. 新增端点：`/v1/memory/get_all`、`/recent`、`/episodic`、`/profile`、`/encrypt`、`/decrypt`、`/trace/{id}`
2. 补全引擎逻辑：**反馈信号**、**用户画像**、**知识图谱/缺口识别**、**衰减/做梦机制**、**加密长时记忆**、**traceId 追踪**、**写队列背压**
3. `emotion` 检索维度（当前 Python `search` 仅支持 `scene_filter`）

> ⚠️ 记忆枢纽若要迁移，**前置工作量主要在 Python 端（写一大片引擎逻辑）**，不是简单重路由。建议放到最后，或先只迁移"已 COVERED 的那部分方法"做渐进切流。

---

## 2. LLM 枢纽（LLMProvider + MultiModelLLMProvider）— 🟡 就绪度中

Python `agent/llm/` 已有 `LLMProvider.chat`/`chat_with_tools`/`chat_stream`(SSE) + OpenAI 兼容端点 `/v1/chat/completions`，多模型有 `ProviderManager` + `/providers` 路由。但**多模态、代码助手、多模型路由策略缺失**。

### 2.1 覆盖矩阵

| TS 方法                                                                                        | Python 等效                                                               | 状态                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| `chat`                                                                                         | `provider.chat` (126) + `/v1/chat/completions`                            | ✅ COVERED                              |
| `chatWithTools`                                                                                | `chat_with_tools` (414)                                                   | ✅ COVERED                              |
| `healthCheck` / `isAvailable`                                                                  | `check_available` (525) + `/health`                                       | ✅ COVERED                              |
| `streamChat`（消费流式）                                                                       | `chat_stream` (445) + SSE `/completions?stream=true` + WS `/stream/{sid}` | ✅ 机制就绪，需**新增 TS 桥接方法**消费 |
| `getModelName`                                                                                 | 仅 `self.model`                                                           | 🟡 PARTIAL                              |
| `generate`（fallback 链）                                                                      | `chat_with_tools` 仅单异常回退                                            | 🟡 PARTIAL                              |
| `registerModel` / `unregisterModel`                                                            | `ProviderManager` + `/providers`                                          | ✅ COVERED                              |
| `route`（RoutingStrategy）                                                                     | 仅 primary+fallback 单回退                                                | ❌ MISSING（无能力/优先级路由）         |
| `benchmarkModel` / 健康熔断                                                                    | —                                                                         | ❌ MISSING                              |
| `multimodalChat` / `multimodalCodeAnalysis`                                                    | —                                                                         | ❌ MISSING                              |
| `analyzeCode` / `generateModificationPlan` / `generateModifiedFileContent` / `devGenerateCode` | —                                                                         | ❌ MISSING                              |
| `markLocalUnavailable` / `resetAvailability`                                                   | 无状态标志（自动 fallback 部分覆盖）                                      | ❌ MISSING                              |

### 2.2 调用方（~30 处）

- `new LLMProvider` ×4（JiabaixingCore / DesktopVision / DesktopExecutionAgent / DesktopAgentLoop）
- `MultiModelLLMProvider.getInstance` ×3（coreRoutes / performanceRoutes）
- `chat` ×~18、`multimodalChat` ×2、`chatWithTools` ×1、`markLocalUnavailable` ×2 + harness/tools/memory 间接调用 ~8

### 2.3 阻塞缺口

1. **流式桥接**：Python 已有真实 SSE/WS，但 TS 无 `streamChat` 消费方法 → 需新增 TS 桥接（HTTP SSE 或 WS 客户端）
2. **多模型路由/故障转移**：Python 仅单 primary+异常回退，缺 `RoutingStrategy`(PRIORITY/CAPABILITY)、failover 链、健康熔断、benchmark → 需新建 Python `LLMManager`/`Router`
3. **多模态/代码助手**：6 个方法无 Python 对等 → 需实现或统一委托给 `chat`(含 vision)

> 🟡 LLM 枢纽"读/聊"已就绪，难点在**流式桥接 + 多模态/代码助手 + 多模型路由**三块。可先做"chat/工具/健康/流式"切流（覆盖 ~60% 调用点），多模态/路由留第二批。

---

## 3. MCP 入口（MCPServerManager，1193 行）— 🟢 就绪度高

**关键发现**：Python `agent/mcp/server_manager.py` **已实现 TS 全部公有方法**（含 stdio 子进程 `asyncio.create_subprocess_exec` + HTTP/SSE 双传输），TS 端 `child_process.spawn` 的进程生命周期 Python 已接管。仅缺 **4 个 HTTP 路由**暴露层。

### 3.1 覆盖矩阵（节选）

| TS 方法                                                        | Python 等效                                 | Python 端点                           | 状态       |
| -------------------------------------------------------------- | ------------------------------------------- | ------------------------------------- | ---------- | --- |
| `getInstance` / `resetInstance`                                | `get_instance`/`reset_instance`             | —                                     | ✅         |
| `startServer` / `stopServer`                                   | `start_server`/`stop_server`                | POST `/servers/{n}/start              | stop`      | ✅  |
| `callTool`                                                     | `call_tool`                                 | POST `/servers/{n}/tools/call`        | ✅         |
| `listResources` / `readResource` / `listPrompts` / `getPrompt` | 对应方法                                    | GET/POST 对应端点                     | ✅         |
| `getServerStatus` / `getAllServerStatus`                       | `get_server_status`/`get_all_server_status` | GET `/servers`、`/servers/{n}/status` | ✅         |
| `registerServer`                                               | `register_server`                           | ❌ **无路由**                         | 🟡 PARTIAL |
| `startAllServers`                                              | `start_all_servers`                         | ❌ **无路由**                         | 🟡 PARTIAL |
| `sendMessage`（JSON-RPC 透传）                                 | `send_message`                              | ❌ **无路由**                         | 🟡 PARTIAL |
| `listTools`                                                    | `list_tools`                                | ❌ **无路由**                         | 🟡 PARTIAL |

### 3.2 调用方（~30 处，6 个生产文件）

- `bootstrap.ts`（启动）、`shutdown.ts`（优雅关闭）
- `mcpRoutes.ts`（HTTP 入口 :3111，~12 调用）
- `MultiPlatformGateway.ts`、`TRAEOptimizationIntegrator.ts`
- `harness/tools/registry/MCPToolBridge.ts`（工具桥接 ~8 调用）

### 3.3 阻塞缺口（最小）

仅需补 4 个 HTTP 路由（引擎方法已存在，router 挂 `/v1`）：

1. `GET /v1/mcp/servers/{name}/tools` → `list_tools`
2. `POST /v1/mcp/servers/{name}/message` → `send_message`
3. `POST /v1/mcp/servers/start-all` → `start_all_servers`
4. `POST /v1/mcp/register` → `register_server`（需加 pydantic 入参模型）

> 🟢 迁移后 TS 保留 **HTTP 转发薄壳**（`mcpRoutes` 直接 `axios` 到 `:3112`），不再持有 spawner。transport 无错配（stdio + http+sse 双支持）。风险最低。

---

## 4. 推荐迁移顺序（基于就绪度）

| 优先级   | 枢纽         | 理由                                                                                        | 预估工作量                 |
| -------- | ------------ | ------------------------------------------------------------------------------------------- | -------------------------- |
| **① 先** | **MCP 入口** | Python 引擎完整，仅补 4 路由 + 转发薄壳；调用点集中（6 文件）；可一次性低风险清零 1 条 FAIL | 低（约 1 轮）              |
| **② 次** | **LLM 枢纽** | 先切 chat/工具/健康/流式（覆盖 ~60% 调用点），多模态/路由留第二批                           | 中（2–3 轮）               |
| **③ 后** | **记忆枢纽** | Python 缺一大片引擎逻辑，需先补后端；或仅先迁"已 COVERED 方法"做渐进切流                    | 高（需先写 Python，3+ 轮） |

---

## 5. 请你定

1. **采纳反转顺序 `MCP → LLM → Memory`**（推荐，最稳，能从低风险处快速清零 FAIL 并积累桥接范式）
2. **仍按原顺序 `记忆 → LLM → MCP`**（从最难的开始，但符合"先啃硬骨头"）
3. **只先做 MCP 这一条**（最小验证，与 EvolutionEngine 试点同量级，补 4 路由即可清零 1 FAIL，再决定后续）

> 无论哪种，按 §0.1，`LLMProvider`/`IMemoryEngine`/`MCPServerManager` 等 **interface/type 契约建议保留为 TS 桥接契约**（实现委托 Python），不整文件删除，以控制下游类型改动规模。
