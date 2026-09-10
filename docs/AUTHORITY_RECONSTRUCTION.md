# Jiabaixing Authority Reconstruction

> **FROZEN: 2026-09-10**
> This document is the single source of truth for the Authority Reconstruction.
> No phase boundary, acceptance criterion, or architectural decision herein may be
> changed without explicit user approval.

---

## 0. Ultimate Goal

Jiabaixing is not "a stronger agent." It is:

> A continuously existing, goal-directed, stateful, remembering, acting,
> verifying, learning, self-continuing general-purpose assistant.

The canonical production loop:

```
                JIABAIXING
                    |
             +------+------+
             | Canonical   |
             | State       |
             +------+------+
                    |
             +------+------+
             | Active Goal |
             +------+------+
                    |
             +------+------+
             | Decision    |
             | Authority   |
             +------+------+
                    |
                FINAL
                    |
             +------+------+
             | Action      |
             | Authority   |
             +------+------+
                    |
                  World
                    |
                    v
               Observation
                    |
                    v
                 Evidence
               +----+----+
               |    |    |
               v    v    v
             Goal State Learning
```

Every production step must answer:

```
goalId      = G123
snapshotId  = S456
decisionId  = D789
action      = open_browser
evidenceId  = E012
goalProgress: 0.2 -> 0.35
```

The entire chain must be replayable: `G123 -> S456 -> D789 -> Action -> E012`

---

## 1. Seven Layers

| Layer | Name | Standard | Status |
|-------|------|----------|--------|
| 0 | Action Authority | Any OS mutation -> ActionAuthority | SEALED |
| 1 | Decision Authority | Any production action has goalId, snapshotId, decisionId; DecisionAuthority is the sole FINAL selector | SEALED |
| 2 | State Authority | Domain Owners -> StateAuthority -> CanonicalDecisionSnapshot; only collects/freezes/identifies/serves | SEALED |
| 3 | Goal Authority | Goal G123 -> ACTIVE -> Decision -> Action -> Evidence -> progress -> same G123; Goal != Plan (planVersion) | SEALED |
| 4 | Evidence | Action -> Expected effect -> Actual effect -> Prediction error -> Evidence -> Goal/State/Learning | SEALED |
| 5 | Learning Authority | Evidence -> PredictionError -> BeliefUpdate -> Future Decision changes | PASS |
| 6 | Memory Authority | experience -> memory write -> retrieval -> state -> decision; canonical owner for TS/Python/Redis | TODO |
| 7 | Long-Horizon Agency | Active Goal + World Change -> Autonomous Replanning -> Autonomous Action | TODO |

---

## 2. Phase P0 -- Action Authority

### Acceptance Criteria

- [x] Any OS mutation goes through ActionAuthority
- [x] No direct child_process.exec / robotjs / nutjs bypass
- [x] Anti-bypass grep confirms zero direct execution paths

### Status: SEALED

---

## 3. Phase D -- Goal/State/Decision Integration

### D4 Design v2 -- FROZEN

Key architectural decisions:

1. **Proposer/Authority separation**: matchSkill(), parseLLMAction(), decomposeGoal() are Proposers that generate DecisionCandidates. DecisionAuthority is the sole FINAL selector.
2. **DecisionType**: PLAN (Orchestrator decomposition) vs ACTION (direct execution). Never mix in one decide() call.
3. **Cross-process delegation**: Python -> TS passes only decisionId + goalId + snapshotId (identity, not payload). TS does not re-decide.
4. **Evidence -> Goal progress**: updateFromEvidence() writes back to the same Goal. Progress is prediction-based (stub) until D5 Learning upgrades it.

### D4-I1: Python Integration

| Gate | Criterion | Status |
|------|-----------|--------|
| I1 | Python DecisionAuthority produces goalId, snapshotId, decisionId per action | PASS |
| R1 | No fallback on authority failure -- throws, never silently bypasses | PASS |
| R2 | Cross-process FINAL: Python Decision -> TS receives authorityMeta -> TS does not re-decide | PASS |
| R3 | Authority IDs (decisionId, goalId, snapshotId) present in execution trace | PASS |

### D4-I2: Desktop Integration

| Gate | Criterion | Status |
|------|-----------|--------|
| I2-1 | matchSkill() -> SkillProposer -> DecisionCandidate (cannot directly execute) | PASS |
| I2-2 | parseLLMAction() -> DesktopLLMProposer -> DecisionCandidate (cannot directly execute) | PASS |
| I2-3 | DesktopExecutionAgent standalone (no authorityMeta) -> Goal -> Snapshot -> DecisionAuthority -> ActionAuthority | PASS |
| I2-4 | Anti-bypass grep: no direct executeWithSkill/executeWithLLMPlanning/executeBasic calls | PASS |
| Post-Audit | 8/8 checks pass | PASS |

### D4-I3: Orchestrator Integration

| Gate | Criterion | Status |
|------|-----------|--------|
| I3-1 | decomposeGoal() -> OrchestratorProposer -> DecisionCandidate (cannot directly dispatch) | PASS |
| I3-2 | Plan Decision via DecisionAuthority with DecisionType.PLAN | PASS |
| I3-3 | DecisionType.PLAN vs ACTION distinction -- never mixed | PASS |
| I3-4 | Anti-bypass grep: no direct dispatch without DecisionAuthority | PASS |

### D4-I4: Global Authority Replay

| Gate | Criterion | Status |
|------|-----------|--------|
| Scenario 1 | TS standalone path: Goal -> Snapshot -> Decision -> Action -> Evidence -> Goal progress | PASS |
| Scenario 2 | Orchestrator path: Goal -> Plan Decision -> Action Decisions -> Evidence chain | PASS |
| Scenario 3 | Python delegated path: Python Decision -> TS executes -> Evidence (no extra TS decision) | PASS |
| Replay 1 | Every production step has goalId + snapshotId + decisionId | PASS |
| Replay 2 | Decision history replayable per goal | PASS |
| Replay 3 | No orphan decisions / no orphan evidence | PASS |

### D4 Status: SEALED

---

## 4. Phase E -- Learning, Memory, Agency

### D5: Learning Authority

**Core question**: Evidence produces PredictionError. What counts as "learned"?
**Answer**: Future Decision must change. Writing cache that is never read does not count.

| Gate | Criterion | Status |
|------|-----------|--------|
| G1 | Evidence -> PredictionError: every GoalEvidence produces computable PredictionError (errorMagnitude in [0,1], errorType in {match, over_prediction, under_prediction, unknown}) | PASS |
| G2 | BeliefUpdate: learn() produces BeliefUpdate with full audit trail (sourceEvidenceId, sourceGoalId, sourceDecisionId, confidenceAdjustment, progressAdjustment, reason). Exact match -> null (nothing to learn). | PASS |
| G3 | Decision Influence: BeliefUpdate changes future Decision scoring. adjustCandidate() applies confidenceBias and progressBias from LearnedBelief. End-to-end: repeated failure -> Learning lowers confidence -> DecisionAuthority selects alternative candidate. | PASS |
| G4 | Audit Trail: every BeliefUpdate traceable to source Evidence. PredictionError history retrievable. LearnedBelief contains sampleCount and lastUpdated. | PASS |

**Integration points**:
- DecisionAuthority.decide(): candidates adjusted via learningAuthority.adjustCandidate() before scoring
- GoalAuthority.updateFromEvidence(): automatically calls learningAuthority.learn() (failure does not block Evidence write)

**Belief accumulation**: Exponential moving average with decay floor at 0.3. Continuous failure drives bias persistently negative; one anomaly cannot fully flip belief.

**Confidence adjustment magnitudes**:

| errorType | confidenceAdjustment |
|-----------|---------------------|
| match | +0.01 |
| under_prediction | +0.15 |
| over_prediction | -0.3 * errorMagnitude |
| unknown | -0.05 |

### D5 Status: PASS

### D6: Memory Authority -- TODO

**Core question**: TS MemoryEngine, Python MemoryEngine, EpisodicMemory, Redis -- who is the canonical owner?

**Acceptance criteria (to be finalized)**:
- [ ] Single canonical memory write path
- [ ] Retrieval serves Decision via StateAuthority
- [ ] Cross-process memory consistency (TS reads what Python wrote and vice versa)
- [ ] No silent memory divergence

### D7: Long-Horizon Agency -- TODO

**Core question**: Active Goal + World Change -> Autonomous Replanning -> Autonomous Action

**Acceptance criteria (to be finalized)**:
- [ ] Goal remains ACTIVE when user leaves
- [ ] World change detection triggers Decision
- [ ] Autonomous action follows same Authority chain (Goal -> State -> Decision -> Action -> Evidence)
- [ ] No action without Goal

---

## 5. Three Production Paths

All three paths go through the sole FINAL DecisionAuthority:

| Path | Entry | Decision | Execution |
|------|-------|----------|-----------|
| Python delegated | desktop_automate(authorityMeta) | Python DecisionAuthority | TS only executes, no re-decision |
| TS standalone | DesktopExecutionAgent.executeTask() | TS DecisionAuthority (ACTION) | SkillProposer + DesktopLLMProposer -> FINAL -> ActionAuthority |
| Orchestrator | OrchestratorAgent.processGoal() | DecisionAuthority (PLAN -> ACTION) | OrchestratorProposer -> Plan Decision -> Action Decisions |

---

## 6. Residual Risks

| # | Risk | Level | Owner | Mitigation |
|---|------|-------|-------|------------|
| 1 | Delegation metadata authenticity: existence verified, consistency not verified (decisionId<->goalId<->action binding) | L2 | D6 | TS->Python cross-query to verify Decision record |
| 2 | Goal progress is prediction-based, not actual result | stub | D5->D7 | Evidence->Learning upgrades to actual progress |
| 3 | Goal != Plan versioning: planVersion field exists, replan logic incomplete | basic | D6 | Implement Plan v1->v2->v3 within same Goal |
| 4 | Learning belief accumulation is local to process -- not shared cross-process | L1 | D6 | Memory Authority should persist LearnedBeliefs |

---

## 7. Test Evidence

| Suite | Tests | Status |
|-------|-------|--------|
| TS Authority unit tests (7 suites) | 92 | ALL GREEN |
| Python D4 Authority Trace (1 suite) | 27 | ALL GREEN |
| **Total** | **119** | ALL GREEN |

---

## 8. File Manifest

### Authority Core

| File | Role |
|------|------|
| src/authority/types.ts | Core type definitions: Goal, Decision, DecisionCandidate, GoalEvidence, DecisionType, CanonicalDecisionSnapshot |
| src/authority/GoalAuthority.ts | Goal lifecycle, evidence-based progress, status transitions |
| src/authority/StateAuthority.ts | Canonical Decision Snapshot provider (collect, freeze, identify, serve) |
| src/authority/DecisionAuthority.ts | Sole FINAL decision selector; integrates LearningAuthority.adjustCandidate() |
| src/authority/LearningAuthority.ts | Evidence->PredictionError->BeliefUpdate->adjustCandidate |
| src/authority/index.ts | Public API exports |

### Proposers

| File | Role |
|------|------|
| src/authority/SkillProposer.ts | matchSkill() -> DecisionCandidate |
| src/authority/DesktopLLMProposer.ts | parseLLMAction() -> DecisionCandidate |
| src/authority/OrchestratorProposer.ts | decomposeGoal() -> DecisionCandidate |

### Integration

| File | Role |
|------|------|
| src/desktop/DesktopExecutionAgent.ts | TS desktop execution: delegated path (no re-decision) + standalone path (via DecisionAuthority) |
| src/harness/orchestration/OrchestratorAgent.ts | Complex goal decomposition via OrchestratorProposer -> Plan Decision |
| python/agent/tools/desktop_tools.py | _call_ts_desktop with authority_meta parameter |

### Tests

| File | Coverage |
|------|----------|
| tests/unit/authority/DecisionAuthority.test.ts | DecisionAuthority core logic |
| tests/unit/authority/GoalAuthority.test.ts | GoalAuthority core logic |
| tests/unit/authority/StateAuthority.test.ts | StateAuthority core logic |
| tests/unit/authority/D4I2DesktopIntegration.test.ts | D4-I2 4 hard gates |
| tests/unit/authority/D4I3OrchestratorIntegration.test.ts | D4-I3 4 hard gates |
| tests/unit/authority/D4I4GlobalReplay.test.ts | D4-I4 3 scenarios + 5 replay contracts |
| tests/unit/authority/D5LearningAuthority.test.ts | D5 4 hard gates + end-to-end |
| python/tests/test_d4_authority_trace.py | Python-side D4 authority trace |

---

## 9. Development Standards

### 9.1 No Direct Execution

Any function that could directly cause an OS mutation must go through ActionAuthority.

**Banned patterns** (anti-bypass grep targets):
```
matchSkill(          -> must be SkillProposer.propose()
parseLLMAction(      -> must be DesktopLLMProposer.propose()
executeWithSkill(    -> @deprecated, must not be called
executeWithLLMPlanning( -> @deprecated, must not be called
executeBasic(        -> @deprecated, must not be called
authority.executeAction( -> only after DecisionAuthority.decide()
executor.executeAction( -> only after DecisionAuthority.decide()
mcpServer.callTool(  -> only after DecisionAuthority.decide()
```

### 9.2 Every Production Step Has Authority IDs

```typescript
// REQUIRED: every action must have these
goalId: string;      // from GoalAuthority
snapshotId: string;  // from StateAuthority
decisionId: string;  // from DecisionAuthority
```

### 9.3 Proposers Are Pure

Proposers generate DecisionCandidates. They never execute.

```typescript
interface DecisionProposer {
  proposerId: string;
  propose(context: DecisionContext): Promise<DecisionCandidate[]>;
}
// NO executeAction, NO dispatch, NO callTool in any Proposer
```

### 9.4 DecisionAuthority Is Sole FINAL

Only DecisionAuthority.decide() selects the chosen candidate.
No other code path may select and execute a candidate.

### 9.5 Evidence Writes Back to Same Goal

```typescript
goalAuthority.updateFromEvidence({
  goalId: goal.goalId,        // SAME goal
  decisionId: decision.decisionId,
});
```

### 9.6 Learning Failure Does Not Block

```typescript
try {
  learningAuthority.learn(evidence, proposerId);
} catch {
  // Learning failure must not block Evidence write
}
```

### 9.7 Cross-Process Delegation Is Identity-Only

```typescript
// PASS (identity reference)
authorityMeta: {
  authority_decisionId: 'D123',
  authority_goalId: 'G456',
  authority_snapshotId: 'SS789',
}

// DO NOT PASS (full decision payload -- creates second authority layer)
authorityMeta: {
  chosen: decision.chosen,
  reason: decision.selectionReason,
  rejectedCandidates: decision.rejectedCandidates,
}
```

### 9.8 Delegation Anti-Forgery

TS must verify the delegation triple exists before trusting:

```typescript
const hasValidDelegation =
  authorityMeta?.authority_decisionId &&
  authorityMeta?.authority_goalId &&
  authorityMeta?.authority_snapshotId;
// All three must exist; missing any -> reject delegation
```

---

## 10. Phase Boundaries (FROZEN)

```
PHASE P0 ----------------------------------- SEALED
  A Action Authority

PHASE D ----------------------------------- SEALED
  D1 Decision Audit
  D2 State Audit
  D3 Goal Audit
  D4 Design v2
  D4-I1 Python integration
  D4-I1-R1 No fallback
  D4-I1-R2 Cross-process FINAL
  D4-I1-R3 IDs in trace
  D4-I2 Desktop integration
  D4-I2 Post-Audit
  D4-I3 Orchestrator integration
  D4-I4 Global Authority Replay

PHASE E ----------------------------------- IN PROGRESS
  D5 Learning Authority             PASS
  D6 Memory Authority              TODO
  D7 Long-Horizon Agency           TODO
```

**Phase E progression rule**: Do not start D(n+1) until D(n) passes all its hard gates.

---

## 11. Three Grand Stages to JARVIS

```
Stage 1: Unified Goal + State + Decision     <- DONE (D4)
Stage 2: Evidence -> Learning -> Future Decision <- DONE (D5)
Stage 3: Active Goal + World Change -> Autonomous Replanning -> Autonomous Action <- TODO (D7)
```

Direction is correct. No route change needed.
