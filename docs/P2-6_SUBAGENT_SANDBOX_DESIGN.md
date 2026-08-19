# P2-6 子 Agent 工具下放 — 白名单与沙箱边界设计（ADR）

> 状态：✅ 已落地（2026-08-03 实现并验证）
> 日期：2026-08-03
> 关联：审计文档 `Agent_Comprehensive_Audit_2026-08-01.md` §3.3 P2-6（已据本文加固为 ✅ 已完成）
>
> 实现清单（对应 §3）：
> - 双轨白名单：`SUBAGENT_DENY_TOOLS` 拒绝集 + `derive_default_safe_tools(registry)` 按 `risk_level==low` 派生；`SUBAGENT_SAFE_TOOLS` 仅作无注册表回退基线（已移除 `code_generate_ast`/`test_run`）。
> - 边界 enforcement：`DEFAULT_PER_TOOL_TIMEOUT=30` / `DEFAULT_MAX_TOOL_OUTPUT_CHARS=8000` / 第五道墙 `DEFAULT_SUBAGENT_MAX_STEPS=12`（单轮内也生效）。
> - `unsafe` 算子级能力门控：`AGENT_SUBAGENT_UNSAFE` 环境变量启用才允许突破子集；`delegate_task` 永不可经覆盖加回。
> - 验证：`tests/test_p2_6_subagent_sandbox.py` 19 例全过（白名单正确性 / 沙箱隔离 / 门控 / 截断 / 超时 / 轮数墙 / 步数墙 / ReAct 收敛）。

---

## 0. 现状核查（先对齐事实，再谈设计）

读取 `python/agent/tools/delegate_tool.py` 后发现：**P2-6 在代码层已基本落地，并非审计文档所说的"裸 LLM"**。已实现的能力：

| 能力 | 现状 | 位置 |
|---|---|---|
| 子 Agent 白名单 | `SUBAGENT_SAFE_TOOLS: frozenset`（约 50 个只读/低风险工具名） | delegate_tool.py:36 |
| 独立 ReAct 循环 | `SubAgentDelegator._run_react`：LLM(tools=schema) → 解析 tool_calls → 在子注册表内执行 → 回灌 → 循环至终答 | delegate_tool.py:315 |
| 沙箱 = 子注册表 | `_build_sub_registry(allowed)` 仅把命中白名单且已注册的工具拷进新 `ToolRegistry`；非白名单对子 Agent 完全不可见 | delegate_tool.py:299 |
| 递归防爆 | `MAX_SPAWN_DEPTH=3` + `leaf/orchestrator` 角色；白名单本身排除 `delegate_task` | delegate_tool.py:144 / 36 |
| 轮数上限 | `DEFAULT_SUBAGENT_MAX_ITERATIONS=5` | delegate_tool.py:73 |
| 调用方覆盖 | `delegate_task_executor` 接受 `tools_whitelist` 参数覆盖默认集 | delegate_tool.py:487 |

**结论**：需要做的不是"从零实现"，而是**核实白名单正确性 + 补沙箱边界 + 固化验证**。

---

## 1. 白名单核证（基于 112 个真实 ToolDefinition 清单）

将 `SUBAGENT_SAFE_TOOLS` 与 `agent/tools/*.py` 中真实注册的 112 个工具逐一比对：

- **无幽灵条目**：白名单中每个名字都能在注册表找到对应工具（`refactor_preview`/`refactor_depgraph` 初看像幽灵，实则在 `refactor_tools.py` 且已在 `registry.py:436-437` 注册）。✅
- **高危工具均未放行**：`shell_exec`(high)、`execute_code`(high)、`git_commit`(high)、`multi_file_edit`(high)、`desktop_*`(high/medium)、`browser_*`(medium)、`uia_*`(medium)、`ha_control`(medium)、`message_push`、`image_generate`、`skill_create`、`cronjob_*`(medium)、`kanban_*`、`memory_store`、`delegate_task`(medium) 全部不在白名单。✅
- **两处越界（需决策）**：
  - `code_generate_ast`（medium，AST 感知精确代码**编辑**，会写文件）→ 违反"只读"意图。
  - `test_run`（medium，运行测试，有真实副作用：测试夹具可能写库/跑 shell/改环境）→ 注释自辩"只读副作用风险可控"，但属 medium 且有副作用。

### 1.1 白名单设计决策

采用 **显式允许集（fail-safe）+ 元数据派生双轨**，而非纯手写列表：

1. **DROP**（从默认集移除，除非显式覆盖）：
   - `code_generate_ast` —— 它是写操作（AST 编辑落盘），与"只读"原则冲突。
   - `test_run` —— 运行测试有副作用且为 medium；子 Agent 应"分析/报告"而非"执行变更验证"。若确需，由调用方通过 `tools_whitelist` 显式加回并自担风险。
2. **KEEP**（维持）：全部只读/认知/感知类（`file_read/list/grep/search`、`*_parse`、`memory_*`、`knowledge_query`、`code_analyze/review/csv_analyze`、`lsp_*`、`vision_understand`、`web_search/fetch`、`git_status/diff/log`、`coverage_read`、`screen_parse/action_verify/smart_wait/speech_transcribe`、`emotion_detect/scene_analyze/self_reflect`、`system_status/task_analytics/morning_brief/calendar/log_view/preview_execution/session_search`）。
3. **元数据派生（防回归）**：默认集改为由注册表**实时计算**——`category ∈ 只读类集合 AND risk_level == "low"`，再叠加一个**显式拒绝清单**（见 §1.2）。手写 frozenset 降级为"覆盖/调试"入口，不再是唯一真相源。这样新增的低危只读工具自动获得下放，改名/删除也不会静默失效。

### 1.2 显式拒绝清单（即使 risk_level=low 也禁止）

风险级为 low 不等于安全。以下 low-risk 但**有状态/外部副作用**的工具必须进入拒绝集：

`note_take`、`reminder_set`、`task_manage`、`task_priority`、`task_dependency`、`batch_task`、`kanban_get_board`、`kanban_add_task`、`kanban_move_task`、`ha_scene`、`ha_sensor`、`message_push`、`skill_create`、`skill_share`、`natural_schedule`、`voice_interact`、`voice_mode`、`context_manage`、`ask_clarification`、`write_approval`、`todo`、`clarify`、`sanbao_*`。

> 拒绝集以"写/外部副作用"语义判定，不唯 risk_level。这正是纯 `risk_level<=low` 规则会漏掉的坑。

---

## 2. 沙箱边界设计

白名单解决"能调用什么"，沙箱边界解决"调用时与调用后受什么约束"。现有实现缺以下边界：

| 边界 | 现状 | 设计 |
|---|---|---|
| **递归** | 靠白名单不含 `delegate_task` 软约束 | 硬约束：`_run_react` 内若 `allowed_tools` 含 `delegate_task` 直接拒绝（防止 `tools_whitelist` 覆盖绕过深度守卫）；`can_delegate` 深度检查保留 |
| **单工具调用超时** | 仅整轮 LLM `timeout`（默认 120s） | 新增 `per_tool_timeout`（默认 30s），子注册表 `execute` 包 `asyncio.wait_for` |
| **输出体积** | 无上限，结果直接回灌 messages | 新增 `max_tool_output_chars`（默认 8000），超限截断并附 `[truncated]` 标记，避免上下文爆量/成本失控 |
| **轮数/总成本** | 仅 `max_iterations=5` | 新增 `max_llm_cost`（可选预算上限，单位按 provider 计费）；达到即终止并标记 `status=COMPLETED(truncated)` |
| **白名单校验** | 无；名字拼错/重命名 → 静默丢失该工具 | 启动时对默认集与覆盖集做"存在性校验"，缺失名字 `log.warning` 并跳过（fail-safe 但可见） |
| **覆盖集合法性** | `tools_whitelist` 参数未校验 | 覆盖集必须是默认安全集的**子集**（除非带 `unsafe=True` 显式开关）；`delegate_task` 永远不可经覆盖加回 |

---

## 3. 实现方案（批准后的动手清单）

1. `delegate_tool.py`：
   - 新增 `SUBAGENT_DENY_TOOLS: frozenset`（§1.2）与 `_derive_default_safe_tools(registry)`（从注册表按 category+risk 计算，再扣拒绝集）。
   - `SUBAGENT_SAFE_TOOLS` 改为 `_derive_default_safe_tools` 的缓存结果；保留 frozenset 形式供测试。
   - 从默认集移除 `code_generate_ast`、`test_run`。
   - `delegate()` / `_run_react`：加 `per_tool_timeout`、`max_tool_output_chars`、`unsafe` 参数；`tools_whitelist` 覆盖做子集校验；拒绝 `delegate_task` 回流。
   - `_build_sub_registry`：单工具调用包 `asyncio.wait_for(per_tool_timeout)`；输出截断。
2. `DELEGATE_TASK_DEF` 参数：
   - `tools_whitelist` 描述更新为"必须是默认安全集子集"；新增 `unsafe`（bool，默认 false，允许突破子集但拒绝 `delegate_task`）、`per_tool_timeout`、`max_tool_output_chars`。
3. 验证（必做，对应 AGENTS.md "测试 100% 通过"）：
   - `tests/test_p2_6_subagent_sandbox.py`：
     - `TestWhitelistIntegrity`：默认集每个名字在注册表存在；默认集不含任何 `high`/`medium` 风险工具；默认集不含拒绝集任何成员。
     - `TestSandboxBoundary`：非白名单工具被拒（执行返回 not-found/denied）；`tools_whitelist` 含 `delegate_task` 被拒；输出超 `max_tool_output_chars` 被截断；单工具超时触发降级而非挂死；`unsafe=False` 时覆盖集含未授权工具被拒。
     - `TestReactLoop`：mock LLM 多轮 tool_calls → 终答收敛；`max_iterations` 到达即停。

---

## 4. 风险与回退

- 移除 `code_generate_ast`/`test_run` 可能让少数既存子 Agent 任务失去这两项能力 → 调用方可用 `tools_whitelist` + `unsafe=True` 显式恢复，且会在日志留痕。
- 元数据派生若误伤某"低风险但应下放"的工具，靠拒绝集/覆盖集兜底，不影响主路径。
- 回退：本改动集中在 `delegate_tool.py` 单文件 + 1 个测试文件，git 单提交可回滚。

---

## 5. 待你拍板的点

1. 是否同意**移除 `code_generate_ast` 与 `test_run`** 出默认集（改由显式 `unsafe` 覆盖恢复）？
2. 是否接受**白名单改为"注册表元数据派生 + 显式拒绝集"** 双轨（而非纯手写）？
3. 单工具超时/输出截断的默认数值（30s / 8000 字符）是否合适？
4. 是否同步把审计文档 P2-6 状态从 🟡 待专项轮 改为 ✅ 已实现+加固中？
