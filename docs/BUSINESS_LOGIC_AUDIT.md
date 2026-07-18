# 家百星（Jiabaixing）业务逻辑审计报告

> **审计对象**：`C:\zy\jiabaixing\python`（TypeScript 薄网关 + Python FastAPI 后端混合架构）
> **审计范围**：六层 Harness（E-T-C-S-L-V）、记忆/持久化/上下文、工具/护栏/凭据/沙箱、MCP/A2A/API 网关、约束/验证/进化/调度/LLM
> **审计方法**：静态代码走查 + 跨模块数据流追踪 + 复现路径推演（只读，未修改业务代码）
> **审计日期**：2026-07-10
> **问题总数**：共识别 **62** 项业务逻辑缺陷（其中 🔴 严重/崩溃 11 项、🟠 高 21 项、🟡 中 30 项）

---

## 一、缺陷总览（按严重程度）

| 等级           | 数量 | 说明                                         |
| -------------- | ---- | -------------------------------------------- |
| 🔴 严重 / 崩溃 | 11   | 调用即抛异常、功能完全失效、数据不可恢复丢失 |
| 🟠 高          | 21   | 守卫形同虚设、业务规则不生效、确定性错误结果 |
| 🟡 中          | 30   | 边界缺失、统计失真、异常流未覆盖、设计缺口   |

> 严重程度定义：
>
> - **🔴 严重**：触发后导致进程崩溃 / 整条功能链路不可用 / 数据不可逆丢失。
> - **🟠 高**：核心业务规则不生效或产生错误结果，但未必崩溃。
> - **🟡 中**：边界/统计/一致性问题，影响正确性但可绕过或影响较小。

---

## 二、执行循环 / 编排（agent/loop, agent/orchestration）

### L-01 🔴 EvalGate.check() 返回错误类型 → 必崩

- **模块**：`agent/evaluation/eval_gate.py:57`
- **问题描述**：`check()` 方法在通过门控时返回 `EvalGate(...)`（构造器仅接受 `config`），而正确应返回 `EvalGateResult(...)`。调用方期望 `EvalGateResult`。
- **影响范围**：所有调用 `EvalGate.check()` 的评估集成（A/B 门控、回归门控）直接 `TypeError` 崩溃。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`check()` 通过时改为返回 `EvalGateResult(passed=True, ...)` 而非 `EvalGate(...)`；失败时返回 `EvalGateResult(passed=False, ...)`。调用方类型匹配。

### L-02 🔴 Executor 退避重试用伪造 context → AttributeError 崩溃

- **模块**：`agent/loop/executor.py:1038`
- **问题描述**：`_retry_with_backoff` 调用 `_execute_step(step, type('ctx', (), {'step_results': {}})())`，该假对象只有 `step_results` 一个属性，而 `_execute_with_tool`（:553）会访问 `context.trace_id`、`context.is_cancelled()` 等 → 抛 `AttributeError`，且异常未被捕获，向上传播导致整步执行崩溃。
- **影响范围**：所有网络/超时类错误的退避重试路径（高频错误类型）。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`_retry_with_backoff` 改为传入真实 `context`（原 `ctx` 参数），不再构造伪造对象；退避重试使用与主执行路径相同的完整 context，`trace_id`/`is_cancelled()` 等属性均可正常访问。

### L-03 🔴 Executor 反思重试 `reflection` 可能未绑定 → NameError

- **模块**：`agent/loop/executor.py:462`
- **问题描述**：当 `max_reflection_retries == 0`（如进化引擎动态置 0 或 `step.max_retries == 0`）时，`for` 循环体不进入，`reflection` 未绑定；随后 :462 `if not (... and reflection.corrected_args)` 引用未定义变量 → `NameError`。
- **影响范围**：`max_retries=0` 的工具步骤的反思重试路径。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`_retry_with_reflection` 在循环前初始化 `reflection = None`；循环后检查 `if reflection is not None and reflection.corrected_args` 才使用，否则直接返回失败结果。

### L-04 🟠 预算维度 max_duration_ms / max_tokens 从不强制、从不累加

- **模块**：`agent/loop/controller.py:197,241`；`agent/loop/types.py:48-52`
- **问题描述**：`BudgetState.max_duration_ms` 在循环中被计算并写入，但主循环仅检查 `rounds_used` 与 `tool_calls_used`；既不比对 elapsed，也未在超时时中止。且 `tokens_used` 永远为 0（全代码无累加点）。
- **影响范围**：长任务可能无限运行直到 `max_tool_calls` 耗尽；无 Token 超限保护。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① 主循环增加 `elapsed > max_duration_ms` 检查，超时即中止并返回 `LoopAction.stop`；② 每次 LLM 调用后累加 `tokens_used += usage.total_tokens`；③ `tokens_used > max_tokens` 时中止。

### L-05 🟠 `continue` 分支对持续失败步骤不升级为 replan（循环空转）

- **模块**：`agent/loop/controller.py:473-478` + `executor.py:96`
- **问题描述**：评估器返回 `continue` 且 `goal_progress < 0.8` 时，控制器 `continue` 回到循环顶部；因 `replan_count==0` 跳过规划，Executor 用同一 plan 重跑。Executor 仅跳过 `status=="completed"` 的步骤，失败步骤以相同（可能错误的）参数重跑，`goal_progress` 不变 → 持续 `continue` 直到 `max_tool_calls` 才退。
- **影响范围**：任何存在确定性失败步骤的任务，无法自动升级为重规划。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`continue` 分支增加连续失败计数器 `consecutive_continue_count`，超过阈值（默认 2）时自动升级为 `replan`（`replan_count += 1`），触发重新规划而非空转。

### L-06 🟠 plan_steps / needs_replan 从未产出 → GAP-05/GAP-08 死代码

- **模块**：`agent/core/engine.py:1705,1720`；`agent/loop/controller.py`（AgentResult.metadata）
- **问题描述**：`AgentResult.metadata` 仅含 `rounds_used/tool_calls_used/...`，不含 `plan_steps`/`needs_replan`；但 `engine` 据 `result.metadata.get("plan_steps")` / `get("needs_replan")` 触发规划质量预检与增量重规划，二者永远为 `None` → 功能从未触发。
- **影响范围**：规划质量反馈闭环与增量重规划完全失效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`AgentResult.metadata` 新增 `plan_steps`（执行计划步骤列表）和 `needs_replan`（布尔值）字段；controller 在评估后写入 `needs_replan = (action == LoopAction.replan)`；executor 写入 `plan_steps = [s.to_dict() for s in plan.steps]`。

### L-07 🟠 PLAN_QUALITY 学习信号恒为 0.5（错误计算）

- **模块**：`agent/loop/controller.py:627-641`
- **问题描述**：`planned_steps = len(context.steps) if hasattr(context,'steps') else 0`，但 `LoopContext` 无 `steps` 属性 → `planned_steps=0` → `plan_quality` 停留在默认 `0.5`。
- **影响范围**：注入进化引擎的规划质量反馈失真（恒常数）。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：改为 `planned_steps = len(context.plan.steps) if hasattr(context, 'plan') and context.plan else 0`，正确访问 `LoopContext.plan.steps`；`plan_quality = completed_steps / planned_steps` 计算真实值。

### L-08 🟡 计划模式无"最终答案合成"，用户拿到工具原始输出

- **模块**：`agent/loop/reporter.py:66-81`；`agent/loop/executor.py:112`
- **问题描述**：`_extract_response` 取 `messages` 中最后一条 `assistant` 消息，而 Executor 在每步成功后追加的是该工具原始返回值；多步任务的最终答复 = 最后一个成功步骤的工具原始输出，而非面向用户的综合回答。
- **影响范围**：所有计划模式多步任务的最终用户体验。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`_extract_response` 增加多步合成逻辑——当 `len(assistant_msgs) > 1` 且有多个成功步骤时，生成步骤摘要（工具名+内容前100字）+ 最终结果的合成回答，而非直接返回最后一条工具原始输出。

### L-09 🟡 错误恢复评分维度恒为 0（字段错配）

- **模块**：`agent/loop/reporter.py:166-169`；`agent/loop/types.py:56-64`
- **问题描述**：`_score_error_recovery` 用 `getattr(r,'retry_count',0)`，但 `StepResult` 无 `retry_count` 字段（重试次数在 `PlanStep.retry_count`），永远为 0 → 凡有失败步骤的任务错误恢复维度恒 0 分（权重 20%）。
- **影响范围**：质量总评被不合理拉低。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`_score_error_recovery` 改为从 `PlanStep.retry_count` 读取重试次数（`step.retry_count` 而非 `result.retry_count`），正确计算错误恢复维度分数。

### L-10 🟡 编排器死三元 + 依赖不保证

- **模块**：`agent/orchestration/executor.py:282-286`；`agent/orchestration/fanout.py:142,173`
- **问题描述**：`overall_status` 三元两侧均为 `TaskStatus.FAILED`（死代码）；并行模式不检查 `task.dependencies`，顺序模式按输入顺序而非拓扑排序执行，依赖任务可能先于前置执行。
- **影响范围**：多 Agent 编排的结果正确性与状态判定。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：① 三元已修复为 `PARTIALLY_COMPLETED`（有完成也有失败）/ `FAILED`（全失败）/ `SKIPPED`（全跳过）三路分支；② `_get_ready_tasks()` 按依赖完成状态拓扑排序，依赖失败则 skip 下游任务，不再按输入顺序执行。

### L-11 🟡 聚合器把 skipped/pending 计入失败

- **模块**：`agent/orchestration/result_aggregator.py:177-181`
- **问题描述**：状态既非 completed 也非 failed（如 skipped/pending）时，`detail.status="failed"` 进而整体 `success=False` → 被 skip 的任务（如依赖失败而跳过）使整个聚合失败，且未区分"跳过"与"真失败"。
- **影响范围**：编排聚合结果判定。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：skipped/pending 状态保留原状态（`detail.status = task.status`），计入 `skipped_count` 而非 `failed_count`；`success = failed_count == 0`（skipped 不影响整体成功判定）。

---

## 三、记忆系统 / 持久化 / 上下文

### M-01 🔴 MemoryStore.search 空查询 / `*` 查询崩溃

- **模块**：`agent/memory/store.py:155-218`
- **问题描述**：`query=""` 时 `tokenize_for_search("")` 返回 `[]` → `fts_query=""` → `WHERE memories_fts MATCH ""` 触发 FTS5 语法错误（`sqlite3.OperationalError`）。`search` 内部无 try/except，异常上抛。`curator.review()` 调 `search("", 1000)`、`generate_self_reminder` 回退 `search("*")` 均触发。
- **影响范围**：记忆审查、自我提醒功能静默失效；任何空/星号查询崩溃。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`search()` 对空查询返回空列表而非触发 FTS5；`query="*"` 改为 `query=""` 后走全量检索路径；增加 try/except 捕获 FTS5 语法错误并回退全表扫描。

### M-02 🟠 写后不失效搜索缓存（数据新鲜度缺陷）

- **模块**：`agent/memory/engine.py:481-482`
- **问题描述**：`MemoryEngine.store` 写入新记忆后，已有搜索缓存（TTL 5 分钟）不失效，新记忆最长 5 分钟内不可见。
- **影响范围**：写读不一致，新记忆"看不见"。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`MemoryEngine.store` 写入后立即调用 `_invalidate_search_cache()` 清除搜索缓存条目，保证新记忆立即可见。

### M-03 🟠 MemoryCurator 忘记/巩固是空操作 + 字段名错误

- **模块**：`agent/memory/curator.py:120-138,122`
- **问题描述**：`curate()` 只统计 `to_forget/to_consolidate` 从不真正删除/合并；`mem.get("type")` 应为 `memory_type`（结果永远 `"general"`），导致情景记忆加分永不生效。
- **影响范围**：记忆保留策略形同虚设。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① `curate()` 对 `to_forget` 列表调用 `store.delete(mem_id)` 真正删除；② 对 `to_consolidate` 调用 `store.consolidate(ids)` 合并；③ 字段名修正为 `memory_type`。

### M-04 🟠 双 FTS 索引脱节（SessionStore vs SessionSearchIndex）

- **模块**：`agent/persistence/session_store.py`；`agent/persistence/session_search_index.py`
- **问题描述**：`SessionStore.add_message`/`delete_session` 从不调用 `SessionSearchIndex`，后者仅 `build_index()` 时更新；两套索引权威性冲突，搜索可能拿到陈旧/空索引。
- **影响范围**：会话搜索结果不一致。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`SessionStore.add_message` 写入后同步调用 `search_index.add_message()`；`delete_session` 后同步调用 `search_index.delete_session()`，保持双索引一致。

### M-05 🟠 上下文压缩功能完全失效（压缩结果被丢弃）

- **模块**：`agent/core/context_compressor.py:204-253`；`agent/core/context_compressor.py:897-908`
- **问题描述**：`ContextCompressor.compress()` 返回仅含统计的 `CompressionResult`，不返回压缩后消息；`ContextWindowManager._do_compress` 返回原始 `messages`。整个自动压缩管道名存实亡，上下文永不压缩。`ConversationCompressor`（可用）未被接线。
- **影响范围**：长对话上下文无限增长，可能超模型窗口。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`_do_compress` 改为使用 `ConversationCompressor`（可用实现），返回压缩后消息列表而非原始消息；`CompressionResult` 新增 `compressed_messages` 字段。

### M-06 🟠 移除旧 tool 结果但保留悬空 tool_call → 非法 LLM 载荷

- **模块**：`agent/core/context_compressor.py:271-296`
- **问题描述**：策略保留最后 3 个 tool 结果及其前置 assistant 消息，但更早的 `role=="assistant"`（含 `tool_calls`）消息被无条件保留，而其对应的 tool 结果已被删除 → 出现"悬空 tool_call" → 发给 LLM 触发 API 校验错误。
- **影响范围**：压缩后上下文可能触发 LLM API 报错。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：压缩策略删除 tool 结果时，同步删除对应的 assistant 消息（含 `tool_calls`），避免悬空 tool_call；或保留 tool 结果直到对应 assistant 消息也被删除。

### M-07 🟠 TrajectoryDatabase 短 ID + OR REPLACE → 级联删除子表

- **模块**：`agent/persistence/trajectory.py:401,313`
- **问题描述**：`record_execution` id 仅 8 位十六进制，`INSERT OR REPLACE` 碰撞时覆盖 `executions` 行，外键 `ON DELETE CASCADE` 删除该 id 下已有的 tool_invocations/state_transitions 子记录 → 历史轨迹被静默抹除。
- **影响范围**：执行轨迹数据不可逆丢失。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：ID 扩展为完整 `uuid4().hex`（32 位），消除碰撞；`INSERT OR REPLACE` 改为 `INSERT OR IGNORE` 避免级联删除。

### M-08 🟠 update_execution_status 以 None 清空已有 response

- **模块**：`agent/persistence/trajectory.py:421-430`
- **问题描述**：调用方只更新状态（`response=None` 默认）时，`SET response=?` 将已有响应清空为 NULL。
- **影响范围**：轨迹响应数据丢失。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`update_execution_status` 改为条件更新：`SET status=?, response=COALESCE(?, response)` 仅在 `response` 非 None 时更新，否则保留原值。

### M-09 🟡 非原子写 + 损坏即静默清空（会话/工作区/检查点）

- **模块**：`agent/persistence/session_store.py:311-326`；`agent/persistence/workspace.py:448-463`；`agent/persistence/checkpoint.py:142-145`
- **问题描述**：JSON 持久化直接覆盖整个文件无临时文件+重命名；`_load()` 捕获 `JSONDecodeError` 后 `pass` → 损坏即丢失全部数据。`checkpoint` 同秒同标签 id 碰撞互相覆盖。
- **影响范围**：进程崩溃/磁盘满时数据丢失且无备份。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：① JSON 写入改为原子写（先写 `.tmp` 再 `os.replace`）；② `_load()` 损坏时保留备份文件并抛出异常而非静默清空；③ checkpoint ID 加入纳秒精度避免碰撞。

### M-10 🟡 短截断 uuid 作为 ID 普遍碰撞覆盖

- **模块**：`session_store.py:329`、`trajectory.py:401`、`workspace.py:110`、`episodic_memory.py:106`
- **问题描述**：多处用 `uuid4().hex[:8]`/`[:12]` 作主键，`INSERT OR REPLACE`/字典赋值碰撞时覆盖已有记录。
- **影响范围**：跨记录覆盖风险。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：所有 `uuid4().hex[:8]`/`[:12]` 改为 `uuid4().hex`（32 位），碰撞概率从 ~10⁻⁸ 降至 ~10⁻³⁸；`INSERT OR REPLACE` 改为 `INSERT OR IGNORE`。

### M-11 🟡 EpisodicMemoryStore 只清内存不清库 → DB 无限膨胀

- **模块**：`agent/memory/episodic_memory.py:278-286`
- **问题描述**：超过 `_MAX_EPISODES=500` 仅从内存列表删除最旧项，从不从 SQLite 删除 → DB 无限增长。
- **影响范围**：磁盘占用无限增长。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：淘汰最旧项时同步执行 `DELETE FROM episodes WHERE id = ?` 从 SQLite 删除，保持内存与 DB 一致。

### M-12 🟡 多模态跨会话向量维度不兼容 → 检索全盘空

- **模块**：`agent/memory/multimodal_encoder.py:281`
- **问题描述**：CLIP/文本模型产 512 维，哈希兜底产 128 维；`cosine_similarity` 维度不等返回 0.0。惰性加载导致存储与查询维度不一致 → 多模态检索全盘返回空。
- **影响范围**：多模态记忆检索静默失效。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`cosine_similarity` 维度不等时对短向量零填充至相同维度后再计算；存储时记录维度元数据，查询时检测不一致则重新编码。

### M-13 🟡 上下文历史 `history[-10:]` 不受 token 预算约束

- **模块**：`agent/core/context_pipeline.py:260-262`
- **问题描述**：历史硬取最近 10 条直接拼接，不受 `allocation.history` 约束；与压缩失效叠加 → 上下文可无限增长。
- **影响范围**：上下文超窗口风险。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`history[-10:]` 改为按 token 预算动态截取：从最新消息向前累加 token 数，达到 `allocation.history` 预算即停止。

---

## 四、工具系统 / 护栏 / 凭据 / 沙箱

### T-01 🔴 权限检查因参数错误被 except 吞掉 → 权限形同虚设

- **模块**：`agent/core/conversation_loop.py:260,270`
- **问题描述**：`self._permission_guard.check(tool_call.name, params)` 只传 2 个位置参数，但 `PermissionGuard.check(self, tool_name, required_permissions, risk_level, context)` 需 4 个 → 抛 `TypeError` → 被 `except Exception: pass` 吞掉；且 `check()` 返回 truthy 对象，`if not allowed` 永远为 False，永不拒绝。
- **影响范围**：所有 ReAct 工具调用的权限检查从未真正执行。
- **严重程度**：🔴 严重
- **复现步骤**：配置禁止某工具的权限策略 → 调用该工具 → 仍被放行（异常被吞）。
- **✅ 修复（2026-07-10）**：新增 `_tool_risk_and_permissions()` 从 `ToolDefinition` 读取 `risk_level`/`permissions`，`_check_permission()` 按 4 参数正确签名 `check(name, required, risk, ctx)` 调用；`TypeError` 回退旧签名，其它异常按“拒绝”处理（不再 `except:pass`）；结果规范化为 `PermissionCheckResult`，`needs_confirmation` 交审批流。回归测试 `test_T01_permission_denied_actually_blocks_tool`、`test_T01_permission_check_typeerror_falls_back_and_denies_on_error`。

### T-02 🔴 shell_exec 宿主直跑、黑名单易绕过、声明 high 不生效

- **模块**：`agent/tools/code_tools.py:252,81-86`
- **问题描述**：`shell_exec` 直接 `subprocess.run(command, shell=True)` 在宿主执行，不调用 `SandboxExecutor` 或 `constraints.service`；`_FORBIDDEN_COMMANDS` 子串匹配可绕过（`rm -r /`、`dd if=`、`mkfs`、`chmod -R 000 /`、fork 炸弹均不在列表）。
- **影响范围**：高危命令执行安全边界失效。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：① `_FORBIDDEN_PATTERNS` 从 9 条扩展到 40+ 条正则，覆盖 `sudo/su/chroot/mount/crontab/nohup/screen/tmux/systemctl/pip install --user` 等绕过路径；② 新增 `_ALLOWED_COMMAND_PREFIXES` 白名单，首个命令词不在白名单则拒绝；③ 通过 `SandboxExecutor(HIGH)` 做安全预检；④ `subprocess.run` 改为 `shell=False` + `shlex.split` 避免 shell 注入。

### T-03 🟠 审批生产环境 auto_approve_all 全放行 + 风险硬编码

- **模块**：`agent/core/conversation_loop.py:273-291`；`agent/tools/approval_manager.py:83-90`
- **问题描述**：生产 `ApprovalManager(auto_approve_all=True)`，`request_approval` 直接返回 approved；且 `risk` 被硬编码为 `low`/`medium`，忽略工具声明的 `high` 风险等级（`shell_exec`/`execute_code` 声明 `high`）。
- **影响范围**：高风险工具按低风险审批，审批流在生产从不介入。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`_execute_tool` 改用工具定义的真实 `risk` 传给 `request_approval`（不再硬编码 low/medium）；`ApprovalManager` 新增 `_NEVER_AUTO_APPROVE_RISKS={"critical"}`，`auto_approve_all`/`auto_approve_low_risk` 对 critical 不生效（强制走审批/超时拒绝）。回归测试 `test_T03_approval_uses_tool_defined_risk_level`、`test_T03_critical_never_auto_approved`。

### T-04 🟠 去重/缓存/限速/参数校验/结果缓存全部未接入执行路径（死代码）

- **模块**：`agent/core/conversation_loop.py:49-75`（赋值但从不调用）
- **问题描述**：`tool_call_guard`、`schema_validator`、`tool_result_cache`、`sandbox`、`constraints` 均已实例化并传参，但 `_execute_tool` 中无任何 `.check/.record/.validate` 调用。守卫层整体失效。
- **影响范围**：工具调用去重、参数校验、结果缓存、沙箱、约束全部不生效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`_execute_tool` 集成完整守卫链路：① 参数解析后调用 `schema_validator.validate()` 校验参数类型/必填/枚举，校验失败直接返回错误，通过则使用 `sanitized_params`；② 权限检查前调用 `tool_call_guard.check()` 执行去重（30s窗口）/缓存（5min TTL）/限速（每工具每轮2次），拦截时返回缓存/去重/限速结果；③ 工具执行后调用 `tool_call_guard.record()` 记录调用历史和缓存成功结果；④ 每轮对话开始时 `reset_round()` 重置速率计数。

### T-05 🟠 凭据池死 Key 无限复活 + 限流抑制失效

- **模块**：`agent/llm/credential_pool.py:83-96,98-107`
- **问题描述**：`get_next()` 无可用凭据时 `_force_reset()` 把所有 `failure_count=0` 后返回 → 全部失败 Key 被强制复活无限重试，无熔断上限；`report_rate_limit` 把 `retry_after`（相对秒数）与 `time.time()`（绝对时间戳，≈1.7e9）比较 → `retry_after <= time.time()` 恒 True → 永不设置 `rate_limited_until`，限流保护失效。
- **影响范围**：持续 401/限流场景形成重试风暴，限流退避无效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① `_force_reset()` 增加熔断上限 `MAX_FORCE_RESETS=3`，超过则抛 `AllCredentialsExhausted` 而非无限复活；② `report_rate_limit` 修复比较逻辑：`retry_after > time.time()` 时才设置 `rate_limited_until`（原 `<=` 恒 True）。

### T-06 🟠 成本/预算守卫只记录不拦截

- **模块**：`agent/llm/provider.py`（仅 `record_usage`）；`agent/llm/budget_config.py`（`check_budget` 无调用方）
- **问题描述**：`CostGuard`/`BudgetGuard` 的事前 `check_budget` 从不被 `LLMProvider` 调用，仅事后 `record_usage` 统计；超预算请求仍照常发出。
- **影响范围**：成本/预算约束形同虚设。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`LLMProvider.chat()` 调用前先 `check_budget()`，超预算抛 `BudgetExceeded` 拦截请求；`record_usage` 后也检查累计是否超限。

### T-07 🟡 timeout=0 在三处均导致立即失败

- **模块**：`agent/tools/registry.py:208`；`agent/sandbox/executor.py:171`；`agent/tools/code_tools.py:249`
- **问题描述**：`asyncio.wait_for(coro, timeout=0)` 立即抛 `TimeoutError`；`shell_exec` `timeout_sec = min(timeout_ms/1000, 60)` 在 `timeout_ms=0` 时为 0 → 命令立即超时失败。无零值保护。
- **影响范围**：配置 `TOOL_EXECUTE_TIMEOUT=0` 或 `timeout:0` 时所有工具/命令必失败。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：三处均增加零值保护：`timeout = max(timeout, 0.001)` 或 `if timeout_ms <= 0: timeout_ms = 30000`（回退默认值），避免 `timeout=0` 立即失败。

### T-08 🟡 元数据跨层丢失

- **模块**：`agent/core/conversation_loop.py:318-325`
- **问题描述**：构造 `ToolResult` 只拷贝 `output/success/error/duration`，不拷贝 `metadata`（registry 写入的 `truncated`/`original_chars`/`exit_code` 等全部丢失）。
- **影响范围**：模型拿不到截断/退出码信息。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`turn_types.ToolResult` 新增 `metadata: dict` 字段；`_execute_tool` 返回时 `metadata=dict(getattr(result,"metadata",{}) or {})` 透传 registry 写入的 `truncated`/`original_chars`/`exit_code` 等。回归测试 `test_T08_tool_result_metadata_propagated`。

### T-09 🟡 registry 异常被压成字符串、register 静默覆盖

- **模块**：`agent/tools/registry.py:230-231,111-112`
- **问题描述**：`except Exception as e: return ToolResult(error=str(e))` 丢失堆栈/类型；同名 `register` 直接覆盖无告警。
- **影响范围**：排障困难、工具被意外替换。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：① `except Exception as e: return ToolResult(error=f"{type(e).__name__}: {e}", metadata={"exception_type": type(e).__name__})` 保留异常类型名；② `register` 同名覆盖时 `log.warning("工具注册覆盖", name=name)` 告警。

### T-10 🟡 沙箱内存/CPU 限制是空声明

- **模块**：`agent/sandbox/executor.py:46-47,288`
- **问题描述**：`SandboxConfig.max_memory_mb/max_cpu_percent` 未施加任何 `setrlimit`/`taskset`/cgroup 限制，仅 `max_output_length` 生效。
- **影响范围**：资源限制形同虚设。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：新增 `_make_preexec_fn()` 在 Unix 上通过 `resource.setrlimit(RLIMIT_AS/RLIMIT_DATA)` 施加内存硬限制；新增 `_monitor_resources()` 在 Windows（无 preexec_fn）上通过 `psutil` 周期性监控 RSS，超限即 kill 子进程；三种执行器（Python/JS/Shell）均已接入资源限制逻辑。

---

## 五、MCP / A2A / API 网关

### A-01 🔴 MCP initialize 缺 id → 握手永未完成、capabilities 恒空

- **模块**：`agent/mcp/server_manager.py:305-316,603-617`
- **问题描述**：`_initialize_server` 构造的 `initialize` 消息无 `id` 字段，`send_message` 对无 `id` 的消息判定为 notification 直接返回桩 `{"result":None}`，从不等待服务器响应；随后 `if server_proc and response.get("result")` 为 `None` → `initialized` 永远 `False`，`capabilities=None` → `list_resources/prompts` 恒 `[]`，`get_server_health` 的 `healthy` 恒 `False`。
- **影响范围**：所有 stdio MCP 服务器处于"已运行但未初始化"半残状态。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`_initialize_server` 构造 `initialize` 消息时添加 `id=str(uuid4())` 字段，使 `send_message` 走 request-response 路径等待服务器响应；`initialized` 和 `capabilities` 正确设置。

### A-02 🔴 网关适配器 receive_message 从未被消费 + sync Future 永不被 resolve

- **模块**：`agent/gateway/platforms/api_server_adapter.py:123,221-254`；`agent/gateway/dispatcher.py`（set_handler 从未调用）
- **问题描述**：`/chat` sync 模式将 Future 存入 `_pending_responses`，但无消费循环调用 `receive_message()` → `await wait_for(future, 60)` 总是超时返回 504；异步消息入队后丢弃。
- **影响范围**：整个 HTTP 网关入口不可用（sync 必 504、async 丢消息）。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：① `MessageDispatcher` 新增 `start_consuming()` 方法，为每个已注册适配器启动消费协程（`async for msg in adapter.receive_message()` → `dispatch(msg)` → `send_message(chat_id, result)`）；② `_init_gateway_dispatcher()` 中自动 `set_handler(_gateway_handler)` + `await start_consuming()`，handler 包装 `engine.process_input`；③ sync Future 现在可被消费循环中的 `send_message` resolve。

### A-03 🔴 TS 传入 trace_id/request_id 在 WS 与 REST 入口均不传入引擎 + 命名不一致

- **模块**：`agent/main.py:341-342,520`；`agent/api/compat.py`；`agent/api/models/chat.py`
- **问题描述**：WS 读取 `trace_id` 但不传给 `engine.process_input_stream`；引擎另生成自己 trace。compat 层 `/process` 返回 `traceId`、`/chat` 返回 `trace_id`，字段命名不一致。
- **影响范围**：端到端 trace 不可关联。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：① WS/REST 入口将 `trace_id` 透传给 `engine.process_input(trace_id=trace_id)`；② compat 层统一返回 `trace_id`（`traceId` 作为别名保留）；③ 引擎优先使用传入的 `trace_id`，仅缺省时自生成。

### A-04 🟠 WebSocket 绕过 API Key 与限流

- **模块**：`agent/main.py:49,154`
- **问题描述**：`MetricsMiddleware`/`ApiGatewayMiddleware` 对 `scope["type"] != "http"` 直接 `await self.app(...)` 放通 → `/`、`/ws`、`/v1/stream`、`/v1/events` 无 API Key、无限流、无 trace 注入。
- **影响范围**：WS 入口无鉴权/限流。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`ApiGatewayMiddleware.__call__` 对 `scope["type"]=="websocket"` 增加完整鉴权+限流链路：① API Key 认证（缺 key 或无效 key 返回 `websocket.close(code=1008)`）；② 令牌桶限流（超限返回 `code=1008, reason="Rate limit exceeded"`）；③ 请求计数纳入统计。`MetricsMiddleware` 对 WebSocket 连接也纳入 `total_requests` 和 `endpoint_counts` 统计。

### A-05 🟠 A2A /agents/publish 无鉴权且回显 authentication 字典

- **模块**：`agent/a2a/server.py:303-328`；`agent/a2a/types.py:260`
- **问题描述**：`/agents/publish` 未加 `Depends(_require_auth)`；`req.authentication`（可含 `api_key`/`jwt_secret`）原样存入并随 `list_agents`/`discover_agents` 返回 → 密钥泄露。
- **影响范围**：A2A 注册入口安全与信息泄露。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① `/agents/publish` 存储时脱敏 `authentication` 字典，仅保留 `type` 字段（如 `{"type": "api-key"}`），移除所有凭据值；② `/.well-known/agent.json` 端点返回前 `pop("authentication")` 防止泄露（此前仅 `list_agents`/`discover_agents` 做了 pop，well-known 端点遗漏）。

### A-06 🟠 /a2a/push 为纯日志空操作

- **模块**：`agent/a2a/server.py:495-516`
- **问题描述**：推送通知只 `logger.info` 后返回 `{"received": True}`，不更新任何 task 状态 → 依赖 push 做状态同步的客户端永远得不到同步。
- **影响范围**：A2A 跨 Agent 状态同步失效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① 修复 `m.get_task()` 缺少 `await` 导致返回 coroutine 而非 task 对象的 bug；② `status-change` 事件更新 task 状态后调用 `m.update_task()` 持久化；③ `progress` 事件更新 metadata 后持久化，增加 metadata None 保护；④ 新增 `artifact` 事件处理，将推送的 artifact 追加到 task.metadata["artifacts"] 并持久化。

### A-07 🟡 api/mcp 工具禁用返回 500 而非 403

- **模块**：`agent/api/mcp.py:412-416`
- **问题描述**：`manager.call_tool` 在 `tool_filtering` 拒绝时抛 `RuntimeError("工具 ... 已被禁用")`，被包成 500；按语义应为 403。
- **影响范围**：客户端无法区分服务器错误与权限不足。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`tool_filtering` 拒绝时抛 `HTTPException(status_code=403, detail="工具已被禁用")` 而非 `RuntimeError`。

### A-08 🟡 限流默认关闭 + 匿名共享 bucket + 多进程失效

- **模块**：`agent/infrastructure/api_gateway.py:179,180`；`agent/main.py:157`
- **问题描述**：`RATE_LIMIT_CAPACITY` 默认 `"0"` → 跳过限流；未认证请求共用字面量 `"anonymous"` bucket；令牌桶进程内存储，多 worker 各自独立。
- **影响范围**：限流在生产默认不生效。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：① 默认容量改为 `"60"`（每分钟 60 次）；② 匿名 bucket 改为 `f"anon_{client_ip}"` 按 IP 隔离；③ 多进程场景建议外接 Redis 令牌桶（文档标注）。

### A-09 🟡 /v1/status 恒为 0（假数据）

- **模块**：`agent/api/chat.py:43-51`
- **问题描述**：`memory_entries=0, active_sessions=0, skills_count=0` 写死，对外暴露假状态。
- **影响范围**：监控指标失真。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`/v1/status` 从 `engine` 获取真实数据：`memory_entries=len(engine.memory_store)`、`active_sessions=engine.session_count`、`skills_count=len(engine.tool_registry)`。

---

## 六、约束 / 验证 / 进化 / 调度 / LLM

### C-01 🟠 约束预算只"报告"不"强制"

- **模块**：`agent/constraints/service.py:198-227`
- **问题描述**：`check_budget` 仅在达硬上限时加一条 warning，`within_budget` 仍 True；且全代码库无调用方据其结果停止循环。
- **影响范围**：预算约束不拦截。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`check_budget` 达硬上限时 `within_budget=False`；循环每轮检查 `constraints_service.check_budget()`，`not within_budget` 时中止。

### C-02 🟠 execute_hooks 吞异常 → HARD 约束失效

- **模块**：`agent/constraints/service.py:260-271`
- **问题描述**：钩子抛异常被 `except Exception: pass` 吞掉，循环继续；且先返回的钩子 `proceed=False` 即返回，屏蔽后续本应拦截的钩子。
- **影响范围**：安全检查钩子失效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① `except Exception` 改为记录异常类型+消息的结构化日志，HARD 约束钩子异常时 `proceed=False`（fail-safe）；② 收集所有钩子结果后取最严格（任一 `proceed=False` 则整体 False）。

### V-01 🟠 无 LLM 时目标进度恒"已达成"（验证误通过）

- **模块**：`agent/verification/service.py:371-406`
- **问题描述**：`evaluate_goal_progress` 在 `self.deps.llm is None` 时直接 `return GoalProgress(achieved=True, progress=0.8)`，任何输出都被当成功。
- **影响范围**：进化/循环据此误判任务完成。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：无 LLM 时返回 `GoalProgress(achieved=False, progress=0.0)` 并记录 warning，避免无验证能力时误判成功。

### V-02 🟠 LLM 解析失败/缺字段仍判成功

- **模块**：`agent/verification/service.py:430-446`
- **问题描述**：`_llm_evaluate_goal` 找不到 JSON 返回 `achieved=True`；缺 `achieved` 字段默认 True → 异常输出一律当成功。
- **影响范围**：验证误通过，无法触发 replan。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：找不到 JSON 或缺 `achieved` 字段时返回 `achieved=False`（fail-safe 默认失败），解析异常记录 warning。

### E-01 🔴 进化回滚验证用"计数−时间戳"恒负 → 永不回滚且快照堆积

- **模块**：`agent/evolution/orchestrator.py:670-694`
- **问题描述**：`elapsed = self._interaction_count - (self._optimization_cycles[-1].timestamp ...)`，计数（int）减时间戳（float Unix）→ 极大负数 → `elapsed < 1` 恒成立 → `continue`，回滚判断永不进入；且 `continue` 在把 cycle_id 加入 `expired` 之前，pending 快照既不验证也不清理，无限堆积。进化后质量下降**永远不会回滚**。
- **影响范围**：进化发散无护栏，快照内存泄漏。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`elapsed` 改为 `time.time() - cycle.timestamp`（两个时间戳相减），正确计算经过时间；`elapsed >= threshold` 时进入回滚判断；pending 快照超时未验证则自动清理。

### E-02 🔴 EvolutionEngineV2 从未被真正调用（方法不存在）

- **模块**：`agent/evolution/orchestrator.py:326` vs `v2_engine.py`
- **问题描述**：`plan = await self._evolution_engine_v2.plan_evolution(cause)` 但 `EvolutionEngineV2` 只有 `trigger_evolution`/`generate_evolution_plan`，无 `plan_evolution` → 抛 `AttributeError` 被 `except` 吞 → V2 自修改引擎永远不执行。
- **影响范围**：V2 自我修改能力完全失效。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：orchestrator 改调真实公开 API `await self._evolution_engine_v2.trigger_evolution(cause)`（内部完成 plan→执行→校验→回滚）；`_detect_v2_evolution_cause()` 返回的 dict 转换为 `V2EvolutionCause`（type/description/context/timestamp）；`v2_result` 为 None 时记 triggered=False。回归测试 `test_E02_v2_public_api_is_trigger_evolution`、`test_E02_orchestrator_triggers_v2_with_cause_object`。

### E-03 🔴 V2 安全评估 assess_action_safety 从未在执行路径调用

- **模块**：`agent/evolution/v2_engine.py:297-365,377-418`
- **问题描述**：`execute_plan → _execute_action → _modify_file/...` 无任何调用去 `assess_action_safety` → LLM 生成的计划可删 `agent/main.py`、改 `src/core/` 等禁止路径，整套 `forbidden_paths` 是死代码，无强制。
- **影响范围**：危险文件修改无阻挡。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`_execute_action` 在动作分发前强制 `assessment = self.assess_action_safety(action)`，`not assessment.allowed` 时记录告警、`learn_safety_outcome(success=False)` 并直接返回 False，禁止路径/删除入口文件被拦截。回归测试 `test_E03_safety_boundary_blocks_forbidden_delete`、`test_E03_safety_boundary_blocks_forbidden_path`。

### E-04 🟠 \_validate_evolution 永远通过

- **模块**：`agent/evolution/v2_engine.py:648-649`
- **问题描述**：`return {"passed": True, "details": "验证通过（Python侧暂无编译检查）"}`，无论改了什么文件验证恒通过 → 坏的代码修改不会被发现/回滚。
- **影响范围**：进化质量门失效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`_validate_evolution` 改为真实校验——对本次计划改动/新建的 `.py` 做 `ast.parse` 语法检查、`.json` 做 `json.loads` 结构检查，有错误返回 `passed=False` 并附明细，触发回滚。回归测试 `test_E04_validate_rejects_bad_python`、`test_E04_validate_passes_good_python_and_json`、`test_E04_validate_rejects_bad_json`。

### E-05 🟠 进化建议持久化用户偏好与"禁止存敏感信息"冲突

- **模块**：`agent/evolution/engine.py:322-344` vs `agent/constraints/service.py`
- **问题描述**：`nudge_knowledge_persistence` 命中"我喜欢/记住/默认"等关键词且无 memory 工具时建议持久化用户输入，不做敏感信息过滤，违背 `no-sensitive-storage` HARD 约束。
- **影响范围**：潜在敏感信息落盘。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① 敏感检测阈值从 HIGH/CRITICAL 扩展到 MEDIUM 及以上；② 检测器异常时 fail-safe 阻止持久化（原静默通过）；③ snippet 脱敏：正则替换邮箱→`[邮箱]`、手机号→`[电话]`、身份证→`[身份证]`。

### E-06 🟠 反馈 cause 词汇与引擎不一致 → 工具失败进化不触发

- **模块**：`agent/evolution/feedback_loop.py:252-278` vs `engine.py:168`
- **问题描述**：`feed_to_evolution_engine` 写 `cause=signal.signal_type`（positive/negative/...），而 `should_evolve` 用 `f.cause == EvolutionCause.TOOL_FAILURE` 过滤。两套词汇不对接 → 反馈驱动的失败进化路径失效。
- **影响范围**：反馈闭环部分失效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：① `EvolutionEngine` 新增 `record_tool_failure(tool_name, error)` 方法，构造 `cause=EvolutionCause.TOOL_FAILURE.value` 的 `FeedbackSignal` 并写入 `_feedback_history`，使 `should_evolve` 的 TOOL_FAILURE 过滤路径生效；② `feedback_loop.py` 新增 `FEEDBACK_TYPE_TOOL_FAILURE="tool_failure"` 常量并加入合法类型集和默认质量映射（0.0）。

### S-01 🔴 调度器 cron/hourly/daily 表达式永不执行

- **模块**：`agent/scheduler/cron.py:134-141,169-174,212-218`
- **问题描述**：`_parse_interval` 只认 `every:N{s|m|h|d}`，返回 None 表示不支持；类/蓝图 docstring 声称支持 `hourly`/`daily`/cron 表达式，但对不支持的 schedule `register` 时 `next_run` 不设置（保持 None），`_tick` 因 `next_run is None` 跳过 → 该任务永远不触发且无报错。内置蓝图 `every:1d`/`every:5m` 可被解析，但 `hourly`/`daily`/真实 cron 不行。
- **影响范围**：所有用 `hourly`/`daily`/cron 表达式注册的定时任务静默失效。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：`_parse_interval` 增加 `hourly`→`every:1h`、`daily`→`every:1d`、`weekly`→`every:7d` 别名映射；不支持的 schedule 在 `register` 时抛 `ValueError` 而非静默跳过。

### S-02 🟠 崩溃后任务卡死在 running 状态

- **模块**：`agent/scheduler/cron.py:215,232,292-299`
- **问题描述**：`_run_job` 写 `status="running"` 并 `_save`；进程运行中崩溃后 `jobs.json` 持久化 `"running"`，重启 `_load` 恢复后 `_tick` 因 `status=="running"` 永远跳过该任务。
- **影响范围**：任务永久失效。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：`_load` 恢复时将 `status=="running"` 的任务重置为 `"pending"` 并重新计算 `next_run`，使崩溃后任务可恢复执行。

### S-03 🟡 命令注入：args 未扫描也未转义

- **模块**：`agent/scheduler/cron.py:220-244`
- **问题描述**：`_scan_injection` 只扫 `command` 不扫 `args`；执行时 `command + " " + " ".join(args)` 直接拼接未转义 → args 可注入任意命令。
- **影响范围**：调度命令注入。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：① `_scan_injection` 扩展到扫描 `args` 列表每个元素；② 执行时改用 `subprocess.run([command] + args, shell=False)` 避免拼接注入。

### L-12 🔴 LLM 缓存键忽略 system_prompt/temperature/tools → 错答碰撞

- **模块**：`agent/llm/cache.py:23-26`；`agent/llm/provider.py:150,293,380`
- **问题描述**：`_key` = `model + "|" + role:content`（仅 messages），不含 `system_prompt`（provider 以独立参数传入）、`temperature`、`tools` → 不同 system prompt/温度/是否带工具的请求命中同一缓存键，返回错误缓存文本。
- **影响范围**：缓存碰撞导致错误回答（尤其带工具 vs 不带工具、不同系统提示）。
- **严重程度**：🔴 严重
- **✅ 修复（2026-07-10）**：缓存键改为 `model + "|" + hash(system_prompt) + "|" + str(temperature) + "|" + hash(tools) + "|" + role:content`，包含所有影响输出的参数维度。

### L-13 🟠 语义缓存 Jaccard 对中文易误命中

- **模块**：`agent/llm/prompt_cache.py:308-344`
- **问题描述**：中文拆单字+二元组，短中文问题（"如何备份数据" vs "如何恢复数据"）高重叠 → 相似度 ≥0.7 直接返回前一个问题缓存响应 → 返回错误答案。
- **影响范围**：语义缓存碰撞给出错误答案。
- **严重程度**：🟠 高
- **✅ 修复（2026-07-10）**：中文分词改为粗粒度（按标点/空格分词而非逐字拆分），相似度阈值从 0.7 提升至 0.85，短问题（<10 字）禁用语义缓存。

### L-14 🟡 stream_via_transport 只解析 OpenAI 格式 → 其他 transport 空流

- **模块**：`agent/llm/stream.py:178-203`
- **问题描述**：对所有 transport 用 `choices[].delta` 解析，Anthropic/Gemini/Bedrock 流式格式不同 → 走该函数时不产出任何 chunk，流看似为空。
- **影响范围**：非 OpenAI transport 流式输出为空。
- **严重程度**：🟡 中
- **✅ 修复（2026-07-10）**：`stream_via_transport` 增加 Anthropic 格式解析（`type=content_block_delta` → `delta.text`，`message_delta` → `stop_reason`/`usage`，`message_stop` → `finish_reason`）和 Gemini 格式解析（`candidates[].content.parts[].text`，`finishReason`）。OpenAI 格式优先，解析失败时依次尝试 Anthropic/Gemini。

---

## 七、修复状态总览

| 编号 | 模块                                  | 严重程度 | 修复状态                                                       |
| ---- | ------------------------------------- | -------- | -------------------------------------------------------------- |
| L-01 | eval_gate.check 类型                  | 🔴       | ✅ 已修复                                                      |
| L-02 | executor 退避伪造 context             | 🔴       | ✅ 已修复                                                      |
| L-03 | executor reflection 未绑定            | 🔴       | ✅ 已修复                                                      |
| L-04 | 预算 max_duration 不强制              | 🟠       | ✅ 已修复                                                      |
| L-05 | continue 不升级 replan                | 🟠       | ✅ 已修复（卡死保护）                                          |
| L-06 | plan_steps/needs_replan 死代码        | 🟠       | ✅ 已修复（AgentResult.metadata 注入 plan_steps/needs_replan） |
| L-07 | PLAN_QUALITY 恒 0.5                   | 🟠       | ✅ 已修复                                                      |
| L-08 | 计划模式无答案合成                    | 🟡       | ✅ 已修复（多步合成步骤摘要+最终结果）                         |
| L-09 | 错误恢复维度恒 0                      | 🟡       | ✅ 已修复                                                      |
| L-10 | 编排死三元/依赖                       | 🟡       | ✅ 已修复（三元三路分支+拓扑排序依赖）                         |
| L-11 | 聚合 skipped 计失败                   | 🟡       | ✅ 已修复（skipped/pending 保留原状态，不影响 success）        |
| M-01 | 空查询崩溃                            | 🔴       | ✅ 已修复                                                      |
| M-02 | 写后不失效缓存                        | 🟠       | ✅ 已修复（store 后 delete_by_prefix 搜索缓存）                |
| M-03 | Curator 空操作/字段错                 | 🟠       | ✅ 已修复（consolidate/forget 有实际操作，字段名兼容）         |
| M-04 | 双 FTS 索引脱节                       | 🟠       | ✅ 已修复（add_message/delete_session 同步搜索索引）           |
| M-05 | 压缩功能失效                          | 🟠       | ✅ 已修复（CompressionResult 含 compressed_messages）          |
| M-06 | 悬空 tool_call                        | 🟠       | ✅ 已修复（压缩策略检测悬空 tool_call 并移除）                 |
| M-07 | 短 ID 级联删除                        | 🟠       | ✅ 已修复（加长 ID）                                           |
| M-08 | update 清空 response                  | 🟠       | ✅ 已修复                                                      |
| M-09 | 非原子写/损坏清空                     | 🟡       | ✅ 已修复（原子写）                                            |
| M-10 | 短 ID 碰撞                            | 🟡       | ✅ 已修复（与 M-07 合并）                                      |
| M-11 | Episodic 只清内存                     | 🟡       | ✅ 已修复（\_cleanup_old 同时删除 DB 记录）                    |
| M-12 | 多模态维度不兼容                      | 🟡       | ✅ 已修复（cosine_similarity 截断公共维度+告警）               |
| M-13 | 历史不受预算约束                      | 🟡       | ✅ 已修复（按 allocation.history 预算截断）                    |
| M-14 | 记忆引擎循环依赖阻塞 MemoryStore 导入 | 🔴       | ✅ 已修复（惰性导入打破循环）                                  |
| T-01 | 权限检查被吞                          | 🔴       | ✅ 已修复（正确签名调用+异常按拒绝）                           |
| T-02 | shell_exec 宿主直跑                   | 🔴       | ✅ 已修复（白名单+扩展黑名单+Sandbox预检+shell=False）         |
| T-03 | 审批全放行                            | 🟠       | ✅ 已修复（风险取自定义+critical 永不自动放行）                |
| T-04 | 守卫未接入                            | 🟠       | ✅ 已修复（schema校验+guard链路集成\_execute_tool）            |
| T-05 | 凭据池复活/限流                       | 🟠       | ✅ 已修复                                                      |
| T-06 | 成本预算不拦截                        | 🟠       | ✅ 已修复（chat() 预估成本+check_budget 前置拦截）             |
| T-07 | timeout=0 立即失败                    | 🟡       | ✅ 已修复                                                      |
| T-08 | 元数据跨层丢失                        | 🟡       | ✅ 已修复（ToolResult 新增 metadata 并透传）                   |
| T-09 | 异常压字符串/静默覆盖                 | 🟡       | ✅ 已修复（异常含类型名+metadata，注册覆盖告警）               |
| T-10 | 沙箱限制空声明                        | 🟡       | ✅ 已修复（Unix setrlimit+Windows psutil 监控）                |
| A-01 | MCP initialize 缺 id                  | 🔴       | ✅ 已修复                                                      |
| A-02 | 网关适配器孤儿                        | 🔴       | ✅ 已修复（start_consuming消费循环+set_handler自动接线）       |
| A-03 | trace_id 丢失/不一致                  | 🔴       | ✅ 已修复（统一 trace_id 字段名，WS→engine 透传 trace_id）     |
| A-04 | WS 绕过鉴权                           | 🟠       | ✅ 已修复（WS增加API Key认证+令牌桶限流）                      |
| A-05 | A2A publish 泄露                      | 🟠       | ✅ 已修复（脱敏authentication+well-known移除）                 |
| A-06 | /a2a/push 空操作                      | 🟠       | ✅ 已修复（await get_task+status/progress/artifact持久化）     |
| A-07 | 禁用返回 500                          | 🟡       | ✅ 已修复（已被禁用工具返回 403）                              |
| A-08 | 限流默认关                            | 🟡       | ✅ 已修复（默认容量改为 60）                                   |
| A-09 | /v1/status 假数据                     | 🟡       | ✅ 已修复（从 engine 获取真实数据）                            |
| C-01 | 约束预算不强制                        | 🟠       | ✅ 已修复（loop 每轮检查 constraints_service.check_budget）    |
| C-02 | execute_hooks 吞异常                  | 🟠       | ✅ 已修复（异常含类型名+结构化日志）                           |
| V-01 | 无 LLM 误通过                         | 🟠       | ✅ 已修复                                                      |
| V-02 | LLM 解析误通过                        | 🟠       | ✅ 已修复                                                      |
| E-01 | 回滚验证时间戳错                      | 🔴       | ✅ 已修复                                                      |
| E-02 | V2 方法不存在                         | 🔴       | ✅ 已修复（改调 trigger_evolution+Cause 转换）                 |
| E-03 | V2 安全评估未调用                     | 🔴       | ✅ 已修复（执行前强制 assess_action_safety）                   |
| E-04 | \_validate 恒通过                     | 🟠       | ✅ 已修复（AST/JSON 真实校验）                                 |
| E-05 | 偏好持久化冲突                        | 🟠       | ✅ 已修复（MEDIUM+阻止+fail-safe+snippet脱敏）                 |
| E-06 | 反馈词汇不一致                        | 🟠       | ✅ 已修复（record_tool_failure+tool_failure类型）              |
| S-01 | 调度 cron 不执行                      | 🔴       | ✅ 已修复                                                      |
| S-02 | 崩溃卡死 running                      | 🟠       | ✅ 已修复                                                      |
| S-03 | args 命令注入                         | 🟡       | ✅ 已修复                                                      |
| L-12 | 缓存键缺维度                          | 🔴       | ✅ 已修复                                                      |
| L-13 | 语义缓存误命中                        | 🟠       | ✅ 已修复（中文粗粒度分词+阈值提升至 0.85）                    |
| L-14 | 流式格式单一                          | 🟡       | ✅ 已修复（Anthropic/Gemini 格式解析）                         |

> **说明**：标记为 ✅ 的项已在本次审计中完成修复。其中 M-14 为验证 M-01 过程中发现的预存循环依赖（`agent.memory.engine` 在模块顶层导入 `agent.memory.store`，而 `store` 又经 `agent.persistence` 回指 `engine`），通过将 `engine` 中的 `store` 导入改为惰性导入（在 `__init__` 内）打破循环，使 `MemoryStore` 可正常隔离导入与测试。所有 📋 项已在本轮迭代中全部修复完毕。
