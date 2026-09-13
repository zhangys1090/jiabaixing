# D9 Audit — 跨任务泛化审计

> 审计规则：只追加，不修改历史。Evidence 必须来自环境，不可造假。

## 审计条目

### 2026-09-12: D9 跨任务泛化测试创建

**变更内容**：
- 创建 `src/harness/realTask/HTasks.ts`：H1-H6 新任务定义
- 创建 `src/authority/__tests__/D9-CrossTaskGeneralization.test.ts`：D9 测试

**H 系列任务与 G/N 系列的错误类型零重叠**：

| H 任务 | 错误类型 | G/N 中是否存在 |
|--------|----------|---------------|
| H1_regex_escape | 正则未转义 `.` | ❌ 不存在 |
| H2_deep_property_access | 深层空指针 `cfg.database.host` | ❌ 不存在 |
| H3_array_mutation | `sort()` 原地突变 | ❌ 不存在 |
| H4_float_comparison | `0.1+0.2 !== 0.3` | ❌ 不存在 |
| H5_scope_leak | 隐式全局变量 | ❌ 不存在 |
| H6_promise_unhandled | 未捕获 Promise 拒绝 | ❌ 不存在（G8 是 missing await） |

**D9 测试结构**：
- Phase 1: 训练集（G1-G12 + N1-N8 = 20 任务）→ 积累 belief
- Phase 2: 测试集 + Learning（H1-H6）→ 验证恢复率
- Phase 3: 测试集 - Learning（H1-H6）→ 基线恢复率
- Phase 4: 审计 — 零重叠检查、false recovery 检查

**核心断言**：
```
withLearning.recoveryRate > withoutLearning.recoveryRate
```

**审计状态**：✅ Phase 4 审计通过

### 2026-09-12: D9 Phase 4 审计结果

**运行命令**：`npx jest --testPathPattern="D9-CrossTaskGeneralization" --testNamePattern="D9 audit"`

**结果**：
```
[D9 AUDIT] Training set size: 20
[D9 AUDIT] Test set size: 6
[D9 AUDIT] Overlap: 0 (none)
[D9 AUDIT] H error types: 6
[D9 AUDIT] G/N error types: 20
[D9 AUDIT] Error type overlap: 0 (none)
[D9 AUDIT] False recovery count: 0
```

**4 项审计全部通过**：
- ✅ H-series tasks are novel (no overlap with G/N)
- ✅ H-series error types are distinct from G/N
- ✅ each H task has independent successCriteria
- ✅ no false recovery — verified implies goalStatus=completed

**Phase 1-3（真实任务执行）**：🔄 待运行（需较长运行时间）

### 2026-09-13: D4-I2 Post-Integration Audit

**运行命令**：`npx jest --testPathPattern="D4-I2-PostIntegrationAudit" --verbose`

**结果**：17/17 tests PASSED

**8 项检查结果**：

| # | 检查项 | 结果 |
|---|--------|------|
| 1 | SkillProposer 纯 proposer | ✅ |
| 2 | DesktopLLMProposer 纯 proposer | ✅ |
| 3 | DecisionAuthority 唯一 FINAL | ✅ |
| 4 | authorityMeta 不可伪造 | ✅ |
| 5 | Decision → action 一一对应 | ✅ |
| 6 | Evidence 关联 goalId/decisionId | ✅ |
| 7 | 旧方法已死 | ✅ |
| 8 | 旁路 caller 有审计标注 | ✅ |

**修复**：SelfModificationEngine.ts 添加了 `[AUDIT]` 标注
