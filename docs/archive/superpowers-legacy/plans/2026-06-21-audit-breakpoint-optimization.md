# 审计断点优化计划

> **日期**: 2026-06-21
> **目标**: 打通审计发现的 5 个断点，将三层架构从 7/10 → 8/10
> **模式**: Subagent-Driven + TDD

---

## 审计断点现状

| #   | 断点                                             | 位置                           | 现状          | 影响                 |
| --- | ------------------------------------------------ | ------------------------------ | ------------- | -------------------- |
| 1   | `resolveConflictsWithLLM` / `mergeWithConsensus` | ResultAggregator.ts L265/L319  | 0 外部调用    | 冲突仲裁能力闲置     |
| 2   | `assignDynamicRoles` / `rebalanceRoles`          | OrchestratorAgent.ts L480/L528 | 0 调用        | 动态角色分配闲置     |
| 3   | 任务间通信                                       | 无                             | 不存在        | 子任务无法共享数据   |
| 4   | ContextManager → FeedbackLoops                   | AgentHarness.ts L748           | 只传 metadata | 反馈循环缺上下文     |
| 5   | PersistenceService 类型                          | PersistenceService.ts L85      | 内联类型      | 未复用 IMemoryEngine |

---

## 优化方案

### 断点1: 集成冲突仲裁到结果聚合流程

**问题**: `resolveConflictsWithLLM` 和 `mergeWithConsensus` 已实现但从未被调用。

**方案**: 在 `OrchestratorAgent.processComplexGoal` 中，当 `aggregator.aggregate` 检测到冲突时，调用 `resolveConflictsWithLLM` 进行仲裁；当多个任务结果有置信度时，调用 `mergeWithConsensus` 合并。

**修改文件**:

- `src/harness/orchestration/OrchestratorAgent.ts` — 在聚合后添加冲突仲裁分支
- `tests/unit/harness/orchestration/ConflictResolution.test.ts` — 新增测试

**TDD 步骤**:

1. 写测试：模拟冲突场景，验证 `resolveConflictsWithLLM` 被调用
2. 写测试：模拟多结果场景，验证 `mergeWithConsensus` 被调用
3. 实现：在 `processComplexGoal` 添加冲突检测和仲裁逻辑
4. 验证：测试通过

---

### 断点2: 集成动态角色分配到任务派发流程

**问题**: `assignDynamicRoles` 和 `rebalanceRoles` 已实现但从未被调用。

**方案**: 在 `OrchestratorAgent.processComplexGoal` 中，Planner 生成任务后、TaskDispatcher 派发前，调用 `assignDynamicRoles` 进行角色分配；在任务执行中检测过载时调用 `rebalanceRoles`。

**修改文件**:

- `src/harness/orchestration/OrchestratorAgent.ts` — 在 `processComplexGoal` 添加角色分配步骤
- `tests/unit/harness/orchestration/DynamicRoleAssignment.test.ts` — 新增测试

**TDD 步骤**:

1. 写测试：模拟多任务场景，验证 `assignDynamicRoles` 被调用
2. 写测试：模拟过载场景，验证 `rebalanceRoles` 被调用
3. 实现：在 `processComplexGoal` 添加角色分配和重平衡逻辑
4. 验证：测试通过

---

### 断点3: 添加轻量任务间通信机制

**问题**: 子任务之间无法共享中间结果。

**方案**: 在 `TaskDispatcher` 中添加 `TaskMessageBus`，允许任务在执行时发布/订阅消息。任务可通过 `context` 字段传递 `messageBus` 引用。

**修改文件**:

- `src/harness/orchestration/TaskDispatcher.ts` — 添加 `TaskMessageBus` 类和集成
- `tests/unit/harness/orchestration/TaskMessageBus.test.ts` — 新增测试

**TDD 步骤**:

1. 写测试：验证 publish/subscribe 基本功能
2. 写测试：验证任务 A 发布数据后任务 B 能接收
3. 实现：`TaskMessageBus` 类 + 在 `executeTaskWithRetry` 中注入
4. 验证：测试通过

---

### 断点4: 传递 ContextManager 上下文到 FeedbackLoops

**问题**: `HookContext` 只传 `event` + `extra`，FeedbackLoops 无法获取完整上下文。

**方案**: 在 `AgentHarness.executeHook` 中，将 `contextManager.buildContext` 的结果（或其摘要）注入到 `HookContext.metadata` 中，使 FeedbackLoops 能访问上下文信息。

**修改文件**:

- `src/harness/AgentHarness.ts` — 在 `executeHook` 中注入上下文摘要
- `src/harness/loops/FeedbackLoops.ts` — 在 `executeLoops` 中读取上下文
- `tests/unit/harness/loops/FeedbackLoopsContext.test.ts` — 新增测试

**TDD 步骤**:

1. 写测试：验证 HookContext.metadata 包含 contextSummary
2. 写测试：验证 FeedbackLoops 能读取上下文摘要
3. 实现：在 `executeHook` 中注入上下文
4. 验证：测试通过

---

### 断点5: PersistenceService 复用 IMemoryEngine 接口

**问题**: `deps.memoryEngine` 使用内联类型而非 `IMemoryEngine` 接口。

**方案**: 将 `PersistenceService` 的 `memoryEngine` 类型改为 `IMemoryEngine`，移除内联类型定义。

**修改文件**:

- `src/harness/persistence/PersistenceService.ts` — 替换内联类型为 `IMemoryEngine`
- `tests/unit/harness/persistence/PersistenceServiceInterface.test.ts` — 新增测试

**TDD 步骤**:

1. 写测试：验证 PersistenceService 接受 IMemoryEngine 实现
2. 实现：替换内联类型
3. 验证：测试通过 + 类型检查通过

---

## 执行顺序

```
断点5 (类型修复) → 断点4 (上下文传递) → 断点1 (冲突仲裁) → 断点2 (角色分配) → 断点3 (任务通信)
```

**理由**: 先修复低风险类型问题，再修复集成问题，最后添加新功能。

---

## 验证标准

- [ ] 所有新增测试 100% 通过
- [ ] 现有测试 100% 通过（回归）
- [ ] TypeScript 编译 0 errors
- [ ] 5 个断点全部打通
- [ ] 三层架构评分 7/10 → 8/10

---

## 回退方案

每个断点独立提交，如出现问题可 `git revert` 单个提交。
