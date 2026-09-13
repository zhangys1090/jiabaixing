import type { Decision, ReplanRequest } from './types';
import type { ReplanExecutionResult } from './ReplanExecutor';
import type { DecisionExecutionResult } from './DecisionExecutor';
import type { EvidenceCollectionResult } from './EvidenceCollector';
import { Logger } from '../utils/Logger';

export interface AutonomousStepResult {
  success: boolean;
  goalId: string;
  replan: {
    success: boolean;
    oldPlanVersion: number;
    newPlanVersion: number;
    decision: Decision | null;
  };
  execution: {
    success: boolean;
    actionResult: unknown;
  };
  evidence: {
    success: boolean;
    progressDelta: number;
    actualEffect: string;
    verified: boolean;
    verdict: string;
  };
  reason: string;
}

export interface AutonomousStep {
  execute(replanRequest: ReplanRequest): Promise<AutonomousStepResult>;
}

class AutonomousStepImpl implements AutonomousStep {
  async execute(replanRequest: ReplanRequest): Promise<AutonomousStepResult> {
    const emptyReplan = { success: false, oldPlanVersion: replanRequest.planVersion, newPlanVersion: replanRequest.planVersion, decision: null };
    const emptyExec = { success: false, actionResult: null };
    const emptyEvidence = { success: false, progressDelta: 0, actualEffect: 'no_evidence', verified: false, verdict: 'unverified' };

    Logger.info(
      `[D7-3C] AutonomousStep starting: goal ${replanRequest.goalId} v${replanRequest.planVersion}`,
      'AutonomousStep'
    );

    const { getReplanExecutor } = require('./ReplanExecutor');
    const replanExecutor = getReplanExecutor();

    let replanResult: ReplanExecutionResult;
    try {
      replanResult = await replanExecutor.execute(replanRequest);
    } catch (err) {
      Logger.error(
        `[D7-3C] ReplanExecutor failed: ${(err as Error).message}`,
        err as Error,
        'AutonomousStep'
      );
      return {
        success: false,
        goalId: replanRequest.goalId,
        replan: emptyReplan,
        execution: emptyExec,
        evidence: emptyEvidence,
        reason: `replan_error: ${(err as Error).message}`,
      };
    }

    if (!replanResult.success || !replanResult.decision) {
      Logger.warn(
        `[D7-3C] Replan produced no decision for goal ${replanRequest.goalId}: ${replanResult.reason}`,
        'AutonomousStep'
      );
      return {
        success: false,
        goalId: replanRequest.goalId,
        replan: {
          success: false,
          oldPlanVersion: replanResult.oldPlanVersion,
          newPlanVersion: replanResult.newPlanVersion,
          decision: replanResult.decision,
        },
        execution: emptyExec,
        evidence: emptyEvidence,
        reason: `no_decision: ${replanResult.reason}`,
      };
    }

    const decision = replanResult.decision;

    Logger.info(
      `[D7-3C] Replan succeeded: goal ${replanRequest.goalId} v${replanResult.oldPlanVersion}→v${replanResult.newPlanVersion}, Decision ${decision.decisionId}`,
      'AutonomousStep'
    );

    const { getDecisionExecutor } = require('./DecisionExecutor');
    const decisionExecutor = getDecisionExecutor();

    let execResult: DecisionExecutionResult;
    try {
      execResult = await decisionExecutor.execute(decision);
    } catch (err) {
      Logger.error(
        `[D7-3C] DecisionExecutor failed: ${(err as Error).message}`,
        err as Error,
        'AutonomousStep'
      );
      return {
        success: false,
        goalId: replanRequest.goalId,
        replan: { success: true, oldPlanVersion: replanResult.oldPlanVersion, newPlanVersion: replanResult.newPlanVersion, decision },
        execution: emptyExec,
        evidence: emptyEvidence,
        reason: `execution_error: ${(err as Error).message}`,
      };
    }

    Logger.info(
      `[D7-3C] Decision executed: success=${execResult.success} reason=${execResult.reason}`,
      'AutonomousStep'
    );

    const { getEvidenceCollector } = require('./EvidenceCollector');
    const evidenceCollector = getEvidenceCollector();

    let evidenceResult: EvidenceCollectionResult;
    try {
      evidenceResult = await evidenceCollector.collect(decision, execResult);
    } catch (err) {
      Logger.error(
        `[D7-3C] EvidenceCollector failed: ${(err as Error).message}`,
        err as Error,
        'AutonomousStep'
      );
      evidenceResult = {
        success: false,
        evidenceId: 'E_error',
        goalId: replanRequest.goalId,
        decisionId: decision.decisionId,
        progressDelta: 0,
        expectedEffect: 'unknown',
        actualEffect: `evidence_error: ${(err as Error).message}`,
        verified: false,
        verificationReason: `evidence_error: ${(err as Error).message}`,
        evaluation: null,
      };
    }

    const overallSuccess = replanResult.success && execResult.success && evidenceResult.success;

    Logger.info(
      `[D7-3C] AutonomousStep complete: goal ${replanRequest.goalId} overall=${overallSuccess} progress_delta=${evidenceResult.progressDelta.toFixed(2)}`,
      'AutonomousStep'
    );

    return {
      success: overallSuccess,
      goalId: replanRequest.goalId,
      replan: {
        success: replanResult.success,
        oldPlanVersion: replanResult.oldPlanVersion,
        newPlanVersion: replanResult.newPlanVersion,
        decision,
      },
      execution: {
        success: execResult.success,
        actionResult: execResult.actionResult,
      },
      evidence: {
        success: evidenceResult.success,
        progressDelta: evidenceResult.progressDelta,
        actualEffect: evidenceResult.actualEffect,
        verified: evidenceResult.verified,
        verdict: evidenceResult.evaluation?.verdict ?? 'unverified',
      },
      reason: overallSuccess ? 'autonomous_step_completed' : 'partial_failure',
    };
  }
}

let instance: AutonomousStep | null = null;

export function getAutonomousStep(): AutonomousStep {
  if (!instance) {
    instance = new AutonomousStepImpl();
  }
  return instance;
}

export function resetAutonomousStep(): void {
  instance = null;
}
