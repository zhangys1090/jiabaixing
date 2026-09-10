# 家百星三项增强 · 落地推进报告

> 日期：2026-08-06
> 关联文档：
>
> - 文档 1：`docs/jiabaixing-audit-weakness-enhancement.md`（薄弱项审计）
> - 文档 2：`docs/jiabaixing-llm-base-agent-senses.md`（LLM 底座 / Agent 执行 / 手脚五感）
> - 文档 3：`docs/jiabaixing-unique-capability-enhancement.md`（独有能力增强）
>
> 本报告记录上述三份方案中**本轮已落地代码增强**的具体改动、验证结果与后续推进项。
> 三份方案文档描述"要做什么"，本报告记录"已做成什么"。

---

## 〇、本轮增强总览

| #   | 增强主题                                    | 对应需求            | 落地位置                                                 | 验证状态             |
| --- | ------------------------------------------- | ------------------- | -------------------------------------------------------- | -------------------- |
| 1   | `file_search` 模糊匹配增强 + NameError 修复 | 全面审计薄弱项      | `python/agent/tools/file_tools.py`                       | ✅ 28 项相关测试通过 |
| 2   | 能力感知路由接入 `LLMProvider.chat()`       | LLM 底座完善        | `python/agent/llm/provider.py`                           | ✅ 语法+AST 校验通过 |
| 3   | 五感融合 / 环境感暴露为 LLM 可调用工具      | 手脚五感 + 独有能力 | `python/agent/tools/perception_tools.py` + `registry.py` | ✅ 17 项感知测试通过 |

---

## 一、增强 #1：`file_search` 模糊匹配增强（薄弱项 W7 收口）

### 1.1 审计发现

`evolution-audit-report.md` 显示 `file_search` 工具成功率仅 **6.4%**，是全部工具中最低。根因有三：

1. **匹配策略单一**：原实现仅 `fnmatch.fnmatch(f, pattern) or pattern in f`，对 LLM 常见误用（漏写通配符 `*`、大小写不符、拼写小偏差、多词拆分）零容错。
2. **无结果即终止**：零命中时直接返回"未找到匹配文件"，无任何恢复建议，Agent 陷入死胡同。
3. **潜伏 NameError**：无结果分支调用 `_suggest_closest_files()`，但该函数**从未定义**——一旦走到无结果路径，会抛 `NameError` 而非返回建议，属于隐藏 bug。

### 1.2 增强措施

**A. 多策略融合匹配 `_file_name_match()`**（[file_tools.py](file:///c:/zy/jiabaixing/python/agent/tools/file_tools.py)）

依次尝试四策略，任一命中即收录：

1. 大小写不敏感 glob（`fnmatch`）
2. 子串包含
3. token 全命中（按 `_\-.` 拆分后所有 token 都出现在文件名中）
4. 模糊相似度（`difflib.SequenceMatcher` ≥ 阈值，默认 0.72）

新增**多模式支持**：`pattern` 可为空白/逗号分隔的多模式字符串或列表，任一模式命中即收录。

**B. 模糊建议兜底 `_suggest_closest_files()`**（新增定义，修复 NameError）

零精确命中时，对全目录文件名计算相似度，返回 top-5 最接近文件名及相似度，避免"零结果"挫败。

**C. 工具定义增强 `FILE_SEARCH_DEF`**

新增参数：

- `fuzzy`（boolean，默认 true）：是否启用模糊匹配兜底
- `fuzzy_threshold`（number，默认 0.72）：模糊匹配相似度阈值

**D. 执行器接线 `file_search_executor()`**

读取 `fuzzy` / `fuzzy_threshold` 参数并传入 `_file_name_match()`。

### 1.3 验证

```
exact glob: True          # *.md 命中 README.md
substring: True           # config 命中 my_config.yaml
fuzzy typo: True          # perception_tools 命中 percepton_tools.py（拼写偏差）
multi-pattern: True       # "app.py,app.test.js" 命中 app.test.js
fuzzy off: False          # fuzzy=False 时拼写偏差不命中（可控）
```

`pytest python/tests/test_p1_tools.py -k "file or search"` → **28 passed**。

### 1.4 预期收益

`file_search` 成功率从 6.4% 大幅提升：四策略融合覆盖 LLM 绝大多数误用模式；模糊建议兜底将"零结果"转化为"可恢复的近似结果"。

---

## 二、增强 #2：能力感知路由接入 LLM 调用主链路（薄弱项 W1 深度收口）

### 2.1 审计发现

文档 1 已识别 W1：`LLMCapabilityDetector` 能检测各模型能力，`CapabilityAwareRouter` 能按任务评分选型，`ProviderManager.select_for_task()` 能委托路由器——**但 `LLMProvider.chat()` 从不调用 `select_for_task()`**。能力感知路由是"检测了、评分了、却不用"的断链状态。

### 2.2 增强措施

在 [provider.py](file:///c:/zy/jiabaixing/python/agent/llm/provider.py) 的 `LLMProvider.chat()` 中接入能力驱动选型：

**A. 新增 `task_type` 参数**

```python
async def chat(self, messages, tools=None, stream=False, use_cache=True,
               system_prompt=None, user_id=None, strategy_name=None,
               task_type: str | None = None) -> dict[str, Any]:
```

**B. 选型逻辑（灰度覆盖之后、effective_model 之前）**

```python
if model_override is None and task_type:
    requirement = TaskRequirement.from_task_type(task_type)
    scored = self.provider_manager.select_for_task(requirement)
    if scored is not None and scored.capabilities and scored.capabilities.model_name:
        model_override = self._normalize_model(scored.capabilities.model_name)
```

**设计要点**：

- **零侵入**：`task_type` 为可选参数，不传时行为与原来完全一致。
- **灰度优先**：canary 灰度覆盖（`model_override` 已设）时跳过能力选型，不破坏灰度发布语义。
- **静默回退**：路由器未挂载、选型失败、无候选时静默回退 `self.model`，异常经 `log_ignored` 吞掉，绝不影响主流程。
- **任务预设**：复用 `TaskRequirement.from_task_type()` 的 6 类预设（coding/reasoning/agentic/vision/cheap/long_context），硬约束（多模态/上下文/成本）优先于软权重。

### 2.3 验证

- `py_compile` 语法校验通过。
- AST 校验确认 `chat` 签名含 `task_type` 参数。
- 注：`agent.llm.__init__` → `capability_aware_router` → `agent.evolution` → 回引 `CapabilityAwareRouter` 存在**既有循环导入**（本轮未引入），运行时由各模块懒加载规避；本增强的 `chat()` 内部采用函数内懒导入（`from agent.llm.capability_aware_router import TaskRequirement`），不加剧该循环。

### 2.4 后续推进

| 项                  | 措施                                                                   | 优先级 |
| ------------------- | ---------------------------------------------------------------------- | ------ |
| LoopController 接线 | 任务分发前按子任务类型传 `task_type`，实现单 Agent 内多模型协同        | P1     |
| 循环导入根治        | `agent.llm.__init__` 与 `agent.evolution.__init__` 互引重构为懒加载    | P1     |
| 能力漂移监控（W4）  | 定时 re-detect + `CapabilityDiff` 告警，联动 `set_provider_degraded()` | P2     |

---

## 三、增强 #3：五感融合 / 环境感暴露为 LLM 工具（独有能力 U1 闭环收口）

### 3.1 审计发现

文档 2/3 已落地 `SensoryFusion`（七通道融合）、`DeviceSenseChannel`（环境感）、`ProprioceptionChannel`（本体感）——但它们**仅作为内部模块存在，未注册为工具**。LLM 在推理循环中无法主动调用"查询融合感知"或"查询设备状态"，五感闭环的最后一公里（LLM 可达性）未打通。

### 3.2 增强措施

在 [perception_tools.py](file:///c:/zy/jiabaixing/python/agent/tools/perception_tools.py) 新增两个工具定义与执行器，并在 [registry.py](file:///c:/zy/jiabaixing/python/agent/tools/registry.py) 注册：

**A. `perception_fuse` 工具**（五感融合上下文查询）

- 汇聚 visual/audio/text/uia/ocr/proprioception/environment 七通道
- 按 `strategy`（weighted/concat）融合，产出统一感知上下文
- `as_prompt=true` 返回可直接拼入提示词的文本；`false` 返回结构化 JSON
- 可分别控制是否纳入本体感（`include_proprioception`）与环境感（`include_environment`）

**B. `environment_sense` 工具**（真实设备环境状态查询）

- 返回已接入设备网关的全部设备最新快照
- 支持 `device_id` 过滤、`online_only` 过滤
- 透出在线状态、位置、业务字段、置信度

**C. 注册接线**

`register_default_tools()` 的感知工具段新增两项注册，工具总数 +2。

### 3.3 验证

```
perception_fuse: True | 【多模态感知融合】当前无可用感知样本。
environment_sense: True | 当前无可用设备状态。
DEFS: perception_fuse environment_sense
```

`pytest python/tests/test_perception_bus.py python/tests/test_sensory_fusion.py` → **17 passed**。

### 3.4 闭环意义

至此，家百星"手脚五感"闭环完整可达：

```
LLM 决策 ──调用 perception_fuse──▶ SensoryFusion 融合七通道 ──▶ 统一感知上下文
    ▲                                                              │
    │                                                              ▼
LLM 决策 ──调用 environment_sense──▶ DeviceSenseChannel ──▶ 设备状态
    │                                                              │
    └────────── 决策依据 ◀──────── 本体感(动作结果回流) ◀────────┘
```

LLM 不再只能被动接收感知注入，而可**主动查询**当前融合感知与设备环境，闭合"感知→决策→行动→验证"回路。

### 3.5 后续推进

| 项                        | 措施                                                                       | 优先级 |
| ------------------------- | -------------------------------------------------------------------------- | ------ |
| PerceptionActionLoop 注入 | 在主循环中自动每轮调用 `perception_fuse` 注入系统提示                      | P1     |
| 设备网关真实接入（W3）    | TS `DeviceManager` 接 MQTT/HTTP 真实设备，`environment_sense` 才有真实数据 | P1     |
| 闭环度量                  | 记录"感知→行动→验证成功"命中率，作为 EvolutionEngine 反馈信号              | P2     |

---

## 四、变更文件清单

| 文件                                     | 变更类型  | 说明                                                                                                  |
| ---------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `python/agent/tools/file_tools.py`       | 增强+修复 | `_file_name_match` 多策略+多模式；新增 `_suggest_closest_files`；`FILE_SEARCH_DEF` 增参数；执行器接线 |
| `python/agent/llm/provider.py`           | 增强      | `chat()` 新增 `task_type` 参数 + 能力感知选型逻辑                                                     |
| `python/agent/tools/perception_tools.py` | 新增工具  | `PERCEPTION_FUSE_DEF` / `ENVIRONMENT_SENSE_DEF` 定义 + 执行器                                         |
| `python/agent/tools/registry.py`         | 注册      | 感知工具段新增两项注册                                                                                |

---

## 五、验证总结

| 验证项           | 命令                                                   | 结果              |
| ---------------- | ------------------------------------------------------ | ----------------- |
| 语法校验         | `py_compile` 四文件                                    | ✅ EXIT=0         |
| file_search 测试 | `pytest test_p1_tools.py -k "file or search"`          | ✅ 28 passed      |
| 感知测试         | `pytest test_perception_bus.py test_sensory_fusion.py` | ✅ 17 passed      |
| 工具执行验证     | 直接调用两个新执行器                                   | ✅ success=True   |
| 能力路由接线     | AST 校验 `chat` 签名                                   | ✅ task_type 存在 |

> 注：`test_p1_tools.py::TestShellExecTool::test_shell_echo` 失败为**既有平台问题**（Windows 无 `echo` 命令），与本轮增强无关。

---

## 六、后续推进路线（按优先级）

### P0（本轮已完成）

- [x] W7 `file_search` 模糊匹配增强 + NameError 修复
- [x] W1 能力感知路由接入 `chat()` 主链路
- [x] U1 五感融合/环境感暴露为 LLM 工具

### P1（下一轮）

- [ ] W3 TS `DeviceManager` 真实设备接入（MQTT/HTTP），使 `environment_sense` 有真实数据
- [ ] W4 能力漂移监控：定时 re-detect + `CapabilityDiff` 告警
- [ ] W5 成本档位自动推导：`CapabilityAwareRouter` 接 `credential_pool._MODEL_PRICING`
- [ ] W6 `PerceptionActionLoop` 注入 `SensoryFusion`，主循环自动融合感知
- [ ] LoopController 按 子任务类型传 `task_type`，单 Agent 多模型协同
- [ ] `agent.llm.__init__` / `agent.evolution.__init__` 循环导入根治

### P2（远期）

- [ ] 闭环度量：感知→行动→验证命中率接入 `EvolutionEngine`
- [ ] U3 进化引擎与 U2 能力路由深度联动（漂移自愈 × 进化验证）
- [ ] 多模态引用 @ 扩展（U4）
