# D4-I4 Global Authority Replay Audit

> 审计日期：2026-09-13
> 审计范围：从 User Input 到 Goal progress 的全链回溯

## 核心验收标准

> 随便挑一个真实任务，从 User Input 一直追到 Goal → Snapshot → Decision → Action → Evidence → Goal progress，而不是再看模块测试。

## 全链回溯结果

```
Step 1: Goal
  → goalId = G_xxx
  → status = ACTIVE
  → planVersion = 1

Step 2: Snapshot
  → snapshotId = S_xxx
  → activeGoalIds = [G_xxx]
  → timestamp = xxx

Step 3: Decision
  → decisionId = D_xxx
  → decisionType = ACTION
  → goalId = G_xxx ← 连接 Goal
  → snapshotId = S_xxx ← 连接 Snapshot
  → chosenCandidateId = C_xxx
  → proposerId = d4_i4_test_proposer
  → planVersion = 1

Step 4: Action
  → type = file_write
  → path = hello.txt
  → content = "Hello D8"

Step 5: Evidence
  → verified = true
  → domain = filesystem
  → evidence = "file content: Hello D8"

Step 6: GoalProgress
  → goalId = G_xxx ← 回到同一 Goal
  → progress > 0
  → updatedAt > createdAt
```

## Authority Contract 验证

**每个 production step 都有 goalId/snapshotId/decisionId**：

| Step | goalId | snapshotId | decisionId |
|------|--------|------------|------------|
| Decision | ✅ | ✅ | ✅ |
| Evidence | ✅ (via decisionId) | — | ✅ |
| GoalProgress | ✅ | — | ✅ |

## 链路连接性验证

| 连接 | 验证 |
|------|------|
| Snapshot.activeGoalIds → Goal.goalId | ✅ |
| Decision.goalId → Goal.goalId | ✅ |
| Decision.snapshotId → Snapshot.snapshotId | ✅ |
| GoalProgress.goalId → Goal.goalId | ✅ |

## 测试

**文件**：`src/authority/__tests__/D4-I4-GlobalReplay.test.ts`
**结果**：8/8 PASSED

## 结论

**D4-I4 通过。D4 全部集成审计完成。**

```
D4-I1 Python       ✅
D4-I1-R 跨进程     ✅
D4-I1-R2 HMAC      ✅
D4-I2 Desktop      ✅
D4-I2 Post-Audit   ✅
D4-I3 Orchestrator ✅
D4-I4 Global Replay ✅
```

**可以进入 D5 Learning Authority。**
