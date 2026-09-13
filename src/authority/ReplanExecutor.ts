import type {
  Decision,
  Goal,
  GoalExecutionDomain,
  ReplanRequest,
} from './types';
import { Logger } from '../utils/Logger';

export interface ReplanExecutionResult {
  success: boolean;
  goalId: string;
  oldPlanVersion: number;
  newPlanVersion: number;
  decision: Decision | null;
  reason: string;
}

export interface ReplanExecutor {
  execute(request: ReplanRequest): Promise<ReplanExecutionResult>;
}

class ReplanExecutorImpl implements ReplanExecutor {
  async execute(request: ReplanRequest): Promise<ReplanExecutionResult> {
    try {
      const { GoalAuthority } = require('./GoalAuthority');
      const goalAuthority = GoalAuthority.getInstance();
      const goal = goalAuthority.getGoal(request.goalId);

      if (!goal) {
        return this.fail(request, `goal ${request.goalId} not found`);
      }

      if (goal.status !== 'active') {
        return this.fail(request, `goal ${request.goalId} is ${goal.status}, not active`);
      }

      if (goal.planVersion !== request.planVersion) {
        return this.fail(
          request,
          `STALE_REQUEST: expected planVersion ${request.planVersion}, current is ${goal.planVersion}`
        );
      }

      const oldPlanVersion = goal.planVersion;

      const replannedGoal = goalAuthority.replan(
        request.goalId,
        request.reason,
        request.planVersion
      );

      const newPlanVersion = replannedGoal.planVersion;

      Logger.info(
        `[D7-3B] Replan CAS succeeded: goal ${request.goalId} v${oldPlanVersion} → v${newPlanVersion}`,
        'ReplanExecutor'
      );

      const { StateAuthority } = require('./StateAuthority');
      const stateAuthority = StateAuthority.getInstance();
      const snapshot = await stateAuthority.captureSnapshot([request.goalId]);

      Logger.info(
        `[D7-3B] Fresh snapshot ${snapshot.snapshotId} captured for goal ${request.goalId}`,
        'ReplanExecutor'
      );

      const domain: GoalExecutionDomain = replannedGoal.executionDomain;

      const { getReplanProposerResolver } = require('./ReplanProposerResolver');
      const resolver = getReplanProposerResolver();
      const isRecovery = request.planVersion > 0;
      const phase: 'initial' | 'recovery' | undefined = isRecovery ? 'recovery' : 'initial';
      Logger.info(
        `[D7-3B] Proposer phase: ${phase} (planVersion=${request.planVersion}) for goal ${request.goalId}`,
        'ReplanExecutor'
      );
      const proposers = resolver.resolve(domain, phase);

      if (proposers.length === 0) {
        Logger.warn(
          `[D7-3B] No proposers for domain "${domain}" — cannot generate candidates for goal ${request.goalId}`,
          'ReplanExecutor'
        );
        return {
          success: false,
          goalId: request.goalId,
          oldPlanVersion,
          newPlanVersion,
          decision: null,
          reason: `no_proposers_for_domain_${domain}`,
        };
      }

      const { DecisionAuthority } = require('./DecisionAuthority');
      const decisionAuthority = DecisionAuthority.getInstance();

      const context = {
        goalId: request.goalId,
        snapshot,
        candidates: [],
      };

      const allCandidates = [];
      for (const proposer of proposers) {
        try {
          const proposed = await proposer.propose(context);
          allCandidates.push(...proposed);
        } catch (e) {
          Logger.warn(
            `[D7-3B] Proposer "${proposer.proposerId}" failed: ${(e as Error).message}`,
            'ReplanExecutor'
          );
        }
      }

      if (allCandidates.length === 0) {
        Logger.warn(
          `[D7-3B] No candidates from ${proposers.length} proposers for goal ${request.goalId}`,
          'ReplanExecutor'
        );
        return {
          success: false,
          goalId: request.goalId,
          oldPlanVersion,
          newPlanVersion,
          decision: null,
          reason: 'no_candidates_generated',
        };
      }

      const decision = await decisionAuthority.decide({
        goalId: request.goalId,
        snapshot,
        candidates: allCandidates,
      });

      Logger.info(
        `[D7-3B] FINAL Decision ${decision.decisionId} for goal ${request.goalId} (plan v${decision.planVersion}) — proposer=${decision.chosen.proposerId}`,
        'ReplanExecutor'
      );

      return {
        success: true,
        goalId: request.goalId,
        oldPlanVersion,
        newPlanVersion,
        decision,
        reason: 'replan_decision_produced',
      };
    } catch (err) {
      Logger.error(
        `[D7-3B] ReplanExecutor.execute failed: ${(err as Error).message}`,
        err as Error,
        'ReplanExecutor'
      );
      return {
        success: false,
        goalId: request.goalId,
        oldPlanVersion: request.planVersion,
        newPlanVersion: request.planVersion,
        decision: null,
        reason: `error: ${(err as Error).message}`,
      };
    }
  }

  private fail(request: ReplanRequest, reason: string): ReplanExecutionResult {
    Logger.warn(
      `[D7-3B] ReplanRequest ${request.requestId} rejected: ${reason}`,
      'ReplanExecutor'
    );
    return {
      success: false,
      goalId: request.goalId,
      oldPlanVersion: request.planVersion,
      newPlanVersion: request.planVersion,
      decision: null,
      reason,
    };
  }
}

let instance: ReplanExecutorImpl | null = null;

export function getReplanExecutor(): ReplanExecutor {
  if (!instance) {
    instance = new ReplanExecutorImpl();
  }
  return instance;
}

export function resetReplanExecutor(): void {
  instance = null;
}
