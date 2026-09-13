export { GoalAuthority } from './GoalAuthority';
export type { CreateGoalInput } from './GoalAuthority';

export { GoalImpactEvaluator, getGoalImpactEvaluator, resetGoalImpactEvaluator, generateObservationId } from './GoalImpactEvaluator';
export type { GoalBinding, LegacyGoalBinding } from './GoalImpactEvaluator';

export { ReplanEvaluator, getReplanEvaluator, resetReplanEvaluator, generateRequestId } from './ReplanEvaluator';

export { ReplanProposerResolver, getReplanProposerResolver, resetReplanProposerResolver } from './ReplanProposerResolver';

export { ReplanExecutor, getReplanExecutor, resetReplanExecutor } from './ReplanExecutor';
export type { ReplanExecutionResult } from './ReplanExecutor';

export { DecisionExecutor, getDecisionExecutor, resetDecisionExecutor } from './DecisionExecutor';
export type { DecisionExecutionResult } from './DecisionExecutor';

export { EvidenceCollector, getEvidenceCollector, resetEvidenceCollector } from './EvidenceCollector';
export type { EvidenceCollectionResult } from './EvidenceCollector';

export { ObservationCollector, getObservationCollector, resetObservationCollector } from './ObservationCollector';

export { GoalEvidenceEvaluator, getGoalEvidenceEvaluator, resetGoalEvidenceEvaluator } from './GoalEvidenceEvaluator';

export {
  IndependentVerifier,
  IndependentVerification,
  FilesystemVerifier,
  TestVerifier,
  CodeVerifier,
  DesktopVerifier,
  getVerifierRegistry,
  resetVerifierRegistry,
  runIndependentVerification,
} from './IndependentVerifier';

export { AutonomousStep, getAutonomousStep, resetAutonomousStep } from './AutonomousStep';
export type { AutonomousStepResult } from './AutonomousStep';

export { AutonomousLoop, getAutonomousLoop, resetAutonomousLoop, LoopTerminationReason, DEFAULT_LOOP_SAFETY } from './AutonomousLoop';
export type { AutonomousLoopResult, LoopSafetyConfig, LoopStepRecord } from './AutonomousLoop';

export { AutonomousRuntime, getAutonomousRuntime, resetAutonomousRuntime, RuntimeState, DEFAULT_RUNTIME_CONFIG } from './AutonomousRuntime';
export type { RuntimeConfig, GoalLoopStatus } from './AutonomousRuntime';

export { StateAuthority } from './StateAuthority';
export type { StateReadProviders } from './StateAuthority';

export { DecisionAuthority } from './DecisionAuthority';
export type { DecisionHistoryEntry } from './DecisionAuthority';

export { LearningAuthority } from './LearningAuthority';
export type { BeliefUpdate, LearnedBelief, PredictionError } from './LearningAuthority';

export { MemoryAuthority } from './MemoryAuthority';
export type { MemoryAuthorityTrace, MemoryDomain, CanonicalMemoryOwner, MemoryWriteRequest, MemoryReadRequest, MemoryWriteResult, MemoryReadResult, RogueStoreReport } from './MemoryAuthority';

export { SelfModificationProposer } from './SelfModificationProposer';
export type { SelfModificationProposal } from './SelfModificationProposer';

export { EvidenceDrivenRecoveryProposer, getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } from './EvidenceDrivenRecoveryProposer';
export { GenericRecoveryProposer, getGenericRecoveryProposer, resetGenericRecoveryProposer } from './GenericRecoveryProposer';

export {
    BindingSource,
    CanonicalDecisionSnapshot,
    CapabilitySet,
    ContextView,
    Decision,
    DecisionCandidate,
    DecisionContext,
    DecisionProposer,
    DecisionType,
    Goal,
    GoalBinding as GoalBindingType,
    GoalEvidence,
    GoalExecutionDomain,
    GoalImpact,
    GoalImpactType,
    GoalPriority,
    GoalStatus,
    GoalStatusEvaluation,
    MemoryView,
    ProposedAction,
    ReplanRequest,
    SelfView,
    WorldObservation,
    WorldObservationSource,
    WorldView
} from './types';
