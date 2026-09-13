import { Logger } from '../utils/Logger';
import type { DecisionCandidate, DecisionContext, DecisionProposer, ProposedAction } from './types';

export interface SelfModificationProposal {
  readonly actionType: 'MODIFY_FILE' | 'CREATE_FILE' | 'DELETE_FILE' | 'UPDATE_PROMPT' | 'UPDATE_CONFIG';
  readonly target: string;
  readonly content: string;
  readonly description: string;
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export class SelfModificationProposer implements DecisionProposer {
  readonly proposerId = 'self_modification';
  private pendingProposals: SelfModificationProposal[] = [];

  propose(context: DecisionContext): Promise<DecisionCandidate[]> {
    const candidates: DecisionCandidate[] = [];

    if (this.pendingProposals.length === 0) {
      Logger.debug('SelfModificationProposer: no pending proposals', 'SelfModificationProposer');
      return Promise.resolve(candidates);
    }

    for (const proposal of this.pendingProposals) {
      const action: ProposedAction = {
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

    Logger.info(`SelfModificationProposer: ${candidates.length} proposal(s) generated`, 'SelfModificationProposer');
    return Promise.resolve(candidates);
  }

  submitProposal(proposal: SelfModificationProposal): void {
    this.pendingProposals.push(proposal);
  }

  clearProposals(): void {
    this.pendingProposals = [];
  }

  private riskToConfidence(risk: 'LOW' | 'MEDIUM' | 'HIGH'): number {
    switch (risk) {
      case 'LOW': return 0.6;
      case 'MEDIUM': return 0.3;
      case 'HIGH': return 0.1;
    }
  }
}
