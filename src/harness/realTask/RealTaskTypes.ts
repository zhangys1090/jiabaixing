import type {
  Goal,
  GoalEvidence,
  ActionExecutionResult,
  EnvironmentObservationResult,
  GoalEvidenceEvaluation,
  GoalExecutionDomain,
} from '../../authority/types';
import type { DecisionExecutionResult } from '../../authority/DecisionExecutor';
import type { EvidenceCollectionResult } from '../../authority/EvidenceCollector';

export type RealTaskDomain =
  | 'filesystem'
  | 'browser'
  | 'code'
  | 'test'
  | 'api'
  | 'desktop'
  | 'multi_step'
  | 'replan';

export interface RealTaskSuccessCriteria {
  description: string;
  check: (env: TaskEnvironment) => Promise<{ satisfied: boolean; evidence: string }>;
}

export interface TaskEnvironment {
  workingDir: string;
  tempDir: string;
  platform: string;
  env: Record<string, string>;
}

export interface DisturbanceSpec {
  description: string;
  phase: 'after_first_step' | 'after_step_n';
  stepIndex?: number;
  execute: (env: TaskEnvironment) => Promise<void>;
  verify: (env: TaskEnvironment) => Promise<{ disturbed: boolean; evidence: string }>;
}

export interface RealTask {
  readonly taskId: string;
  readonly description: string;
  readonly domain: RealTaskDomain;
  readonly goalDescription: string;
  readonly executionDomain: GoalExecutionDomain;
  readonly successCriteria: RealTaskSuccessCriteria;
  readonly allowedCapabilities: string[];
  readonly maxSteps: number;
  readonly maxTimeMs: number;
  readonly disturbance?: DisturbanceSpec;
  readonly setup?: (env: TaskEnvironment) => Promise<void>;
  readonly teardown?: (env: TaskEnvironment) => Promise<void>;
}

export interface RealTaskEvidenceChain {
  goal: Goal | null;
  decisionId: string | null;
  executionResult: ActionExecutionResult | null;
  observation: EnvironmentObservationResult | null;
  evidence: GoalEvidence | null;
  evaluation: GoalEvidenceEvaluation | null;
  finalStatus: string;
}

export interface RealTaskResult {
  taskId: string;
  domain: RealTaskDomain;
  declaredCompleted: boolean;
  externallyVerified: boolean;
  verificationEvidence: string;
  evidenceChain: RealTaskEvidenceChain;
  steps: RealTaskStepRecord[];
  totalTimeMs: number;
  error: string | null;
}

export interface RealTaskStepRecord {
  stepIndex: number;
  timestamp: number;
  actionType: string;
  executionStatus: string;
  observationStatus: string;
  verdict: string;
  verified: boolean;
  progressDelta: number;
}

export interface RealTaskReport {
  runId: string;
  timestamp: number;
  tasks: RealTaskResult[];
  metrics: RealTaskMetrics;
}

export interface RealTaskMetrics {
  totalTasks: number;
  declaredCompleted: number;
  externallyVerified: number;
  falseCompletions: number;
  verifiedCompletionRate: number;
  trueCompletionRate: number;
  falseCompletionRate: number;
  byDomain: Record<RealTaskDomain, {
    total: number;
    verified: number;
    falseCompletions: number;
  }>;
}
