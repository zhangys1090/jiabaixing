import type { Goal, GoalEvidence, GoalImpact, ReplanRequest, WorldObservation } from './types';
import type { AutonomousStepResult } from './AutonomousStep';
import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';

export enum LoopTerminationReason {
  GOAL_COMPLETED = 'goal_completed',
  GOAL_FAILED = 'goal_failed',
  GOAL_ABANDONED = 'goal_abandoned',
  MAX_STEPS_REACHED = 'max_steps_reached',
  MAX_TIME_REACHED = 'max_time_reached',
  CONSECUTIVE_FAILURES = 'consecutive_failures',
  REPEATED_ACTION_LOOP = 'repeated_action_loop',
  REPLAN_LIMIT_REACHED = 'replan_limit_reached',
  NO_REPLAN_NEEDED = 'no_replan_needed',
  SAFETY_STOP = 'safety_stop',
}

export interface LoopSafetyConfig {
  maxSteps: number;
  maxTimeMs: number;
  maxConsecutiveFailures: number;
  maxReplans: number;
  repeatedActionThreshold: number;
  stepDelayMs: number;
}

export const DEFAULT_LOOP_SAFETY: LoopSafetyConfig = {
  maxSteps: 20,
  maxTimeMs: 5 * 60 * 1000,
  maxConsecutiveFailures: 6,
  maxReplans: 10,
  repeatedActionThreshold: 5,
  stepDelayMs: 1000,
};

export interface LoopStepRecord {
  stepIndex: number;
  timestamp: number;
  goalId: string;
  planVersion: number;
  stepSuccess: boolean;
  evidenceDelta: number;
  decisionId: string | null;
  actionType: string;
  actionHash: string;
}

export interface AutonomousLoopResult {
  goalId: string;
  terminated: boolean;
  terminationReason: LoopTerminationReason;
  totalSteps: number;
  totalReplans: number;
  totalTimeMs: number;
  finalGoalStatus: string;
  finalGoalProgress: number;
  steps: LoopStepRecord[];
  consecutiveFailures: number;
}

export interface AutonomousLoop {
  run(
    goalId: string,
    initialImpact: GoalImpact,
    observation: WorldObservation,
    safety?: Partial<LoopSafetyConfig>
  ): Promise<AutonomousLoopResult>;
}

function hashAction(actionType: string, payload: unknown): string {
  const raw = JSON.stringify({ type: actionType, payload });
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

class AutonomousLoopImpl implements AutonomousLoop {
  async run(
    goalId: string,
    initialImpact: GoalImpact,
    observation: WorldObservation,
    safety?: Partial<LoopSafetyConfig>
  ): Promise<AutonomousLoopResult> {
    const config: LoopSafetyConfig = { ...DEFAULT_LOOP_SAFETY, ...safety };
    const startTime = Date.now();

    const { GoalAuthority } = require('./GoalAuthority');
    const goalAuthority = GoalAuthority.getInstance();

    const steps: LoopStepRecord[] = [];
    let consecutiveFailures = 0;
    let totalReplans = 0;
    let recoveryTriggered = false;
    const actionHashCounts = new Map<string, number>();

    Logger.info(
      `[D7-3D] AutonomousLoop starting: goal ${goalId} maxSteps=${config.maxSteps} maxTime=${config.maxTimeMs}ms`,
      'AutonomousLoop'
    );

    let currentImpact = initialImpact;

    for (let stepIndex = 0; stepIndex < config.maxSteps; stepIndex++) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= config.maxTimeMs) {
        Logger.warn(`[D7-3D] Max time reached: ${elapsed}ms >= ${config.maxTimeMs}ms`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.MAX_TIME_REACHED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }

      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        Logger.warn(`[D7-3D] Consecutive failures: ${consecutiveFailures} >= ${config.maxConsecutiveFailures}`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.CONSECUTIVE_FAILURES, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }

      if (totalReplans >= config.maxReplans) {
        Logger.warn(`[D7-3D] Replan limit: ${totalReplans} >= ${config.maxReplans}`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.REPLAN_LIMIT_REACHED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }

      const goal = goalAuthority.getGoal(goalId);
      if (!goal) {
        Logger.error(`[D7-3D] Goal ${goalId} not found`, new Error(`Goal ${goalId} not found`), 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.SAFETY_STOP, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }

      if (goal.status === 'completed') {
        Logger.info(`[D7-3D] Goal ${goalId} COMPLETED at step ${stepIndex}`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.GOAL_COMPLETED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }
      if (goal.status === 'failed') {
        Logger.info(`[D7-3D] Goal ${goalId} FAILED at step ${stepIndex}`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.GOAL_FAILED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }
      if (goal.status === 'abandoned') {
        Logger.info(`[D7-3D] Goal ${goalId} ABANDONED at step ${stepIndex}`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.GOAL_ABANDONED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }
      if (goal.status !== 'active') {
        Logger.info(`[D7-3D] Goal ${goalId} status=${goal.status} — stopping loop`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.SAFETY_STOP, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
      }

      const { getReplanEvaluator } = require('./ReplanEvaluator');
      const replanEvaluator = getReplanEvaluator();
      const evidenceLog = goalAuthority.getEvidenceLog(goalId);
      const replanRequest = replanEvaluator.evaluate(goal, currentImpact, evidenceLog);

      if (!replanRequest) {
        Logger.info(`[D7-3D] No replan needed for goal ${goalId} at step ${stepIndex}`, 'AutonomousLoop');

        if (stepIndex === 0) {
          return this.terminate(goalId, LoopTerminationReason.NO_REPLAN_NEEDED, stepIndex, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
        }

        if (config.stepDelayMs > 0) {
          await this.delay(config.stepDelayMs);
        }
        continue;
      }

      totalReplans++;

      const { getAutonomousStep } = require('./AutonomousStep');
      const autonomousStep = getAutonomousStep();

      let stepResult: AutonomousStepResult;
      try {
        stepResult = await autonomousStep.execute(replanRequest);
      } catch (err) {
        Logger.error(`[D7-3D] Step execution error: ${(err as Error).message}`, err as Error, 'AutonomousLoop');
        consecutiveFailures++;
        steps.push({
          stepIndex,
          timestamp: Date.now(),
          goalId,
          planVersion: goal.planVersion,
          stepSuccess: false,
          evidenceDelta: 0,
          decisionId: null,
          actionType: 'error',
          actionHash: 'error',
        });
        continue;
      }

      const actionType = stepResult.replan.decision?.chosen?.action?.type || 'none';
      const actionPayload = stepResult.replan.decision?.chosen?.action?.payload;
      const actionHashKey = hashAction(actionType, actionPayload);

      const currentCount = (actionHashCounts.get(actionHashKey) || 0) + 1;
      actionHashCounts.set(actionHashKey, currentCount);

      if (currentCount >= config.repeatedActionThreshold) {
        if (!recoveryTriggered) {
          Logger.warn(
            `[D7-3D] Repeated action detected: ${actionType} count=${currentCount} >= ${config.repeatedActionThreshold} — triggering recovery`,
            'AutonomousLoop'
          );
          recoveryTriggered = true;
          actionHashCounts.clear();
          currentImpact = {
            goalId,
            observationId: `OBS_RECOVERY_${Date.now().toString(36)}`,
            affected: true,
            impactType: 'recovery_needed' as const,
            reason: 'repeated_action_loop',
            confidence: 1.0,
          };
        } else {
          Logger.warn(
            `[D7-3D] Repeated action after recovery: ${actionType} count=${currentCount} >= ${config.repeatedActionThreshold} — terminating`,
            'AutonomousLoop'
          );
          return this.terminate(goalId, LoopTerminationReason.REPEATED_ACTION_LOOP, stepIndex + 1, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
        }
      }

      if (stepResult.success) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }

      steps.push({
        stepIndex,
        timestamp: Date.now(),
        goalId,
        planVersion: stepResult.replan.newPlanVersion,
        stepSuccess: stepResult.success,
        evidenceDelta: stepResult.evidence.progressDelta,
        decisionId: stepResult.replan.decision?.decisionId || null,
        actionType,
        actionHash: actionHashKey,
      });

      Logger.info(
        `[D7-3D] Step ${stepIndex}: goal ${goalId} success=${stepResult.success} verified=${stepResult.evidence.verified} verdict=${stepResult.evidence.verdict} delta=${stepResult.evidence.progressDelta.toFixed(2)} failures=${consecutiveFailures}`,
        'AutonomousLoop'
      );

      currentImpact = {
        goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: stepResult.success ? 'environment_change' : 'failure_detected',
        reason: stepResult.success ? 'step_completed' : 'step_failed_needs_recovery',
        confidence: stepResult.success ? 0.8 : 1.0,
      };

      if (stepResult.evidence.verdict === 'completed' && stepResult.evidence.verified) {
        Logger.info(`[D7-3D] Goal ${goalId} VERIFIED COMPLETED via evidence verdict at step ${stepIndex}`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.GOAL_COMPLETED, stepIndex + 1, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
      }

      if (stepResult.evidence.verdict === 'failed' && stepResult.evidence.verified) {
        Logger.info(`[D7-3D] Goal ${goalId} VERIFIED FAILED via evidence verdict at step ${stepIndex}`, 'AutonomousLoop');
        return this.terminate(goalId, LoopTerminationReason.GOAL_FAILED, stepIndex + 1, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
      }

      if (config.stepDelayMs > 0) {
        await this.delay(config.stepDelayMs);
      }
    }

    return this.terminate(goalId, LoopTerminationReason.MAX_STEPS_REACHED, config.maxSteps, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
  }

  private terminate(
    goalId: string,
    reason: LoopTerminationReason,
    totalSteps: number,
    totalReplans: number,
    totalTimeMs: number,
    steps: LoopStepRecord[],
    consecutiveFailures: number,
    goalAuthority: any
  ): AutonomousLoopResult {
    const goal = goalAuthority.getGoal(goalId);

    Logger.info(
      `[D7-3D] Loop terminated: goal ${goalId} reason=${reason} steps=${totalSteps} replans=${totalReplans} time=${totalTimeMs}ms`,
      'AutonomousLoop'
    );

    this.recordRecoveryMetrics(reason, totalSteps, totalReplans, steps, goal);

    EventBus.emit('autonomous_loop_terminated', {
      goalId,
      terminationReason: reason,
      totalSteps,
      totalReplans,
      totalTimeMs,
      finalGoalStatus: goal?.status || 'unknown',
      finalGoalProgress: goal?.progress || 0,
    });

    return {
      goalId,
      terminated: true,
      terminationReason: reason,
      totalSteps,
      totalReplans,
      totalTimeMs,
      finalGoalStatus: goal?.status || 'unknown',
      finalGoalProgress: goal?.progress || 0,
      steps,
      consecutiveFailures,
    };
  }

  private recordRecoveryMetrics(
    reason: LoopTerminationReason,
    totalSteps: number,
    totalReplans: number,
    steps: LoopStepRecord[],
    goal: import('./types').Goal | null
  ): void {
    const hadFailure = steps.some(s => !s.stepSuccess);
    if (!hadFailure) return;

    try {
      const { getRecoveryMetrics } = require('./EvidenceDrivenRecoveryProposer');
      const metrics = getRecoveryMetrics();

      const success = reason === LoopTerminationReason.GOAL_COMPLETED;
      const autonomous = true;
      const usedTaskSpecificRule = false;
      const verifiedAtEnd = success && (goal?.status === 'completed');

      metrics.recordRecoveryAttempt({
        success,
        autonomous,
        usedTaskSpecificRule,
        steps: totalSteps,
        replans: totalReplans,
        verifiedAtEnd,
      });

      Logger.info(
        `[D8-3] RecoveryMetrics recorded: success=${success} autonomous=${autonomous} steps=${totalSteps} replans=${totalReplans} verifiedAtEnd=${verifiedAtEnd}`,
        'AutonomousLoop'
      );
    } catch (err) {
      Logger.warn(
        `[D8-3] Failed to record recovery metrics: ${(err as Error).message}`,
        'AutonomousLoop'
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

let instance: AutonomousLoop | null = null;

export function getAutonomousLoop(): AutonomousLoop {
  if (!instance) {
    instance = new AutonomousLoopImpl();
  }
  return instance;
}

export function resetAutonomousLoop(): void {
  instance = null;
}
