# Phase 10 & Phase 11 实施计划

## 概述

| Phase | 目标 | 当前状态 | 目标状态 |
|-------|------|----------|----------|
| Phase 10 | 多 Agent 协同 + 任务拆解 + Sub-Agent 扇出 | 🚧 骨架代码已有，未集成到主流程 | ✅ 完整集成，可端到端运行 |
| Phase 11 | 效果自评估 + 持续优化闭环 + Golden Eval Set | 🚧 评估组件已有，缺少 Golden Eval Set 和 CI/CD 门禁 | ✅ 完整闭环，Golden Eval Set 50+ 案例 |

---

## Phase 10: Multi-Agent Orchestration

### 现有代码基础

| 文件 | 已有能力 | 缺失能力 |
|------|----------|----------|
| `AgentRegistry.ts` | Agent 注册/发现/状态管理 | 无健康检查、无心跳、无能力评分排序 |
| `OrchestratorAgent.ts` | 目标拆解→分发→聚合→评估→进化记录 | 未集成到 AgentHarness/JiabaixingCore，无 Sub-Agent 扇出 |
| `TaskDispatcher.ts` | DAG 拓扑排序、并行执行、依赖注入 | 无任务超时、无重试、无任务取消 |
| `ResultAggregator.ts` | 结果聚合、成功/失败统计 | 无 LLM 摘要生成、无冲突检测 |
| `TaskComplexityAnalyzer.ts` | 关键词复杂度分析、子任务拆解 | 未与 OrchestratorAgent 集成 |

### 实施步骤

#### Step 1: 增强 AgentRegistry — 健康检查与能力评分

**文件**: `src/harness/orchestration/AgentRegistry.ts`

改动内容：
1. 添加 `AgentHealth` 接口（lastHeartbeat, successRate, avgResponseTime, errorCount）
2. 添加 `updateHealth(agentId, health)` 方法
3. 添加 `findBestAgent(toolName)` 方法 — 按能力评分 + 健康状态排序，替代简单的 `findAgentByCapability`
4. 添加 `getHealthStatus(agentId)` 方法
5. 添加定时健康检查 `cleanupStaleAgents(timeoutMs)` — 自动将超时无心跳的 Agent 标记为 error

#### Step 2: 增强 TaskDispatcher — 超时/重试/取消

**文件**: `src/harness/orchestration/TaskDispatcher.ts`

改动内容：
1. 添加 `TaskDispatcherConfig` 接口（taskTimeoutMs, maxRetries, retryDelayMs, maxConcurrentPerLayer）
2. 在 `executeTask` 中添加超时控制（Promise.race + AbortController）
3. 添加可重试任务的自动重试逻辑（基于 TaskNode.priority 和错误类型）
4. 添加 `cancel(taskId)` 方法 — 取消正在执行的任务
5. 添加并发限制（每层最大并行数），防止资源耗尽
6. 在 `dispatch` 中添加 `TaskDispatcherConfig` 参数

#### Step 3: 增强 ResultAggregator — LLM 摘要与冲突检测

**文件**: `src/harness/orchestration/ResultAggregator.ts`

改动内容：
1. 添加可选的 `llm` 依赖注入（用于生成人类可读的聚合摘要）
2. 添加 `aggregateWithSummary(agentResults, taskNodes, llm?)` 方法 — 使用 LLM 生成自然语言摘要
3. 添加 `detectConflicts(results)` 方法 — 检测不同 Agent 结果之间的冲突（如文件写入冲突）
4. 在 `AggregatedResult` 中添加 `conflicts` 字段和 `llmSummary` 字段

#### Step 4: Sub-Agent 扇出机制

**文件**: `src/harness/orchestration/SubAgentFanout.ts`（新建）

核心设计：
1. `SubAgentFanout` 类 — 管理子 Agent 的扇出执行
2. `FanoutConfig` 接口 — maxFanout（最大扇出数）、strategy（parallel/sequential/adaptive）
3. `fanout(parentTask, subTasks, config)` 方法 — 扇出执行子任务
4. 支持三种策略：
   - `parallel`: 所有子任务并行执行（无依赖时）
   - `sequential`: 顺序执行（有依赖时）
   - `adaptive`: 根据 TaskComplexityAnalyzer 自动选择
5. 结果收集：等待所有子任务完成，聚合结果
6. 错误处理：部分失败时继续执行，标记失败子任务
7. 上下文隔离：每个 Sub-Agent 拥有独立的上下文窗口

#### Step 5: 集成 TaskComplexityAnalyzer 到 OrchestratorAgent

**文件**: `src/harness/orchestration/OrchestratorAgent.ts`

改动内容：
1. 在 `processGoal` 中先调用 `TaskComplexityAnalyzer.analyzeComplexity` 判断是否需要多 Agent
2. 简单任务（complexity=simple）直接走单 Agent 路径
3. 复杂任务（complexity=complex/very_complex）走多 Agent 编排路径
4. 使用 `TaskComplexityAnalyzer.decomposeTask` 作为 LLM 拆解的降级方案（LLM 不可用时）
5. 集成 `SubAgentFanout` 处理扇出逻辑
6. 添加 `OrchestratorConfig` 接口（enableMultiAgent, complexityThreshold, maxSubAgents）

#### Step 6: 集成 OrchestratorAgent 到 AgentHarness

**文件**: `src/harness/AgentHarness.ts`

改动内容：
1. 在 `HarnessDeps` 中添加可选的 `orchestratorAgent` 依赖
2. 在 `processInput` 流程中，当检测到复杂任务时，委托给 OrchestratorAgent
3. 添加 `shouldUseMultiAgent(input)` 判断逻辑
4. 保持向后兼容：无 OrchestratorAgent 时走原有单 Agent 路径

#### Step 7: 集成到 JiabaixingCore

**文件**: `src/core/JiabaixingCore.ts`

改动内容：
1. 在初始化时创建 OrchestratorAgent 实例
2. 将 OrchestratorAgent 注入到 AgentHarness 的 deps 中
3. 添加 WebSocket 事件：`orchestration_start`、`orchestration_task_update`、`orchestration_complete`

#### Step 8: 前端多 Agent 状态展示

**文件**: `src/frontend/src/stores/useAgentStore.ts`

改动内容：
1. 添加 `orchestrationState` 字段（activeOrchestration, subAgents, taskProgress）
2. 添加 WebSocket 事件处理：orchestration_start/task_update/complete
3. 添加 `OrchestrationPanel` 组件展示多 Agent 执行状态

#### Step 9: Phase 10 测试

**文件**: `tests/harness/orchestration.test.ts`（新建）

测试用例：
1. AgentRegistry: 注册/注销/健康检查/能力排序
2. TaskDispatcher: DAG 执行/超时/重试/取消/并发限制
3. ResultAggregator: 聚合/冲突检测/LLM 摘要
4. SubAgentFanout: parallel/sequential/adaptive 策略
5. OrchestratorAgent: 简单任务直通/复杂任务拆解/降级处理
6. 集成测试: OrchestratorAgent → AgentHarness 端到端

---

## Phase 11: Self-Evaluation Pipeline

### 现有代码基础

| 文件 | 已有能力 | 缺失能力 |
|------|----------|----------|
| `EvaluationPipeline.ts` | 三阶段流水线（步骤/独立/质量） | 无 Golden Eval 集成、无 CI/CD 门禁 |
| `QualityScorer.ts` | 五维质量评分 | 无历史趋势对比 |
| `IndependentEvaluationService.ts` | 规则+LLM评估、多裁判共识 | 无 Golden Eval 对比 |
| `OptimizationFeedbackLoop.ts` | 评估→优化闭环 | 无持久化、无回归检测 |
| `EvalRunner.ts` | 评估运行器、LLM Judge | 无 Golden Eval Set、无持久化报告 |
| `EvalTypes.ts` | 类型定义 | 类别不够丰富 |

### 实施步骤

#### Step 1: Golden Eval Set 数据集

**文件**: `src/harness/evaluation/GoldenEvalSet.ts`（新建）

核心设计：
1. `GoldenEvalCase` 接口 — 扩展 `EvalCase`，添加 `goldenOutput`、`goldenToolCalls`、`difficulty`、`assertions`
2. `GoldenEvalSet` 类 — 管理评估数据集
3. `loadCases(category?)` — 加载案例（从 JSON 文件或内存）
4. `addCase(case)` — 添加新案例
5. `validateCase(case)` — 验证案例格式
6. `getStats()` — 数据集统计（总数、按类别、按难度）
7. 内置 50+ 案例，覆盖 5 个类别：
   - `memory` (10+): 记忆存储/召回/遗忘
   - `tool_use` (10+): 工具调用正确性/参数验证
   - `safety` (10+): 敏感信息/权限/注入
   - `planning` (10+): 任务拆解/多步骤规划
   - `multi_step` (10+): 复杂多步骤任务

#### Step 2: Golden Eval 案例 JSON 数据

**文件**: `src/harness/evaluation/golden-eval-cases/`（新建目录）

按类别组织 JSON 文件：
- `memory.json` — 记忆类评估案例
- `tool_use.json` — 工具使用类评估案例
- `safety.json` — 安全类评估案例
- `planning.json` — 规划类评估案例
- `multi_step.json` — 多步骤类评估案例

每个案例包含：
```typescript
{
  id: "golden-memory-001",
  category: "memory",
  input: "记住我的生日是3月15日",
  expectedBehavior: "系统应确认记忆存储，并在后续查询中正确召回",
  goldenOutput: "好的，已为您记住生日：3月15日。",
  goldenToolCalls: [{ name: "memory_store", args: { key: "birthday", value: "3月15日" } }],
  judgePrompt: "评估是否正确调用了记忆存储工具并确认",
  assertions: [
    { type: "tool_call", toolName: "memory_store" },
    { type: "output_contains", value: "3月15日" }
  ],
  difficulty: "easy",
  tags: ["memory", "store"]
}
```

#### Step 3: 断言验证器

**文件**: `src/harness/evaluation/AssertionValidator.ts`（新建）

核心设计：
1. `Assertion` 接口 — 类型化断言（tool_call/output_contains/output_not_contains/json_field/regex/score_range）
2. `AssertionValidator` 类 — 验证输出是否满足断言
3. `validate(output, trace, assertions)` — 执行所有断言，返回通过率
4. 支持的断言类型：
   - `tool_call`: 验证是否调用了指定工具
   - `output_contains`: 验证输出是否包含指定文本
   - `output_not_contains`: 验证输出不包含指定文本（如敏感信息）
   - `json_field`: 验证 JSON 输出中的字段值
   - `regex`: 正则匹配
   - `score_range`: 验证评分在指定范围内

#### Step 4: 增强 EvalRunner — Golden Eval 集成

**文件**: `src/harness/evaluation/EvalRunner.ts`

改动内容：
1. 添加 `runGoldenEval(config)` 方法 — 运行 Golden Eval Set
2. 在 `runSingleCase` 中添加断言验证（AssertionValidator）
3. 在 `EvalCaseResult` 中添加 `assertionResults` 字段
4. 添加 `compareWithBaseline(currentReport, baselineReport)` — 与基线对比，检测回归
5. 添加 `persistReport(report, path)` — 持久化评估报告到文件
6. 添加 `loadHistoricalReports(path)` — 加载历史报告用于趋势分析

#### Step 5: 评估趋势分析

**文件**: `src/harness/evaluation/EvalTrendAnalyzer.ts`（新建）

核心设计：
1. `EvalTrendAnalyzer` 类 — 分析评估结果趋势
2. `analyzeTrend(reports)` — 计算趋势（改善/退化/稳定）
3. `detectRegression(currentReport, previousReport)` — 检测回归
4. `generateTrendReport(reports)` — 生成趋势报告
5. 指标：passRate 趋势、averageScore 趋势、按类别趋势
6. 回归检测：passRate 下降超过 5% 或 averageScore 下降超过 10 分

#### Step 6: CI/CD 评估门禁

**文件**: `src/harness/evaluation/EvalGate.ts`（新建）

核心设计：
1. `EvalGateConfig` 接口 — 门禁配置（minPassRate, minAverageScore, regressionTolerance, blockedCategories）
2. `EvalGate` 类 — CI/CD 评估门禁
3. `check(report, config)` — 检查报告是否通过门禁
4. `checkWithBaseline(report, baselineReport, config)` — 与基线对比检查
5. 返回 `GateResult`：passed/failed、失败原因、建议操作
6. 支持 pass@k 指标：运行 k 次评估，至少通过 n 次

#### Step 7: 增强 OptimizationFeedbackLoop — 持久化与回归检测

**文件**: `src/harness/evaluation/OptimizationFeedbackLoop.ts`

改动内容：
1. 添加 `persistenceService` 可选依赖 — 持久化优化历史
2. 在 `evaluateAndOptimize` 中添加回归检测 — 优化后重新评估，确保不退化
3. 添加 `getOptimizationTrend()` — 返回优化趋势
4. 添加 `rollbackLastOptimization()` — 回滚上次优化（如果导致回归）

#### Step 8: 集成自评估到 AgentHarness 生命周期

**文件**: `src/harness/AgentHarness.ts`

改动内容：
1. 在 `AFTER_RESPONSE` 钩子中触发自评估
2. 评估结果通过 EventBus 广播 `evaluation_complete` 事件
3. 低评分时自动触发 OptimizationFeedbackLoop
4. 添加 `HarnessConfig.evaluation` 配置项（enableAutoEval, evalThreshold, enableOptimizationLoop）

#### Step 9: Phase 11 测试

**文件**: `tests/harness/golden-eval.test.ts`（新建）
**文件**: `tests/harness/eval-gate.test.ts`（新建）
**文件**: `tests/harness/eval-trend.test.ts`（新建）

测试用例：
1. GoldenEvalSet: 加载/验证/统计
2. AssertionValidator: 各类断言验证
3. EvalRunner.runGoldenEval: Golden Eval 运行
4. EvalTrendAnalyzer: 趋势分析/回归检测
5. EvalGate: 门禁检查/pass@k
6. OptimizationFeedbackLoop: 持久化/回归检测/回滚
7. 集成测试: AgentHarness → 自评估 → 优化闭环

---

## 实施顺序

```
Phase 10 (Multi-Agent)                    Phase 11 (Self-Evaluation)
─────────────────────                     ─────────────────────────
Step 1: AgentRegistry 增强                Step 1: GoldenEvalSet 数据集
Step 2: TaskDispatcher 增强               Step 2: Golden Eval JSON 数据
Step 3: ResultAggregator 增强             Step 3: AssertionValidator
Step 4: SubAgentFanout (新建)             Step 4: EvalRunner 增强
Step 5: OrchestratorAgent 集成            Step 5: EvalTrendAnalyzer (新建)
Step 6: AgentHarness 集成                 Step 6: EvalGate (新建)
Step 7: JiabaixingCore 集成              Step 7: OptimizationFeedbackLoop 增强
Step 8: 前端多Agent状态                   Step 8: AgentHarness 生命周期集成
Step 9: Phase 10 测试                     Step 9: Phase 11 测试
```

**建议并行开发**：Phase 10 Step 1-4 与 Phase 11 Step 1-3 可并行，集成步骤串行。

---

## 文件变更清单

### Phase 10 新建文件

| 文件 | 说明 |
|------|------|
| `src/harness/orchestration/SubAgentFanout.ts` | Sub-Agent 扇出机制 |
| `tests/harness/orchestration.test.ts` | Phase 10 测试 |

### Phase 10 修改文件

| 文件 | 说明 |
|------|------|
| `src/harness/orchestration/AgentRegistry.ts` | 健康检查、能力评分 |
| `src/harness/orchestration/TaskDispatcher.ts` | 超时/重试/取消 |
| `src/harness/orchestration/ResultAggregator.ts` | LLM 摘要、冲突检测 |
| `src/harness/orchestration/OrchestratorAgent.ts` | 复杂度分析集成、Sub-Agent 扇出 |
| `src/harness/AgentHarness.ts` | 多 Agent 路径集成 |
| `src/core/JiabaixingCore.ts` | OrchestratorAgent 初始化 |
| `src/frontend/src/stores/useAgentStore.ts` | 多 Agent 状态 |
| `src/harness/index.ts` | 导出新增组件 |

### Phase 11 新建文件

| 文件 | 说明 |
|------|------|
| `src/harness/evaluation/GoldenEvalSet.ts` | Golden Eval 数据集管理 |
| `src/harness/evaluation/AssertionValidator.ts` | 断言验证器 |
| `src/harness/evaluation/EvalTrendAnalyzer.ts` | 评估趋势分析 |
| `src/harness/evaluation/EvalGate.ts` | CI/CD 评估门禁 |
| `src/harness/evaluation/golden-eval-cases/memory.json` | 记忆类案例 |
| `src/harness/evaluation/golden-eval-cases/tool_use.json` | 工具使用类案例 |
| `src/harness/evaluation/golden-eval-cases/safety.json` | 安全类案例 |
| `src/harness/evaluation/golden-eval-cases/planning.json` | 规划类案例 |
| `src/harness/evaluation/golden-eval-cases/multi_step.json` | 多步骤类案例 |
| `tests/harness/golden-eval.test.ts` | Golden Eval 测试 |
| `tests/harness/eval-gate.test.ts` | Eval Gate 测试 |
| `tests/harness/eval-trend.test.ts` | Eval Trend 测试 |

### Phase 11 修改文件

| 文件 | 说明 |
|------|------|
| `src/harness/evaluation/EvalRunner.ts` | Golden Eval 集成、断言验证、持久化 |
| `src/harness/evaluation/EvalTypes.ts` | 扩展类型定义 |
| `src/harness/evaluation/OptimizationFeedbackLoop.ts` | 持久化、回归检测、回滚 |
| `src/harness/AgentHarness.ts` | 自评估生命周期集成 |
| `src/harness/index.ts` | 导出新增组件 |

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Sub-Agent 上下文隔离不完整 | 子 Agent 间数据泄露 | 每个 Sub-Agent 独立 ContextManager |
| Golden Eval 案例质量不足 | 评估结果不可靠 | 逐步积累，从 20 个核心案例开始 |
| LLM Judge 不稳定 | 评估结果波动 | 规则评估为主，LLM 评估为辅，多裁判共识 |
| 多 Agent 编排性能开销 | 响应时间增加 | 简单任务直通，仅复杂任务走编排 |
| 优化闭环导致无限循环 | 系统不稳定 | 冷却期 + 最大连续优化次数 + 回归检测 |

---

## 验收标准

### Phase 10 验收

- [ ] 复杂任务自动走多 Agent 编排路径
- [ ] 简单任务直通单 Agent 路径（无性能损失）
- [ ] DAG 任务分发支持并行执行和依赖注入
- [ ] Sub-Agent 扇出支持 parallel/sequential/adaptive 三种策略
- [ ] 任务超时和重试机制正常工作
- [ ] 前端可展示多 Agent 执行状态
- [ ] 所有测试通过

### Phase 11 验收

- [ ] Golden Eval Set 包含 50+ 评估案例
- [ ] 断言验证器支持 6 种断言类型
- [ ] EvalGate 门禁可配置 passRate 和 score 阈值
- [ ] 评估趋势分析可检测回归
- [ ] OptimizationFeedbackLoop 支持回归检测和回滚
- [ ] AgentHarness 生命周期自动触发自评估
- [ ] 所有测试通过
