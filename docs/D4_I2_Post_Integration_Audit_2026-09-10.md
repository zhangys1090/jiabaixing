# D4-I2 Post-Integration Audit — Desktop Authority 接管真实性审计

> 日期: 2026-09-10
> 性质: 只读审计（不改代码）
> 范围: 冻结方案第六节 8 项检查点 + 审计过程中的新增发现
> 结论速览: **8 项中 4 PASS / 3 条件性 / 1 FAIL，另发现 1 个 P0 级新问题（Python 主实现不在源码树）**

---

## 一、八项检查点逐项裁决

### 1. SkillProposer 是否纯 proposer — ✅ PASS

`src/authority/SkillProposer.ts`：`propose()` 仅做 `matchSkill()` → 组装 `DecisionCandidate` 返回，无任何 execute/executeAction 调用。旧注释明确记录了改造前路径（matchSkill → executeWithSkill 隐式 FINAL）。

### 2. DesktopLLMProposer 是否纯 proposer — ✅ PASS（附注）

`src/authority/DesktopLLMProposer.ts`：`propose()` 仅经 PythonBridge `llmChat` 生成候选，Bridge 不可用时返回空（fail-quiet，不产生可执行 fallback）。

附注（非缺陷，记入 D5 观察）：
- confidence 硬编码 0.7，不反映真实把握；
- `estimatedGoalProgress` 仍是 `current + 0.3` 预测 stub —— 与冻结方案第三节判断一致：**只能叫 progress integration stub，不能叫真实 Goal Learning**。

### 3. DecisionAuthority 是否唯一 FINAL — 🟡 条件性成立

- **TS 独立路径 PASS**：`DesktopExecutionAgent.executeTask()` 无 authorityMeta 时强制走 `executeViaDecisionAuthority()`：createGoal → captureSnapshot → 双 Proposer → `decide()` → ActionAuthority。无候选即拒绝（`authority_denied`），无旁路。
- **Delegated 路径按设计跳过 TS 决策**（正确，TS 降级为 executor）。
- **条件性成立的漏洞**：`/api/desktop/automate` HTTP 路由（`coreRoutes.ts:689`）把请求体里的任意 `authority` 字段原样透传为 `_authority_meta`。即**任何能触达网关的外部调用者都可以自带伪造 authorityMeta，直接跳过 TS DecisionAuthority**。缓解因素：ActionAuthority/SafetyGuard 仍在执行层拦截；且该工具 policy='ask' + 路由传空权限集（`permissions: new Set()`），实际能否通过 PermissionGuard 待运行时验证 —— 但"不能伪造"不能依赖恰好被别处拦住。
- 附注：DecisionAuthority 历史仅存内存 Map，重启即失，全局 replay（D4-I4）目前只能覆盖单进程生命周期。

### 4. authorityMeta 是否不能伪造 — ❌ FAIL（本审计唯一直接 FAIL）

`DesktopExecutionAgent.executeTask()` 对 authorityMeta 只做**三字段存在性检查**（L182-187）：

- 无签名/HMAC/nonce，无来源认证；
- TS 侧不持有 Python Decision 注册表，**无法验证 decisionId 真实存在**；
- 冻结方案第三节预言的"合法 decisionId + 恶意/错误 action"问题**确认为真实存在**（见第 5 项）。

### 5. Decision → action 是否一一对应 — 🟡 仅独立路径成立

- **TS 独立路径 PASS**：`decision.chosen.action` 直接构造 executeAction 入参，内容来自 Decision 本身。
- **Delegated 路径 FAIL**：`executeWithAuthorityDelegation()` 执行的 action 是**硬编码的 `desktop_automate` + HTTP 请求里的 task**，与 decisionId 绑定的动作内容完全无关。decisionId 目前只是"装饰性通行证"。这正是方案第三节 residual #1，现确认为真实差距。

### 6. Evidence 是否真正关联 goalId/decisionId — 🟡 结构 PASS / 语义未闭环

- 结构：`GoalEvidence` 含 goalId + decisionId；独立路径调用 `goalAuthority.updateFromEvidence()` 传入真实 decisionId。✅
- 语义：`progressDelta` 在 `DesktopExecutionAgent.ts:421` 仍硬编码（成功 +0.5 / 失败 -0.05），**不来自 actual observation 与 expected effect 的比对** —— 证据是"结果标签"而非"预测误差"。
- 缺口：**delegated 路径完全不写 Evidence**（`executeWithAuthorityDelegation` 无 updateFromEvidence 调用）；Python 侧是否写、写在哪，待 Python 实现迁移入源码树后核验（见第二节）。
- 消费侧：Evidence 目前只推 goal.progress，尚无 Learning 消费者（符合阶段规划，属 D5 范围）。

### 7. 旧 executeWithSkill / executeWithLLMPlanning 是否死掉 — 🟡 代码级已死，尸体未清

全局扫描（排除 dist/coverage）：两方法均 `@deprecated` + private，**零调用点**；`executeBasic` 同理。执行面无旁路，结论安全。
但按 AGENTS.md 审计清单"无死代码"项，这三个方法（约 280 行）应删除而非保留作参考 —— 每保留一轮就是一次"未来有人误用复活"的机会。

### 8. 是否还有其它 Desktop production caller — ✅ 收口确认

`DesktopExecutionAgent.executeTask` 的生产调用方**仅剩 1 个**：`src/harness/tools/desktop/desktop_automate.ts:71`。
其余桌面执行面全部经 DesktopActionAuthority 单一入口：

- DesktopMCPServer：19 处 `authority.executeAction()` ✅
- DesktopAgentLoop:283 `authority.execute()` ✅
- Harness DesktopChannel：经 ActionAuthority ✅
- DesktopActionExecutor.executeTask 无 authority 之外的调用方 ✅

**Action 层单一入口成立，Decision 层收口仅受 HTTP authorityMeta 伪造面影响。**

---

## 二、🔴 新增发现（8 项之外，P0 级）

### D4-I1 Python 主实现不在源码树

D4-I1 的全部 Python 实现——`decision_authority.py`、`goal_authority.py`、`state_authority.py`、`authority_types.py`、conversation_loop 的 authority 注入、`test_d4_authority_trace.py`——**只存在于打包产物目录**：

```
src/frontend/release/JiabaixingDesktop-win32-x64/resources/app.asar.unpacked/python-backend/agent/core/
```

而源码树 `python/agent/core/` 中**完全不存在**这些文件（grep 全 python/ 树 0 命中）。

后果：

1. 违反 AGENTS.md §0.1/§0.3 —— Python 主实现必须可构建、可测试、受版本控制；当前 CI（跑 `python/` 树）根本测不到 D4-I1；
2. 重新打包/重装桌面端将基于源码树生成 python-backend，**authority 实现会被直接抹掉**；
3. "D4-I1 Python integration ✅" 的完成认定不满足 §0.3 五条标准。

**处置要求（进入 D4-I3 前必须完成）**：将 release 目录下的 authority 模块迁移到 `python/agent/core/` 并纳入 git，Python 测试在源码树跑通，与 TS 侧契约（authority_decisionId/goalId/snapshotId 三元组）对齐验证。

---

## 三、其它 D4 阶段状态修正（供冻结账本更新）

| 账本项 | 审计修正 |
|---|---|
| D4-I3 Orchestrator | **已实现**：`OrchestratorProposer` + PLAN/ACTION DecisionType 区分已在 `OrchestratorAgent.ts` 落地，测试 `D4I3OrchestratorIntegration.test.ts` 存在（冻结方案原列为"下一步"） |
| D4-I4 Global Replay | 测试 `D4I4GlobalReplay.test.ts` 已存在；但受制于发现 #3（Decision 历史仅内存）与发现 #4（delegated 链无 Evidence），**端到端 replay 的"真实任务级"验收尚未达成** |

---

## 四、下一步建议（按优先级）

1. **P0：Python authority 实现迁回 `python/agent/core/`**（发现二）—— 这是所有后续 Python 侧工作的地基，且不修则打包即丢。
2. **authorityMeta 防伪造**：最小方案 = Python 对 `{goalId, snapshotId, decisionId, actionHash}` 做 HMAC 签名，TS 校验签名后才走 delegated 路径；同时 `/api/desktop/automate` 不再接受外部 `authority` 字段（或仅接受合法签名）。
3. **Delegated 路径补 Evidence 写入**，使 G→S→D→A→E 链在跨进程路径也完整。
4. **删除三个 deprecated 死方法**（executeWithSkill / executeWithLLMPlanning / executeBasic）。
5. 以上完成后，再进入 D4-I3 验收复核与 D4-I4 真实任务 Global Replay（现成测试升格为真实链路验收）。

---

## 五、修复记录（同日完成，四项建议 1→4 全部落地）

### 1. ✅ P0：Python authority 实现迁回源码树

- 新增 `python/agent/core/`：`authority_types.py` / `decision_authority.py` / `goal_authority.py` / `state_authority.py`（自打包副本迁回）。
- `python/agent/core/conversation_loop.py` 移植 7 处 authority 注入：imports、`__init__`（`use_authority` 开关 + 三权接线）、`run()` 开头 goal/snapshot 创建、工具调用决策闸门（LLMProposer → DecisionAuthority，无候选/决策失败即 fail-closed 拒绝）、证据回写（Evidence 关联同一 goalId）、结果 metadata 暴露 authority 三元组、`_execute_tool` 注入 `_authority_meta` + ToolResult 继承 authority 元数据。
- `python/agent/core/turn_types.py`：`ToolCall` / `ToolResult` 补 `metadata` 字段。
- `python/agent/tools/desktop_tools.py`：`desktop_automate_executor` 透传 `_authority_meta` → `_call_ts_desktop`，HTTP payload 键修正为 `authority`（原错误键 `authority_meta` TS 根本不读）。
- `python/tests/test_d4_authority_trace.py` 迁回源码树：**27/27 通过**。
- 顺带修复 3 个阻断性预存缺陷（此前全量 pytest 收集即崩）：
  - `agent/sandbox/executor.py`：引用了不存在的 `SecurityLevel`（统一为 `RiskLevel` + 兼容别名）；
  - `agent/sandbox/sandbox_audit_agent.py`：使用 `AuditSeverity` 但未导入；
  - `agent/core/conversation_loop.py`：两处 `tr.content`（字段实为 `output`）、`decision_id` 循环外未初始化 UnboundLocalError。
- 导入扫描 `check_import_scan.py` 恢复 **528/528 PASS**（顺带修复 `agent/gateway/platform_manager.py:80` 非法字符 `、`）。
- 修复过程中继续暴露并修复未提交重构的潜伏缺陷（此前模块导入即崩、测试从未真正跑过）：
  - `core/types.py` `PermissionCheckResult` 补可选 `risk_level` 字段（sandbox/权限守卫共用契约）；
  - `sandbox/sandbox_audit_agent.py` `AuditReport.to_dict()` 用 `RiskLevel` 与 `AuditSeverity` 比较（值域不同，永不命中）→ 改用 `AuditSeverity`；
  - `sandbox/executor.py` KERNEL 层降级判断匹配 `"not available"`，但 spawn 实际返回 "No kernel isolation backend available" → 降级永不触发，补第二匹配；
  - `tests/test_sandbox_treekill.py` 两个用例硬编码"本机无 pywin32"假设 → 改为 mock，不依赖宿主机状态。
- 修复后 `test_sandbox.py`(48失败→0) + `test_sandbox_treekill.py` 全绿。
- **P2-1 静默吞红线恢复**：工作区未提交重构曾引入 64 处 `except:pass`（conversation_loop 14 / sandbox 16 / desktop 等），破坏 `test_p2_1_silent_except` 红线。用项目自带 `scripts/codemod_silent_except.py --apply` 全包机械改写 59 处为 `log_ignored(...)`（自动补 import、可选依赖守卫豁免、幂等），另手修 `decision_authority.py` 1 处（迁移带入）与 `logger.py` `log_ignored` 自身兜底 except 误用 stdlib logger kwargs 的 bug。红线测试恢复 **12/12 全绿**。

### 2. ✅ authorityMeta HMAC 防伪造

- 新增 `python/agent/core/authority_signature.py` 与 `src/authority/AuthoritySignature.ts`：算法逐字节一致 —— `sig = HMAC-SHA256(secret, goalId|snapshotId|decisionId|sha256(task))`。
- 密钥：`AGENT_AUTHORITY_HMAC_SECRET`（两端共享）；未设置时回退开发默认值并暴露 `isProductionSecret()` 供部署告警，**生产必须显式设置**。
- TS 侧 `DesktopExecutionAgent.executeTask()`：delegated 路径前置 `verifyAuthorityMeta()`（timing-safe 比较 + actionHash 绑定 task 内容）；**签名无效 → 拒绝委托，fail-safe 降级为 TS 本地 DecisionAuthority 决策链**。"合法 decisionId + 任意 action" 换货漏洞就此关闭。
- 跨语言互操作运行时验证（Python 真签 → Node 真校验）**10/10 通过**，含换货攻击、篡改 decisionId、裸 metadata（无签名）、共享 env 密钥四类拒绝场景。

### 3. ✅ Delegated 路径补 Evidence

- `GoalAuthority.ensureGoal()`：以 Python 提供的 goalId 注册影子 Goal（幂等），delegated 执行后 `updateFromEvidence()` 写回同一 goalId + decisionId。跨进程 G→S→D→A→E 链闭合。
- 注：progressDelta 仍为结果驱动 stub（+0.5/-0.05），真实 progress 留待 D5 Learning 用 prediction error 校准（与冻结方案一致）。

### 4. ✅ 删除死代码

- `DesktopExecutionAgent.ts` 删除 `executeWithSkill` / `executeWithLLMPlanning` / `executeBasic` 及其专属 helper（`buildPlanningPrompt` / `getSystemPrompt` / `parseLLMAction` / `_bridgeChat`），约 -280 行。
- 顺带修复该文件工作区未提交改动的潜在编译错误：补 `DesktopActionAuthority` / `DesktopAction` 导入、`endTask` 可选参数化、`LearningAuthority.ts` 两处类型转换。
- 新增 `tests/unit/authority/AuthoritySignature.test.ts`（8 例，供 CI）+ `python/tests/test_authority_signature.py`（4 例）。

### 验证汇总

| 验证项 | 结果 |
| --- | --- |
| `python/tests/test_d4_authority_trace.py` | 27/27 ✅ |
| `python/tests/test_authority_signature.py` | 4/4 ✅ |
| `tests/test_p2_1_silent_except.py`（P2-1 红线） | 12/12 ✅ |
| 相关回归（core_loop/gateway/tool_selector/sandbox/treekill 合计） | 243/243 ✅ |
| 全包导入扫描 check_import_scan.py | 528/528 PASS ✅ |
| 跨语言 HMAC 互操作（Python→Node） | 10/10 ✅ |
| tsc 编译（改动文件 + authority 包） | 0 error ✅ |
| 全量 pytest | **145 failed / 3769 passed**（本轮起点为"收集即崩"；首轮修复后 220 failed → 现 145，净修复 75 个失败、+74 通过） |

**全量回归说明**：修复前全量 pytest 因 sandbox 导入崩溃**收集即失败**（等于全量不可用）。本轮修复后，与 authority/sandbox 工作相关的失败簇全部清零：`test_sandbox`(48→0)、`test_sandbox_treekill`(2→0)、`test_p2_1_silent_except`(3→0，红线恢复)。剩余 145 失败分布于 audit_reporter(17)/otel(14)/production_metrics(13)/p2_audit(10)/full_integration(10)/capabilities(9) 等簇——全部来自工作区大量未提交的预存重构，与本次 authority 改动无模块交集，建议作为独立任务分簇清理。

### 状态账本更新

```text
D4-I2 Post-Audit 发现
  ✅ 全部修复 CONFIRMED（1-4 项）

下一步
  → D4-I3 验收复核（OrchestratorProposer 已实现，测试已存在）
  → D4-I4 真实任务 Global Replay（现成测试升格为真实链路验收）
```

---

## 六、交接项执行记录（同日）

### 1. ✅ git 分逻辑提交（工作区 1184 条变更清零）

```text
81f5ffb chore: 清理构建产物、临时脚本与过期审计报告（505 项删除 + .gitignore）
1d01907 feat(authority): D4 Authority 落地 — Python 三权迁回 + HMAC + delegated Evidence（39 文件 +8468/-455）
a3f07dc feat: 收敛工作区存量重构 — sandbox/网关/感知/推理/测试与文档
<HEAD>  fix(d4-i3): 简单路径接入 DecisionAuthority + planDecisionId 下沉
<HEAD>  test(d4-i4): 真实链路 Global Authority Replay 验收
```

注：pre-commit 的 `npx lint-staged` 因本机 node_modules 损坏无法运行（备份暂存区即失败），
按用户要求以 pytest/导入扫描/运行时验证替代质量门禁后 `--no-verify` 提交。
修复 node_modules 后建议 `git commit --amend` 以恢复钩子链路（或保持现状）。

### 2. ✅ AGENT_AUTHORITY_HMAC_SECRET 部署配置

- `.env.example` 增占位与生成示例；`deploy/kubernetes/secret.yaml` 增条目
  （两个 deployment 均 `secretRef: jiabaixing-secrets` 全量注入，Py/TS 两端自动生效）。

### 3. ✅ D4-I3 Orchestrator 验收复核 — **复核通过（修复 2 缺口后）**

对照冻结方案第七节逐项裁决：
- ✅ OrchestratorProposer 为纯 proposer（decomposeGoal → composite 计划候选）
- ✅ Plan Decision 与 Action Decision 区分（DecisionType.PLAN/ACTION，未硬塞一个函数）
- ✅ 复杂路径：createGoal → captureSnapshot → propose → DecisionAuthority.decide(PLAN) → FINAL
- 🔧 **缺口1（已修）**：`processSimpleGoal` 注释声称走 Action Decision，实际直通
  `agent.execute()/dispatch()`（无 Goal/Snapshot/Decision）→ 补 createGoal+captureSnapshot+
  decide(ACTION) 前置 + Evidence 写回
- 🔧 **缺口2（已修）**：plan decisionId 未下沉子任务 → parentGoalId/planDecisionId/
  planSnapshotId 写入每个 TaskNode.metadata
- 链路运行时验证 6/6；遗留观察：子任务执行尚未创建 sub-Goal（parentGoalId 仅在
  metadata 层关联），建议 D5 前决定是否将 TaskNode 执行升级为子 Goal 生命周期

### 4. ✅ D4-I4 真实任务 Global Replay — **验收通过**

现成模块级 mock 测试升格为**真实链路验收**（`python/tests/test_d4_i4_global_replay.py`，
2/2 通过）：真实 ConversationLoop + 真实 ToolRegistry + 真实三权（仅 LLM 网络层 stub，
同 conftest 离线模式）离线跑通完整任务：

```text
[D4-I4 REPLAY TRACE]
user_input: "用echo探针执行D4-I4全局回放验证"
  → Goal      G_7bc3f038f04d   （createGoal, 身份全程稳定）
  → Snapshot  SS_2b43bf2f20c3  （StateAuthority.captureSnapshot）
  → Decision  D_ee9ebd468473   （DecisionAuthority FINAL, proposer=llm）
  → Candidate C_67585955a9da   （chosen）
  → Action    echo_probe       （真实工具经 ToolRegistry 执行）
  → Evidence  E_7f25e7137da4   （observation 来自真实工具输出, decisionId 绑定）
  → progress  0 → 0.3          （Evidence 驱动）
```

验收断言全过：同一 goalId 贯穿全程 / decision 可按 goalId replay / chosen 即真实
执行动作 / Evidence.observation 含真实工具输出 / 时间序正确 / 无动作任务对照组
（建 Goal、progress=0、无 decision）/ fail-closed 语义保留。

### 残余事项（不在 authority 主线）

- 全量 pytest 残余 145 失败（audit_reporter/otel/production_metrics 等 14 簇），
  均为未提交重构的预存问题，建议独立任务分簇清理
- TS 侧 jest 因 node_modules 损坏不可运行，AuthoritySignature 等 TS 测试已入库待 CI 修复后生效
- Decision 历史仅内存态（重启即失），持久化属 D6 Memory Authority 范畴

---

## 七、D5 Learning Authority（同日, commit 5fa5cb0）

### 现状审计（D5-A）

| 层 | 现状 | 结论 |
| --- | --- | --- |
| TS `LearningAuthority.ts` | 算法完整且被 TS DecisionAuthority/GoalAuthority 消费 | 但按 §0.1 Learning 归 Python 主实现，不能作为权威 |
| Python `continual_learning.py` | 有经验环（record_experience/retrieve_relevant_knowledge 注入 prompt） | prompt 级软影响，**不进权威裁决** |
| Python `decision_authority.py` | 零学习集成 | **D5 闭环在权威层缺失** ← 本轮补齐 |

### 实现（Python 主实现，语义对齐 TS + 一处有意分歧）

- `agent/core/learning_authority.py`：`compute_prediction_error`（match/over/under
  + 词重叠分类）→ `learn`（信念库，RLock 线程安全，只从意外中学习）→
  `adjust_candidate`（置信度/进度偏移 + `[learned:]` 审计注记）；
  `record_decision` 登记 decisionId→provenance 供证据侧回查 proposer
- **有意分歧**：contextSignature 用 `proposer::actionName`（工具名）而非 TS 的
  `actionType`——Python LLMProposer 的 actionType 恒为 `tool_call`，TS 粒度会把
  全部工具折叠进同一信念，无法表达"bash 常失败"这类事实
- 接线：`decision_authority.decide()` 裁决前对全部候选应用偏移（selectionReason
  记 `learningAdjustments=N`）；`goal_authority.updateFromEvidence()` 写回即学习
  （失败不阻断记账，log_ignored 可观测）

### 验收（test_d5_learning_replay.py，2/2 通过）

```text
第 1 轮: Goal A → bash 胜出(conf .9) → Evidence failed
  → PredictionError(over_prediction, 1.0) → Belief(llm::bash, confBias=-0.3)
第 2 轮: Goal B 同上下文 → bash 被压低(0.54) → python 胜出(0.67)
  → selectionReason 含 learningAdjustments=1, 候选含 [learned:] 注记
```

- ✅ 失败 Evidence 改变未来决策（闭环核心断言）
- ✅ match 不更新（只从意外中学习）/ under_prediction 正向偏移
- ✅ 无信念路径与 D4 零回归 / belief 可按 goalId replay 溯源
- ✅ 回归：D4 33 + I4 2 + core_loop/gateway 合计 **122/122**；红线 12/12；导入扫描 PASS

### D5 遗留（不阻塞闭环验收）

- 信念库仍为内存态，持久化属 D6 Memory Authority 范畴
- TS `LearningAuthority` 的 actionType 粒度问题建议后续与 Python 对齐
- EvolutionEngine 尚未消费采样/信念结果（延续 2026-07 诚实遗留清单）

---

## 八、D6 Memory Authority（同日, commit a35c721）

### 现状审计（D6-A）

| 项 | 现状 | 结论 |
| --- | --- | --- |
| 记忆写路径 | Python MemoryEngine（SQLite）主实现；TS 侧已是 MemoryEngineBridge 壳（HTTP 代理 /v1/memory/*） | ✅ 架构上已收敛 |
| StateAuthority.readMemory | provider **从未被注册**，快照 MemoryView 恒空壳 | ❌ 检索不服务 Decision（验收②断裂）→ 本轮接通 |
| 信念/Decision/Evidence | 全内存态，重启即失 | ❌ Risk 4 → 本轮持久化 |

### 实现

- **`agent/core/memory_authority.py`**（新增）：beliefs/belief_history/decisions/
  evidence 的唯一持久化写路径（SQLite WAL + RLock，`AUTHORITY_STORE_PATH` 可配）；
  写入失败 `log_ignored` 可观测，绝不静默
- **三处接线（写入方唯一）**：LearningAuthority→persist_belief_update；
  DecisionAuthority→persist_decision；GoalAuthority→persist_evidence；
  `restore_from_store()` 启动恢复（engine.py 组装时调用）
- **检索服务 Decision**：StateAuthority 新增 `registerMemoryProvider`（独立注册，
  不等全量 providers）；conversation_loop `set_memory_engine` 把
  `MemoryEngine.search` 注入快照 MemoryView；engine.py 组装接线
- **Risk 1 交叉验证端点**：`GET /v1/authority/decisions/{id}`、
  `/v1/authority/goals/{id}/decisions|evidence|beliefs` — TS delegated 可对
  Python FINAL 落盘记录做 decisionId↔goalId↔action 绑定查证，未知 404

### 验收（test_d6_memory_authority.py，5/5 通过）

- ✅ round-trip：decide+evidence 落盘，全新实例从同一文件完整读回
- ✅ Risk 4：LearningAuthority 重建后 `restore_from_store` 信念恢复
- ✅ 验收②：快照 MemoryView 携带真实检索记忆；provider 故障降级空视图
- ✅ Risk 1：已裁决 200 可查 / 伪造 decisionId 404 拒绝
- ✅ 存储故障降级：`is_persistent=False` 且裁决/Evidence 记账照常完成

**过程发现真 bug**：`persist_decision` 占位符 9 vs 列 8 → 静默失败（log_ignored
接住）——被本测试**首次运行即捕获**，"无静默分歧"验收标准直接产生价值。

- 回归：D4+D5+I4+core_loop+gateway+红线 **139 通过**；导入扫描 PASS

### D6 遗留

- Plan v1→v2→v3 replan 逻辑（Risk 3, basic）→ 归 D7 长时程自治一并处理
- 信念恢复目前仅 engine 组装时调用；K8s 多副本共享 SQLite 需换 Redis/PG（D7+）
