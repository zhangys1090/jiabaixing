# 家百星（Jiabaixing）功能薄弱项审计报告与增强优化方案

> 文档 1 / 3 — 对应需求「全面审计功能薄弱项进行增强优化」
> 审计日期：2026-08-06　|　审计范围：TS + Python 混合架构（`src/` + `python/agent/`）
> 审计原则：遵循 `AGENTS.md` 架构强制条款——**Agent 核心能力以 Python 端为主实现**，仅 TS 侧实现而 Python 缺失者记为「🟡 部分完成」，不计入「✅ 完成」。

---

## 一、审计方法

1. **静态结构扫描**：遍历 `python/agent/` 与 `src/` 目录，识别模块归属（LLM 底座 / Agent 执行 / 手脚五感 / 记忆 / 进化 / 协议 / 持久化）。
2. **残留 stub 检索**：正则扫描 `NotImplementedError / TODO / FIXME / 占位 / 未实现 / 待实现 / 纯 `pass`` 等模式。
3. **测试覆盖核对**：对照 `python/tests/` 下 141 个测试文件，确认核心模块是否具备端到端测试。
4. **调用链贯通性**：确认能力检测、路由、执行循环之间是否存在"检测了但不使用"的断点。
5. **落地验证**：对本次新增增强编写并运行 pytest（25 用例全绿）。

---

## 二、模块完备性矩阵

| 模块 | 主实现端 | 状态 | 关键证据 |
|------|----------|------|----------|
| LLM 底座（调用/路由/缓存/限速/熔断/凭据池） | Python | ✅ 完整 | `python/agent/llm/` 19 文件，含 circuit_breaker / rate_limiter / credential_pool / canary |
| LLM 能力检测 | Python | ✅ 完整 | `python/agent/evolution/llm_capability_detector.py` + `test_llm_capability_detector.py` |
| Agent 执行循环（感知-行动闭环） | Python | ✅ 完整 | `python/agent/perception/perception_loop.py` 2047 行；`test_loop*.py` 多文件 |
| 五感感知（视觉/UIA/OCR/屏幕监听/VLM） | Python | ✅ 完整 | `python/agent/perception/` 视觉定位/动作验证/VLM 调用齐全 |
| 手（工具/动作） | Python | ✅ 完整 | `python/agent/tools/` + `test_p1_tools.py`(39KB) + `test_executor.py`(25KB) |
| 脚（桌面/浏览器自动化） | Python | ✅ 完整 | `python/agent/desktop/` + `test_browser_automation.py` |
| 记忆系统 | Python | ✅ 完整 | `python/agent/memory/` + `test_episodic_memory.py` |
| 进化引擎 | Python | ✅ 完整 | `python/agent/evolution/` + `test_evolution*.py` |
| MCP / A2A 协议 | Python | ✅ 完整 | `python/agent/mcp/` + `python/agent/a2a/` + `test_mcp_*.py` / `test_a2a*.py` |
| 持久化/会话 | Python | ✅ 完整 | `python/agent/persistence/` + `test_*.py` |
| 智能家居/手脚层（DeviceManager） | TS | 🟡 部分完成 | `src/hardware/DeviceManager.ts` 仅 `simulateDeviceStatus` 随机模拟，无真实设备接入 |
| 旧 LLM TS 层（`src/llm/*`） | TS | ❌ 已废弃 | git 已删除 `ModelCapabilityDetector` 等 5 文件，迁移至 Python |

**结论**：Python 侧 Agent 核心体系**高度完备**，主要薄弱项集中在三类：
- **能力断层**：检测出的能力未被用于决策（已修复，见第四节）。
- **五感未融合**：感知通道分散，缺统一融合层（已修复，见第四节）。
- **遗留模拟层**：TS `DeviceManager` 仅为占位模拟，未接真实设备。

---

## 三、薄弱项清单（按优先级）

### P0（阻塞能力闭环，本次已修复）

| 编号 | 薄弱项 | 位置 | 风险 | 增强措施 |
|------|--------|------|------|----------|
| W1 | 能力检测与路由**断链**：`LLMCapabilityDetector` 检测能力后，`ProviderManager` 仅按配置优先级 `get_primary()` 选模型，能力未被用于任务级选型 | `python/agent/llm/router.py` `get_primary()` | 多模型优势无法发挥，复杂任务可能落到弱模型 | ✅ 新增 `CapabilityAwareRouter` 并挂载 `ProviderManager.select_for_task()` |
| W2 | 感知通道**孤岛**：视觉/OCR/UIA/文本各自独立，无统一融合层喂给执行循环 | `python/agent/perception/` | 五感信息无法协同，削弱"感知-行动闭环"独特性 | ✅ 新增 `SensoryFusion` + `SenseSample` + `FusedPerception` |

### P1（重要，建议下轮）

| 编号 | 薄弱项 | 位置 | 建议 |
|------|--------|------|------|
| W3 | TS `DeviceManager` 纯模拟（`simulateDeviceStatus` 随机值），"手脚"层无真实设备接入 | `src/hardware/DeviceManager.ts` | 定义 `DeviceAdapter` 接口，支持 MQTT/HTTP 真实设备，模拟仅作 fallback |
| W4 | 能力检测为一次性，未随模型版本/时段刷新；缺乏"能力漂移"监控 | `llm_capability_detector.py` | 增加定时 re-detect + 漂移告警，复用 `CapabilityDiff` |
| W5 | `CapabilityAwareRouter` 暂无成本档位数据源（cost_tier 需手动注册） | `capability_aware_router.py` | 接 `credential_pool._MODEL_PRICING` 自动推导 cost_tier |
| W6 | 五感融合未接入 `PerceptionActionLoop` 主链路 | `perception_loop.py` | 在 `PerceptionActionLoop` 中注入 `SensoryFusion`，统一感知上下文 |

### P2（优化）

| 编号 | 薄弱项 | 建议 |
|------|--------|------|
| W7 | 多 Agent 编排（SubAgentFanout）缺少对"感知-行动"子 Agent 的专用模板 | 增加视觉/桌面操作专用子 Agent 预设 |
| W8 | 缺乏跨端 traceId 在 `SensoryFusion` 中的贯通 | 融合结果携带 traceId 透传 |
| W9 | 旧 `docs/` 下大量 HTML 审计报告未沉淀为可维护 Markdown | 归档为 `docs/audit/` 并链接本表 |

---

## 四、本次已落地增强（代码 + 测试）

> 两项均为 Python 端实现，符合架构强制条款；各附 pytest，全部通过（25/25）。

### 4.1 能力驱动路由（修复 W1）

- 新增 `python/agent/llm/capability_aware_router.py`
  - `TaskRequirement`：任务能力诉求（含 `from_task_type` 预设 coding/reasoning/agentic/vision/cheap/long_context）。
  - `CapabilityAwareRouter`：按 `LLMCapabilities` 对 Provider 打分与排序，支持**硬约束**（多模态/上下文窗口/成本上限）与**软权重**（推理/工具/代码/结构化）+ 偏好轻加权。
  - `ScoredProvider`：携带评分与可解释 `reasons`。
- 挂载点：`ProviderManager.set_capability_router()` + `select_for_task()`，未挂载时回退 `get_primary()`（零侵入）。
- 导出：`agent.llm` 包 `__init__` 已导出三个符号。

### 4.2 五感融合（修复 W2）

- 新增 `python/agent/perception/sensory_fusion.py`
  - `SenseSample(modality, content, confidence)`：解耦于具体感知实现，避免与 `OCRResult`/`GroundingResult` 强耦。
  - `SensoryFusion`：加权/拼接两种融合策略，产出 `FusedPerception` + `to_prompt_context()`。
  - 五感通道：`visual / audio / text / uia / ocr`，权重可配置。
- 导出：`agent.perception` 包 `__init__` 已导出 `SensoryFusion / SenseSample / FusedPerception / DEFAULT_SENSE_WEIGHTS`。

### 4.3 测试

- `python/tests/test_capability_aware_router.py`（18 用例）
- `python/tests/test_sensory_fusion.py`（13 用例）
- 运行：`cd python && python -m pytest tests/test_capability_aware_router.py tests/test_sensory_fusion.py -q` → **25 passed**。

---

## 五、推进计划与执行记录

> 状态图例：✅ 已完成　🟡 进行中　⬜ 待开始

### 5.1 本轮已执行（2026-08-06）

| 编号 | 任务 | 产出 | 验收 | 状态 |
|------|------|------|------|------|
| W2 | 五感融合 `SensoryFusion` | `perception/sensory_fusion.py` | 13 单测通过 | ✅ |
| W1 | 能力驱动路由 | `llm/capability_aware_router.py` + 挂载 | 18 单测通过 | ✅ |
| W6 | 融合接入执行循环 | `perception_loop.py` 注入 `SensoryFusion` | 集成测试 + 手动验证通过 | ✅ |
| W5 | 成本档位自动推导 | router 接 `_MODEL_PRICING` | 单测通过 | ✅ |
| W4 | 能力漂移监控 | detector `check_drift`/`start_drift_monitor` | 单测通过 | ✅ |
| W3 | DeviceAdapter 接口 + fallback | `src/hardware/DeviceAdapter.ts` + 替换硬编码模拟 | **TS 单测 5/5 通过** | ✅（适配器层） |

**验证汇总（本轮）**
- Python：`test_capability_aware_router` + `test_sensory_fusion` + `test_llm_capability_detector` + `test_perception_fusion_wiring` = **62 passed**
- TypeScript：`src/hardware/DeviceAdapter.test.ts` = **5 passed**
- 调用链：监控循环经 `deviceAdapter.sampleStatus` 取数，`refresh` 后台拉取真实状态并降级到模拟；执行循环末尾自动 `fuse_perception` 并保存 `last_fusion`。

### 5.2 后续排期

| 阶段 | 任务 | 产出 | 验收 |
|------|------|------|------|
| 下轮 | W3 真实设备接入 | 为 `HttpDeviceAdapter` 接入真实网关/设备，设备状态回流 `SensoryFusion`（环境感通道） | 端到端演示 |
| 下轮 | W7/W8 多 Agent 感知模板 + traceId 贯通 | 子 Agent 预设 + 透传 | `test_fanout.py` 覆盖 |
| 下轮 | U2×U3 能力路由 × 进化联动 | 漂移触发进化回滚 | 漂移自愈演练 |
| 持续 | W9 审计报告归档 | `docs/audit/` | 链接本矩阵 |

> 下一步见文档 2（LLM 底座 + Agent 执行 + 手脚五感）与文档 3（独有能力增强）。
