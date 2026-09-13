# E2: Authority Closure Audit — Verification Gate Report

**日期**: 2026-09-10
**审计范围**: E2-V1 Learning, E2-V2 Memory, E2-V3 Self-Modification
**状态**: IMPLEMENTED + VERIFIED (29/29 tests PASS)

---

## 0. 审计判断

```text
E2-1 Learning Closure         ✅ VERIFIED (6/6 tests PASS)
E2-2 Memory Canonicality      ✅ VERIFIED (9/9 tests PASS)
E2-3 Self-Modification        ✅ VERIFIED (14/14 tests PASS)
```

**区分 Implemented / Verified / Production Proven：**

| 层级 | 含义 | E2-1 | E2-2 | E2-3 |
|------|------|------|------|------|
| Implemented | 代码已修改，方向正确 | ✅ | ✅ | ✅ |
| Verified | 测试通过，运行时行为符合声明 | ✅ | ✅ | ✅ |
| Production Proven | 生产环境实际运行验证 | ⚠️ 需bridge运行时验证 | ⚠️ 需bridge运行时验证 | ⚠️ 需端到端验证 |

---

## 1. 审计总表

| 审计项 | 危险等级 | 修复前 | 修复后 | 验证结果 | 修复文件 |
|--------|---------|--------|--------|---------|---------|
| E2-1: Learning closure | HIGH | Evidence→Learning→Decision TS路径成立 | ✅ 闭合 | ✅ 6/6 PASS | GoalAuthority.ts, DecisionAuthority.ts, LearningAuthority.ts |
| E2-1: Learning failure observable | HIGH | catch静默吞没 | ✅ metadata记录+Logger.error | ✅ PASS | GoalAuthority.ts |
| E2-2: Memory write fail-closed | CRITICAL | Python不可用时静默降级ts_local | ✅ fail-closed | ✅ PASS | MemoryAuthority.ts |
| E2-2: Memory read fail-closed | CRITICAL | Python不可用时静默降级ts_local/ts_bridge | ✅ fail-closed | ✅ PASS | MemoryAuthority.ts |
| E2-2: Rogue store zero-caller | HIGH | @deprecated但仍有import | ✅ IMemoryEngine类型内联,0 caller | ✅ grep验证 | IMemoryEngine.ts |
| E2-3: SelfMod authorityMeta gate | CRITICAL | 无检查，可绕过DecisionAuthority | ✅ authorityMeta+HMAC gate | ✅ PASS | SelfModificationEngine.ts |
| E2-3: SelfMod one-shot lifecycle | CRITICAL | set后永不失效(stale authorization) | ✅ consumeAuthority+isAuthorityAvailable | ✅ PASS | SelfModificationEngine.ts |
| E2-3: SelfMod 换货防护 | CRITICAL | 合法decisionId+不同action可执行 | ✅ actionHash(task)绑定 | ✅ PASS | AuthoritySignature.ts |
| E2-3: Orchestrator自动触发阻断 | CRITICAL | 3处自动触发triggerTrueEvolution | ✅ 全部BLOCKED | ✅ 源码审查 | EvolutionOrchestrator.ts, initEvolution.ts |
| E2-3: EvolutionEngineV2 authority gate | CRITICAL | 直接调用modifier.executePlan无检查 | ✅ isAuthorityAvailable检查 | ✅ 源码审查 | EvolutionEngineV2.ts |
| E2-3: SelfModificationProposer | HIGH | 无DecisionProposer实现 | ✅ 新增 | ✅ 源码审查 | SelfModificationProposer.ts |

---

## 2. E2-V1: Learning Authority Closure (6/6 PASS)

### 2.1 测试结果

```
V1-1: Evidence → BeliefUpdate → belief changes → future Decision changes
  ✅ learning from evidence produces a BeliefUpdate
  ✅ over-prediction reduces future confidence via adjustCandidate

V1-2: Learning failure is observable
  ✅ GoalAuthority.updateFromEvidence records learning status in goal metadata
  ✅ when learning succeeds, status is "applied" with beliefId

V1-3: Prediction error computation
  ✅ over-prediction (expected success, actual failure) has high error magnitude
  ✅ match has zero error magnitude
```

### 2.2 Learning Observability 修复

**修复前**：Learning异常被catch静默吞没，Evidence写入成功但无法知道Learning是否生效。

**修复后**：GoalAuthority.updateFromEvidence在goal.metadata中记录learning状态：

```typescript
goal.metadata[`learning_${evidenceId}`] = {
  status: 'applied' | 'no_update_needed' | 'failed',
  beliefId?: string,
  confidenceAdj?: number,
  progressAdj?: number,
  error?: string,  // only when status='failed'
};
```

审计时可通过 `goal.metadata` 查询任意 Evidence 是否真正改变了 belief。

### 2.3 边界记录

- **TS路径**: Evidence → Learning → Decision ✅ 完整闭合
- **Python路径**: Python DecisionAuthority 消费 TS LearningAuthority 的 Belief（通过bridge）✅ 间接消费
- **Python-native decision learning**: 尚未统一 ⚠️ 记入总账
- **Goal Progress不是事实真值**: ⚠️ 记入总账

---

## 3. E2-V2: Memory Canonicality Closure (9/9 PASS)

### 3.1 测试结果

```
M1: bridge registered → write → Python owner
  ✅ write with bridge registered goes to Python

M2: bridge registered → read → Python owner
  ✅ read with bridge registered goes to Python

M3: bridge NOT registered → write/read → failed_closed
  ✅ write without bridge returns failed_closed for Python domain
  ✅ read without bridge returns failed_closed for Python domain
  ✅ write without bridge returns failed_closed for all Python domains
  ✅ read without bridge returns failed_closed for all Python domains

M4: persistent_hermes (ts_bridge) does NOT fail-closed when bridge absent
  ✅ write for ts_bridge domain does not fail-closed

operation log tracks failed_closed operations
  ✅ failed_closed writes appear in operation log
  ✅ operation stats include failed_closed count
```

### 3.2 Rogue Store Zero-Caller 验证

| Rogue Store | grep结果 | Production Callers |
|-------------|---------|-------------------|
| EpisodicMemoryStore | `new EpisodicMemoryStore` = 0 matches | **0** ✅ |
| PersistentMemoryService | `PersistentMemoryService.getInstance` = 0 matches | **0** ✅ |
| MemoryRetriever | `import.*MemoryRetriever` = 0 matches | **0** ✅ |

IMemoryEngine.ts已将EpisodicMemory/PersistentMemoryService的类型内联，消除编译依赖。

### 3.3 Runtime Gate 总结

| Gate | 条件 | 结果 | 验证 |
|------|------|------|------|
| M1 | bridge registered + write | → Python owner | ✅ test |
| M2 | bridge registered + read | → Python owner | ✅ test |
| M3 | bridge NOT registered + write/read | → failed_closed | ✅ test |
| M4 | rogue store production callers | → 0 | ✅ grep |

---

## 4. E2-V3: Self-Modification Authority Closure (14/14 PASS)

### 4.1 测试结果

```
V3-1: no authorityMeta → BLOCK
  ✅ executePlan without authorityMeta returns success=false with E2-3 error
  ✅ isAuthorityAvailable returns false when no meta set

V3-2: bad HMAC → BLOCK
  ✅ executePlan with invalid HMAC returns success=false

V3-3: correct HMAC + correct action hash → ALLOW (authority consumed)
  ✅ executePlan with valid authorityMeta succeeds and consumes authority

V3-4: correct decisionId + modified action → BLOCK (换货)
  ✅ authorityMeta signed for task A cannot execute task B

V3-5: stale authorization (one-shot) → BLOCK
  ✅ second executePlan without fresh setAuthorityMeta is BLOCKED
  ✅ fresh setAuthorityMeta resets one-shot

V3-6: clearAuthorityMeta invalidates
  ✅ clearAuthorityMeta makes isAuthorityAvailable false

AuthoritySignature correctness:
  ✅ actionHash is deterministic
  ✅ actionHash differs for different tasks
  ✅ verifyAuthorityMeta returns true for valid meta
  ✅ verifyAuthorityMeta returns false for wrong task (换货)
  ✅ verifyAuthorityMeta returns false for missing fields
  ✅ verifyAuthorityMeta returns false for tampered signature
```

### 4.2 One-Shot Lifecycle 修复

**修复前**：`setAuthorityMeta(meta)` 后，authorityMeta永远有效，可被多次executePlan使用（stale authorization）。

**修复后**：
```typescript
private authorityConsumed: boolean = false;

setAuthorityMeta(meta) → authorityConsumed = false
executePlan() → 成功后 consumeAuthority() → authorityConsumed = true
再次 executePlan() → authorityConsumed=true → BLOCK ("stale authorization")
```

### 4.3 Self-Modification Trigger Census

**全局grep结果** — 所有self-modification触发入口：

| 入口 | 文件 | 状态 | Authority路径 |
|------|------|------|--------------|
| `EvolutionOrchestrator.triggerTrueEvolution()` | EvolutionOrchestrator.ts | ✅ BLOCKED | 日志记录，不执行 |
| `EvolutionOrchestrator.runAutoDetection()` | EvolutionOrchestrator.ts | ✅ BLOCKED | 仅记录信号 |
| `EvolutionOrchestrator.recordInteraction()` 低质量 | EvolutionOrchestrator.ts | ✅ BLOCKED | 仅记录信号 |
| `initEvolution.ts` 定时器 | initEvolution.ts | ✅ BLOCKED | 仅记录信号 |
| `EvolutionEngineV2.triggerEvolution()` | EvolutionEngineV2.ts | ✅ GATED | 需isAuthorityAvailable |
| `EvolutionEngineV2.executePlan()` | EvolutionEngineV2.ts | ✅ GATED | 需isAuthorityAvailable |
| `SelfModificationEngine.executePlan()` | SelfModificationEngine.ts | ✅ GATED | authorityMeta+HMAC+one-shot |
| `SelfModificationEngine.executeAction()` | SelfModificationEngine.ts | ✅ GATED | checkAuthorityGate |
| `evolutionRoutes.ts /api/evolution/trigger` | evolutionRoutes.ts | ✅ Python侧 | bridge.triggerEvolution()→Python |
| `evolutionRoutes.ts /api/orchestrator/optimize` | evolutionRoutes.ts | ✅ 优化 | triggerOptimizationCycle (非自修改) |
| `PythonAgentBridge.triggerEvolution()` | PythonAgentBridge.ts | ✅ Python侧 | HTTP POST→Python |

**结论**：所有TS侧self-modification触发入口均已GATED或BLOCKED。Python侧由Python DecisionAuthority负责。

### 4.4 正确执行路径

```
1. SelfModificationProposer.submitProposal(proposal)
2. DecisionAuthority.decideWithProposers(goalId, snapshot)
   → SelfModificationProposer.propose() 生成候选
   → LearningAuthority.adjustCandidate() 调整置信度
   → 选择最优候选 → Decision
3. AuthoritySignature.signAuthorityMeta(goalId, snapshotId, decisionId, actionHash)
4. SelfModificationEngine.setAuthorityMeta(meta)  [authorityConsumed = false]
5. EvolutionEngineV2.executePlan(plan)  [检查isAuthorityAvailable]
   → SelfModificationEngine.executePlan(plan, checkpointId)
     → checkAuthorityGate() 验证authorityMeta + HMAC + !consumed
     → executeAction() 逐个执行
     → consumeAuthority()  [authorityConsumed = true]
6. GoalAuthority.updateFromEvidence() 记录结果
   → LearningAuthority.learn() 更新belief  [status: 'applied' | 'failed']
```

---

## 5. 修改文件清单

| 文件 | 修改类型 | 关键变更 |
|------|---------|---------|
| `src/authority/MemoryAuthority.ts` | 修改 | read/write fail-closed; source类型扩展failed_closed |
| `src/authority/GoalAuthority.ts` | 修改 | Learning failure observable: metadata记录+Logger.error |
| `src/evolution/v2/SelfModificationEngine.ts` | 修改 | authorityMeta gate + HMAC验证 + one-shot lifecycle |
| `src/evolution/v2/EvolutionEngineV2.ts` | 修改 | isAuthorityAvailable检查 |
| `src/evolution/EvolutionOrchestrator.ts` | 修改 | 阻断自动触发; triggerTrueEvolution BLOCKED; dead code移除 |
| `src/server/init/initEvolution.ts` | 修改 | 阻断local模式定时器自动触发 |
| `src/authority/SelfModificationProposer.ts` | 新增 | DecisionProposer实现 |
| `src/core/IMemoryEngine.ts` | 修改 | 类型内联，消除rogue store编译依赖 |
| `src/authority/index.ts` | 修改 | 导出SelfModificationProposer |

### 测试文件

| 文件 | 测试数 | 状态 |
|------|--------|------|
| `src/authority/__tests__/E2-LearningAuthority.test.ts` | 6 | ✅ PASS |
| `src/authority/__tests__/E2-MemoryAuthority.test.ts` | 9 | ✅ PASS |
| `src/evolution/v2/__tests__/E2-SelfModificationAuthority.test.ts` | 14 | ✅ PASS |

---

## 6. 已知边界（记入总账，非阻塞）

1. **Python-native decision learning尚未统一**: Python DecisionAuthority没有独立LearningAuthority
2. **Goal Progress不是事实真值**: progressDelta由proposer估计
3. **persistent_hermes域ts_bridge路径**: write时也fail-closed（当前实现统一处理）
4. **Production Proven尚需端到端验证**: 测试验证了单元行为，生产环境需确认bridge注册后Python路径正常工作
5. **SelfModificationProposer的risk→confidence映射**: 当前riskLevel直接映射confidence，未来应拆分为独立维度（P1，不阻塞）

---

## 7. 推进状态

```text
A-P0                 ✅
D4                   ✅
D5                   ✅ 核心闭环
D6                   ⚠️ → E2-V2 已封口

E2-1 Learning        ✅ VERIFIED
E2-2 Memory          ✅ VERIFIED
E2-3 SelfModification ✅ VERIFIED

D7                   ❌ 暂停 — 需E2 Production Proven后才能进入
```

## 8. 下一步

E2 Verified通过。进入D7-1前，需要：

1. **Production smoke test**: 启动系统，确认bridge注册后MemoryAuthority走Python路径
2. **端到端Authority replay**: Goal→State→Decision→Action→Evidence完整闭环一次

通过后进入 **D7-1: Active Goal + Scheduler**（仅做"知道自己该继续做什么"，不做自动执行）。
