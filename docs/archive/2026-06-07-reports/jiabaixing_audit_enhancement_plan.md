# 家百星（Jiabaixing）全面代码审计与增强方案

> **审计方法**：本轮审计严格遵循「不采信文档宣称，所有结论来自实时探测（`grep`/`read`/`pytest`）」原则。
> 由 5 个只读审计代理分别对 LLM 底座、执行引擎、感知层、行动层、TS 桥接五个子系统做实证探查，本文为综合结论。
> **审计基准**：`python/agent/`（Python 真后端，FastAPI `:3112`）、`src/`（TS 入口/桥接/UI）。
> **总体判定**：Agent 核心能力绝大部分为**真实落地**（Python 主实现），但存在四类共性缺陷——①「已写未接线」逻辑空转；②「桩伪装成功」（网关模拟态上报 connected/sent=true）；③「TS 影子核心」违规独立实现且静默降级；④「缺失感官 / 跨平台」。下方逐模块给出改进点、实现目标与验收标准。

---

## 0. 总体成熟度评分卡

| 模块 | 真实度 | 风险 | 一句话结论 |
|---|---|---|---|
| LLM 底座（provider/catalog/路由/成本） | 中高 | 🔴 | 16 家「支持」实为 litellm 代理壳；能力路由/成本守卫写了未挂主链路 |
| 记忆与上下文（MemoryEngine/向量/压缩） | 高 | 🟡 | 三层记忆 + FTS5 + 压缩真在跑；语义向量默认降级 |
| Agent 执行引擎（ReAct/规划/工具/进化） | 高 | 🔴 | 规划/自纠错/进化均真实；防护模块未串入主执行路径 |
| 感知层（五感） | 中 | 🔴 | 视觉/文本/ASR 真实；听觉输出+麦克风为桩；总线已建未跑 |
| 行动层（手/脚/网关/MCP/A2A） | 高 | 🔴 | 工具/MCP/A2A 真；网关模拟静默成功、Win 沙箱无硬隔离 |
| TS 桥接与交互闭环 | 中 | 🔴 | 桥真实；Python 掉线静默回退 TS 影子核心，违反 AGENTS.md §0.1 |
| 安全护栏（posture/approval/sandbox/SSRF） | 高 | 🟡 | 决策矩阵/审批/SSRF 真拦截；Win 内存限制靠轮询 |

**核心闭环模型（目标态）**：`感知(五感) → 认知(LLM底座+记忆) → 决策(规划+自主决策+护栏) → 行动(工具+桌面+网关) → 反馈(轨迹+进化)`。当前断点在：感知总线空转、执行路径缺防护串联、TS 影子核心、网关伪连通。

---

## 1. 模块 A：LLM 底座（强化「LLM 底座能力」）

### 现状（真实 vs 桩）
- ✅ 真实：`litellm.acompletion` + `transports.py` 四种真实现（OpenAI/Anthropic/Gemini/Bedrock）；`router.get_fallback` 失败切换；`CircuitBreaker` 熔断（`provider.py:114`）、`AdaptiveRateLimiter` 限速；function-calling（`convert_tools` 真实）；流式 SSE 真实；`CostGuard` 成本守卫、`TieredCache`（SQLite L1/L2）真实可用。
- 🔴 `provider_catalog.py` 声明 16 家厂商元数据，**无独立 SDK**，窄腰 `catalog` 实为元数据壳而非路由抽象层；`vertex`/`bedrock` 标 `oauth_supported=True` 但注释「本轮回做握手」= **未实现**。
- 🔴 `CapabilityAwareRouter`（`capability_aware_router.py`）：仅测试实例化，`set_capability_router` 无生产调用 → 运行时任务级选型为 **no-op**。
- 🔴 `ModelCostGuard`：`engine.py:4785` 实例化但主 `chat` 路径未调用 `check_before_call` → 模型级自动降级不生效。
- 🟡 `VectorStore`（ChromaDB）可选依赖，未装则 `is_available()=False` 降级空操作，embedding 失败返回空向量 → 语义检索默认可能失效。
- 🟡 `REDIS_ENABLED_DEFAULT=False`：记忆热路径默认无分布式缓存。

### 改进点与目标 / 验收标准

| 改进点 | 实现目标 | 验收标准 |
|---|---|---|
| A1 能力路由真正挂载 | 在 `LLMProvider.chat()` 主路径调用 `CapabilityAwareRouter.select_for_task`，按任务类型（代码/推理/多模态/长上下文）选模型 | 集成测试证明：给定任务标签，chat 实际路由到对应 provider；无 mounted 时断言失败了测试 |
| A2 成本守卫接入主链路 | `chat()` 调用前 `ModelCostGuard.check_before_call`，超限自动切 fallback 模型 | 单测+集成：预算超限触发降级且记录事件；默认配置下主路径覆盖率 100% |
| A3 窄腰 catalog 落地或去宣称 | 把 catalog 改造为真实 provider 抽象（统一接口 + 真实 OAuth 握手），或删除未实现的 16 家宣称 | `available_providers()` 仅返回已验证可实例化的 provider；OAuth 厂商有真实 token 获取路径或明确标注未支持 |
| A4 向量检索可观测降级 | ChromaDB 不可用时显式告警并退回 FTS5，不在无感知下降级 | 启动期打印 availability；降级路径有日志 + 单测覆盖 |
| A5 缓存默认策略 | 明确 Redis 开启条件；本地 TieredCache 作为最低保障 | 无 Redis 时 TieredCache 命中率有单测；配置文档说明 |

---

## 2. 模块 B：记忆与上下文

### 现状
- ✅ `MemoryEngine` 真实：即时/短期/长期三层 + TTL（`engine.py:702`），底层 `MemoryStore` SQLite+FTS5（jieba 中文分词）。
- ✅ `ContextCompressor` + `ConversationCompression` 已接线到 `core/engine.py` 与 `loop/controller.py` 的 `check_and_compress` → **真在跑**。
- 🟡 语义向量默认降级（见 A4）；知识图谱为朴素文本相似，非真向量/图。

### 改进点与目标 / 验收标准

| 改进点 | 实现目标 | 验收标准 |
|---|---|---|
| B1 语义检索保底 | ChromaDB 缺失时提供本地轻量向量（如 `sentence-transformers` 本地模型）或明确 SKU 依赖 | 无外部服务时语义检索仍返回非空结果；单测覆盖降级 |
| B2 长期记忆去重/衰减 | 长期记忆引入相似度去重与遗忘曲线，避免无限膨胀 | 压测脚本验证长会话下存储增长受控；去重单测 |
| B3 压缩可解释 | 压缩前后保留关键事实清单，供轨迹回放 | 压缩单测断言关键信息保留率 ≥ 阈值 |

---

## 3. 模块 C：Agent 执行引擎（重点——规划/决策/工具/推理）

### 现状
- ✅ **ReAct 真实**：`controller.run_react_loop`（`controller.py:1091`）结构化 `Thought(JSON)→Action→Observation`，工具失败进入 `while correction_attempts<REACT_MAX_CORRECTIONS` 双路径自纠错：路径 A `reflection.corrected_args` 修正参数重试，路径 B `reflection.alternative_tool` 降级替代工具；`_evaluate_thought_quality` 检测敷衍推理。
- ✅ **规划真实**：`Planner` LLM 语义复杂度分级 → complex 走 Tree-of-Thoughts（`plan_with_tot`）；`replan` 用 `IncrementalPlanner` 增量修正；`HierarchicalPlanner` 递归分解 + 依赖图 + 并行组 `compute_parallel_groups`。
- ✅ **工具执行健壮性**：Executor 重试 `_retry_with_reflection`/`_retry_with_backoff`（指数退避）、熔断器 `get_circuit(threshold=3)`、超时 `asyncio.wait_for`、并发 `asyncio.gather(return_exceptions=True)`；`SchemaValidator` 真实（类型/必填/枚举/嵌套）；`ToolCallGuard` 真实（缓存/去重/限速/宪法闸门）。
- ✅ **进化引擎真实**：`EvolutionEngine.record_signal` 累积成败、`get_adjusted_tool_priority`（按成功率排序）、`get_adjusted_reflection_config`（按成功率动态调反思深度）、`generate_skill`、状态持久化 `engine-state.json`。
- ✅ **自主决策门禁真实**：`runtime_posture`（SAFE/CONFIRM/AUTO/YOLO × 风险 → ALLOW/DENY/REVIEW，critical 永不放行）+ `ApprovalManager`（规划预览/执行复用/超时 120s 自动拒/lockdown/SafetyNet）。
- 🔴 `evolution/multi_agent.py` **源码缺失**（仅 `.pyc`），与 AGENTS.md 路径不符；真实多智能体在 `orchestration/agent_factory.py` 的 `MultiAgentOrchestrator`。
- 🔴 **执行主路径未接防护**：`python/agent/loop/` 对 `schema_validator`/`ToolCallGuard` grep 零命中——用户最看重的执行入口**未串入**入参校验与调用守卫（防护只在 `conversation_loop` 生效）。
- 🟡 并发无 `Semaphore` 上限；层级 HTD 规划树未端到端贯通（子目标级回滚缺失）；工具超时单值、重试默认偏低。

### 改进点与目标 / 验收标准

| 改进点 | 实现目标 | 验收标准 |
|---|---|---|
| C1 防护串联主路径 🔴 | 在 `LoopController`/`Executor`/ReAct 入口统一调用 `SchemaValidator` + `ToolCallGuard`（去重/缓存/限速/宪法闸门） | 集成测试：构造非法参数工具调用在主执行路径被拦截；重复调用命中去重；覆盖率 100% 串接 |
| C2 清理命名残骸 🔴 | 删除 `evolution/multi_agent.py` 仅 `.pyc` 残骸或补回源码；路径统一到 `orchestration/` | `git status` 无孤儿 `.pyc`；导入图无悬空引用 |
| C3 层级规划端到端贯通 🟡 | `HierarchicalPlanner` 分解的子目标在执行器内可独立回滚/重规划，并写入轨迹 | e2e：注入子目标失败 → 仅该分支重规划，兄弟分支不受影响 |
| C4 并发配额 🟡 | Executor 并发加 `Semaphore(max_concurrency)`，按风险/能力分级超时与重试预算 | 压测：超额并发被限流且不崩；资源占用受控单测 |
| C5 进化反馈闭环校验 🟡 | 验证 `record_signal` 埋点完整性（每个工具成败都上报），避免自适应退化 | 埋点覆盖率测试 ≥ 99%；`get_adjusted_tool_priority` 行为有断言 |

---

## 4. 模块 D：感知层（五感）—— 补全「感知」接口与实现

### 现状（五感映射）
| 感官 | 接口 | 真实实现 | 状态 |
|---|---|---|---|
| 视觉 Vision | `screen_parse`/`VisualGrounding`/`ScreenWatcher`/`vlm_call` | 桌面截图 + Windows UIA/macOS A11y/OCR 三级降级；VLM 走 `litellm`(`gpt-4o`) | ✅ 已接入 |
| 听觉·输入 ASR | `speech_transcribe` | `faster-whisper` 本地模型（仅文件输入） | ✅ 已接入 |
| 听觉·输出 TTS | `voice_interact(speak)`/`tts_speak` | 仅 `simulated:true` 模拟 | 🔴 桩 |
| 听觉·麦克风 | `voice_interact(listen)` | `Buffer.from('模拟音频输入数据')` | 🔴 桩 |
| 文本/语言 | `emotion_perceive`/`scene_perceive`/OCR | LLM 语义 + 规则回退；`LocalOCR`(Paddle/Tesseract) | ✅ 已接入 |
| 环境/本体感 | `environment_sense`/`device_sense`/`ProprioceptionChannel` | 代码真实但无数据源（需 TS DeviceManager 网关未接通） | 🟡 半通 |
| 嗅觉/味觉（隐喻） | 无 | 无 | 🔴 缺失 |

- ✅ 有统一融合层 `SenseSample(modality,content,confidence)` + `SensoryFusion`（加权/拼接）；`PlatformAdapter(ABC)` 工厂；`SharedPerceptionBus` 支持多子 Agent `trace_id` 汇聚。
- 🔴 `PerceptionBus.perceive()` **已建未跑**：`engine.py` 构造了总线，但全源码搜不到 `bus.perceive()` 被主循环调用 → 五感未真正驱动决策。
- 🔴 `perception_fuse` 仅注入 `environment`+`proprioception` 两通道，未纳入 visual/audio/ocr。
- 🟡 无统一 `Sensor`/`InputAdapter` 注册表 → 新增感官需改源码（不支持热插拔）。

### 改进点与目标 / 验收标准

| 改进点 | 实现目标 | 验收标准 |
|---|---|---|
| D1 总线接入主循环 🔴 | 在 Loop 的 `PERCEIVING` 阶段调用 `bus.perceive()` 并注入 `LoopContext` | 集成测试：开启总线后，主循环每轮携带感知样本；无总线时优雅降级 |
| D2 听觉输出/输入真后端 🔴 | 接入 Edge-TTS / azure-cognitive / pyttsx3（TTS）与 PyAudio 麦克风流（listen） | 单测：TTS 产出非空音频；麦克风采集真实音频帧 |
| D3 复用 ASR 做 audio 通道 🔴 | 把 `speech_transcribe`(faster-whisper) 接为 `PerceptionBus._perceive_audio` 采集器，替换空桩 | 总线 audio 通道返回真实转录文本；不再 return 空 `AudioState()` |
| D4 融合层补全通道 🟡 | `perception_fuse` 纳入 visual/audio/ocr 样本（封装为 `SenseSample`） | 融合输出含多模态字段；单测断言各通道贡献 |
| D5 传感器注册表 🟡 | 抽象 `BaseSensor` 注册表，支持热插拔感官适配器 | 新增一个自定义 Sensor 无需改 `bus.py`；注册/注销单测 |
| D6 环境/本体感数据源 🟡 | 实现 TS `DeviceManager` MQTT/HTTP 接入并打到 `/v1/devices/telemetry` | 设备遥测真实流入 `environment_sense`；无数据时明确空态告警 |
| D7 嗅觉/味觉隐喻占位 🟢 | 映射为「领域信号感知」（代码异味、数据异常检测），新增 `smell`/`taste` 模态示例适配器 | 示例适配器可注册并产出 `SenseSample` |

---

## 5. 模块 E：行动层（手脚）—— 补全「行动」接口与实现

### 现状
- ✅ **手（工具执行）真实**：`tools/` 52 模块——`code_execution_tool.py`（子进程沙箱+黑名单+超时+输出截断）、`sandbox/executor.py`（多语言 py/js/shell + Unix `setrlimit` + psutil）、`file_tools`/`code_tools`/`git_tools`（真实 subprocess，无 shell 注入）、`network_tools`（SSRF 防护）、`browser_tools`（Playwright 30KB）、`desktop_tools`+`desktop_controller`（鼠标/键盘/截图/窗口/剪贴板/shell）。
- ✅ **脚（触达/移动）**：桌面自动化真实（强依赖 Windows）；`MCP` 真实双通道（STDIO + HTTP/SSE JSON-RPC，默认 filesystem/sqlite/browser/cron）；`A2A` 真实（`A2AClient` 完整 Task 生命周期 + 鉴权 + `server.py` FastAPI）。
- ✅ **安全**：`ApprovalManager.request_approval` 链路 lockdown→`runtime_posture.decide`→SafetyNet→用户审批（critical 永不放行）；`write_approval` 路径风险评分；`network_tools.async_is_safe_url` 真实拦截私网/元数据。
- 🔴 **网关模拟静默成功**：8 个适配器（slack/whatsapp/signal/matrix/webhook/relay/api_server+通用）在缺凭证/SDK 时进「模拟模式」——`start()` 置 `_connected=True`、`send_message()` 返回 `True` 实际未发；`get_stats()` 把模拟态计为「connected」。宣称 8 平台 ≠ 实测连通。
- 🔴 **Windows 沙箱无硬内存隔离**：win32 下 `preexec_fn=None`，内存限制仅靠 psutil 轮询，无硬隔离。
- 🟡 桌面自动化跨平台缺失（非 Windows 鼠标/键盘/clipboard 不可用）；`file_parse_tools.py:343` OCR TODO 未接线；`test_gen_tools` 生成空断言模板。

### 改进点与目标 / 验收标准

| 改进点 | 实现目标 | 验收标准 |
|---|---|---|
| E1 网关状态诚实化 🔴 | 区分 real vs simulated；模拟态不上报 connected、不计入「连通」、显式告警 | 单元测试：无凭证适配器 `is_connected()=False`；发送返回明确未发送态 |
| E2 Win 沙箱硬隔离 🔴 | Windows 下用 Job Object / 容器 / WSL 限制内存与 CPU | 集成测试：内存超限进程被 kill；非靠轮询 |
| E3 桌面跨平台后端 🟡 | 补齐 Linux(X11/Wayland)、macOS 键鼠/剪贴板后端 | 各平台冒烟测试可用 |
| E4 OCR/解析真接入 🟡 | `file_parse_tools.py:343` 接真实 OCR 或显式报错而非 TODO | 解析单测产出非空文本或抛明确异常 |
| E5 测试生成质量 🟡 | `test_gen_tools` 生成可运行断言或显式标为模板（不得伪装通过） | 生成产物不含 `# TODO: 补充断言` 空断言 |
| E6 外部真连通冒烟 🟢 | 带真实凭证的 Slack/Signal/Matrix 集成冒烟（替代本地回路） | CI 可选 job：真实平台收发验证 |
| E7 MCP 离线健康 🟢 | `npx` 服务器离线启动失败标记为 unhealthy 而非仅 warning 吞掉 | 离线时 `get_server_status()=unhealthy` 并告警 |

---

## 6. 模块 F：TS 桥接与交互闭环（修复影子核心）

### 现状
- ✅ `src/ide/PythonAgentBridge.ts` **真实桥接**：HTTP(axios 连接池) + 双 WS（Chat `/`、EventBus `/v1/events`），`processInput` 优先 WS 流式、`WS→HTTP` 回退；`x-trace-id` 透传；指数退避重连。
- 🔴 **静默降级**：`bootstrap.ts:608-641` 仅 `healthCheck()` 成功才 `setPythonBridgeResolver`；失败则 `pythonBridge=null` 静默降 TS 本地。闭环完整性全取决于 Python `:3112` 在线。
- 🔴 **TS 影子核心违规**：`JiabaixingCore.processInput` 回退分支落到 `this.harness.processInput`，即完整 TS 本地 Agent 核心（`src/core/JiabaixingCore.ts`、`src/harness/loop/*`、`src/models/LLMProvider.ts`、`src/evolution/*`、`src/memory/*`）——这些模块标 `@deprecated`「python 默认不用」却**在生产回退路径实际运行**，违反 AGENTS.md §0.1。
- 🔴 `DesktopExecutionAgent.ts:26,113` 直接 `import { LLMProvider }` 并 `new LLMProvider()` 做决策 —— TS 独立 LLM 调用，违反 §0.1。
- 🟡 `ChatInterface` 确为死代码（活路径 = `DesktopDashboard`）；桥接未端到端实测（测试仅 mock bridge）。

### 改进点与目标 / 验收标准

| 改进点 | 实现目标 | 验收标准 |
|---|---|---|
| F1 降级显式化 🔴 | Python 掉线时 `healthCheck` 失败显式报错；`/api/health` 暴露 backend 状态（python/ts/local） | 前端在 Python 缺席时收到明确错误而非静默本地结果；health 端点反映真实 backend |
| F2 消除影子核心 🔴 | 移除或彻底隔离 TS 本地 Agent 核心；回退路径改为「报错 + 可选安全模式」，不在生产静默运行 | 代码扫描：回退分支不再调用 `harness.processInput`；`@deprecated` 模块无生产引用 |
| F3 桌面决策归 Python 🔴 | `DesktopExecutionAgent` 改用 `bridge.processInput`/`desktopAction`，删除本地 `LLMProvider` | grep 确认 TS 侧无 `new LLMProvider()` 做决策 |
| F4 桥接 e2e 实测 🟡 | 测试起真实 Python `:3112` 做端到端（替代 mock bridge） | e2e 测试套件覆盖 chat/stream/event 真链路 |
| F5 清理死代码 🟡 | 删除 `ChatInterface` 或恢复其用途 | 构建无未引用模块告警 |

---

## 7. 模块 G：安全护栏（跨切面，保留并强化）

- ✅ 已真实：`runtime_posture` 决策矩阵、`ApprovalManager`（超时自动拒/lockdown/SafetyNet）、`write_approval` 路径风险评分、`network_tools` SSRF 防护、`ToolCallGuard` 宪法闸门。
- 🟡 审批监听器失败被静默（代码注释 D2 自曝）→ 多通道冗余 + 失败告警。
- 与 C1/E1/E2 协同：护栏需随执行路径串联（C1）与网关诚实化（E1）一起生效。

---

## 8. 差异化优势构建（用户重点：规划/决策/工具/推理）

家百星的独特卖点应是 **「可信护栏 + 自我进化 + 多模态感知 + 真实工具执行」四位一体的闭环 Agent**，而非又一个纯对话 LLM。具体差异化能力设计：

### 8.1 任务规划（差异化：可恢复任务 DAG + 自适应选路）
- 现状真实：`Planner` 复杂度分级 → ToT / Incremental / Hierarchical；执行器按复杂度自动选路。
- 增强：① 把 HTD 层级规划树端到端贯通到执行与子目标级回滚（C3）；② 引入「规划置信度 + 不确定性预算」，低置信计划触发人工确认或 A/B 规划对比；③ 计划版本化（分支/回滚可审计）。
- **验收**：复杂任务 e2e 中，子目标失败仅局部重规划；规划置信度低时触发确认；计划变更写入轨迹可追溯。

### 8.2 自主决策（差异化：元决策层 + 风险预算累计）
- 现状真实：`runtime_posture × risk` 矩阵 + `ApprovalManager` + `EvolutionEngine` 数据驱动优先级。
- 增强：① 建「元决策层」——基于 `EvolutionEngine` 历史成败信号自动选工具/策略；② 风险预算跨步骤累计（避免单步 safe 但累积危险）；③ 反思深度随整体成功率自适应（`get_adjusted_reflection_config` 已部分）。
- **验收**：多轮任务后工具优先级收敛到高成功率工具；跨步风险累计触发降级；反思深度随成功率变化有断言。

### 8.3 工具调用（差异化：预算化 + 自愈 + 可解释轨迹）
- 现状真实：`SchemaValidator` + `ToolCallGuard` + ReAct 双路径自纠错（修正参数/替代工具）+ `tool_trace`。
- 增强：① 把校验/守卫真正串入 LoopController/Executor 主路径（C1，当前缺口）；② 并发配额 Semaphore（C4）；③ 工具调用「可解释轨迹」标准化（已部分 `tool_trace`，需全量）；④ 失败自愈从 ReAct 贯通到 Executor 入口。
- **验收**：主执行路径非法参数被拦截；超限并发被限流；每次工具调用产出标准化轨迹；失败后自动尝试替代工具并成功。

### 8.4 多步推理（差异化：反思缓存 + 因果链 + 长期推理记忆）
- 现状真实：ReAct T/A/O + 双路径自纠错 + Thought 质量评估 + ToT。
- 增强：① 「反思缓存」避免重复同类错误（复用 `EvolutionEngine` 信号）；② 因果一致性检查（Observation 与 Thought 预测不符时强制重推理）；③ 从 `TrajectoryDatabase` 抽取可复用推理模式 → `generate_skill`（已部分）形成长期推理记忆。
- **验收**：同类错误第二次出现时命中反思缓存并加速纠错；因果不一致触发重推理；成功推理模式被抽取为可复用 skill。

---

## 9. 优先级路线图（P0 → P2）

| 优先级 | 任务 | 模块 | 风险 | 依赖 |
|---|---|---|---|---|
| **P0** | C2 清理 multi_agent 残骸 / 统一路径 | C | 🔴 | 无 |
| **P0** | C1 防护串联主执行路径 | C | 🔴 | C2 |
| **P0** | F2 消除 TS 影子核心（静默降级） | F | 🔴 | 无 |
| **P0** | F3 桌面决策归 Python | F | 🔴 | F2 |
| **P0** | E1 网关状态诚实化（模拟≠连通） | E | 🔴 | 无 |
| **P0** | E2 Win 沙箱硬隔离 | E | 🔴 | 无 |
| **P0** | D1 感知总线接入主循环 | D | 🔴 | 无 |
| **P0** | D2/D3 听觉输出+麦克风真后端 | D | 🔴 | 无 |
| **P1** | A1/A2 能力路由 + 成本守卫挂主链路 | A | 🔴 | 无 |
| **P1** | A3 窄腰 catalog 落地或去宣称 | A | 🔴 | 无 |
| **P1** | C3 层级规划端到端贯通 | C | 🟡 | C1 |
| **P1** | C4/E 并发配额 + 跨平台桌面 | C/E | 🟡 | 无 |
| **P1** | D4/D5/D6 融合补全 + 传感器注册表 | D | 🟡 | D1 |
| **P1** | F4 桥接 e2e 实测 | F | 🟡 | F2 |
| **P2** | A4/A5/B1/B2/B3 检索保底/记忆治理 | A/B | 🟡 | 无 |
| **P2** | D7 嗅觉/味觉隐喻占位 | D | 🟢 | D5 |
| **P2** | E3/E4/E5/E6/E7 OCR/测试质量/冒烟 | E | 🟡 | 无 |
| **P2** | 差异化 8.1–8.4 深化 | C/D | 🟡 | C1/C3/D1 |

---

## 10. 验收总览（汇总）

- **架构合规**：无 TS 独立 Agent 核心在生产运行；降级显式化；`@deprecated` 模块零生产引用。
- **LLM 底座**：能力路由/成本守卫在主链路生效；provider 宣称与实况一致；语义检索有保底。
- **执行引擎**：防护（校验+守卫）100% 串入主路径；层级规划可回滚；并发受控；进化反馈闭环完整。
- **感知闭环**：总线驱动决策；五感（视觉/听觉输入输出/文本/环境）真实可用；支持热插拔 Sensor。
- **行动闭环**：网关状态诚实；沙箱硬隔离；桌面跨平台；MCP/A2A 真连通；审批/SSRF 真实拦截。
- **差异化**：规划可恢复 DAG、元决策风险预算、工具自愈轨迹、因果推理 + 长期推理记忆，均有可测断言。

> **交付说明**：本文为审计与方案文档，未改动任何源码。建议按 P0 → P1 → P2 顺序实施，每轮以「实时探测 + 测试」验证「宣称=实况」，并同步更新 `docs/PRODUCTION_READINESS_RUNBOOK.md` 与 AGENTS.md 状态表。
