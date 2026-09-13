import type {
  Decision,
  Goal,
  GoalEvidenceEvaluation,
  GoalEvaluationVerdict,
  EnvironmentObservationResult,
  VerificationStatus,
} from './types';
import { Logger } from '../utils/Logger';

export interface GoalEvidenceEvaluator {
  evaluate(
    goal: Goal,
    decision: Decision,
    observation: EnvironmentObservationResult
  ): GoalEvidenceEvaluation;
}

class GoalEvidenceEvaluatorImpl implements GoalEvidenceEvaluator {
  evaluate(
    goal: Goal,
    decision: Decision,
    observation: EnvironmentObservationResult
  ): GoalEvidenceEvaluation {
    const evaluationId = `EVAL_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = Date.now();

    const predictedProgressDelta = decision.chosen.estimatedGoalProgress * 0.5;

    if (observation.verificationStatus === 'contradicted') {
      Logger.info(
        `[D7-4.1] GoalEvaluation: goal ${goal.goalId} CONTRADICTED — observation contradicts expected state`,
        'GoalEvidenceEvaluator'
      );
      return {
        evaluationId,
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        verdict: 'replan',
        verified: false,
        verificationReason: `environment contradicted: ${observation.verificationReason}`,
        observedProgressDelta: -0.1,
        predictedProgressDelta,
        environmentObservation: observation,
        timestamp,
      };
    }

    if (observation.verificationStatus === 'unverified') {
      Logger.info(
        `[D7-4.1] GoalEvaluation: goal ${goal.goalId} UNVERIFIED — cannot confirm goal from observation`,
        'GoalEvidenceEvaluator'
      );
      return {
        evaluationId,
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        verdict: 'unverified',
        verified: false,
        verificationReason: `unverified observation: ${observation.verificationReason}`,
        observedProgressDelta: 0,
        predictedProgressDelta,
        environmentObservation: observation,
        timestamp,
      };
    }

    const successCriteriaMet = this.checkSuccessCriteria(goal, observation);

    if (successCriteriaMet) {
      Logger.info(
        `[D7-4.1] GoalEvaluation: goal ${goal.goalId} COMPLETED — verified observation satisfies success criteria`,
        'GoalEvidenceEvaluator'
      );
      return {
        evaluationId,
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        verdict: 'completed',
        verified: true,
        verificationReason: 'verified observation satisfies goal success criteria',
        observedProgressDelta: 1 - goal.progress,
        predictedProgressDelta,
        environmentObservation: observation,
        timestamp,
      };
    }

    const partialProgress = this.assessPartialProgress(goal, observation);
    if (partialProgress > 0) {
      Logger.info(
        `[D7-4.1] GoalEvaluation: goal ${goal.goalId} CONTINUE — verified partial progress ${partialProgress.toFixed(3)}`,
        'GoalEvidenceEvaluator'
      );
      return {
        evaluationId,
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        verdict: 'continue',
        verified: true,
        verificationReason: 'verified observation shows partial progress toward goal',
        observedProgressDelta: partialProgress,
        predictedProgressDelta,
        environmentObservation: observation,
        timestamp,
      };
    }

    Logger.info(
      `[D7-4.1] GoalEvaluation: goal ${goal.goalId} REPLAN — verified but no progress detected`,
      'GoalEvidenceEvaluator'
    );
    return {
      evaluationId,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      verdict: 'replan',
      verified: true,
      verificationReason: 'verified observation shows no progress toward goal — need different approach',
      observedProgressDelta: 0,
      predictedProgressDelta,
      environmentObservation: observation,
      timestamp,
    };
  }

  private checkSuccessCriteria(goal: Goal, observation: EnvironmentObservationResult): boolean {
    const state = observation.observedState;

    if (goal.successCondition) {
      return this.evaluateSuccessCondition(goal.successCondition, state);
    }

    if ('independentVerification' in state && state.independentVerification === true) {
      return true;
    }

    if ('verificationSource' in state && state.verificationSource === 'independent_verifier' && observation.verificationStatus === 'verified') {
      return true;
    }

    if ('verificationSource' in state && state.verificationSource === 'tool_output_pass' && observation.verificationStatus === 'verified') {
      return true;
    }

    return false;
  }

  private evaluateSuccessCondition(
    condition: string,
    state: Record<string, unknown>
  ): boolean {
    try {
      const keys = Object.keys(state);
      const values = Object.values(state);
      const fn = new Function(...keys, `return !!(${condition})`);
      return fn(...values) as boolean;
    } catch {
      Logger.warn(
        `[D7-4.1] Success condition evaluation failed: ${condition}`,
        'GoalEvidenceEvaluator'
      );
      return false;
    }
  }

  private assessPartialProgress(goal: Goal, observation: EnvironmentObservationResult): number {
    const state = observation.observedState;

    if ('progressDelta' in state && typeof state.progressDelta === 'number') {
      return Math.max(0, Math.min(1, state.progressDelta));
    }

    if ('verificationSource' in state && state.verificationSource === 'independent_verifier' && 'partialProgress' in state && typeof state.partialProgress === 'number') {
      return Math.max(0, Math.min(1, state.partialProgress as number));
    }

    if ('verificationSource' in state && state.verificationSource === 'tool_output_pass' && observation.verificationStatus === 'verified') {
      return 0.5;
    }

    if ('desktopObservation' in state) {
      const desktopObs = state.desktopObservation as Record<string, unknown> | undefined;
      if (desktopObs && 'progressDelta' in desktopObs && typeof desktopObs.progressDelta === 'number') {
        return Math.max(0, Math.min(1, desktopObs.progressDelta));
      }
    }

    return 0;
  }
}

let instance: GoalEvidenceEvaluator | null = null;

export function getGoalEvidenceEvaluator(): GoalEvidenceEvaluator {
  if (!instance) {
    instance = new GoalEvidenceEvaluatorImpl();
  }
  return instance;
}

export function resetGoalEvidenceEvaluator(): void {
  instance = null;
}
