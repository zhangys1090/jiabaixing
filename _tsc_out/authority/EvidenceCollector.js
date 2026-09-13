"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEvidenceCollector = getEvidenceCollector;
exports.resetEvidenceCollector = resetEvidenceCollector;
const Logger_1 = require("../utils/Logger");
const EventBus_1 = require("../shared/EventBus");
class EvidenceCollectorImpl {
    async collect(decision, executionResult) {
        const { GoalAuthority } = require('./GoalAuthority');
        const goalAuthority = GoalAuthority.getInstance();
        const goal = goalAuthority.getGoal(decision.goalId);
        const evidenceId = `E_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const expectedEffect = this.inferExpectedEffect(decision.chosen.action);
        if (!goal) {
            Logger_1.Logger.warn(`[D7-4.1] EvidenceCollector: goal ${decision.goalId} not found — cannot evaluate`, 'EvidenceCollector');
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
        const evidence = {
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
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-4.1] EvidenceCollector: failed to update goal from evidence: ${err.message}`, err, 'EvidenceCollector');
        }
        if (evaluation.verdict === 'completed' && evaluation.verified) {
            try {
                goalAuthority.updateGoalStatus(decision.goalId, 'completed');
                Logger_1.Logger.info(`[D7-4.1] Goal ${decision.goalId} COMPLETED — verified by evidence`, 'EvidenceCollector');
            }
            catch (err) {
                Logger_1.Logger.error(`[D7-4.1] Failed to mark goal completed: ${err.message}`, err, 'EvidenceCollector');
            }
        }
        else if (evaluation.verdict === 'failed' && evaluation.verified) {
            try {
                goalAuthority.updateGoalStatus(decision.goalId, 'failed');
                Logger_1.Logger.info(`[D7-4.1] Goal ${decision.goalId} FAILED — verified by evidence`, 'EvidenceCollector');
            }
            catch (err) {
                Logger_1.Logger.error(`[D7-4.1] Failed to mark goal failed: ${err.message}`, err, 'EvidenceCollector');
            }
        }
        EventBus_1.EventBus.emit('evidence_collected', {
            goalId: decision.goalId,
            decisionId: decision.decisionId,
            evidenceId,
            verified: evaluation.verified,
            verdict: evaluation.verdict,
            progressDelta,
        });
        Logger_1.Logger.info(`[D7-4.1] Evidence collected: goal ${decision.goalId} verdict=${evaluation.verdict} verified=${evaluation.verified} delta=${progressDelta.toFixed(3)}`, 'EvidenceCollector');
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
    inferExpectedEffect(action) {
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
    describeActualEffect(observation, evaluation) {
        const prefix = observation.verificationStatus === 'verified'
            ? 'verified'
            : observation.verificationStatus === 'contradicted'
                ? 'contradicted'
                : 'unverified';
        return `${prefix}:${evaluation.verdict}`;
    }
}
let instance = null;
function getEvidenceCollector() {
    if (!instance) {
        instance = new EvidenceCollectorImpl();
    }
    return instance;
}
function resetEvidenceCollector() {
    instance = null;
}
