# D4-I3 Orchestrator Audit

> 审计日期：2026-09-13
> 审计范围：OrchestratorAgent 是否真经过 DecisionAuthority，三种 Decision 类型

## 核心设计变更

### 三种 Decision 类型

```
DecisionType.GOAL   — 目标决策（是否接受/创建目标）
DecisionType.PLAN   — 计划决策（如何拆解目标为子任务）
DecisionType.ACTION — 动作决策（执行什么具体动作）
```

**原则**：不要把所有 decision 都塞进一个函数。三种决策有不同的 proposer 集合和不同的评分逻辑。

### OrchestratorProposer 是纯 proposer

```
OrchestratorProposer
  → implements DecisionProposer
  → propose() 返回 DecisionCandidate[]
  → 不直接执行/分发
```

### 两条路径都经过 DecisionAuthority

**复杂路径**：
```
用户目标
  → GoalAuthority.createGoal() → goalId
  → StateAuthority.captureSnapshot() → snapshotId
  → OrchestratorProposer.propose() → plan candidates
  → DecisionAuthority.decide(decisionType=PLAN) → FINAL plan decision
  → TaskDispatcher.dispatch(tasks) → 执行
  → Evidence → GoalAuthority.updateFromEvidence()
```

**简单路径**：
```
用户目标
  → GoalAuthority.createGoal() → goalId
  → StateAuthority.captureSnapshot() → snapshotId
  → DecisionAuthority.decide(decisionType=ACTION) → FINAL action decision
  → Agent.execute() / TaskDispatcher.dispatch() → 执行
  → Evidence → GoalAuthority.updateFromEvidence()
```

## 审计检查

| # | 检查项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | DecisionType 有 GOAL/PLAN/ACTION | ✅ | `types.ts` enum 定义 |
| 2 | OrchestratorProposer 是纯 proposer | ✅ | 无 execute/dispatch 方法 |
| 3 | 复杂路径用 DecisionType.PLAN | ✅ | OrchestratorAgent L202 |
| 4 | Plan decision 下沉 goalId/decisionId 到子任务 | ✅ | parentGoalId + planDecisionId + planSnapshotId |
| 5 | 简单路径用 DecisionType.ACTION | ✅ | OrchestratorAgent L508 |
| 6 | 简单路径写 Evidence 回同一 goalId | ✅ | recordSimplePathEvidence() |
| 7 | DecisionAuthority 处理三种类型 | ✅ | decide() 接受 decisionType 参数 |
| 8 | OrchestratorAgent 不直接调用 executeAction | ✅ | 全局搜索无 .executeAction( |
| 9 | Goal identity 稳定（Goal ≠ Plan） | ✅ | replan() 增 planVersion，不改 goalId |

## Goal ≠ Plan 原则

```
Goal G123
   ├── Plan v1
   ├── Plan v2  (replan 后)
   └── Plan v3  (再 replan 后)
```

**不是**：
```
Goal G123 → replan → Goal G124  ❌
```

`GoalAuthority.replan()` 实现 CAS（Compare-And-Swap）乐观锁：
- `goalId` 不变
- `planVersion` 递增
- 旧 Decision 的 `planVersion` 与 Goal 不匹配时，DecisionExecutor 拒绝执行（STALE_DECISION）

## 测试

**文件**：`src/authority/__tests__/D4-I3-OrchestratorAudit.test.ts`
**结果**：15/15 PASSED
