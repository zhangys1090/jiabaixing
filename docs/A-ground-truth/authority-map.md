# Authority Map — 真相底账

> 此文件记录系统当前所有 Authority 及其职责。
> 更新规则：每次 src/ 变更后同步更新对应条目。GLM 不自行修改。

## Authority 清单

| Authority | 职责 | 关键方法 | 状态 |
|-----------|------|----------|------|
| GoalAuthority | Goal 生命周期管理 | createGoal, getGoal, updateGoalStatus | ✅ 活跃 |
| DecisionAuthority | 决策生成与 FINAL 标记 | propose, finalize, getDecisionHistory | ✅ 活跃 |
| ActionAuthority | 动作执行授权 | authorize, execute | ✅ 活跃 |
| EvidenceCollector | 证据收集 | collect, verify | ✅ 活跃 |
| IndependentVerifier | 独立环境验证 | verify(filesystem/test/code/novel/desktop) | ✅ 活跃 |
| LearningAuthority | 跨任务学习 | computePredictionError, learn, adjustCandidate | ✅ 活跃 |
| AutonomousLoop | 持续任务循环 | run, getStepHistory | ✅ 活跃 |
| ReplanProposerResolver | Replan 提案解析 | register, resolve | ✅ 活跃 |
| DirectActionProposer | 直接动作提案 | propose, freeze | ✅ 活跃 |
| GenericRecoveryProposer | 通用恢复提案 | propose | ✅ 活跃 |
| EvidenceDrivenRecoveryProposer | 证据驱动恢复提案 | propose | ✅ 活跃 |
| GoalEvidenceEvaluator | Goal 证据评估 | evaluate | ✅ 活跃 |
| ObservationCollector | 环境观察收集 | collect | ✅ 活跃 |

## P0-P6 主链状态

| 阶段 | 名称 | 状态 | 验证日期 |
|------|------|------|----------|
| P0 | 权力闭环 | ✅ 完成 | 2026-09-08 |
| P1 | 真实执行闭环 | ✅ 完成 | 2026-09-09 |
| P2 | 结果/证据闭环 | ✅ 完成 | 2026-09-09 |
| P3 | 任务完成闭环 | ✅ 完成 | 2026-09-10 |
| P4 | 持续自主闭环 | ✅ 完成 | 2026-09-10 |
| P5 | 泛化任务闭环 | ✅ 完成 | 2026-09-11 |
| P6 | 长期助手 | 🔄 进行中 | — |
