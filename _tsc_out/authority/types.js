"use strict";
// ═══════════════════════════════════════════════════════════════
// D4-Design v2: Four Minimal Contracts
//   1. Goal          — stable identity, plan versioned
//   2. CanonicalDecisionSnapshot — read model, not state owner
//   3. Decision      — proposer/authority separation, audit trail
//   4. Evidence      — outcome bridge to Goal/Learning/State
// ═══════════════════════════════════════════════════════════════
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecisionType = exports.GoalPriority = exports.GoalStatus = void 0;
// ─── 1. Goal ───────────────────────────────────────────────────
// Design principle: Goal identity is STABLE. Plan is VERSIONED.
// Replan changes plan_version, not goalId.
var GoalStatus;
(function (GoalStatus) {
    GoalStatus["ACTIVE"] = "active";
    GoalStatus["PAUSED"] = "paused";
    GoalStatus["COMPLETED"] = "completed";
    GoalStatus["ABANDONED"] = "abandoned";
})(GoalStatus || (exports.GoalStatus = GoalStatus = {}));
var GoalPriority;
(function (GoalPriority) {
    GoalPriority[GoalPriority["LOW"] = 1] = "LOW";
    GoalPriority[GoalPriority["NORMAL"] = 5] = "NORMAL";
    GoalPriority[GoalPriority["HIGH"] = 8] = "HIGH";
    GoalPriority[GoalPriority["CRITICAL"] = 10] = "CRITICAL";
})(GoalPriority || (exports.GoalPriority = GoalPriority = {}));
// ─── 3. Decision ──────────────────────────────────────────────
// Design principle: DecisionAuthority CHOOSES what to do.
// It does NOT decide whether it's ALLOWED (that's ActionAuthority).
// Proposers generate candidates; Authority picks the FINAL one.
// Every decision carries a full audit trail.
//
// D4-I3: Decision types distinguish PLAN decisions (how to decompose)
// from ACTION decisions (what to execute). Both go through
// DecisionAuthority as the single FINAL, but they serve different
// purposes in the authority hierarchy.
var DecisionType;
(function (DecisionType) {
    DecisionType["PLAN"] = "plan";
    DecisionType["ACTION"] = "action";
})(DecisionType || (exports.DecisionType = DecisionType = {}));
