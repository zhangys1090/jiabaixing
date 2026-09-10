# 家百星 LLM 底座 · Agent 执行 · 手脚五感 完善方案

> 文档 2 / 3 — 对应需求「完善 jiabaixing 作为 LLM 底座与 agent 执行与手脚五感的能力」
> 日期：2026-08-06

---

## 〇、目标定位

把家百星建设为**真正以 LLM 为底座、具备完整 Agent 执行闭环、拥有手脚五感**的自主智能体框架：

```
         ┌─────────────── LLM 底座（多模型/能力感知/路由）──────────────┐
         │  ProviderManager · CapabilityAwareRouter · 缓存/限速/熔断/凭据  │
         └───────────────────────────┬──────────────────────────────────┘
                                     │ 能力感知选型
         ┌───────────────────────────▼──────────────────────────────────┐
         │              Agent 执行层（感知 → 决策 → 行动 → 验证）          │
         │   PerceptionActionLoop · Planner · Executor · Evaluator        │
         └──────┬───────────────────────────────────────────┬───────────┘
    ┌───────────▼──────────┐                       ┌─────────▼──────────┐
    │   五感（感知输入）      │                       │   手脚（动作输出）   │
    │ SensoryFusion         │                       │  Tools / Desktop    │
    │ visual/audio/text/uia │                       │  / Browser / Device │
    │ /ocr                   │                       │                     │
    └────────────────────────┘                       └─────────────────────┘
```

---

## 一、LLM 底座完善

### 1.1 现状（Python 端已强）

`python/agent/llm/` 已具备：Provider 多模型管理、TieredCache、PromptCache（Anthropic 前缀缓存）、AdaptiveRateLimiter、CircuitBreaker、CredentialPool（含 `_MODEL_PRICING` 成本）、CanaryRelease、MOA 聚合、连接池。这是坚实底座。

### 1.2 关键缺口与完善（已落地 W1）

**缺口**：`LLMCapabilityDetector` 能检测各模型能力（推理深度/工具调用/代码生成/多模态/上下文窗口），但 `ProviderManager.get_primary()` 仅按**配置优先级**选模型——检测出的能力被浪费，复杂任务可能落到弱模型。

**完善**：新增 `CapabilityAwareRouter`（详见文档 1 第四节），并通过 `ProviderManager.select_for_task()` 打通：
- 任务级选型：coding→高代码/工具能力；reasoning→高推理；vision→多模态过滤；long_context→上下文窗口过滤；cheap→成本上限过滤。
- 硬约束（多模态/上下文/成本）优先于软权重，确保**正确性不被能力分数牺牲**。
- 偏好轻加权（+0.05），不越权压倒明显更优模型。

### 1.3 后续完善（P1，建议下轮）

| 项 | 措施 | 预期收益 |
|----|------|----------|
| 成本档位自动推导（W5） | `CapabilityAwareRouter` 接 `credential_pool._MODEL_PRICING` 自动算出 cost_tier | 免去手动注册成本 |
| 能力漂移监控（W4） | 定时 re-detect + 复用 `CapabilityDiff` 告警 | 模型升级/降级自动感知 |
| 能力感知接入 LoopController | 任务分发前调用 `select_for_task`，按子任务类型选模型 | 单 Agent 内多模型协同 |

---

## 二、Agent 执行层完善

### 2.1 现状（Python 端已强）

- **感知-行动闭环**：`python/agent/perception/perception_loop.py`（~2047 行）实现 `PerceptionActionLoop`，含屏幕监听、视觉定位、动作验证、自动重试。
- **执行器/编排**：`python/agent/loop/`、`SubAgentFanout`、`Executor`（`test_executor.py` 25KB）覆盖。

### 2.2 完善方向

1. **融合感知注入执行循环（W6）**：在 `PerceptionActionLoop` 中注入 `SensoryFusion`，将五感统一上下文作为决策输入，闭合"感知→决策→行动→验证"。
2. **能力感知的子任务路由**：把 `CapabilityAwareRouter` 用于多子 Agent 的模型分配（coding 子 Agent 用强代码模型，vision 子 Agent 用多模态模型）。
3. **执行可观测性**：每次循环带 `traceId`，贯通 LLM 调用（已支持 OTel 透传）。

---

## 三、手脚五感完善

### 3.1 五感（感知输入）——已落地 W2

新增 `SensoryFusion`（`python/agent/perception/sensory_fusion.py`）：
- 统一五感通道：`visual / audio / text / uia / ocr`，各带置信度。
- 加权融合（默认权重 `DEFAULT_SENSE_WEIGHTS`）与拼接融合两种策略。
- 产出 `FusedPerception`，可直接 `to_prompt_context()` 序列化为提示词上下文。
- 与具体感知实现解耦（仅消费 `SenseSample`），避免强耦 `OCRResult`/`GroundingResult`。

**接入计划**：`PerceptionActionLoop` 在每一步感知后把各通道结果封装为 `SenseSample` 送入 `SensoryFusion`，得到统一上下文再决策（W6）。

### 3.2 手（动作输出）

- **工具层** `python/agent/tools/`：已完整，`ToolRegistry` + `ToolCallGuard`（去重/守卫）健壮。
- **桌面动作** `python/agent/desktop/`：浏览器/Playwright/UIA 操作齐备。
- **增强点**：动作执行结果应回填 `SensoryFusion` 作为" proprioception（本体感）"通道，形成"行动→验证→再感知"闭环。

### 3.3 脚（移动/导航/环境交互）

- **智能家居/环境控制层** `src/hardware/DeviceManager.ts`：**当前仅为 `simulateDeviceStatus` 随机模拟（W3）**，未接真实设备。
- **完善方案**：
  1. 定义 `DeviceAdapter` 接口（`connect/discover/actuate/status`）。
  2. 提供真实适配器（MQTT / HTTP / 厂商云 API）与模拟适配器（现有随机逻辑降级为 fallback）。
  3. TS 侧仅做 HTTP 入口与透传，业务逻辑下沉 Python（符合架构强制条款）；建议把设备状态作为"环境感"通道接入 `SensoryFusion`。
  4. 补齐 `DeviceManager` 单元测试（当前缺）。

---

## 四、落地验证

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 能力路由单测 | `pytest tests/test_capability_aware_router.py` | 18 passed |
| 五感融合单测 | `pytest tests/test_sensory_fusion.py` | 13 passed |
| 全量回归（新增不破坏） | `pytest tests/test_capability_aware_router.py tests/test_sensory_fusion.py -q` | 25 passed |

---

## 五、推进清单（勾选式）

- [x] W1 能力驱动路由 + 挂载 `ProviderManager`
- [x] W2 五感融合 `SensoryFusion`
- [ ] W3 `DeviceAdapter` 真实设备接入 + 单测
- [ ] W4 能力漂移监控
- [ ] W5 成本档位自动推导
- [ ] W6 融合接入 `PerceptionActionLoop`
- [ ] 动作结果回填五感（本体感通道）

> 独有能力增强见文档 3。
