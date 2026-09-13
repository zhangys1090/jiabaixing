"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecisionAuthority = void 0;
const Logger_1 = require("../utils/Logger");
const GoalAuthority_1 = require("./GoalAuthority");
const types_1 = require("./types");
const LearningAuthority_1 = require("./LearningAuthority");
function generateDecisionId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `D_${ts}_${rand}`;
}
class DecisionAuthority {
    static instance = null;
    history = new Map();
    proposers = new Map();
    constructor() { }
    static getInstance() {
        if (!DecisionAuthority.instance) {
            DecisionAuthority.instance = new DecisionAuthority();
        }
        return DecisionAuthority.instance;
    }
    static resetInstance() {
        DecisionAuthority.instance = null;
    }
    registerProposer(proposer) {
        this.proposers.set(proposer.proposerId, proposer);
        Logger_1.Logger.info(`DecisionAuthority: registered proposer "${proposer.proposerId}"`, 'DecisionAuthority');
    }
    async decide(context) {
        const { goalId, snapshot, candidates, decisionType } = context;
        const goalAuthority = GoalAuthority_1.GoalAuthority.getInstance();
        const goal = goalAuthority.getGoal(goalId);
        if (!goal) {
            throw new Error(`DecisionAuthority: goal ${goalId} not found`);
        }
        if (goal.status !== types_1.GoalStatus.ACTIVE) {
            throw new Error(`DecisionAuthority: goal ${goalId} is ${goal.status}, cannot decide`);
        }
        if (candidates.length === 0) {
            throw new Error(`DecisionAuthority: no candidates for goal ${goalId}`);
        }
        // D5: LearningAuthority adjusts candidate confidence/progress based on past Evidence
        const learningAuthority = LearningAuthority_1.LearningAuthority.getInstance();
        const adjustedCandidates = candidates.map((c) => learningAuthority.adjustCandidate(c));
        const scored = adjustedCandidates.map((c) => ({
            candidate: c,
            score: this.scoreCandidate(c, goal.progress),
        }));
        scored.sort((a, b) => b.score - a.score);
        const chosen = scored[0].candidate;
        const selectionReason = this.buildSelectionReason(chosen, scored[0].score, goal.progress);
        const acceptThreshold = scored[0].score * 0.7;
        const accepted = scored.filter((s) => s.score >= acceptThreshold).map((s) => s.candidate);
        const rejected = scored.filter((s) => s.score < acceptThreshold).map((s) => s.candidate);
        const decision = {
            decisionId: generateDecisionId(),
            decisionType: decisionType ?? types_1.DecisionType.ACTION,
            goalId,
            snapshotId: snapshot.snapshotId,
            planVersion: goal.planVersion,
            candidateIds: candidates.map((c) => c.candidateId),
            chosenCandidateId: chosen.candidateId,
            chosen,
            acceptedCandidates: accepted,
            rejectedCandidates: rejected,
            selectionReason,
            proposerSet: [...new Set(candidates.map((c) => c.proposerId))],
            vetoReason: null,
            timestamp: Date.now(),
        };
        this.recordDecision(goalId, decision);
        Logger_1.Logger.info(`DecisionAuthority: FINAL decision ${decision.decisionId} for goal ${goalId} — proposer=${chosen.proposerId} candidate=${chosen.candidateId} score=${scored[0].score.toFixed(3)} reason="${selectionReason}"`, 'DecisionAuthority');
        return decision;
    }
    async decideWithProposers(goalId, snapshot) {
        const goalAuthority = GoalAuthority_1.GoalAuthority.getInstance();
        const goal = goalAuthority.getGoal(goalId);
        if (!goal) {
            throw new Error(`DecisionAuthority: goal ${goalId} not found`);
        }
        if (goal.status !== types_1.GoalStatus.ACTIVE) {
            throw new Error(`DecisionAuthority: goal ${goalId} is ${goal.status}, cannot decide`);
        }
        const context = { goalId, snapshot, candidates: [] };
        const allCandidates = [];
        for (const proposer of this.proposers.values()) {
            try {
                const proposed = await proposer.propose(context);
                allCandidates.push(...proposed);
            }
            catch (e) {
                Logger_1.Logger.warn(`DecisionAuthority: proposer "${proposer.proposerId}" failed — ${e.message}`, 'DecisionAuthority');
            }
        }
        if (allCandidates.length === 0) {
            throw new Error(`DecisionAuthority: no candidates from ${this.proposers.size} proposers for goal ${goalId}`);
        }
        return this.decide({ goalId, snapshot, candidates: allCandidates });
    }
    getDecisionHistory(goalId) {
        return this.history.get(goalId) ?? [];
    }
    getAllHistory() {
        const entries = [];
        for (const [goalId, decisions] of this.history) {
            for (const decision of decisions) {
                entries.push({ decision, goalId });
            }
        }
        return entries;
    }
    clearHistory() {
        this.history.clear();
    }
    scoreCandidate(candidate, currentGoalProgress) {
        const confidenceWeight = 0.6;
        const progressWeight = 0.4;
        const progressDelta = candidate.estimatedGoalProgress - currentGoalProgress;
        const normalizedProgressDelta = Math.max(0, Math.min(1, progressDelta));
        return (confidenceWeight * candidate.confidence +
            progressWeight * normalizedProgressDelta);
    }
    buildSelectionReason(chosen, score, currentProgress) {
        return `proposer=${chosen.proposerId} confidence=${chosen.confidence.toFixed(2)} estimatedProgress=${chosen.estimatedGoalProgress.toFixed(2)} currentProgress=${currentProgress.toFixed(2)} score=${score.toFixed(3)}`;
    }
    recordDecision(goalId, decision) {
        if (!this.history.has(goalId)) {
            this.history.set(goalId, []);
        }
        this.history.get(goalId).push(decision);
    }
}
exports.DecisionAuthority = DecisionAuthority;
