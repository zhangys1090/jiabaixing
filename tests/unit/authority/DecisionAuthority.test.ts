import type {
    CanonicalDecisionSnapshot,
    DecisionCandidate,
    DecisionProposer
} from '../../../src/authority';
import {
    DecisionAuthority,
    GoalAuthority,
} from '../../../src/authority';

function makeSnapshot(activeGoalIds: string[]): CanonicalDecisionSnapshot {
  return {
    snapshotId: 'SS_test',
    timestamp: Date.now(),
    activeGoalIds,
    self: { agentId: 'test', activeGoalIds, currentStage: 'executing', safetyStatus: 'nominal' },
    world: { observation: null, platform: 'desktop', timestamp: Date.now() },
    memory: { relevantMemories: [], query: '', timestamp: Date.now() },
    context: { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now() },
    capabilities: { availableTools: [], availableSkills: [], desktopAvailable: true, bridgeAvailable: true },
  };
}

let candidateCounter = 0;
function makeCandidate(
  proposerId: string,
  confidence: number,
  estimatedProgress: number,
  actionType: 'desktop_action' | 'tool_call' | 'message' | 'composite' = 'desktop_action'
): DecisionCandidate {
  candidateCounter += 1;
  return {
    candidateId: `C_test_${candidateCounter}`,
    proposerId,
    action: { type: actionType, payload: {} },
    confidence,
    reasoning: `${proposerId} proposes this`,
    estimatedGoalProgress: estimatedProgress,
  };
}

describe('DecisionAuthority v2', () => {
  let goalAuthority: GoalAuthority;
  let decisionAuthority: DecisionAuthority;

  beforeEach(() => {
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    goalAuthority = GoalAuthority.getInstance();
    decisionAuthority = DecisionAuthority.getInstance();
    candidateCounter = 0;
  });

  describe('decide', () => {
    it('chooses the highest-scoring candidate as FINAL with full audit trail', async () => {
      const goal = goalAuthority.createGoal({
        description: '整理下载文件',
        originalInput: '帮我整理下载文件',
      });

      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [
        makeCandidate('skill', 0.6, 0.3),
        makeCandidate('llm', 0.9, 0.5),
        makeCandidate('rule', 0.7, 0.2),
      ];

      const decision = await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates });

      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.snapshotId).toBe(snapshot.snapshotId);
      expect(decision.chosen.proposerId).toBe('llm');
      expect(decision.chosenCandidateId).toBe(decision.chosen.candidateId);
      expect(decision.vetoReason).toBeNull();
      expect(decision.candidateIds).toHaveLength(3);
      expect(decision.rejectedCandidates).toHaveLength(2);
      expect(decision.proposerSet).toEqual(expect.arrayContaining(['llm', 'skill', 'rule']));
      expect(decision.selectionReason).toContain('proposer=llm');
      expect(decision.selectionReason).toContain('confidence=0.90');
      expect(decision.decisionId).toMatch(/^D_[a-z0-9]+_[a-z0-9]{4}$/);
    });

    it('throws if goal not found', async () => {
      const snapshot = makeSnapshot(['G_unknown']);
      const candidates = [makeCandidate('llm', 0.9, 0.5)];
      await expect(
        decisionAuthority.decide({ goalId: 'G_unknown', snapshot, candidates })
      ).rejects.toThrow('goal G_unknown not found');
    });

    it('throws if goal is not ACTIVE', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      goalAuthority.markCompleted(goal.goalId, 'done');

      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [makeCandidate('llm', 0.9, 0.5)];
      await expect(
        decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates })
      ).rejects.toThrow('is completed');
    });

    it('throws if no candidates provided', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);
      await expect(
        decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates: [] })
      ).rejects.toThrow('no candidates');
    });

    it('prefers higher confidence when progress estimates are equal', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [
        makeCandidate('skill', 0.5, 0.5),
        makeCandidate('llm', 0.95, 0.5),
      ];

      const decision = await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates });
      expect(decision.chosen.proposerId).toBe('llm');
    });

    it('prefers higher estimated progress when confidences are equal', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [
        makeCandidate('rule', 0.8, 0.2),
        makeCandidate('llm', 0.8, 0.7),
      ];

      const decision = await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates });
      expect(decision.chosen.proposerId).toBe('llm');
    });
  });

  describe('decideWithProposers (proposer/authority separation)', () => {
    it('collects candidates from registered proposers and decides', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const llmProposer: DecisionProposer = {
        proposerId: 'llm',
        propose: jest.fn().mockResolvedValue([
          makeCandidate('llm', 0.9, 0.5),
        ]),
      };
      const skillProposer: DecisionProposer = {
        proposerId: 'skill',
        propose: jest.fn().mockResolvedValue([
          makeCandidate('skill', 0.7, 0.3),
        ]),
      };

      decisionAuthority.registerProposer(llmProposer);
      decisionAuthority.registerProposer(skillProposer);

      const decision = await decisionAuthority.decideWithProposers(goal.goalId, snapshot);

      expect(decision.chosen.proposerId).toBe('llm');
      expect(decision.proposerSet).toEqual(expect.arrayContaining(['llm', 'skill']));
      expect(llmProposer.propose).toHaveBeenCalledTimes(1);
      expect(skillProposer.propose).toHaveBeenCalledTimes(1);
    });

    it('handles proposer failures gracefully', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const failingProposer: DecisionProposer = {
        proposerId: 'failing',
        propose: jest.fn().mockRejectedValue(new Error('proposer crashed')),
      };
      const workingProposer: DecisionProposer = {
        proposerId: 'working',
        propose: jest.fn().mockResolvedValue([
          makeCandidate('working', 0.8, 0.4),
        ]),
      };

      decisionAuthority.registerProposer(failingProposer);
      decisionAuthority.registerProposer(workingProposer);

      const decision = await decisionAuthority.decideWithProposers(goal.goalId, snapshot);
      expect(decision.chosen.proposerId).toBe('working');
    });

    it('throws if all proposers produce no candidates', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const emptyProposer: DecisionProposer = {
        proposerId: 'empty',
        propose: jest.fn().mockResolvedValue([]),
      };

      decisionAuthority.registerProposer(emptyProposer);

      await expect(
        decisionAuthority.decideWithProposers(goal.goalId, snapshot)
      ).rejects.toThrow('no candidates from 1 proposers');
    });
  });

  describe('Decision does NOT do safety (review point 7)', () => {
    it('DecisionAuthority only chooses, does not authorize', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [makeCandidate('llm', 0.9, 0.5)];

      const decision = await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates });

      expect(decision.chosen).toBeDefined();
      expect(decision.vetoReason).toBeNull();
    });
  });

  describe('Decision audit trail (review point 8)', () => {
    it('records selectionReason, rejectedCandidates, proposerSet', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [
        makeCandidate('llm', 0.9, 0.5),
        makeCandidate('skill', 0.7, 0.3),
      ];

      const decision = await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates });

      expect(decision.selectionReason).toContain('proposer=llm');
      expect(decision.selectionReason).toContain('confidence=');
      expect(decision.selectionReason).toContain('estimatedProgress=');
      expect(decision.selectionReason).toContain('score=');
      expect(decision.acceptedCandidates.length).toBeGreaterThanOrEqual(1);
      expect(decision.acceptedCandidates[0].proposerId).toBe('llm');
      expect(decision.proposerSet).toEqual(['llm', 'skill']);
      expect(decision.candidateIds).toHaveLength(2);
      expect(decision.chosenCandidateId).toBe(decision.chosen.candidateId);
    });
  });

  describe('getDecisionHistory', () => {
    it('tracks decision history per goal', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);
      const c1 = [makeCandidate('llm', 0.9, 0.3)];
      const c2 = [makeCandidate('skill', 0.8, 0.6)];

      await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates: c1 });
      await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates: c2 });

      const history = decisionAuthority.getDecisionHistory(goal.goalId);
      expect(history).toHaveLength(2);
      expect(history[0].chosen.proposerId).toBe('llm');
      expect(history[1].chosen.proposerId).toBe('skill');
    });

    it('returns empty for unknown goal', () => {
      expect(decisionAuthority.getDecisionHistory('unknown')).toEqual([]);
    });
  });

  describe('Decision declares goalId + snapshotId (D4-3)', () => {
    it('every decision explicitly references its goal and snapshot', async () => {
      const goal = goalAuthority.createGoal({ description: '整理下载文件', originalInput: '帮我整理下载文件' });
      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [makeCandidate('llm', 0.9, 0.5)];

      const decision = await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates });

      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.snapshotId).toBe(snapshot.snapshotId);
    });
  });

  describe('FINAL decision uniqueness (D1 fix)', () => {
    it('only one chosen candidate exists per decision', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);
      const candidates = [
        makeCandidate('llm', 0.9, 0.5),
        makeCandidate('skill', 0.8, 0.4),
        makeCandidate('rule', 0.7, 0.3),
      ];

      const decision = await decisionAuthority.decide({ goalId: goal.goalId, snapshot, candidates });

      expect(decision.candidateIds).toHaveLength(3);
      expect(decision.chosen).toBeDefined();
      expect(decision.acceptedCandidates.length).toBeGreaterThanOrEqual(1);
      expect(decision.acceptedCandidates.length + decision.rejectedCandidates.length).toBe(3);
    });
  });
});
