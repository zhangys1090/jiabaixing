"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReplanExecutor = getReplanExecutor;
exports.resetReplanExecutor = resetReplanExecutor;
const Logger_1 = require("../utils/Logger");
class ReplanExecutorImpl {
    async execute(request) {
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
                return this.fail(request, `STALE_REQUEST: expected planVersion ${request.planVersion}, current is ${goal.planVersion}`);
            }
            const oldPlanVersion = goal.planVersion;
            const replannedGoal = goalAuthority.replan(request.goalId, request.reason, request.planVersion);
            const newPlanVersion = replannedGoal.planVersion;
            Logger_1.Logger.info(`[D7-3B] Replan CAS succeeded: goal ${request.goalId} v${oldPlanVersion} → v${newPlanVersion}`, 'ReplanExecutor');
            const { StateAuthority } = require('./StateAuthority');
            const stateAuthority = StateAuthority.getInstance();
            const snapshot = await stateAuthority.captureSnapshot([request.goalId]);
            Logger_1.Logger.info(`[D7-3B] Fresh snapshot ${snapshot.snapshotId} captured for goal ${request.goalId}`, 'ReplanExecutor');
            const domain = replannedGoal.executionDomain;
            const { getReplanProposerResolver } = require('./ReplanProposerResolver');
            const resolver = getReplanProposerResolver();
            const isRecovery = request.planVersion > 0;
            const phase = isRecovery ? 'recovery' : 'initial';
            Logger_1.Logger.info(`[D7-3B] Proposer phase: ${phase} (planVersion=${request.planVersion}) for goal ${request.goalId}`, 'ReplanExecutor');
            const proposers = resolver.resolve(domain, phase);
            if (proposers.length === 0) {
                Logger_1.Logger.warn(`[D7-3B] No proposers for domain "${domain}" — cannot generate candidates for goal ${request.goalId}`, 'ReplanExecutor');
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
                }
                catch (e) {
                    Logger_1.Logger.warn(`[D7-3B] Proposer "${proposer.proposerId}" failed: ${e.message}`, 'ReplanExecutor');
                }
            }
            if (allCandidates.length === 0) {
                Logger_1.Logger.warn(`[D7-3B] No candidates from ${proposers.length} proposers for goal ${request.goalId}`, 'ReplanExecutor');
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
            Logger_1.Logger.info(`[D7-3B] FINAL Decision ${decision.decisionId} for goal ${request.goalId} (plan v${decision.planVersion}) — proposer=${decision.chosen.proposerId}`, 'ReplanExecutor');
            return {
                success: true,
                goalId: request.goalId,
                oldPlanVersion,
                newPlanVersion,
                decision,
                reason: 'replan_decision_produced',
            };
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-3B] ReplanExecutor.execute failed: ${err.message}`, err, 'ReplanExecutor');
            return {
                success: false,
                goalId: request.goalId,
                oldPlanVersion: request.planVersion,
                newPlanVersion: request.planVersion,
                decision: null,
                reason: `error: ${err.message}`,
            };
        }
    }
    fail(request, reason) {
        Logger_1.Logger.warn(`[D7-3B] ReplanRequest ${request.requestId} rejected: ${reason}`, 'ReplanExecutor');
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
let instance = null;
function getReplanExecutor() {
    if (!instance) {
        instance = new ReplanExecutorImpl();
    }
    return instance;
}
function resetReplanExecutor() {
    instance = null;
}
