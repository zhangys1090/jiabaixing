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

export type BindingSource =
  | 'explicit'
  | 'workspace_context'
  | 'desktop_context'
  | 'task_context';

export type GoalExecutionDomain =
  | 'orchestrator'
  | 'desktop'
  | 'self_modification'
  | 'tool_execution';

export interface GoalBinding {
  repository?: string;
  repositoryPath?: string;
  paths?: string[];
  resources?: string[];
  source: BindingSource;
  confidence: number;
  resolvedAt: number;
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
  executionDomain: GoalExecutionDomain;
  metadata: Record<string, unknown>;
  readonly bindings?: GoalBinding;
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
  GOAL = 'goal',
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
  readonly planVersion: number;
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
  readonly verified?: boolean;
  readonly verificationReason?: string;
}

// ─── D7-4.1: Three-Layer Evidence Truth ──────────────────────
// Layer 1: ActionExecutionResult — did the action execute?
// Layer 2: EnvironmentObservationResult — what is the real world state?
// Layer 3: GoalEvidenceEvaluation — does the observation support the goal?

export type ExecutionStatus = 'executed' | 'execution_failed' | 'dispatched' | 'not_executed';

export interface ActionExecutionResult {
  readonly executionId: string;
  readonly decisionId: string;
  readonly goalId: string;
  readonly planVersion: number;
  readonly status: ExecutionStatus;
  readonly actionType: string;
  readonly rawResult: unknown;
  readonly error?: string;
  readonly timestamp: number;
}

export type VerificationStatus = 'verified' | 'unverified' | 'contradicted';

export interface EnvironmentObservationResult {
  readonly observationId: string;
  readonly executionId: string;
  readonly goalId: string;
  readonly verificationStatus: VerificationStatus;
  readonly observedState: Record<string, unknown>;
  readonly verificationMethod: string;
  readonly verificationReason: string;
  readonly timestamp: number;
}

export type GoalEvaluationVerdict = 'completed' | 'continue' | 'replan' | 'failed' | 'unverified';

export interface GoalEvidenceEvaluation {
  readonly evaluationId: string;
  readonly goalId: string;
  readonly decisionId: string;
  readonly verdict: GoalEvaluationVerdict;
  readonly verified: boolean;
  readonly verificationReason: string;
  readonly observedProgressDelta: number;
  readonly predictedProgressDelta: number;
  readonly environmentObservation: EnvironmentObservationResult | null;
  readonly timestamp: number;
}

// ─── Shared helpers ───────────────────────────────────────────

export interface GoalStatusEvaluation {
  status: GoalStatus;
  reason: string;
}

// ─── D7-1: World Observation + Goal Impact ────────────────────
// Design principle: Observation is FACT, Impact is EVALUATION, Replan is SUGGESTION.
// None of these mutate Goal or trigger Decision/Action.

export type WorldObservationSource = 'environment' | 'git' | 'file' | 'proactive' | 'scheduled';

export interface WorldObservation {
  observationId: string;
  source: WorldObservationSource;
  type: string;
  timestamp: string;
  payload: unknown;
}

export type GoalImpactType =
  | 'environment_change'
  | 'file_change'
  | 'git_change'
  | 'schedule_due'
  | 'proactive_signal'
  | 'resource_deleted'
  | 'resource_invalidated'
  | 'structural_change'
  | 'failure_detected'
  | 'recovery_needed';

export interface GoalImpact {
  goalId: string;
  observationId: string;
  affected: boolean;
  impactType: GoalImpactType;
  reason: string;
  confidence: number;
}

// ─── D7-2: ReplanRequest ──────────────────────────────────────
// Design principle: ReplanRequest is a REQUEST, not an EXECUTION.
// It does NOT mutate Goal, trigger Decision, or execute Action.
// D7-2 produces ReplanRequest; D7-3 consumes it.

export interface ReplanRequest {
  requestId: string;
  goalId: string;
  observationId: string;
  impactType: GoalImpactType;
  reason: string;
  confidence: number;
  planVersion: number;
  timestamp: number;
}
