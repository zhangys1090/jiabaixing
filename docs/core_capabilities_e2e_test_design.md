# 家百星 · 四大核心能力深度端到端测试设计

> 配套测试套件：`python/tests/test_capabilities_deep_e2e.py`（73 个用例，全部通过）
> 运行：`cd python && python -m pytest tests/test_capabilities_deep_e2e.py -q`
> 设计原则：纯组件级 E2E，不依赖外部 LLM / Redis / Docker / 真实 MCP server；
> 用 fallback 编码器、内存锁（`_FakeLockProvider`）、`MagicMock` 外部依赖保证离线可跑。

---

## 0. 范围说明

用户标题称"五大核心能力"，正文明确枚举 **4 项**（第 5 项"Agent 自主编排/执行闭环"未给出细节）。
本设计聚焦已明确 4 项；若需第 5 项，可基于现有 `LoopController` / `WorkflowEngine` 复用本套件模式补充。

| 编号 | 能力 | 覆盖模块（Python 主实现，符合 AGENTS.md） |
| --- | --- | --- |
| 能力 1 | 安全沙箱增强与持久化工作流 | `sandbox/executor`、`security/runtime_posture`、`workflow/*` |
| 能力 2 | 多模态感知闭环 | `memory/multimodal_encoder`、`perception/action_verifier` |
| 能力 3 | 知识沉淀与主动学习 | `knowledge/*`、`evolution/engine` |
| 能力 4 | MCP 生态集成 | `mcp/transport`、`mcp_integration/*` |

每项均覆盖 **正常路径 / 边界条件 / 异常失败** 三类鲁棒性验证。

---

## 能力 1 · 安全沙箱增强与持久化工作流

### 1-a 安全沙箱 —— 执行隔离与危险拦截

**测试目标**：验证子进程隔离执行、黑名单静态拦截、安全级别对危险操作的约束、超时与运行期异常的捕获。

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | LOW 级执行 `print('hello')`(python) | stdout 被捕获，exit_code=0 | `success and "hello" in output` | `test_sandbox_python_normal_execution` |
| 正常 | LOW 级执行 `echo shell-ok`(shell) | 命令成功返回输出 | `success and "shell-ok" in output` | `test_sandbox_shell_normal_execution` |
| 异常 | 任意级别执行 `rm -rf /`(shell) | 静态黑名单拦截，**不进入子进程** | `success is False` 且 `security_violations` 非空 | `test_sandbox_forbidden_code_pattern_blocked` |
| 边界 | HIGH 级执行 `eval('1+1')`(python) | 受限调用被静态拦截 | `success is False` 且 `security_violations` 非空 | `test_sandbox_dangerous_python_blocked_at_high` |
| 边界 | LOW 级执行 `print(eval('1+1'))`(python) | 仅黑名单生效，代码真实执行 | `success and "2" in output` | `test_sandbox_dangerous_python_allowed_at_low` |
| 边界 | 语言=`ruby` | 立即失败，明确原因，不抛未捕获异常 | `success is False and "不支持" in error` | `test_sandbox_unsupported_language` |
| 异常 | 代码 `time.sleep(5)`，timeout=400ms | 进程被终止，返回超时失败而非挂起 | `success is False and "超时" in error and exit_code==-1` | `test_sandbox_execution_timeout` |
| 异常 | 代码 `raise ValueError('boom')` | 运行期异常被捕获透传 | `success is False and exit_code!=0 and "boom" in error` | `test_sandbox_runtime_error_captured` |
| 正常/边界 | 工具权限矩阵（delete_file / write_file × 安全级别） | 高危仅 LOW 放行，中危 HIGH 禁止 | `check_tool_permission` 按级别给出 `allowed` | `test_check_tool_permission_matrix` |

### 1-b 运行时安全姿态裁决

**测试目标**：验证 `SAFE/CONFIRM/AUTO/YOLO × 风险级别` 决策矩阵，以及 `critical` 永不被静默 `ALLOW` 的硬底线。

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | 14 组 `(姿态, 风险)` 全覆盖 | 按矩阵返回 ALLOW/DENY/REVIEW | `decide()==对应 PostureDecision` | `test_runtime_posture_decision_matrix`(参数化) |
| 硬底线 | 任意姿态 + critical | 结果 ≠ ALLOW | `decide(.,'critical') != ALLOW` | 同上（每个 case 内断言） |
| 边界 | 别名解析 `safe-mode/readonly/danger/unknown` | 别名映射正确；未知回退 CONFIRM | `parse`/`is_valid` 行为符合预期 | `test_runtime_posture_parse_and_aliases` |

### 1-c 持久化工作流 —— 状态保存/恢复、崩溃恢复、失败策略

**测试目标**：验证 `WorkflowEngine` DAG 执行的持久化（跨独立存储实例一致）、暂停后续跑、崩溃恢复（RUNNING→PAUSED）、并发隔离，以及 fail/skip/retry 三种失败策略。

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | 两步骤依赖工作流完整运行 | 按依赖顺序执行；状态落盘 | `status==done`、`calls==["RUN_A","RUN_B"]`；新 `WorkflowStore` 可恢复 | `test_workflow_full_run_and_persistence` |
| 恢复 | 模拟"step_a 已完成、实例 paused"断点 | `run()` 从断点续跑，不重复已完成步骤 | 仅执行 step_b；step_a 状态保持 done | `test_workflow_resume_from_paused_state` |
| 鲁棒性 | 实例被标为 running 后重启 | 恢复为 PAUSED 等待人工恢复 | `recover_crashed_instances()` → status=paused | `test_workflow_crash_recovery` |
| 边界 | 零步骤工作流 | 直接判定完成 | `status==done` | `test_workflow_empty_definition` |
| 失败策略 | on_failure=fail | 步骤标记 FAILED，实例收尾为 FAILED | `step_states[id].status=="failed"`、`status=="failed"`（已修复见下文） | `test_workflow_step_failure_fail_policy` / `test_workflow_partial_failure_marks_instance_failed` |
| 失败策略 | on_failure=skip | 步骤标记 SKIPPED，流程仍完成 | `step_states[id].status=="skipped"`、`status==done` | `test_workflow_step_failure_skip_policy` |
| 失败策略 | on_failure=retry，retry_count=1 | 失败后自动重试至成功 | 执行 2 次（1 失败 + 1 成功），`status==done` | `test_workflow_step_retry_policy` |
| 鲁棒性 | start 不存在的定义 | 返回 None | `start("no-such-def") is None` | `test_workflow_start_unknown_definition` |
| 鲁棒性 | run 不存在的实例 | 返回 None | `run("no-such-instance") is None` | `test_workflow_run_unknown_instance` |
| 隔离 | 同一定义并发启动两实例 | 状态互不串扰 | 两实例均 done，步骤状态按实例隔离 | `test_workflow_concurrency_isolation` |

---

## 能力 2 · 多模态感知闭环

### 2-a 跨模态编码与检索

**测试目标**：验证文本↔图像在同一（fallback）向量空间编码、确定性、空/缺失输入处理、余弦相似度边界与跨模态检索。

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | 编码文本 + 图像并跨模态检索 | 同维度向量（128 维），返回带分数结果 | `modality` 正确、向量长度 128、结果为 `(vector,score)` 列表 | `test_multimodal_cross_modal_encode_and_search` |
| 边界 | 相同输入重复编码 | 输出完全一致（可缓存/去重） | 两次 `encode_text("abc").vector` 相等 | `test_multimodal_encoder_deterministic` |
| 异常 | 空文本 / 空路径 / 不存在图像 | 抛 `ValueError` / `FileNotFoundError` | 三类异常被正确抛出 | `test_multimodal_encoder_empty_and_missing_inputs` |
| 边界 | 零向量余弦相似度 | 安全返回 0.0，不除零不抛异常 | `cosine_similarity([], [...])==0.0` | `test_multimodal_cosine_zero_vector` |
| 边界 | 空候选列表检索 | 返回空 | `cross_modal_search(q,[],top_k=5)==[]` | `test_multimodal_cross_modal_empty_candidates` |
| 鲁棒性 | 跨维度向量检索 | 截断到公共维度计算，不静默失败 | 返回长度 1 的结果 | `test_multimodal_dimension_mismatch_no_crash` |

### 2-b 感知闭环反馈 —— ActionVerifier 验证 + 自动重试

**测试目标**：验证验证策略自动选择、像素差异判定、缺失截图兜底，以及"操作无效→自动重试"的反馈闭环。

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | 有验证问题 → 策略选择 | 有疑问→VLM，有关注区→OCR，否则→pixel | `_select_strategy` 三分支正确 | `test_verifier_strategy_selection` |
| 正常 | 操作前后截图明显不同(pixel) | 判定操作成功 | `success and diff_ratio>0.1` | `test_verifier_pixel_change_detected` |
| 边界 | 缺少截图路径 | 返回失败且不抛异常 | `success is False and "截图" in evidence` | `test_verifier_missing_screenshot` |
| 鲁棒性 | 操作无效（截图无变化）→ 自动重试 | 重试 max_retries 次后**显式**标记 `retry_exhausted` | `action_fn` 调用 1+max_retries 次；`method=="retry_exhausted"`、`retry_suggested is False` | `test_verifier_retry_until_exhausted` |

---

## 能力 3 · 知识沉淀与主动学习

### 3-a 知识存储与检索（底座）

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | 添加知识后语义检索 | 返回相关条目且相似度>0.1 | `results[0]` 内容匹配、`score>0.1` | `test_knowledge_store_add_and_search` |
| 边界 | 未初始化即读取 | `get`→None、`count`→0；新增后可见 | 初始 0，新增后 1 | `test_knowledge_store_missing_get_and_count` |
| 正常 | 删除知识 | 删除后不可取回 | `delete` 返回 True，`get` 返回 None | `test_knowledge_store_delete` |
| 边界 | min_confidence 过滤 | 低置信条目在 SQL 层即被排除 | 仅高置信条目出现在结果，低置信不在 | `test_knowledge_store_min_confidence_filter` |

### 3-b 知识提取器（自动归纳）

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | 对话含事实/纠正/洞察 | 分别提取 fact/correction/insight | 至少 3 条提取并落库 | `test_extractor_from_dialog_facts_and_corrections` |
| 鲁棒性 | 工具失败的操作结果 | 归纳为 correction 知识 | 内容含"操作失败" | `test_extractor_from_operation_failure` |
| 正常 | 短文档 | 切分为单块并存储 | 1 条，`source=="document"` | `test_extractor_from_document_chunking` |

### 3-c 知识生命周期（沉淀→检索→衰减维护闭环）

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 鲁棒性 | 未初始化即摄入 | 抛 `RuntimeError` | `ingest_dialog` 前未 `initialize` 报错 | `test_knowledge_lifecycle_requires_init` |
| 正常 | 对话摄入 | 自动提取并落库 | `ids>=1`、`count>=1` | `test_knowledge_lifecycle_ingest_dialog` |
| 正常 | 英文知识语义检索 | 检索命中 | `results` 非空且内容含关键字 | `test_knowledge_lifecycle_retrieve_english` |
| 正常 | 运行维护 | 返回含总数与耗时的报告 | `total_entries>=1`、`duration_ms>=0` | `test_knowledge_lifecycle_maintenance` |
| 正常 | 验证通过 | 置信度被提升 | `validate_knowledge(verified=True)` 后 `confidence>0.5` | `test_knowledge_lifecycle_validate_boost` |

### 3-d 进化引擎（反馈驱动迭代 + 持久化）

**测试目标**：验证 `EvolutionEngine` 反馈聚合 → 触发进化计划（工具失败 / 低质量）→ 执行动作（降权/提示优化）→ 纠错规则生成 → 状态落盘恢复。

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 边界 | 无任何信号 | `should_evolve` 返回 None | 不误触发进化 | `test_evolution_no_plan_without_signals` |
| 正常 | 连续 3 次工具失败 | 触发 `TOOL_WEIGHT_ADJUSTMENT` 计划 | `cause==TOOL_FAILURE`，actions 含失败工具 | `test_evolution_tool_failure_triggers_plan` |
| 正常 | 平均质量<0.7（10 次低分） | 触发 `PROMPT_OPTIMIZATION` 计划 | `cause==LOW_QUALITY` | `test_evolution_low_quality_triggers_plan` |
| 正常 | 执行 `reduce_weight` 动作 | 目标工具权重下调为原值×0.8 | `execute_evolution` 成功，权重≈before×0.8 | `test_evolution_execute_reduce_weight` |
| 鲁棒性 | 低质量且含失败工具 | 自动生成纠错规则 | `get_correction_rules()` 非空 | `test_evolution_correction_rule_from_failure` |
| 正常 | 纠错规则编译进提示 | 返回非空提示片段 | `build_evolution_prompt_section()` 非空字符串 | `test_evolution_prompt_section_contains_rules` |
| 正常 | 累计 5 条信号后 | 状态落盘；新实例可恢复工具统计 | `engine-state.json` 存在，新引擎 `_tool_call_stats` 含工具 | `test_evolution_state_persistence` |

---

## 能力 4 · MCP 生态集成

### 4-a 传输层协议兼容（JSON-RPC / SSE）

**测试目标**：验证 JSON-RPC 响应/错误/通知/Server→Client 请求三类消息分发、SSE endpoint 提取与 message 事件解析、工厂创建与未知类型报错。

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | JSON-RPC 响应到达 | 完成 pending future | `future.done()` 且 `result` 正确 | `test_mcp_jsonrpc_response_and_error` |
| 异常 | JSON-RPC 错误到达 | 以 `RuntimeError` 抛出 | `future.result()` 抛 RuntimeError | 同上 |
| 正常 | 通知（无 id） | 分发到 `on_notification` | handler 收到 params | `test_mcp_jsonrpc_notification_and_server_request` |
| 正常 | Server→Client 请求（有 id+method） | 分发到 `on_request` | handler 收到含 id/method 的完整消息 | 同上 |
| 正常 | SSE `endpoint` 事件 | 提取 POST URL（相对路径经 urljoin 补全） | `_sse_endpoint` 为完整 URL | `test_mcp_sse_endpoint_extraction` |
| 正常 | SSE `message` 事件携带响应 | 完成 pending future | `_feed_raw` 后 `future.done()` | `test_mcp_sse_message_resolves_pending` |
| 正常/异常 | 工厂创建传输 | `stdio`/`http+sse` 正确创建；未知类型抛 `ValueError` | 类型断言 + 异常断言 | `test_mcp_transport_factory` |

### 4-b MCP 工具桥接（发现→注册→转发）

| 类别 | 输入场景 | 预期行为 | 验收标准 | 用例 |
| --- | --- | --- | --- | --- |
| 正常 | `register_all` 注册工具 | 工具注册到注册表，handler 转发到 `client.call_tool` | 注册数=1；handler 调用参数正确（`server__tool` 命名、`[MCP]` 前缀） | `test_mcp_tool_bridge_register_all_and_forward` |
| 边界 | 工具无 `input_schema` | 参数结构回退为空的 object | `params=={"type":"object","properties":{},"required":[]}` | `test_mcp_tool_bridge_empty_schema_defaults` |
| 鲁棒性 | 注册表缺失 | `register_all` 安全返回 0，不抛异常 | 返回 0 | `test_mcp_tool_bridge_no_registry` |
| 边界 | 注册不存在的工具 | 返回 False | `register_tool("s","absent") is False` | `test_mcp_tool_bridge_register_missing_tool` |
| 鲁棒性 | 调用未连接的服务端 | `call_tool` 返回 error 字典；`list_tools` 返回空 | `"error" in res`、列表为空 | `test_mcp_client_call_tool_not_connected` |

---

## 测试结果

```
73 passed, 2 warnings in 111.58s
```

全部 73 个用例通过，覆盖 4 项能力 × 3 类鲁棒性维度。

---

## 测试中发现的设计观察 / 风险（跟进状态）

> 下列 1/2/3 已在测试驱动下完成修复并附回归用例；第 4 项为环境依赖说明。

1. **工作流失败策略语义 ✅ 已修复（原中风险）**：根因 `WorkflowStateMachine.is_all_done()` 将 `FAILED` 步骤计入"完成"，
   导致 `has_failed_steps()→FAILED` 分支对单步/多步部分失败均不可达，实例错误收尾为 `done`。
   **修复**：`is_all_done()` 现排除 `FAILED`（`PENDING/RUNNING/FAILED` 任一即视为未完成），使失败步骤正确驱动实例收尾为 `failed`。
   **回归**：`test_workflow_step_failure_fail_policy`（单步）+ `test_workflow_partial_failure_marks_instance_failed`（一步成功一步失败，实例仍 `failed`）。
   `on_failure=skip` 不受影响（SKIPPED 仍计入完成 → 实例 `done`）。

2. **ActionVerifier 死代码 ✅ 已修复（原低风险）**：`verify_with_retry` 末尾 `retry_exhausted` 兜底分支因循环体内均 `return` 而不可达。
   **修复**：在 `attempt == retries` 且仍失败（`not result.success`）时显式返回 `method="retry_exhausted"`、`retry_suggested=False`，并移除原不可达的尾随 `return`。
   **回归**：`test_verifier_retry_until_exhausted` 断言 `method=="retry_exhausted"` 与 `retry_suggested is False`。

3. **fallback 向量分词不一致 ✅ 已修复（原"无中文分词"已知限制）**：根因比"仅中文"更普遍——
   `_simple_hash_embedding` 对**无空格文本走字符级**、**多词文本走词级**，二者 token 空间错位，
   导致**英文单词查询**与含该词的内容余弦恒为 0（检索彻底失效），中文同理。
   **修复**：统一切词——按空白分词，含 CJK 的词展开为单字，纯无空格串退化为字符级；
   查询与内容现落入同一 token 空间，英文单词与中文按字检索均可命中。
   **保留建议**：fallback 哈希仅做字面命中，无同义/语义泛化能力；生产环境仍需接入真实 embedding 模型以获得语义召回。
   **回归**：`test_knowledge_store_min_confidence_filter`（单字查询 "backup" 现可命中）与 `test_knowledge_store_add_and_search`。

4. **环境依赖（说明）**：本机托管 Python 缺少 `psutil` / `sentence_transformers`，但沙箱超时在缺 `psutil` 时仍通过"循环超时后 kill"路径正常工作；
   真实语义检索/CLIP 跨模态需补装对应依赖或配置 embedding provider。

---

## 复用建议

- 新增能力（如第 5 项"自主编排/执行闭环"）可直接套用本套件模式：伪造锁/注册表 + `MagicMock` 外部依赖 + 参数化矩阵 + 正常/边界/异常三栏表。
- `_FakeLockProvider`、`_CapturingRegistry`、`_make_png` 已抽象为共享 fixture，可迁移至 `conftest.py` 全局复用。
