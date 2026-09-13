"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelfModificationProposer = void 0;
const Logger_1 = require("../utils/Logger");
class SelfModificationProposer {
    proposerId = 'self_modification';
    pendingProposals = [];
    propose(context) {
        const candidates = [];
        if (this.pendingProposals.length === 0) {
            Logger_1.Logger.debug('SelfModificationProposer: no pending proposals', 'SelfModificationProposer');
            return Promise.resolve(candidates);
        }
        for (const proposal of this.pendingProposals) {
            const action = {
                type: 'composite',
                payload: {
                    selfModification: true,
                    actionType: proposal.actionType,
                    target: proposal.target,
                    content: proposal.content,
                    description: proposal.description,
                    riskLevel: proposal.riskLevel,
                },
            };
            const confidence = this.riskToConfidence(proposal.riskLevel);
            candidates.push({
                candidateId: `sm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                proposerId: this.proposerId,
                action,
                confidence,
                reasoning: `Self-modification proposal: ${proposal.description} (risk: ${proposal.riskLevel})`,
                estimatedGoalProgress: 0.1,
            });
        }
        Logger_1.Logger.info(`SelfModificationProposer: ${candidates.length} proposal(s) generated`, 'SelfModificationProposer');
        return Promise.resolve(candidates);
    }
    submitProposal(proposal) {
        this.pendingProposals.push(proposal);
    }
    clearProposals() {
        this.pendingProposals = [];
    }
    riskToConfidence(risk) {
        switch (risk) {
            case 'LOW': return 0.6;
            case 'MEDIUM': return 0.3;
            case 'HIGH': return 0.1;
        }
    }
}
exports.SelfModificationProposer = SelfModificationProposer;
