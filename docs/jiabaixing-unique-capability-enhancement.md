# 家百星独有能力增强方案

> 文档 3 / 3 — 对应需求「增强优化 jiabaixing 独有能力进行增强」
> 日期：2026-08-06

---

## 一、什么是家百星的"独有能力"

区别于"套壳单模型 Agent"的核心差异化能力，归纳为五类：

| 独有能力 | 载体 | 当前状态 | 增强目标 |
|----------|------|----------|----------|
| **U1 感知-行动闭环（五感+手脚）** | `perception/perception_loop.py` + `SensoryFusion` | 🟡 通道分散 | 融合感知驱动闭环 |
| **U2 能力驱动的多模型路由** | `CapabilityAwareRouter` | ✅ 新增 | 任务自适应选模 |
| **U3 进化引擎（自我改进）** | `evolution/EvolutionEngine` | ✅ 完整 | 能力反馈闭环 |
| **U4 宪法/人格/上下文引用 @** | `core/ConstitutionPromptBuilder` + persona | ✅ 完整 | 多模态 @引用 + 宪法约束作用于动作 |
| **U5 多 Agent 编排（群体智能）** | `SubAgentFanout` | ✅ 完整 | 感知型子 Agent 模板 |

本方案优先增强 **U1 / U2**（本次已落地骨架），并给出 U3–U5 的协同增强路线。

---

## 二、U1 感知-行动闭环（核心独特性）

家百星的"手脚五感"不是装饰，而是**闭环**：感知世界 → 决策 → 施加动作 → 验证结果 → 再感知。

### 2.1 已落地：五感融合 `SensoryFusion`

- 五感通道 `visual/audio/text/uia/ocr` 统一为 `FusedPerception`。
- 加权融合突出高置信度通道，产出可直接喂给 LLM 的提示词上下文。
- 解耦设计：感知实现变更不影响融合层。

### 2.2 闭环增强路线

1. **本体感通道（proprioception）**：把"动作执行结果/屏幕变化"作为第六类样本接入 `SensoryFusion`，让 Agent 感知"我刚做了什么、环境如何变化"。
2. **环境感通道**：把 `DeviceManager` 的真实设备状态（W3）作为"环境"样本接入融合，使 Agent 能感知物理/智能家居环境。
3. **验证回环**：`ActionVerifier` 的验证结果回填融合，形成"尝试→验证→修正"的强化闭环。
4. **闭环度量**：记录每轮「感知→行动→验证成功」的命中率，作为 `EvolutionEngine` 的反馈信号（连接 U3）。

---

## 三、U2 能力驱动路由（已落地）

### 3.1 设计哲学

传统 Agent 固定一个模型；家百星按**任务画像**动态选模：
- 编码任务 → 高 `code_generation` + `tool_calling_accuracy`
- 复杂推理 → 高 `reasoning_depth`
- 多模态 → 过滤 `multi_modal`
- 成本敏感 → `max_cost_tier` 过滤 + 降权

硬约束（多模态/上下文/成本）永远优先于软分数，保证**正确性**。

### 3.2 与进化引擎联动（U2 × U3）

- `LLMCapabilityDetector` 的 `CapabilityDiff` 可作为进化信号：当某模型能力漂移，自动调整路由权重。
- `EvolutionEngine` 产出的"更优提示词/工具"可经能力路由后，在最合适的模型上验证（避免弱模型误判进化效果）。

---

## 四、U3 进化引擎协同

`python/agent/evolution/` 已具备完整进化回路。增强方向：

1. **感知质量作为适应度**：将 `SensoryFusion` 的融合置信度、验证成功率纳入进化适应度函数，让"更会感知"的 Agent 被优选。
2. **能力感知的进化实验**：进化实验在不同模型上并行（强模型验证逻辑、弱模型验证鲁棒性），由 `CapabilityAwareRouter` 分配。
3. **漂移自愈**：模型能力下降（W4）触发进化回滚到已知良好提示词/工具组合。

---

## 五、U4 宪法/人格/上下文引用增强

`core/ConstitutionPromptBuilder` + persona 系统已完整。增强：

1. **多模态上下文引用**：将"@引用"从纯文本扩展到"@截图区域 / @设备状态 / @某感知样本"，使 LLM 能引用五感融合中的具体片段（依赖 `FusedPerception.structured`）。
2. **宪法约束作用于动作**：把人格/宪法约束前置到动作执行守卫（与 `ToolCallGuard` 协同），避免"感知到危险仍执行"。

---

## 六、U5 多 Agent 编排增强

`SubAgentFanout` 已支持多子 Agent 并行。增强：

1. **感知型子 Agent 预设**：为视觉操作、桌面自动化、设备控制提供专用子 Agent 模板，内置 `SensoryFusion` 与对应工具集。
2. **能力路由驱动分派**：主 Agent 按子任务类型经 `CapabilityAwareRouter` 选模后，再把子任务派给具备对应能力的子 Agent。
3. **感知共享总线**：多个子 Agent 的 `SenseSample` 汇入共享 `SensoryFusion`，形成群体对环境的统一认知（群体智能独特性）。

---

## 七、独有能力增强路线图

| 阶段 | 独有能力 | 关键交付 | 验收 | 状态 |
|------|----------|----------|------|------|
| 当前 | U1/U2 骨架 | `SensoryFusion` + `CapabilityAwareRouter` | 单测 25/25 | ✅ |
| 阶段 A | U1 闭环 | 本体感/环境感通道 + 接入 `PerceptionActionLoop` | 闭环命中率指标 | ✅ W3 |
| 阶段 B | U2×U3 | 能力漂移 → 进化反馈 | 漂移自愈演练 | ✅ U2×U3 |
| 阶段 C | U4 | 多模态 @引用 | 引用解析测试 | ✅ U4 |
| 阶段 D | U5 | 感知型子 Agent + 共享感知总线 | 群体感知测试 | ✅ W7/W8 |

---

## 九、执行记录（W3 / W7 / W8 / U2×U3）— 2026-08-06

### W3 真实设备网关接入（环境感通道）
- **Python 端（Agent 核心）**：新增 `python/agent/perception/device_sense.py`
  - `DeviceSenseChannel`：吸收 TS 推送的设备状态字典 → 生成 `environment` 模态 `SenseSample`，支持单设备最新快照、批量 ingest、`feed(fusion)` 直接灌入 `SensoryFusion`。离线设备置信度自动压低。
  - `ProprioceptionChannel`：记录代理自身动作结果（`proprioception` 模态），作为自我感知信号。
  - 进程级单例 `get_device_sense_channel()` / `ingest_device_telemetry()` 供 API 端点写入。
- **SensoryFusion 扩容**：`VALID_MODALITIES` 新增 `proprioception` / `environment` 两通道及默认权重（§2.2）。
- **TS 端（入口/透传，遵守 §0.1）**：`DeviceManager`
  - 新增 `buildDeviceTelemetry()`（字段对齐 Python schema）、`publishDeviceTelemetry()`（经 `PythonAgentBridge`）、`setTelemetryBridge()`；监控循环每次刷新后自动透传最新设备快照。
  - `PythonAgentBridge.postDeviceTelemetry()` 新增 `POST /v1/devices/telemetry`。
  - `python/agent/api/devices.py` + `main.py` 挂载该端点，写入 `DeviceSenseChannel`。
- **测试**：`test_device_sense.py`（8 例）、`DeviceManager.telemetry.test.ts`（4 例）。

### W7 / W8 多 Agent 感知模板 + traceId 贯通
- **Python 端（Agent 核心）**：新增 `python/agent/orchestration/perception_bus.py`
  - `PerceptionAgentTemplate` + `PERCEPTION_AGENT_TEMPLATES`：视觉操作 / 桌面自动化 / 设备控制三类预设（模态 + 工具集）。
  - `SharedPerceptionBus`：汇聚多子 Agent 的 `SenseSample`（带 `trace_id` + `agent_id`），可按 `trace_id` 聚合为 `FusedPerception`，实现跨子 Agent 感知融合与链路贯通。
  - `SubAgentFanout` 增强：`fanout()` 接受 `trace_id`（缺省自动生成），向下透传至每个 `SubTaskResult` 与 `FanoutResult`；内置 `collect_perception()` / `aggregate_perception()` 对接共享总线（§六 / §八）。
- **TS 端（入口/协调）**：`SubAgentFanout`
  - 新增 `PERCEPTION_AGENT_TEMPLATES` 预设、`FanoutOptions`（`traceId` + `perceptionTemplate`）；`fanout()` 把 `traceId` 注入任务元数据并贯通到执行器与每个子结果；`SubTaskResult` / `FanoutResult` 新增 `traceId` 字段。
  - `TaskDispatcher.TaskNode` 新增可选 `metadata` 字段。
- **测试**：`test_perception_bus.py`（5 例）、`SubAgentFanout.trace.test.ts`（5 例）。

### U2×U3 能力路由 × 进化引擎联动（漂移自愈）
- **Python 端（Agent 核心）**：新增 `python/agent/evolution/capability_evolution_linkage.py`
  - `CapabilityEvolutionLinkage`：把 `LLMCapabilityDetector` 的 `on_capability_drift` 回调接到联动；检测到能力**退化**（`changed` 中 new<old 或 `removed`）时：
    1. **路由降级** —— 调用 `CapabilityAwareRouter.set_provider_degraded()` 临时降权（权重因子 0.25），避免继续派发高风险任务（W4 漂移 → 路由）。
    2. **进化回滚** —— 触发 `EvolutionEngineV2` 回滚到最近良好检查点（Prompt/工具组合），恢复退化前状态（漂移自愈）。
  - 联动结果带 `trace_id`（贯通审计），支持 `flush_pending_rollbacks()` 异步执行排队回滚；`evolution_rollback_handlers(engine)` 提供与进化引擎的解耦接线。
  - `CapabilityAwareRouter` 新增动态权重覆写：`override_provider_weight()` / `set_provider_degraded()` / `clear_override()`（评分时按因子降权）。
  - `EvolutionEngineV2.latest_checkpoint_id()` 新增公开方法，供联动选取回滚目标。
- **测试**：`test_capability_evolution_linkage.py`（4 例）、`test_capability_router_override.py`（3 例）。

### 验证汇总
- Python：`pytest` 本次新增 20 例全绿，涉及模块 import 与 `main.py` 启动均通过。
- TS：`jest` 本次新增 9 例全绿；`tsc --noEmit` 对本次改动源文件 0 错误（既有 `DeviceAdapter.test.ts` 因 `isolatedModules` 模式历史未在全量 tsc 通过，非本次回归）。

---

## 十、执行记录（阶段 C / U4 多模态 @引用）— 2026-08-06

### U4 多模态上下文引用（@截图区域 / @设备状态 / @某感知样本）
把"@引用"从纯文本文件引用，扩展到**多模态感知引用**，使 LLM 能精确引用 `SensoryFusion` 融合后的具体感知片段（依赖 `FusedPerception.structured`）。

- **Python 端（Agent 核心，遵守 §0.1）**：新增 `python/agent/perception/reference_resolver.py`
  - `PerceptionReferenceResolver`：将文本中的 `@引用` 解析到 `FusedPerception.structured` 的具体片段。
  - 支持三类引用：① 具名多模态类型 `@截图区域`→`visual`、`@设备状态`→`environment`…（`MULTIMODAL_REFERENCE_TYPES`）；② 直接通道名 `@visual` / `@environment`…；③ 指定样本 `@visual#0` / `@环境#1`（通道名 + `#` + 索引）。
  - 解析结果 `ReferenceResolution` 产出 `text`（原文 `@引用` 替换为 `[ref#N]` 标记）、`references`（每条含通道/置信度/内容）、`unresolved`（无法解析的 token 原样保留）；`resolved_content` 可直接拼入提示词。
  - `parse_reference_tokens()` 提供纯语法 token 提取；`perception/__init__.py` 已导出全部新符号。
- **TS 端（入口/透传，遵守 §0.1）**：扩展 `src/harness/context/ContextReferenceResolver.ts`
  - 新增 `MultimodalReference` / `MultimodalModality` / `MultimodalReferenceProvider` 类型，与 Python 端结构对齐。
  - `setMultimodalReferenceProvider()`：注入多模态解析委托（实际融合数据在 Python，TS 仅调用与渲染，不持有融合逻辑）。
  - `collectMultimodalTokens()`（静态）：语法提取 CJK 具名类型、已知通道名、`#索引` 样本；**不劫持**普通 `@文件` / `@配置` / URL 中的 `https`。
  - `resolve()` 增强：多模态 token 不再走文件/路径解析通道（避免误判）；有 provider 时委托解析并渲染进 `resolvedContent`，无 provider 时原样保留（降级）。
- **测试**：`test_perception_reference_resolver.py`（8 例）、`ContextReferenceResolver.multimodal.test.ts`（7 例）。

> 说明：U4 第 2 项「宪法约束作用于动作（与 `ToolCallGuard` 协同）」属动作守卫范畴，未在本轮多模态 @引用中展开，可作为后续独立任务；本轮仅完成「多模态上下文引用」验收项（引用解析测试）。

---

## 八、风险与边界

- **架构合规**：所有 Agent 核心逻辑保持在 Python 端；TS `DeviceManager` 仅作入口/透传（W3 落地时遵守）。
- **不牺牲正确性**：能力路由硬约束优先；进化实验不降低线上稳定性（灰度/Canary 已具备）。
- **可观测**：每一项独有能力带 `traceId`，贯通 OTel，确保可审计。

> 配套：文档 1（薄弱项审计与增强）、文档 2（LLM 底座 + 执行 + 手脚五感）。
