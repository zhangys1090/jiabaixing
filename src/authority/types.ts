// ═══════════════════════════════════════════════════════════════
// D4-Design v2: Four Minimal Contracts
//   1. Goal          — stable identity, plan versioned
//   2. CanonicalDecisionSnapshot — read model, not state owner
//   3. Decision      — proposer/authority separation, audit trail
//   4. Evidence      — outcome bridge to Goal/Learning/State
// ═══════════════════════════════════════════════════════════════

// ─── 1. Goal ───────────────────────────────────────────────────
// Design principle: Goal identity is STABLE. Plan is VERSIONED.
// Replan changes plan_version, not goalId.

export enum GoalStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
}

export enum GoalPriority {
  LOW = 1,
  NORMAL = 5,
  HIGH = 8,
  CRITICAL = 10,
}

export interface Goal {
  readonly goalId: string;
  readonly description: string;
  readonly originalInput: string;
  status: GoalStatus;
  priority: GoalPriority;
  progress: number;
  readonly parentGoalId: string | null;
  readonly createdAt: number;
  updatedAt: number;
  successCondition: string;
  abandonmentCondition: string;
  currentStage: string;
  planVersion: number;
  metadata: Record<string, unknown>;
}

// ─── 2. CanonicalDecisionSnapshot ─────────────────────────────
// Design principle: StateAuthority is a READ MODEL provider.
// It does NOT own the underlying state. Domain owners remain:
//   MemoryEngine → memory owner
//   SessionStore → conversation owner
//   DesktopVisionEngine → world observation owner
//   DesktopSafetyGuard → safety owner
//   GoalAuthority → goal owner
//
// A snapshot serves MULTIPLE active goals simultaneously.
// State = world truth; Goal = problem to solve; Decision = choice.

export interface SelfView {
  agentId: string;
  activeGoalIds: string[];
  currentStage: string;
  safetyStatus: 'nominal' | 'degraded' | 'emergency';
}

export interface WorldView {
  observation: unknown;
  platform: 'desktop' | 'server' | 'cli';
  timestamp: number;
}

export interface MemoryView {
  relevantMemories: unknown[];
  query: string;
  timestamp: number;
}

export interface ContextView {
  systemPrompt: string;
  conversationHistory: unknown[];
  fileContexts: unknown[];
  personaSummary: string;
  timestamp: number;
}

export interface CapabilitySet {
  availableTools: string[];
  availableSkills: string[];
  desktopAvailable: boolean;
  bridgeAvailable: boolean;
}

export interface CanonicalDecisionSnapshot {
  readonly snapshotId: string;
  readonly timestamp: number;
  readonly activeGoalIds: readonly string[];
  readonly self: SelfView;
  readonly world: WorldView;
  readonly memory: MemoryView;
  readonly context: ContextView;
  readonly capabilities: CapabilitySet;
}

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

export enum DecisionType {
  PLAN = 'plan',
  ACTION = 'action',
}

export interface ProposedAction {
  type: 'desktop_action' | 'tool_call' | 'message' | 'composite';
  payload: unknown;
}

export interface DecisionCandidate {
  readonly candidateId: string;
  readonly proposerId: string;
  readonly action: ProposedAction;
  readonly confidence: number;
  readonly reasoning: string;
  readonly estimatedGoalProgress: number;
}

export interface DecisionContext {
  goalId: string;
  snapshot: CanonicalDecisionSnapshot;
  candidates: DecisionCandidate[];
  decisionType?: DecisionType;
}

export interface Decision {
  readonly decisionId: string;
  readonly decisionType: DecisionType;
  readonly goalId: string;
  readonly snapshotId: string;
  readonly candidateIds: readonly string[];
  readonly chosenCandidateId: string;
  readonly chosen: DecisionCandidate;
  readonly acceptedCandidates: readonly DecisionCandidate[];
  readonly rejectedCandidates: readonly DecisionCandidate[];
  readonly selectionReason: string;
  readonly proposerSet: readonly string[];
  readonly vetoReason: string | null;
  readonly timestamp: number;
}

export interface DecisionProposer {
  readonly proposerId: string;
  propose(context: DecisionContext): Promise<DecisionCandidate[]>;
}

// ─── 4. Evidence ──────────────────────────────────────────────
// Design principle: Evidence bridges Outcome → Goal/Learning/State.
// It answers "why did progress change?" and feeds future decisions.

export interface GoalEvidence {
  readonly evidenceId: string;
  readonly goalId: string;
  readonly decisionId: string;
  readonly observation: unknown;
  readonly action: ProposedAction;
  readonly expectedEffect: string;
  readonly actualEffect: string;
  readonly progressDelta: number;
  readonly timestamp: number;
}

// ─── Shared helpers ───────────────────────────────────────────

export interface GoalStatusEvaluation {
  status: GoalStatus;
  reason: string;
}
