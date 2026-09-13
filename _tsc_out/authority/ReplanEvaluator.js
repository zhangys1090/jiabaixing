"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRequestId = generateRequestId;
exports.getReplanEvaluator = getReplanEvaluator;
exports.resetReplanEvaluator = resetReplanEvaluator;
const Logger_1 = require("../utils/Logger");
const REPLAN_ELIGIBLE_SOURCES = new Set([
    'explicit',
    'workspace_context',
    'desktop_context',
    'task_context',
]);
const STRONG_INVALIDATION_TYPES = new Set([
    'resource_deleted',
    'resource_invalidated',
    'structural_change',
]);
function generateRequestId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `RR_${ts}_${rand}`;
}
class ReplanEvaluatorImpl {
    recentRequests = new Map();
    maxRecentRequests = 200;
    evaluate(goal, impact, evidence) {
        try {
            if (goal.status !== 'active') {
                return null;
            }
            if (!impact.affected) {
                return null;
            }
            const bindingEligibility = this.checkBindingEligibility(goal, impact);
            if (!bindingEligibility.eligible) {
                return null;
            }
            const dedupKey = `${impact.goalId}:${goal.planVersion}:${impact.observationId}`;
            if (this.recentRequests.has(dedupKey)) {
                return null;
            }
            const staleResult = this.assessPlanStaleness(goal, impact, evidence);
            if (!staleResult.stale) {
                return null;
            }
            const request = {
                requestId: generateRequestId(),
                goalId: goal.goalId,
                observationId: impact.observationId,
                impactType: impact.impactType,
                reason: staleResult.reason,
                confidence: impact.confidence,
                planVersion: goal.planVersion,
                timestamp: Date.now(),
            };
            this.recentRequests.set(dedupKey, request);
            if (this.recentRequests.size > this.maxRecentRequests) {
                const oldest = this.recentRequests.keys().next().value;
                if (oldest !== undefined) {
                    this.recentRequests.delete(oldest);
                }
            }
            Logger_1.Logger.info(`[D7-2] ReplanRequest ${request.requestId} for Goal ${goal.goalId} (plan v${goal.planVersion}): ${staleResult.reason}`, 'ReplanEvaluator');
            return request;
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-2] ReplanEvaluator.evaluate failed: ${err.message}`, err, 'ReplanEvaluator');
            return null;
        }
    }
    checkBindingEligibility(goal, impact) {
        if (goal.bindings) {
            if (REPLAN_ELIGIBLE_SOURCES.has(goal.bindings.source)) {
                return { eligible: true };
            }
            return {
                eligible: false,
                reason: `binding_source_ineligible: ${goal.bindings.source}`,
            };
        }
        if (impact.reason.startsWith('goal_bindings_match')) {
            return { eligible: true };
        }
        if (impact.reason.startsWith('structured_resource_match') || impact.reason.startsWith('bound_')) {
            return { eligible: true, reason: 'legacy_metadata_eligible' };
        }
        if (impact.reason.startsWith('inferred_')) {
            return {
                eligible: false,
                reason: 'inferred_binding_ineligible',
            };
        }
        if (impact.impactType === 'environment_change' && impact.confidence >= 0.5) {
            return { eligible: true, reason: 'environment_change_with_confidence' };
        }
        if (impact.impactType === 'failure_detected' && impact.confidence >= 0.5) {
            return { eligible: true, reason: 'failure_detected_requires_recovery' };
        }
        return {
            eligible: false,
            reason: 'no_structured_binding',
        };
    }
    assessPlanStaleness(goal, impact, evidence) {
        const strongSignal = this.checkStrongInvalidationSignal(goal, impact);
        if (strongSignal.stale) {
            return strongSignal;
        }
        if (impact.impactType === 'environment_change' && impact.confidence >= 0.5) {
            return { stale: true, reason: 'environment_change_requires_replan' };
        }
        if (impact.impactType === 'failure_detected' && impact.confidence >= 0.5) {
            return { stale: true, reason: 'failure_detected_requires_recovery' };
        }
        const negativeEvidence = this.checkConsecutiveNegativeEvidence(evidence);
        if (negativeEvidence.stale) {
            return negativeEvidence;
        }
        return { stale: false, reason: 'impact_not_sufficient_for_replan' };
    }
    checkStrongInvalidationSignal(goal, impact) {
        if (impact.impactType === 'git_change' && goal.bindings) {
            const binding = goal.bindings;
            if (binding.repository || binding.repositoryPath) {
                if (impact.reason.includes('goal_bindings_match') ||
                    impact.reason.includes('goal_bindings_repository_match')) {
                    return {
                        stale: true,
                        reason: `bound_repository_structural_change: ${binding.repository || binding.repositoryPath}`,
                    };
                }
            }
        }
        if (impact.impactType === 'file_change' && goal.bindings) {
            const binding = goal.bindings;
            if (binding.paths && binding.paths.length > 0) {
                if (impact.reason.includes('goal_bindings_path_match')) {
                    const payload = impact.reason;
                    if (this.isStructuralFileChange(payload)) {
                        return {
                            stale: true,
                            reason: `bound_path_structural_change: paths affected`,
                        };
                    }
                }
            }
        }
        return { stale: false, reason: '' };
    }
    isStructuralFileChange(reason) {
        return (reason.includes('deleted') ||
            reason.includes('removed') ||
            reason.includes('renamed') ||
            reason.includes('structural_change') ||
            reason.includes('resource_deleted') ||
            reason.includes('resource_invalidated'));
    }
    checkConsecutiveNegativeEvidence(evidence) {
        if (evidence.length < 2) {
            return { stale: false, reason: '' };
        }
        const recentEvidence = evidence.slice(-3);
        const negativeCount = recentEvidence.filter((e) => e.progressDelta <= -0.3).length;
        if (negativeCount >= 2) {
            return {
                stale: true,
                reason: `consecutive_negative_evidence: ${negativeCount} of ${recentEvidence.length} recent evidence with delta <= -0.3`,
            };
        }
        return { stale: false, reason: '' };
    }
}
let instance = null;
function getReplanEvaluator() {
    if (!instance) {
        instance = new ReplanEvaluatorImpl();
    }
    return instance;
}
function resetReplanEvaluator() {
    instance = null;
}
