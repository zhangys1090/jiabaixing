import { Logger } from '../utils/Logger';
import { DecisionAuthority } from './DecisionAuthority';
import { GoalAuthority, type CreateGoalInput } from './GoalAuthority';
import { StateAuthority } from './StateAuthority';
import {
  CanonicalDecisionSnapshot,
  Decision,
  DecisionCandidate,
  DecisionType,
  GoalExecutionDomain,
  GoalPriority,
  GoalStatus,
  ProposedAction,
} from './types';

function generateCandidateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `C_${ts}_${rand}`;
}

export interface GuardedExecutionResult<T = unknown> {
  success: boolean;
  output?: T;
  error?: string;
  authorityMeta: {
    goalId: string;
    snapshotId: string;
    decisionId: string;
    planVersion: number;
  };
}

export interface GuardedActionRequest {
  action: ProposedAction;
  description: string;
  executionDomain: GoalExecutionDomain;
  proposerId: string;
  confidence?: number;
  reasoning?: string;
  estimatedGoalProgress?: number;
  existingGoalId?: string;
  priority?: GoalPriority;
}

export class DecisionGuard {
  private static instance: DecisionGuard | null = null;

  private constructor() {}

  public static getInstance(): DecisionGuard {
    if (!DecisionGuard.instance) {
      DecisionGuard.instance = new DecisionGuard();
    }
    return DecisionGuard.instance;
  }

  public static resetInstance(): void {
    DecisionGuard.instance = null;
  }

  public async guardAction(
    request: GuardedActionRequest
  ): Promise<{ decision: Decision; snapshot: CanonicalDecisionSnapshot; goalId: string }> {
    const goalAuthority = GoalAuthority.getInstance();
    const stateAuthority = StateAuthority.getInstance();
    const decisionAuthority = DecisionAuthority.getInstance();

    let goalId: string | undefined = request.existingGoalId;
    let goal = goalId ? goalAuthority.getGoal(goalId) : null;

    if (!goal) {
      const createInput: CreateGoalInput = {
        description: request.description,
        originalInput: request.description,
        executionDomain: request.executionDomain,
        priority: request.priority ?? GoalPriority.NORMAL,
      };
      goal = goalAuthority.createGoal(createInput);
      goalId = goal.goalId;
      Logger.info(
        `DecisionGuard: created ephemeral goal ${goalId} for "${request.description.slice(0, 60)}"`,
        'DecisionGuard'
      );
    }

    const resolvedGoalId = goal.goalId;

    if (goal.status !== GoalStatus.ACTIVE) {
      throw new Error(
        `DecisionGuard: goal ${resolvedGoalId} is ${goal.status}, cannot guard action`
      );
    }

    const snapshot = await stateAuthority.captureSnapshot([resolvedGoalId]);

    const candidate: DecisionCandidate = {
      candidateId: generateCandidateId(),
      proposerId: request.proposerId,
      action: request.action,
      confidence: request.confidence ?? 0.9,
      reasoning: request.reasoning ?? `Guarded action: ${request.description.slice(0, 80)}`,
      estimatedGoalProgress: request.estimatedGoalProgress ?? 0.5,
    };

    const decision = await decisionAuthority.decide({
      goalId: resolvedGoalId,
      snapshot,
      candidates: [candidate],
      decisionType: DecisionType.ACTION,
    });

    Logger.info(
      `DecisionGuard: FINAL decision ${decision.decisionId} for goal ${resolvedGoalId} snapshot ${snapshot.snapshotId} — chosen=${decision.chosenCandidateId}`,
      'DecisionGuard'
    );

    return { decision, snapshot, goalId: resolvedGoalId };
  }

  public extractAuthorityMeta(
    decision: Decision,
    snapshot: CanonicalDecisionSnapshot,
    goalId: string
  ): { goalId: string; snapshotId: string; decisionId: string; planVersion: number } {
    return {
      goalId,
      snapshotId: snapshot.snapshotId,
      decisionId: decision.decisionId,
      planVersion: decision.planVersion,
    };
  }

  public reportEvidence(params: {
    goalId: string;
    decisionId: string;
    action: ProposedAction;
    expectedEffect: string;
    actualEffect: string;
    observation: unknown;
    success: boolean;
  }): void {
    const goalAuthority = GoalAuthority.getInstance();
    const progressDelta = params.success ? 0.1 : -0.05;

    try {
      goalAuthority.updateFromEvidence({
        goalId: params.goalId,
        decisionId: params.decisionId,
        observation: params.observation,
        action: params.action,
        expectedEffect: params.expectedEffect,
        actualEffect: params.actualEffect,
        progressDelta,
      });

      Logger.info(
        `DecisionGuard: evidence reported for goal ${params.goalId} decision ${params.decisionId} — success=${params.success} progressDelta=${progressDelta}`,
        'DecisionGuard'
      );
    } catch (e) {
      Logger.warn(
        `DecisionGuard: evidence report failed — ${(e as Error).message}`,
        'DecisionGuard'
      );
    }
  }
}
