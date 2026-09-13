"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LOOP_SAFETY = exports.LoopTerminationReason = void 0;
exports.getAutonomousLoop = getAutonomousLoop;
exports.resetAutonomousLoop = resetAutonomousLoop;
const Logger_1 = require("../utils/Logger");
const EventBus_1 = require("../shared/EventBus");
var LoopTerminationReason;
(function (LoopTerminationReason) {
    LoopTerminationReason["GOAL_COMPLETED"] = "goal_completed";
    LoopTerminationReason["GOAL_FAILED"] = "goal_failed";
    LoopTerminationReason["GOAL_ABANDONED"] = "goal_abandoned";
    LoopTerminationReason["MAX_STEPS_REACHED"] = "max_steps_reached";
    LoopTerminationReason["MAX_TIME_REACHED"] = "max_time_reached";
    LoopTerminationReason["CONSECUTIVE_FAILURES"] = "consecutive_failures";
    LoopTerminationReason["REPEATED_ACTION_LOOP"] = "repeated_action_loop";
    LoopTerminationReason["REPLAN_LIMIT_REACHED"] = "replan_limit_reached";
    LoopTerminationReason["NO_REPLAN_NEEDED"] = "no_replan_needed";
    LoopTerminationReason["SAFETY_STOP"] = "safety_stop";
})(LoopTerminationReason || (exports.LoopTerminationReason = LoopTerminationReason = {}));
exports.DEFAULT_LOOP_SAFETY = {
    maxSteps: 20,
    maxTimeMs: 5 * 60 * 1000,
    maxConsecutiveFailures: 6,
    maxReplans: 10,
    repeatedActionThreshold: 5,
    stepDelayMs: 1000,
};
function hashAction(actionType, payload) {
    const raw = JSON.stringify({ type: actionType, payload });
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
        h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    }
    return h.toString(36);
}
class AutonomousLoopImpl {
    async run(goalId, initialImpact, observation, safety) {
        const config = { ...exports.DEFAULT_LOOP_SAFETY, ...safety };
        const startTime = Date.now();
        const { GoalAuthority } = require('./GoalAuthority');
        const goalAuthority = GoalAuthority.getInstance();
        const steps = [];
        let consecutiveFailures = 0;
        let totalReplans = 0;
        const actionHashCounts = new Map();
        Logger_1.Logger.info(`[D7-3D] AutonomousLoop starting: goal ${goalId} maxSteps=${config.maxSteps} maxTime=${config.maxTimeMs}ms`, 'AutonomousLoop');
        let currentImpact = initialImpact;
        for (let stepIndex = 0; stepIndex < config.maxSteps; stepIndex++) {
            const elapsed = Date.now() - startTime;
            if (elapsed >= config.maxTimeMs) {
                Logger_1.Logger.warn(`[D7-3D] Max time reached: ${elapsed}ms >= ${config.maxTimeMs}ms`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.MAX_TIME_REACHED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            if (consecutiveFailures >= config.maxConsecutiveFailures) {
                Logger_1.Logger.warn(`[D7-3D] Consecutive failures: ${consecutiveFailures} >= ${config.maxConsecutiveFailures}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.CONSECUTIVE_FAILURES, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            if (totalReplans >= config.maxReplans) {
                Logger_1.Logger.warn(`[D7-3D] Replan limit: ${totalReplans} >= ${config.maxReplans}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.REPLAN_LIMIT_REACHED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            const goal = goalAuthority.getGoal(goalId);
            if (!goal) {
                Logger_1.Logger.error(`[D7-3D] Goal ${goalId} not found`, new Error(`Goal ${goalId} not found`), 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.SAFETY_STOP, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            if (goal.status === 'completed') {
                Logger_1.Logger.info(`[D7-3D] Goal ${goalId} COMPLETED at step ${stepIndex}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.GOAL_COMPLETED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            if (goal.status === 'failed') {
                Logger_1.Logger.info(`[D7-3D] Goal ${goalId} FAILED at step ${stepIndex}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.GOAL_FAILED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            if (goal.status === 'abandoned') {
                Logger_1.Logger.info(`[D7-3D] Goal ${goalId} ABANDONED at step ${stepIndex}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.GOAL_ABANDONED, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            if (goal.status !== 'active') {
                Logger_1.Logger.info(`[D7-3D] Goal ${goalId} status=${goal.status} — stopping loop`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.SAFETY_STOP, stepIndex, totalReplans, elapsed, steps, consecutiveFailures, goalAuthority);
            }
            const { getReplanEvaluator } = require('./ReplanEvaluator');
            const replanEvaluator = getReplanEvaluator();
            const evidenceLog = goalAuthority.getEvidenceLog(goalId);
            const replanRequest = replanEvaluator.evaluate(goal, currentImpact, evidenceLog);
            if (!replanRequest) {
                Logger_1.Logger.info(`[D7-3D] No replan needed for goal ${goalId} at step ${stepIndex}`, 'AutonomousLoop');
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
            let stepResult;
            try {
                stepResult = await autonomousStep.execute(replanRequest);
            }
            catch (err) {
                Logger_1.Logger.error(`[D7-3D] Step execution error: ${err.message}`, err, 'AutonomousLoop');
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
                Logger_1.Logger.warn(`[D7-3D] Repeated action detected: ${actionType} count=${currentCount} >= ${config.repeatedActionThreshold}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.REPEATED_ACTION_LOOP, stepIndex + 1, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
            }
            if (stepResult.success) {
                consecutiveFailures = 0;
            }
            else {
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
            Logger_1.Logger.info(`[D7-3D] Step ${stepIndex}: goal ${goalId} success=${stepResult.success} verified=${stepResult.evidence.verified} verdict=${stepResult.evidence.verdict} delta=${stepResult.evidence.progressDelta.toFixed(2)} failures=${consecutiveFailures}`, 'AutonomousLoop');
            currentImpact = {
                goalId,
                observationId: `OBS_${Date.now().toString(36)}`,
                affected: true,
                impactType: stepResult.success ? 'environment_change' : 'failure_detected',
                reason: stepResult.success ? 'step_completed' : 'step_failed_needs_recovery',
                confidence: stepResult.success ? 0.8 : 1.0,
            };
            if (stepResult.evidence.verdict === 'completed' && stepResult.evidence.verified) {
                Logger_1.Logger.info(`[D7-3D] Goal ${goalId} VERIFIED COMPLETED via evidence verdict at step ${stepIndex}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.GOAL_COMPLETED, stepIndex + 1, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
            }
            if (stepResult.evidence.verdict === 'failed' && stepResult.evidence.verified) {
                Logger_1.Logger.info(`[D7-3D] Goal ${goalId} VERIFIED FAILED via evidence verdict at step ${stepIndex}`, 'AutonomousLoop');
                return this.terminate(goalId, LoopTerminationReason.GOAL_FAILED, stepIndex + 1, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
            }
            if (config.stepDelayMs > 0) {
                await this.delay(config.stepDelayMs);
            }
        }
        return this.terminate(goalId, LoopTerminationReason.MAX_STEPS_REACHED, config.maxSteps, totalReplans, Date.now() - startTime, steps, consecutiveFailures, goalAuthority);
    }
    terminate(goalId, reason, totalSteps, totalReplans, totalTimeMs, steps, consecutiveFailures, goalAuthority) {
        const goal = goalAuthority.getGoal(goalId);
        Logger_1.Logger.info(`[D7-3D] Loop terminated: goal ${goalId} reason=${reason} steps=${totalSteps} replans=${totalReplans} time=${totalTimeMs}ms`, 'AutonomousLoop');
        this.recordRecoveryMetrics(reason, totalSteps, totalReplans, steps, goal);
        EventBus_1.EventBus.emit('autonomous_loop_terminated', {
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
    recordRecoveryMetrics(reason, totalSteps, totalReplans, steps, goal) {
        const hadFailure = steps.some(s => !s.stepSuccess);
        if (!hadFailure)
            return;
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
            Logger_1.Logger.info(`[D8-3] RecoveryMetrics recorded: success=${success} autonomous=${autonomous} steps=${totalSteps} replans=${totalReplans} verifiedAtEnd=${verifiedAtEnd}`, 'AutonomousLoop');
        }
        catch (err) {
            Logger_1.Logger.warn(`[D8-3] Failed to record recovery metrics: ${err.message}`, 'AutonomousLoop');
        }
    }
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
let instance = null;
function getAutonomousLoop() {
    if (!instance) {
        instance = new AutonomousLoopImpl();
    }
    return instance;
}
function resetAutonomousLoop() {
    instance = null;
}
