# D5 Learning Authority Audit

> 审计日期：2026-09-13
> 审计范围：Evidence → Prediction Error → Belief Update → Future Decision 闭环

## 核心验收标准

> 必须证明：学到了什么 → 未来 decision 是否真的改变
> 不能出现：update() → 写 cache → 结束 → 未来根本不用

## 审计结果

### Audit 1: Evidence → Prediction Error → Belief Update ✅

- `learn()` 产生 `PredictionError`，包含 `goalId`/`decisionId`
- over-prediction（expected=success, actual=failed）→ `confidenceAdjustment < 0`
- exact match → 无 BeliefUpdate（不浪费）
- PredictionError 有完整溯源：`evidenceId`/`goalId`/`decisionId`

### Audit 2: Belief update actually changes Future Decision ✅

- **over-prediction**：proposer_A 失败 → confidence 降低 → proposer_B 赢
- **under-prediction**：proposer_C 超预期 → confidence 升高 → C 更可能被选中
- 关键：不是"写 cache → 结束"，而是真的改变了 `DecisionAuthority.decide()` 的输出

### Audit 3: Full closure Evidence → Learn → Adjust → Decide ✅

- `GoalAuthority.updateFromEvidence()` 触发 `LearningAuthority.learn()`
- `DecisionAuthority.decide()` 调用 `LearningAuthority.adjustCandidate()`
- 完整闭环：
  ```
  Evidence → GoalAuthority.updateFromEvidence()
    → LearningAuthority.learn() → Belief update
    → DecisionAuthority.decide() → adjustCandidate() → Future Decision
  ```

### Audit 4: Belief is not just cache — traceable history ✅

- 每个 `BeliefUpdate` 有 `sourceEvidenceId`/`sourceGoalId`/`sourceDecisionId`
- Belief history 可按 `goalId` 查询
- 完整溯源链：`BeliefUpdate → Evidence → Decision → Goal`

### Audit 5: Cross-task generalization ✅

- 同 `proposerId + actionType` → 同 `contextSignature` → 共享 belief
- 任务 1 的失败经验自动影响任务 2 中同一 proposer 的 confidence
- `sampleCount` 累积，belief 逐步稳定

## 代码路径

| 步骤 | 代码位置 |
|------|----------|
| Evidence 产生 | `GoalAuthority.ts` L198: `learningAuthority.learn(fullEvidence, proposerId)` |
| Prediction Error 计算 | `LearningAuthority.ts` L62-117: `computePredictionError()` |
| Belief Update 应用 | `LearningAuthority.ts` L126-170: `learn()` → `applyBeliefUpdate()` |
| Candidate 调整 | `LearningAuthority.ts` L171-197: `adjustCandidate()` |
| Decision 使用调整 | `DecisionAuthority.ts` L75: `candidates.map(c => learningAuthority.adjustCandidate(c))` |

## 测试

**文件**：`src/authority/__tests__/D5-LearningAudit.test.ts`
**结果**：10/10 PASSED

## 结论

**D5 Learning Authority 通过。**

Learning 不是"写 cache → 结束"的空转。Evidence 真正改变了 Future Decision。
