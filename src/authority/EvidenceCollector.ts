import type {
  Decision,
  GoalEvidence,
  GoalEvidenceEvaluation,
  ProposedAction,
} from './types';
import type { DecisionExecutionResult } from './DecisionExecutor';
import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';

export interface EvidenceCollectionResult {
  success: boolean;
  evidenceId: string;
  goalId: string;
  decisionId: string;
  progressDelta: number;
  expectedEffect: string;
  actualEffect: string;
  verified: boolean;
  verificationReason: string;
  evaluation: GoalEvidenceEvaluation | null;
}

export interface EvidenceCollector {
  collect(
    decision: Decision,
    executionResult: DecisionExecutionResult
  ): Promise<EvidenceCollectionResult>;
}

class EvidenceCollectorImpl implements EvidenceCollector {
  async collect(
    decision: Decision,
    executionResult: DecisionExecutionResult
  ): Promise<EvidenceCollectionResult> {
    const { GoalAuthority } = require('./GoalAuthority');
    const goalAuthority = GoalAuthority.getInstance();
    const goal = goalAuthority.getGoal(decision.goalId);

    const evidenceId = `E_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const expectedEffect = this.inferExpectedEffect(decision.chosen.action);

    if (!goal) {
      Logger.warn(
        `[D7-4.1] EvidenceCollector: goal ${decision.goalId} not found — cannot evaluate`,
        'EvidenceCollector'
      );
      return {
        success: false,
        evidenceId,
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        progressDelta: 0,
        expectedEffect,
        actualEffect: 'goal_not_found',
        verified: false,
        verificationReason: 'goal not found — cannot verify goal completion',
        evaluation: null,
      };
    }

    const { getObservationCollector } = require('./ObservationCollector');
    const observationCollector = getObservationCollector();
    const observation = await observationCollector.collect(executionResult.executionResult, goal, decision);

    const { getGoalEvidenceEvaluator } = require('./GoalEvidenceEvaluator');
    const goalEvidenceEvaluator = getGoalEvidenceEvaluator();
    const evaluation = goalEvidenceEvaluator.evaluate(goal, decision, observation);

    const actualEffect = this.describeActualEffect(observation, evaluation);

    const progressDelta = evaluation.observedProgressDelta;

    const evidence: GoalEvidence = {
      evidenceId,
      goalId: decision.goalId,
      decisionId: decision.decisionId,
      observation: observation.observedState,
      action: decision.chosen.action,
      expectedEffect,
      actualEffect,
      progressDelta,
      timestamp: Date.now(),
      verified: evaluation.verified,
      verificationReason: evaluation.verificationReason,
    };

    try {
      goalAuthority.updateFromEvidence({
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        observation: observation.observedState,
        action: decision.chosen.action,
        expectedEffect,
        actualEffect,
        progressDelta,
        verified: evaluation.verified,
        verificationReason: evaluation.verificationReason,
      });
    } catch (err) {
      Logger.error(
        `[D7-4.1] EvidenceCollector: failed to update goal from evidence: ${(err as Error).message}`,
        err as Error,
        'EvidenceCollector'
      );
    }

    if (evaluation.verdict === 'completed' && evaluation.verified) {
      try {
        goalAuthority.updateGoalStatus(decision.goalId, 'completed');
        Logger.info(
          `[D7-4.1] Goal ${decision.goalId} COMPLETED — verified by evidence`,
          'EvidenceCollector'
        );
      } catch (err) {
        Logger.error(
          `[D7-4.1] Failed to mark goal completed: ${(err as Error).message}`,
          err as Error,
          'EvidenceCollector'
        );
      }
    } else if (evaluation.verdict === 'failed' && evaluation.verified) {
      try {
        goalAuthority.updateGoalStatus(decision.goalId, 'failed');
        Logger.info(
          `[D7-4.1] Goal ${decision.goalId} FAILED — verified by evidence`,
          'EvidenceCollector'
        );
      } catch (err) {
        Logger.error(
          `[D7-4.1] Failed to mark goal failed: ${(err as Error).message}`,
          err as Error,
          'EvidenceCollector'
        );
      }
    }

    EventBus.emit('evidence_collected', {
      goalId: decision.goalId,
      decisionId: decision.decisionId,
      evidenceId,
      verified: evaluation.verified,
      verdict: evaluation.verdict,
      progressDelta,
    });

    Logger.info(
      `[D7-4.1] Evidence collected: goal ${decision.goalId} verdict=${evaluation.verdict} verified=${evaluation.verified} delta=${progressDelta.toFixed(3)}`,
      'EvidenceCollector'
    );

    return {
      success: evaluation.verified,
      evidenceId,
      goalId: decision.goalId,
      decisionId: decision.decisionId,
      progressDelta,
      expectedEffect,
      actualEffect,
      verified: evaluation.verified,
      verificationReason: evaluation.verificationReason,
      evaluation,
    };
  }

  private inferExpectedEffect(action: ProposedAction): string {
    switch (action.type) {
      case 'desktop_action':
        return 'desktop_state_changed';
      case 'tool_call':
        return 'tool_executed';
      case 'message':
        return 'message_dispatched';
      case 'composite':
        return 'all_sub_actions_succeeded';
      default:
        return 'action_completed';
    }
  }

  private describeActualEffect(
    observation: import('./types').EnvironmentObservationResult,
    evaluation: GoalEvidenceEvaluation
  ): string {
    const prefix = observation.verificationStatus === 'verified'
      ? 'verified'
      : observation.verificationStatus === 'contradicted'
        ? 'contradicted'
        : 'unverified';

    return `${prefix}:${evaluation.verdict}`;
  }
}

let instance: EvidenceCollector | null = null;

export function getEvidenceCollector(): EvidenceCollector {
  if (!instance) {
    instance = new EvidenceCollectorImpl();
  }
  return instance;
}

export function resetEvidenceCollector(): void {
  instance = null;
}
