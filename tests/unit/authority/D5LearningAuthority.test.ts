import {
  GoalAuthority,
  DecisionAuthority,
  LearningAuthority,
  GoalStatus,
  DecisionType,
} from '../../../src/authority';
import type { GoalEvidence, DecisionCandidate, CanonicalDecisionSnapshot } from '../../../src/authority';

function makeSnapshot(goalId: string, progress: number): CanonicalDecisionSnapshot {
  return {
    snapshotId: `SS_${Date.now().toString(36)}`,
    goalIds: [goalId],
    self: { agentId: 'test', activeGoalIds: [goalId], currentStage: 'deciding', safetyStatus: 'nominal' },
    world: { observation: null, platform: 'desktop', timestamp: Date.now() },
    memory: { relevantMemories: [], query: '', timestamp: Date.now() },
    context: { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '' },
    capabilities: { availableTools: [], toolCount: 0 },
    goalProgress: { [goalId]: progress },
    timestamp: Date.now(),
  };
}

function makeCandidate(
  proposerId: string,
  actionType: string,
  confidence: number,
  estimatedProgress: number
): DecisionCandidate {
  return {
    candidateId: `C_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    proposerId,
    action: { type: actionType, payload: {} },
    confidence,
    reasoning: `${proposerId} proposes ${actionType}`,
    estimatedGoalProgress: estimatedProgress,
  };
}

describe('D5 Learning Authority', () => {
  beforeEach(() => {
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    LearningAuthority.resetInstance();
  });

  describe('D5-G1: Evidence → PredictionError', () => {
    it('every Evidence produces a computable PredictionError', () => {
      const learning = LearningAuthority.getInstance();
      const evidence: GoalEvidence = {
        evidenceId: 'E_test1',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'saw browser open',
        action: { type: 'open_browser', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'success',
        progressDelta: 0.3,
        timestamp: Date.now(),
      };

      const pe = learning.computePredictionError(evidence);
      expect(pe.evidenceId).toBe('E_test1');
      expect(pe.goalId).toBe('G_test');
      expect(pe.decisionId).toBe('D_test');
      expect(pe.errorMagnitude).toBeGreaterThanOrEqual(0);
      expect(pe.errorMagnitude).toBeLessThanOrEqual(1);
      expect(pe.errorType).toBeDefined();
    });

    it('over-prediction produces high errorMagnitude', () => {
      const learning = LearningAuthority.getInstance();
      const evidence: GoalEvidence = {
        evidenceId: 'E_over',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'action failed',
        action: { type: 'delete_file', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      const pe = learning.computePredictionError(evidence);
      expect(pe.errorType).toBe('over_prediction');
      expect(pe.errorMagnitude).toBeGreaterThan(0.5);
    });

    it('under-prediction produces moderate errorMagnitude', () => {
      const learning = LearningAuthority.getInstance();
      const evidence: GoalEvidence = {
        evidenceId: 'E_under',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'action succeeded beyond expectation',
        action: { type: 'open_browser', payload: {} },
        expectedEffect: 'partial success',
        actualEffect: 'success',
        progressDelta: 0.5,
        timestamp: Date.now(),
      };

      const pe = learning.computePredictionError(evidence);
      expect(pe.errorType).toBe('under_prediction');
      expect(pe.errorMagnitude).toBeLessThan(1);
    });

    it('exact match produces zero error', () => {
      const learning = LearningAuthority.getInstance();
      const evidence: GoalEvidence = {
        evidenceId: 'E_match',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'exact outcome',
        action: { type: 'click', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'success',
        progressDelta: 0.3,
        timestamp: Date.now(),
      };

      const pe = learning.computePredictionError(evidence);
      expect(pe.errorType).toBe('match');
      expect(pe.errorMagnitude).toBe(0);
    });
  });

  describe('D5-G2: BeliefUpdate — not just cache write', () => {
    it('learn() produces BeliefUpdate with full audit trail', () => {
      const learning = LearningAuthority.getInstance();
      const evidence: GoalEvidence = {
        evidenceId: 'E_learn1',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'file not found',
        action: { type: 'delete_file', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      const update = learning.learn(evidence, 'skill_proposer');
      expect(update).not.toBeNull();
      expect(update!.sourceEvidenceId).toBe('E_learn1');
      expect(update!.sourceGoalId).toBe('G_test');
      expect(update!.sourceDecisionId).toBe('D_test');
      expect(update!.proposerId).toBe('skill_proposer');
      expect(update!.actionType).toBe('delete_file');
      expect(update!.beliefId).toMatch(/^BU_/);
      expect(update!.confidenceAdjustment).toBeLessThan(0);
      expect(update!.reason).toContain('over_prediction');
    });

    it('exact match produces null BeliefUpdate (nothing to learn)', () => {
      const learning = LearningAuthority.getInstance();
      const evidence: GoalEvidence = {
        evidenceId: 'E_match2',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'ok',
        action: { type: 'click', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'success',
        progressDelta: 0.3,
        timestamp: Date.now(),
      };

      const update = learning.learn(evidence, 'skill_proposer');
      expect(update).toBeNull();
    });

    it('BeliefUpdate is recorded in history and retrievable', () => {
      const learning = LearningAuthority.getInstance();
      const evidence: GoalEvidence = {
        evidenceId: 'E_hist',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'failed',
        action: { type: 'open_app', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      learning.learn(evidence, 'llm_proposer');

      const history = learning.getBeliefHistory();
      expect(history.length).toBe(1);
      expect(history[0].sourceEvidenceId).toBe('E_hist');

      const forEvidence = learning.getBeliefHistoryForEvidence('E_hist');
      expect(forEvidence.length).toBe(1);

      const forGoal = learning.getBeliefHistoryForGoal('G_test');
      expect(forGoal.length).toBe(1);
    });
  });

  describe('D5-G3: Decision Influence — BeliefUpdate changes future Decision', () => {
    it('over-prediction reduces future candidate confidence for same action', () => {
      const learning = LearningAuthority.getInstance();

      const evidence: GoalEvidence = {
        evidenceId: 'E_over_pred',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'failed',
        action: { type: 'delete_file', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      learning.learn(evidence, 'skill_proposer');

      const candidate = makeCandidate('skill_proposer', 'delete_file', 0.8, 0.5);
      const adjusted = learning.adjustCandidate(candidate);

      expect(adjusted.confidence).toBeLessThan(candidate.confidence);
    });

    it('under-prediction increases future candidate confidence', () => {
      const learning = LearningAuthority.getInstance();

      const evidence: GoalEvidence = {
        evidenceId: 'E_under_pred',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'better than expected',
        action: { type: 'open_browser', payload: {} },
        expectedEffect: 'partial success',
        actualEffect: 'success',
        progressDelta: 0.5,
        timestamp: Date.now(),
      };

      learning.learn(evidence, 'skill_proposer');

      const candidate = makeCandidate('skill_proposer', 'open_browser', 0.5, 0.3);
      const adjusted = learning.adjustCandidate(candidate);

      expect(adjusted.confidence).toBeGreaterThan(candidate.confidence);
    });

    it('learning from multiple Evidence accumulates belief', () => {
      const learning = LearningAuthority.getInstance();

      for (let i = 0; i < 10; i++) {
        const evidence: GoalEvidence = {
          evidenceId: `E_fail_${i}`,
          goalId: 'G_test',
          decisionId: 'D_test',
          observation: 'failed',
          action: { type: 'risky_action', payload: {} },
          expectedEffect: 'success',
          actualEffect: 'failed',
          progressDelta: -0.1,
          timestamp: Date.now(),
        };
        learning.learn(evidence, 'llm_proposer');
      }

      const beliefs = learning.getAllBeliefs();
      const riskyBelief = beliefs.find((b) => b.actionType === 'risky_action');
      expect(riskyBelief).toBeDefined();
      expect(riskyBelief!.sampleCount).toBe(10);
      expect(riskyBelief!.confidenceBias).toBeLessThan(0);

      const candidate = makeCandidate('llm_proposer', 'risky_action', 0.9, 0.8);
      const adjusted = learning.adjustCandidate(candidate);
      expect(adjusted.confidence).toBeLessThan(candidate.confidence);
      expect(adjusted.confidence).toBeLessThan(0.7);
    });

    it('different proposer+action combinations learn independently', () => {
      const learning = LearningAuthority.getInstance();

      const evidenceA: GoalEvidence = {
        evidenceId: 'E_A',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'failed',
        action: { type: 'action_a', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };
      learning.learn(evidenceA, 'proposer_a');

      const candidateB = makeCandidate('proposer_b', 'action_b', 0.8, 0.5);
      const adjustedB = learning.adjustCandidate(candidateB);
      expect(adjustedB.confidence).toBe(candidateB.confidence);
    });
  });

  describe('D5-G4: Audit Trail — every BeliefUpdate traceable to Evidence', () => {
    it('every BeliefUpdate has sourceEvidenceId, sourceGoalId, sourceDecisionId', () => {
      const learning = LearningAuthority.getInstance();

      const evidence: GoalEvidence = {
        evidenceId: 'E_audit',
        goalId: 'G_audit',
        decisionId: 'D_audit',
        observation: 'failed',
        action: { type: 'test_action', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      const update = learning.learn(evidence, 'test_proposer');
      expect(update!.sourceEvidenceId).toBe('E_audit');
      expect(update!.sourceGoalId).toBe('G_audit');
      expect(update!.sourceDecisionId).toBe('D_audit');
    });

    it('PredictionError history is retrievable', () => {
      const learning = LearningAuthority.getInstance();

      const evidence: GoalEvidence = {
        evidenceId: 'E_pe_hist',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'failed',
        action: { type: 'test', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      learning.learn(evidence, 'test_proposer');

      const errors = learning.getPredictionErrors();
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.evidenceId === 'E_pe_hist')).toBe(true);
    });

    it('LearnedBelief contains sampleCount and lastUpdated', () => {
      const learning = LearningAuthority.getInstance();

      const evidence: GoalEvidence = {
        evidenceId: 'E_belief',
        goalId: 'G_test',
        decisionId: 'D_test',
        observation: 'failed',
        action: { type: 'test_action', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      learning.learn(evidence, 'test_proposer');

      const beliefs = learning.getAllBeliefs();
      const belief = beliefs.find((b) => b.actionType === 'test_action');
      expect(belief).toBeDefined();
      expect(belief!.sampleCount).toBe(1);
      expect(belief!.lastUpdated).toBeGreaterThan(0);
    });
  });

  describe('D5: End-to-End Evidence → Learning → Decision Change', () => {
    it('full chain: Evidence → Learning → adjusted Decision selects different candidate', async () => {
      const goalAuth = GoalAuthority.getInstance();
      const decisionAuth = DecisionAuthority.getInstance();
      const learning = LearningAuthority.getInstance();

      const goal = goalAuth.createGoal({
        description: 'risky task',
        originalInput: 'risky task',
      });

      const snapshot = makeSnapshot(goal.goalId, 0);

      const riskyCandidate = makeCandidate('skill_proposer', 'risky_action', 0.9, 0.5);
      const safeCandidate = makeCandidate('rule_proposer', 'safe_action', 0.7, 0.6);

      const firstDecision = await decisionAuth.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [riskyCandidate, safeCandidate],
      });
      expect(firstDecision.chosen.proposerId).toBe('skill_proposer');

      for (let i = 0; i < 3; i++) {
        const evidence: GoalEvidence = {
          evidenceId: `E_risky_fail_${i}`,
          goalId: goal.goalId,
          decisionId: firstDecision.decisionId,
          observation: 'risky action failed',
          action: { type: 'risky_action', payload: {} },
          expectedEffect: 'success',
          actualEffect: 'failed',
          progressDelta: -0.1,
          timestamp: Date.now(),
        };
        learning.learn(evidence, 'skill_proposer');
      }

      const secondRisky = makeCandidate('skill_proposer', 'risky_action', 0.9, 0.5);
      const secondSafe = makeCandidate('rule_proposer', 'safe_action', 0.7, 0.6);

      const secondDecision = await decisionAuth.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [secondRisky, secondSafe],
      });

      expect(secondDecision.chosen.proposerId).toBe('rule_proposer');
      expect(secondDecision.chosen.action.type).toBe('safe_action');
    });

    it('repeated success increases confidence and progress estimates', () => {
      const learning = LearningAuthority.getInstance();

      for (let i = 0; i < 3; i++) {
        const evidence: GoalEvidence = {
          evidenceId: `E_success_${i}`,
          goalId: 'G_test',
          decisionId: 'D_test',
          observation: 'worked',
          action: { type: 'reliable_action', payload: {} },
          expectedEffect: 'partial success',
          actualEffect: 'success',
          progressDelta: 0.3,
          timestamp: Date.now(),
        };
        learning.learn(evidence, 'skill_proposer');
      }

      const candidate = makeCandidate('skill_proposer', 'reliable_action', 0.5, 0.3);
      const adjusted = learning.adjustCandidate(candidate);

      expect(adjusted.confidence).toBeGreaterThan(candidate.confidence);
      expect(adjusted.estimatedGoalProgress).toBeGreaterThan(candidate.estimatedGoalProgress);
    });
  });
});
