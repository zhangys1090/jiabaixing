"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LearningAuthority = void 0;
const Logger_1 = require("../utils/Logger");
function generateBeliefId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `BU_${ts}_${rand}`;
}
class LearningAuthority {
    static instance = null;
    beliefs = new Map();
    beliefHistory = [];
    predictionErrors = [];
    maxHistorySize = 1000;
    constructor() { }
    static getInstance() {
        if (!LearningAuthority.instance) {
            LearningAuthority.instance = new LearningAuthority();
        }
        return LearningAuthority.instance;
    }
    static resetInstance() {
        LearningAuthority.instance = null;
    }
    computePredictionError(evidence) {
        const { expectedEffect, actualEffect } = evidence;
        let errorMagnitude;
        let errorType;
        if (expectedEffect === actualEffect) {
            errorMagnitude = 0;
            errorType = 'match';
        }
        else {
            const expectedLower = expectedEffect.toLowerCase().trim();
            const actualLower = actualEffect.toLowerCase().trim();
            const actualIsSuccess = actualLower === 'success';
            const actualIsFailure = actualLower === 'failed' || actualLower.includes('fail');
            const expectedIsSuccess = expectedLower === 'success';
            if (actualIsSuccess && expectedIsSuccess) {
                errorMagnitude = 0;
                errorType = 'match';
            }
            else if (actualIsSuccess && !expectedIsSuccess) {
                errorMagnitude = 0.3;
                errorType = 'under_prediction';
            }
            else if (actualIsFailure && expectedIsSuccess) {
                errorMagnitude = 1.0;
                errorType = 'over_prediction';
            }
            else if (actualIsFailure && !expectedIsSuccess) {
                errorMagnitude = 0.5;
                errorType = 'over_prediction';
            }
            else {
                const sharedWords = this.countSharedWords(expectedLower, actualLower);
                const totalWords = new Set([
                    ...expectedLower.split(/\s+/),
                    ...actualLower.split(/\s+/),
                ]).size;
                errorMagnitude = totalWords > 0 ? 1 - sharedWords / totalWords : 0.5;
                errorType = errorMagnitude > 0.5 ? 'over_prediction' : 'under_prediction';
            }
        }
        const pe = {
            evidenceId: evidence.evidenceId,
            goalId: evidence.goalId,
            decisionId: evidence.decisionId,
            expectedEffect,
            actualEffect,
            errorMagnitude,
            errorType,
            timestamp: Date.now(),
        };
        this.predictionErrors.push(pe);
        if (this.predictionErrors.length > this.maxHistorySize) {
            this.predictionErrors.shift();
        }
        return pe;
    }
    learn(evidence, proposerId) {
        const pe = this.computePredictionError(evidence);
        if (pe.errorType === 'match' && pe.errorMagnitude === 0) {
            Logger_1.Logger.debug(`LearningAuthority: exact match for ${evidence.evidenceId}, no update needed`, 'LearningAuthority');
            return null;
        }
        const actionType = evidence.action.type || 'unknown';
        const contextSignature = this.buildContextSignature(proposerId, actionType);
        const confidenceAdjustment = this.computeConfidenceAdjustment(pe);
        const progressAdjustment = this.computeProgressAdjustment(pe, evidence.progressDelta);
        const beliefUpdate = {
            beliefId: generateBeliefId(),
            sourceEvidenceId: evidence.evidenceId,
            sourceGoalId: evidence.goalId,
            sourceDecisionId: evidence.decisionId,
            proposerId,
            actionType,
            contextSignature,
            confidenceAdjustment,
            progressAdjustment,
            reason: `${pe.errorType}: expected="${pe.expectedEffect}" actual="${pe.actualEffect}" error=${pe.errorMagnitude.toFixed(2)}`,
            timestamp: Date.now(),
        };
        this.applyBeliefUpdate(beliefUpdate);
        this.beliefHistory.push(beliefUpdate);
        if (this.beliefHistory.length > this.maxHistorySize) {
            this.beliefHistory.shift();
        }
        Logger_1.Logger.info(`LearningAuthority: belief ${beliefUpdate.beliefId} — ${beliefUpdate.reason} → confΔ=${confidenceAdjustment.toFixed(3)} progΔ=${progressAdjustment.toFixed(3)}`, 'LearningAuthority');
        return beliefUpdate;
    }
    adjustCandidate(candidate) {
        const actionType = candidate.action.type || 'unknown';
        const contextSignature = this.buildContextSignature(candidate.proposerId, actionType);
        const belief = this.beliefs.get(contextSignature);
        if (!belief)
            return candidate;
        const adjustedConfidence = Math.max(0.01, Math.min(1, candidate.confidence + belief.confidenceBias));
        const adjustedProgress = Math.max(0, Math.min(1, candidate.estimatedGoalProgress + belief.progressBias));
        if (Math.abs(adjustedConfidence - candidate.confidence) < 0.001 &&
            Math.abs(adjustedProgress - candidate.estimatedGoalProgress) < 0.001) {
            return candidate;
        }
        return {
            ...candidate,
            confidence: adjustedConfidence,
            estimatedGoalProgress: adjustedProgress,
            reasoning: `${candidate.reasoning} [learned: confBias=${belief.confidenceBias.toFixed(3)}, progBias=${belief.progressBias.toFixed(3)}, samples=${belief.sampleCount}]`,
        };
    }
    getBelief(contextSignature) {
        return this.beliefs.get(contextSignature) ?? null;
    }
    getAllBeliefs() {
        return Array.from(this.beliefs.values());
    }
    getBeliefHistory() {
        return [...this.beliefHistory];
    }
    getPredictionErrors() {
        return [...this.predictionErrors];
    }
    getBeliefHistoryForEvidence(evidenceId) {
        return this.beliefHistory.filter((b) => b.sourceEvidenceId === evidenceId);
    }
    getBeliefHistoryForGoal(goalId) {
        return this.beliefHistory.filter((b) => b.sourceGoalId === goalId);
    }
    applyBeliefUpdate(update) {
        const existing = this.beliefs.get(update.contextSignature);
        if (existing) {
            const decay = Math.max(0.3, 1 / existing.sampleCount);
            const newConfBias = existing.confidenceBias * (1 - decay) + update.confidenceAdjustment * decay;
            const newProgBias = existing.progressBias * (1 - decay) + update.progressAdjustment * decay;
            this.beliefs.set(update.contextSignature, {
                contextSignature: update.contextSignature,
                proposerId: update.proposerId,
                actionType: update.actionType,
                confidenceBias: newConfBias,
                progressBias: newProgBias,
                sampleCount: existing.sampleCount + 1,
                lastUpdated: Date.now(),
            });
        }
        else {
            this.beliefs.set(update.contextSignature, {
                contextSignature: update.contextSignature,
                proposerId: update.proposerId,
                actionType: update.actionType,
                confidenceBias: update.confidenceAdjustment,
                progressBias: update.progressAdjustment,
                sampleCount: 1,
                lastUpdated: Date.now(),
            });
        }
    }
    computeConfidenceAdjustment(pe) {
        switch (pe.errorType) {
            case 'match':
                return 0.01;
            case 'under_prediction':
                return 0.15;
            case 'over_prediction':
                return -0.3 * pe.errorMagnitude;
            case 'unknown':
                return -0.05;
        }
    }
    computeProgressAdjustment(pe, actualDelta) {
        switch (pe.errorType) {
            case 'match':
                return 0;
            case 'under_prediction':
                return 0.05;
            case 'over_prediction':
                return -0.1 * pe.errorMagnitude;
            case 'unknown':
                return -0.02;
        }
    }
    buildContextSignature(proposerId, actionType) {
        return `${proposerId}::${actionType}`;
    }
    countSharedWords(a, b) {
        const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
        const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
        let count = 0;
        for (const w of wordsA) {
            if (wordsB.has(w))
                count++;
        }
        return count;
    }
}
exports.LearningAuthority = LearningAuthority;
