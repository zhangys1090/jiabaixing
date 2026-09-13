"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAutonomousStep = getAutonomousStep;
exports.resetAutonomousStep = resetAutonomousStep;
const Logger_1 = require("../utils/Logger");
class AutonomousStepImpl {
    async execute(replanRequest) {
        const emptyReplan = { success: false, oldPlanVersion: replanRequest.planVersion, newPlanVersion: replanRequest.planVersion, decision: null };
        const emptyExec = { success: false, actionResult: null };
        const emptyEvidence = { success: false, progressDelta: 0, actualEffect: 'no_evidence', verified: false, verdict: 'unverified' };
        Logger_1.Logger.info(`[D7-3C] AutonomousStep starting: goal ${replanRequest.goalId} v${replanRequest.planVersion}`, 'AutonomousStep');
        const { getReplanExecutor } = require('./ReplanExecutor');
        const replanExecutor = getReplanExecutor();
        let replanResult;
        try {
            replanResult = await replanExecutor.execute(replanRequest);
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-3C] ReplanExecutor failed: ${err.message}`, err, 'AutonomousStep');
            return {
                success: false,
                goalId: replanRequest.goalId,
                replan: emptyReplan,
                execution: emptyExec,
                evidence: emptyEvidence,
                reason: `replan_error: ${err.message}`,
            };
        }
        if (!replanResult.success || !replanResult.decision) {
            Logger_1.Logger.warn(`[D7-3C] Replan produced no decision for goal ${replanRequest.goalId}: ${replanResult.reason}`, 'AutonomousStep');
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
        Logger_1.Logger.info(`[D7-3C] Replan succeeded: goal ${replanRequest.goalId} v${replanResult.oldPlanVersion}→v${replanResult.newPlanVersion}, Decision ${decision.decisionId}`, 'AutonomousStep');
        const { getDecisionExecutor } = require('./DecisionExecutor');
        const decisionExecutor = getDecisionExecutor();
        let execResult;
        try {
            execResult = await decisionExecutor.execute(decision);
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-3C] DecisionExecutor failed: ${err.message}`, err, 'AutonomousStep');
            return {
                success: false,
                goalId: replanRequest.goalId,
                replan: { success: true, oldPlanVersion: replanResult.oldPlanVersion, newPlanVersion: replanResult.newPlanVersion, decision },
                execution: emptyExec,
                evidence: emptyEvidence,
                reason: `execution_error: ${err.message}`,
            };
        }
        Logger_1.Logger.info(`[D7-3C] Decision executed: success=${execResult.success} reason=${execResult.reason}`, 'AutonomousStep');
        const { getEvidenceCollector } = require('./EvidenceCollector');
        const evidenceCollector = getEvidenceCollector();
        let evidenceResult;
        try {
            evidenceResult = await evidenceCollector.collect(decision, execResult);
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-3C] EvidenceCollector failed: ${err.message}`, err, 'AutonomousStep');
            evidenceResult = {
                success: false,
                evidenceId: 'E_error',
                goalId: replanRequest.goalId,
                decisionId: decision.decisionId,
                progressDelta: 0,
                expectedEffect: 'unknown',
                actualEffect: `evidence_error: ${err.message}`,
                verified: false,
                verificationReason: `evidence_error: ${err.message}`,
                evaluation: null,
            };
        }
        const overallSuccess = replanResult.success && execResult.success && evidenceResult.success;
        Logger_1.Logger.info(`[D7-3C] AutonomousStep complete: goal ${replanRequest.goalId} overall=${overallSuccess} progress_delta=${evidenceResult.progressDelta.toFixed(2)}`, 'AutonomousStep');
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
let instance = null;
function getAutonomousStep() {
    if (!instance) {
        instance = new AutonomousStepImpl();
    }
    return instance;
}
function resetAutonomousStep() {
    instance = null;
}
