# jiabaixing v5.0 全面开发路线图

## 当前状态诊断

v5.0 Harness Agent Framework 六层架构骨架已搭建，132 个测试通过。但诚实地说，这是一个 **骨架完整、血肉缺失** 的半成品：

| 层面 | 已实现 | 缺失 |
|------|--------|------|
| E - 执行循环 | Plan-Execute-Evaluate 状态机 | Evaluator 不评估工具结果；stepResults 字段从未填充 |
| T - 工具注册 | 25 个工具声明 + JSON Schema | 工具实际可靠性未知；无工具调用正确率数据 |
| C - 上下文管理 | 组合管道骨架 | Token 预算分配器未真正生效；动态上下文注入待验证 |
| S - 状态存储 | SQLite + ChromaDB 表结构 | 3-tier memory 实际流转未打通；轨迹全部丢弃 |
| L - 生命周期钩子 | 9 个钩子定义 | 实际拦截效果未知；AFTER_RESPONSE 未持久化任何数据 |
| V - 验证评估 | 基础安全检查 + 启发式打分 | quality score 循环推导（friendliness 硬编码 0.8）；无独立评估 |
| 测试 | 132 个测试通过 | 全部 mock LLM，0 个真实模型测试用例 |
| 前端 | 14 个面板 | 与 Harness 的实时状态同步未验证 |
| 网关 | 4 平台声明 | 真实平台集成测试缺失 |

**核心问题**: 你能跑起来看到一个聊天界面，但你不知道它回答得好不好、工具用得对不对、改了代码是变好还是变坏。这就是"骨架完整、血肉缺失"——工程上无法迭代。

---

## 总体开发哲学

1. **先让闭环真正工作，再加功能。** 当前 Evaluator 是瞎的 → 先让它看见。
2. **先建立度量，再做优化。** 没有 eval set 之前，任何"优化"都是信仰编程。
3. **先持久化数据，再做分析。** 轨迹丢了就永远不知道发生了什么。
4. **每个阶段结束跑 `npm test && npm run check`，不积累回归。**

---

## Phase 1: 打通最小闭环（预估 5-7 天）

> 目标：Evaluator 能真正评估 → 有 eval set 能度量 → 轨迹可回溯。
> 这个阶段完成之前，不要做任何新功能。

### 1.1 (P0) 独立求值器 — `StepEvaluator`

**为什么先做这个**: 当前 Evaluator.evaluate() 只看"LLM 是否停止输出 tool_calls"，不看"工具返回了什么"。这意味着一个工具调用返回了错误信息，只要 LLM 认为它完成了，Evaluator 就给通过。

**做什么**:
- 新建 `src/harness/evaluation/StepEvaluator.ts`
  - 规则引擎：成功/失败检查、空输出检测、格式异常检测、敏感信息泄露检测
  - 输入：toolName, args, result, context
  - 输出：`{ stepId, passed, score, issues[], suggestions[] }`
- 修改 `src/harness/loop/Executor.ts` — 每轮 FC 循环后将 tool 结果写入 `context.stepResults`
- 修改 `src/harness/loop/Evaluator.ts` — 集成 StepEvaluator，聚合步骤得分
- 修改 `src/harness/AgentHarness.ts` — 新增 `useIndependentEvaluator` 开关
- 新建 `tests/harness/step-evaluator.test.ts`

**验收**: 工具调用返回 error → evaluator 给出 failed；工具返回空 → sanity check 捕获。

### 1.2 (P1) 结构化评估集 — Eval Framework

**为什么第二个做**: StepEvaluator 只能检查单步工具调用。要度量"助手整体表现好不好"，需要端到端的 eval set + judge LLM。

**做什么**:
- 新建 `src/harness/evaluation/EvalTypes.ts` — EvalCase / EvalCaseResult / EvalReport 类型
- 新建 `src/harness/evaluation/EvalRunner.ts` — 逐条发真实 LLM 请求，judge LLM 独立评判
- 新建 `data/eval/cases-v1.json` — 20 条初始用例（memory 5 / tool_use 5 / safety 3 / planning 4 / multi_step 3）
- 新建 `scripts/runEval.ts` — CLI 入口，支持 `--category` 和 `--verbose`
- `package.json` 添加 `"eval"` script
- 新建 `tests/harness/eval-runner.test.ts`

**验收**: `npm run eval` 跑完 20 条，输出 JSON + Markdown 报告。以后每次改代码都跑一次，知道质量变化。

### 1.3 (P2) 全轨迹审计 — Trajectory Persistence

**为什么第三个做**: 有 eval set 知道"变好还是变坏"之后，需要轨迹数据来定位"为什么坏了"。Eval 告诉你分数降了，轨迹告诉你是哪个工具调用出了问题。

**做什么**:
- 新建 `src/harness/persistence/TrajectoryDatabase.ts` — 三张 SQLite 表（executions / tool_invocations / state_transitions）
- 新建 `src/harness/persistence/TrajectoryQueryService.ts` — 查询接口
- 修改 `Executor.ts` — traceToolCall 写入 tool_invocations
- 修改 `LoopController.ts` — 状态转移写入 state_transitions，结束写入 executions
- 修改 `AgentHarness.ts` — `useTrajectoryPersistence` 开关 + AFTER_RESPONSE 异步写入
- 新建 `tests/harness/trajectory.test.ts`

**验收**: 发一条消息 → SQLite 中有 execution 记录 + tool_invocation 记录 + state_transition 记录。

### Phase 1 完成标志

```
发消息 → Evaluator 真正检查工具结果 → npm run eval 有分数 → SQLite 有完整轨迹
```

---

## Phase 2: 核心能力补全（预估 7-10 天）

> 目标：闭环通了之后，让每个核心能力真正可靠。
> 此时你有了 eval set（知道改好改坏）和轨迹（知道哪里坏了），可以开始迭代优化。

### 2.1 Memory 系统打通

**现状**: 3-tier memory 定义好了（instant/short-term/long-term），SQLite + ChromaDB 表也有了，但：
- 短期记忆何时转为长期记忆的触发逻辑可能缺失
- 向量检索（ChromaDB）的实际召回质量未知
- memory_recall 工具返回结果是否准确无人验证

**做什么**:
- 补全记忆生命周期：创建 → 重要性评分 → 短期存储 → 衰减/晋升到长期
- 在 eval set 中增加 memory 专项用例（从 5 条扩到 15 条）
- 实现记忆去重（当前 MemoryAssistant 有去重声明，验证它真的在工作）
- 跑 eval → 看 memory 类用例通过率 → 针对性修

### 2.2 Tool 可靠性验证

**现状**: 25 个工具声明了 JSON Schema，但：
- 每个工具的 error rate 未知
- 工具超时后的重试策略未验证
- 部分工具可能从未被真正调用过

**做什么**:
- 用 Phase 1 的轨迹数据，统计每个工具的调用次数、成功率、平均耗时
- 对成功率 < 90% 的工具逐一修复或降级
- 确保每个工具在 eval set 中至少有一条用例覆盖
- 工具返回格式不规范 → StepEvaluator 告警 → 修工具

### 2.3 Planner 质量提升

**现状**: Planner 分三档（regex 简单 / 关键词匹配 / LLM 判断），但：
- 复杂多步任务的计划质量未知
- ExecutionPlan.dependencies 字段从未被验证
- 计划的 estimatedBudget 是否准确无人知晓

**做什么**:
- 在 eval set 中增加 planning 专项用例（从 4 条扩到 12 条）
- 用轨迹数据对比 estimatedBudget vs 实际消耗
- 如果 Planner 频繁低估预算 → 调整估算系数
- 如果 replan 触发率 > 30% → 说明首次计划质量差，需要改进 Planner prompt

### 2.4 错误恢复路径

**现状**: replan 最多 1 次，但 replan 之后如果还失败，就放弃了。

**做什么**:
- 定义工具级错误分类：可重试（超时/网络） vs 不可重试（权限/参数错误）
- 可重试错误自动重试（最多 2 次），不可重试错误触发 replan
- 在 eval set 中增加错误恢复用例

### Phase 2 完成标志

```
Memory 召回率 > 70% → 工具成功率 > 90% → Planner 预算准确度 > 60% → replan 触发率 < 30%
```

---

## Phase 3: 主动智能（预估 5-7 天）

> 目标：让 jiabaixing 从"等你说"变成"主动说"。
> 这是产品层面的分水岭——被动应答 vs 主动关怀。

### 3.1 场景感知调度器验证

**现状**: `ScenarioAwareScheduler` 已实现，使用 cron 轮询。但：
- 触发时机是否合理未在真实场景验证
- 晨间播报的内容质量未知
- 日程提醒是否准时无人测试

**做什么**:
- 在 eval set 中增加 proactive 类用例
- 让 Scheduler 运行 24 小时，记录每次触发的上下文和响应
- 检查：是否在不合适的时间触发？是否漏掉重要提醒？
- 给 Scheduler 增加"安静时段"配置（夜间不打扰）

### 3.2 上下文感知增强

**现状**: ContextManager 有 Dynamic Context 注入，但实际注入了什么、注入了多少，没有验证。

**做什么**:
- 在轨迹中记录每次请求的上下文注入内容（token 数、来源模块）
- 验证：上下文是否与用户当前话题相关？
- 调优 TokenBudgetAllocator 的分配比例（当前 6 个桶的比例是拍脑袋定的）

### Phase 3 完成标志

```
Scheduler 24h 无异常触发 → 晨间播报内容合理 → 上下文注入相关性 > 60%
```

---

## Phase 4: 生产可靠性（预估 7-10 天）

> 目标：不只是"能跑"，而是"跑不坏"。
> 这个阶段做的是工程基础设施，不做用户可见的新功能。

### 4.1 可观测性

**现状**: 有 Logger 和 EventBus，但：
- 没有结构化日志（JSON 格式）
- 没有指标采集（请求量、延迟分布、错误率）
- 没有链路追踪（一次请求经过哪些模块）

**做什么**:
- 结构化日志：每条日志带 traceId、module、level、timestamp
- 核心指标采集：请求数、延迟 p50/p95/p99、工具调用成功率、token 消耗
- 基于 Phase 1 的轨迹数据库，构建 `/api/metrics` 端点
- 前端 MonitorPanel 接入真实数据（当前可能是静态/mock）

### 4.2 优雅降级

**现状**: 预算超限后触发 ON_BUDGET_EXCEEDED 钩子，但降级行为可能只是"返回一条错误消息"。

**做什么**:
- LLM 不可用时 → 返回预设的友好降级回复（不是报错 JSON）
- ChromaDB 不可用时 → 自动回退到 SQLite 关键词搜索
- 工具超时时 → 返回部分结果而非全部失败
- 每种降级路径在 eval set 中有对应用例

### 4.3 成本管理

**现状**: 用本地 LLM.server（qwen2.5:3b），成本不是问题。但架构上 TokenBudgetAllocator 已经定义了，未来切云端模型时直接可用。

**做什么**:
- Token 消耗追踪（每次请求、每个工具调用消耗多少 token）
- 按日/周/月统计 token 消耗报表
- 设置 token 消耗告警阈值
- 如果未来切到云端 API，成本预估直接可用

### 4.4 安全加固

**现状**: VerificationService.checkOutputSafety() 有基础正则（银行卡号、身份证号、密码泄露），但覆盖面有限。

**做什么**:
- 工具调用权限审计：每个工具的 risk level 是否与实际匹配
- 敏感数据掩码：在日志和轨迹中自动掩码手机号、邮箱、身份证号
- 在 eval set 中增加安全对抗用例（prompt injection、越狱尝试）

### Phase 4 完成标志

```
/api/metrics 返回实时数据 → 每种降级路径有测试覆盖 → token 消耗可追踪 → 安全用例全部通过
```

---

## Phase 5: 体验与集成（预估 5-7 天）

> 目标：面向用户的界面和平台接入真正可用。

### 5.1 前端状态同步

**现状**: 14 个面板，但 AgentExecutionPanel 是否实时显示 Harness 执行状态未知。

**做什么**:
- WebSocket 推送 Harness 执行状态到前端（planning → executing → evaluating → done）
- AgentExecutionPanel 实时显示当前步骤、工具调用、进度
- MemoryPanel 显示最近记忆的可视化
- 修复前端已知 bug

### 5.2 多平台网关验证

**现状**: 4 平台声明（WeChat QR/API、QQ Mirai、Feishu、DingTalk），IntegrationManager 有 inline fallback。但真实平台测试可能从未做过。

**做什么**:
- 至少在一个平台上完成端到端测试（推荐 Feishu，API 最规范）
- 验证消息格式转换（平台消息 ↔ Harness 输入）
- 验证多平台并发（两个平台同时发消息不互相干扰）

### 5.3 Voice 集成验证

**现状**: 有 Whisper 语音转文字端点 `/api/voice/upload`。

**做什么**:
- 端到端测试：上传音频 → 转文字 → Harness 处理 → 返回回复
- 测试不同音频格式、不同语速
- 验证中文识别准确率

### Phase 5 完成标志

```
前端实时显示执行状态 → 至少 1 个平台端到端通过 → 语音转文字可用
```

---

## Phase 6: 自我进化（预估 7-10 天，可并行探索）

> 目标：系统能自己发现自己哪里不好，自己改进。
> 这是最"智能"的阶段，但依赖前 5 个阶段的产物（eval set、轨迹、指标）。

### 6.1 自动优化管道

**现状**: `ENABLE_AUTO_OPTIMIZE=true` 配置存在，EvolutionMetrics 已存储，但优化行为可能只是调整配置参数。

**做什么**:
- 每次 `npm run eval` 的结果自动存入 evolution-metrics.json
- 定义优化目标：eval pass rate、平均响应延迟、token 效率
- 自动 A/B 测试：改 system prompt → 跑 eval → 比较分数 → 选择更好的
- 回滚机制：如果优化后分数下降，自动回滚

### 6.2 Prompt 工程化

**现状**: ConstitutionPromptBuilder 构建系统 prompt。但 prompt 的版本管理和 A/B 测试未建立。

**做什么**:
- Prompt 模板外部化到文件（非硬编码）
- Prompt 版本管理（git 天然支持，只需文件化）
- 在 eval set 中对比不同 prompt 版本的效果
- 建立 prompt 变更的审批流程（改了 prompt → 跑 eval → 看分数 → 决定是否合入）

### 6.3 Fine-tuning 数据积累

**现状**: 每次请求的完整轨迹在 Phase 1 已持久化。

**做什么**:
- 从轨迹中提取高质量交互（用户满意 + 工具使用正确 + 语气合适）
- 构建 fine-tuning 数据集
- 标记：哪些对话是好的训练样本，哪些不能用于训练（含敏感信息、失败案例）
- 如果未来换更强模型，这些数据可直接用于微调

### Phase 6 完成标志

```
npm run eval 自动存档 → A/B 测试可运行 → prompt 文件化管理 → fine-tuning 数据可导出
```

---

## 开发节奏建议

```
Phase 1 ████████████████ (5-7 天) → 闭环通了，可以开始迭代
Phase 2 ████████████████ (7-10 天) → 核心能力可靠
Phase 3 ████████████████ (5-7 天) → 主动智能工作
Phase 4 ████████████████ (7-10 天) → 生产级可靠性
Phase 5 ████████████████ (5-7 天) → 用户体验完整
Phase 6 ████████████████ (7-10 天) → 自我进化
```

总计约 **5-7 周** 达到完整可用的生产级私人 AI 助手。

**关键原则**:
- **Phase 1 不做完，不碰 Phase 2。** 没有 eval set，任何"优化"都是自欺欺人。
- **每个 Phase 结束跑完整 `npm run check`。** 不积累技术债。
- **每完成一个能力模块，立即在 eval set 里加对应用例。** Eval set 是活的，随系统一起成长。
- **如果只有碎片时间，优先做 Phase 1。** Phase 1 的三个任务每个都是独立可交付的改进。

---

## 每个 Phase 的验收门禁

| Phase | 门禁条件 |
|-------|---------|
| Phase 1 | `npm test` 全过 + `npm run eval` 输出报告 + 轨迹可查询 |
| Phase 2 | Memory 召回 > 70% + Tool 成功率 > 90% + Eval pass rate > 60% |
| Phase 3 | Scheduler 24h 无误触发 + 上下文注入相关性 > 60% |
| Phase 4 | `/api/metrics` 可用 + 降级路径全覆盖 + 安全用例全通过 |
| Phase 5 | 前端实时状态同步 + 至少 1 个平台端到端通过 |
| Phase 6 | Eval 自动存档 + A/B 测试可运行 + Prompt 文件化 |
