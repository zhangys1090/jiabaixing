# D7: Long-Horizon Agency Audit

> 审计日期: 2026-09-13
> 审计目标: 验证 Goal remains ACTIVE → world changes → Jiabaixing notices → Decision → Action

## 核心验收标准

> User leaves → Goal remains ACTIVE → world changes → Jiabaixing notices → Decision → Action
> 这才是"JARVIS"

## 审计结果

### Audit 1: Goal remains ACTIVE after user leaves ✅

- Goal 创建后 status = 'active'，无外部更新时保持 active
- Replan 后 goalId 不变，planVersion 递增
- Goal identity 跨 plan version 稳定

### Audit 2: World observation → Goal impact evaluation ✅

- Active goals 可被 GoalImpactEvaluator 检索
- Inactive (completed/abandoned) goals 不在 active 列表
- AutonomousRuntime.injectObservation() → GoalImpactEvaluator.evaluate() → affected goals

### Audit 3: Full authority chain: Goal → State → Decision → Action → Evidence ✅

- Goal 包含所有必需字段: goalId, description, status, priority, progress, createdAt, updatedAt
- StateAuthority.captureSnapshot() 生成包含 activeGoalIds 的快照
- DecisionAuthority.decide() 需要 goalId + snapshot，生成 decisionId

### Audit 4: Evidence feeds back to Goal progress ✅

- 正 Evidence (progressDelta > 0) → goal.progress 增加
- 负 Evidence (progressDelta < 0) → goal.progress 减少或不变
- updateFromEvidence 同时触发 LearningAuthority.learn()

### Audit 5: Learning from long-horizon experience ✅

- 失败 Evidence → LearningAuthority.learn() → BeliefUpdate
- adjustCandidate() 降低被惩罚 proposer 的 confidence
- 未来 Decision 受学习结果影响

### Audit 6: Memory persists across sessions ✅

- MemoryAuthority.write() 带 goalId/decisionId/snapshotId
- Operation log 可按 goalId 检索
- 跨 session 记忆通过 Python canonical owner 持久化

### Audit 7: Full long-horizon chain replay ✅

完整链路验证:

```
Goal (G_xxx)
  ↓
StateAuthority.captureSnapshot() → S_xxx
  ↓
DecisionAuthority.decide() → D_xxx
  ↓
GoalAuthority.updateFromEvidence() → progress 更新
  ↓
DecisionAuthority.getDecisionHistory() → 可回溯
```

## 代码路径

```
AutonomousRuntime.start()
  → setInterval(tick, observationIntervalMs)
  → tick() → GoalAuthority.getActiveGoals()
  → injectObservation(obs) → GoalImpactEvaluator.evaluate()
  → affected goals → initiateLoopForGoal()
  → AutonomousLoop.run(goalId, impact, observation, safetyConfig)
  → observe → decide → act → verify → report
  → 循环直到 COMPLETED / FAILED / ABANDONED / safety_stop
```

## 结论

**D7 Long-Horizon Agency: ✅ 通过**

三个台阶全部完成:
1. ✅ 统一 Goal + State + Decision (D4-I1~I4)
2. ✅ Evidence → Learning → Future Decision (D5)
3. ✅ Active Goal + World Change → Autonomous Replanning → Autonomous Action (D7)

AutonomousRuntime 实现了:
- 定时观察 (observationIntervalMs)
- 观察 → 影响评估 (GoalImpactEvaluator)
- 受影响目标 → 自动发起 Loop (initiateLoopForGoal)
- 安全终止 (maxSteps, maxTimeMs, consecutiveFailures, repeatedActionLoop)
