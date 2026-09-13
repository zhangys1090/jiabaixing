import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { LearningAuthority } from '../../authority/LearningAuthority';
import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { StateAuthority } from '../../authority/StateAuthority';
import type { GoalEvidence, DecisionCandidate } from '../../authority/types';
import { DecisionType } from '../../authority/types';

describe('D5: Learning Authority Audit', () => {
  let la: LearningAuthority;
  let ga: GoalAuthority;
  let da: DecisionAuthority;

  beforeEach(() => {
    LearningAuthority.resetInstance();
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    la = LearningAuthority.getInstance();
    ga = GoalAuthority.getInstance();
    da = DecisionAuthority.getInstance();
  });

  afterAll(() => {
    LearningAuthority.resetInstance();
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
  });

  describe('Audit 1: Evidence → Prediction Error → Belief Update (not just write cache)', () => {
    it('learn() produces PredictionError with goalId/decisionId', () => {
      const evidence: GoalEvidence = {
        evidenceId: 'E_d5_1',
        goalId: 'G_d5_1',
        decisionId: 'D_d5_1',
        observation: 'action failed',
        action: { type: 'tool_call', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      const update = la.learn(evidence, 'proposer_A');
      expect(update).not.toBeNull();
      expect(update!.sourceGoalId).toBe('G_d5_1');
      expect(update!.sourceDecisionId).toBe('D_d5_1');
      expect(update!.confidenceAdjustment).toBeLessThan(0);

      const errors = la.getPredictionErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].goalId).toBe('G_d5_1');
      expect(errors[0].decisionId).toBe('D_d5_1');
      expect(errors[0].errorType).toBe('over_prediction');
    });

    it('exact match produces no BeliefUpdate (no waste)', () => {
      const evidence: GoalEvidence = {
        evidenceId: 'E_d5_match',
        goalId: 'G_d5_match',
        decisionId: 'D_d5_match',
        observation: 'exact match',
        action: { type: 'tool_call', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'success',
        progressDelta: 0.5,
        timestamp: Date.now(),
      };

      const update = la.learn(evidence, 'proposer_match');
      expect(update).toBeNull();
    });
  });

  describe('Audit 2: Belief update actually changes Future Decision', () => {
    it('over-prediction reduces confidence → different candidate wins', async () => {
      const goal = ga.createGoal({
        description: 'D5 audit: learning changes decision',
        originalInput: 'test',
        executionDomain: 'desktop',
      });
      const sa = StateAuthority.getInstance();
      const snapshot = await sa.captureSnapshot([goal.goalId]);

      const proposerA = 'proposer_A';
      const proposerB = 'proposer_B';

      const evidence: GoalEvidence = {
        evidenceId: 'E_d5_2',
        goalId: goal.goalId,
        decisionId: 'D_d5_past',
        observation: 'proposer A failed before',
        action: { type: 'desktop_action', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.2,
        timestamp: Date.now(),
      };
      la.learn(evidence, proposerA);

      const candidateA: DecisionCandidate = {
        candidateId: 'C_A',
        proposerId: proposerA,
        action: { type: 'desktop_action', payload: { cmd: 'action_A' } },
        confidence: 0.6,
        reasoning: 'A proposes this',
        estimatedGoalProgress: 0.3,
      };

      const candidateB: DecisionCandidate = {
        candidateId: 'C_B',
        proposerId: proposerB,
        action: { type: 'tool_call', payload: { cmd: 'action_B' } },
        confidence: 0.5,
        reasoning: 'B proposes this',
        estimatedGoalProgress: 0.5,
      };

      const adjustedA = la.adjustCandidate(candidateA);
      expect(adjustedA.confidence).toBeLessThan(candidateA.confidence);

      const decision = await da.decide({
        goalId: goal.goalId,
        snapshot,
        decisionType: DecisionType.ACTION,
        candidates: [candidateA, candidateB],
      });

      expect(decision.chosen.proposerId).toBe(proposerB);
    });

    it('under-prediction increases confidence → same proposer wins more', async () => {
      const goal = ga.createGoal({
        description: 'D5 audit: under-prediction boost',
        originalInput: 'test',
        executionDomain: 'desktop',
      });
      const sa = StateAuthority.getInstance();
      const snapshot = await sa.captureSnapshot([goal.goalId]);

      const proposerC = 'proposer_C';

      const evidence: GoalEvidence = {
        evidenceId: 'E_d5_3',
        goalId: goal.goalId,
        decisionId: 'D_d5_past2',
        observation: 'proposer C succeeded beyond expectation',
        action: { type: 'composite', payload: {} },
        expectedEffect: 'partial',
        actualEffect: 'success',
        progressDelta: 0.8,
        timestamp: Date.now(),
      };
      la.learn(evidence, proposerC);

      const candidateC: DecisionCandidate = {
        candidateId: 'C_C',
        proposerId: proposerC,
        action: { type: 'composite', payload: { cmd: 'action_C' } },
        confidence: 0.5,
        reasoning: 'C proposes this',
        estimatedGoalProgress: 0.3,
      };

      const adjustedC = la.adjustCandidate(candidateC);
      expect(adjustedC.confidence).toBeGreaterThan(candidateC.confidence);
    });
  });

  describe('Audit 3: Full closure Evidence → Learn → Adjust → Decide', () => {
    it('GoalAuthority.updateFromEvidence triggers LearningAuthority.learn', () => {
      const goal = ga.createGoal({
        description: 'D5 full closure test',
        originalInput: 'test',
        executionDomain: 'desktop',
      });

      ga.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: 'D_closure',
        observation: 'task failed',
        action: { type: 'tool_call', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
      });

      expect(la.getBeliefCount()).toBeGreaterThan(0);
    });

    it('DecisionAuthority.decide applies LearningAuthority.adjustCandidate', async () => {
      const goal = ga.createGoal({
        description: 'D5 decide with learning',
        originalInput: 'test',
        executionDomain: 'desktop',
      });

      ga.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: 'D_before',
        observation: 'proposer_X failed',
        action: { type: 'desktop_action', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.2,
      });

      const sa = StateAuthority.getInstance();
      const snapshot = await sa.captureSnapshot([goal.goalId]);

      const decision = await da.decide({
        goalId: goal.goalId,
        snapshot,
        decisionType: DecisionType.ACTION,
        candidates: [
          {
            candidateId: 'C_X',
            proposerId: 'proposer_X',
            action: { type: 'desktop_action', payload: {} },
            confidence: 0.6,
            reasoning: 'X moderate confidence',
            estimatedGoalProgress: 0.2,
          },
          {
            candidateId: 'C_Y',
            proposerId: 'proposer_Y',
            action: { type: 'tool_call', payload: {} },
            confidence: 0.5,
            reasoning: 'Y moderate confidence',
            estimatedGoalProgress: 0.5,
          },
        ],
      });

      expect(decision.chosen.proposerId).toBe('proposer_Y');
    });
  });

  describe('Audit 4: Belief is not just cache — it has traceable history', () => {
    it('every BeliefUpdate has sourceEvidenceId/sourceGoalId/sourceDecisionId', () => {
      const evidence: GoalEvidence = {
        evidenceId: 'E_trace',
        goalId: 'G_trace',
        decisionId: 'D_trace',
        observation: 'trace test',
        action: { type: 'tool_call', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      la.learn(evidence, 'proposer_trace');

      const history = la.getBeliefHistory();
      expect(history.length).toBeGreaterThan(0);

      const lastUpdate = history[history.length - 1];
      expect(lastUpdate.sourceEvidenceId).toBe('E_trace');
      expect(lastUpdate.sourceGoalId).toBe('G_trace');
      expect(lastUpdate.sourceDecisionId).toBe('D_trace');
      expect(lastUpdate.beliefId).toBeTruthy();
      expect(lastUpdate.timestamp).toBeGreaterThan(0);
    });

    it('belief history is queryable by goalId', () => {
      const evidence: GoalEvidence = {
        evidenceId: 'E_query',
        goalId: 'G_query_target',
        decisionId: 'D_query',
        observation: 'query test',
        action: { type: 'tool_call', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      la.learn(evidence, 'proposer_query');

      const goalHistory = la.getBeliefHistoryForGoal('G_query_target');
      expect(goalHistory.length).toBeGreaterThan(0);
      expect(goalHistory[0].sourceGoalId).toBe('G_query_target');
    });
  });

  describe('Audit 5: Cross-task generalization — belief transfers across goals', () => {
    it('same proposer+actionType → same contextSignature → shared belief', () => {
      const evidence1: GoalEvidence = {
        evidenceId: 'E_cross1',
        goalId: 'G_task1',
        decisionId: 'D_cross1',
        observation: 'task 1 failed',
        action: { type: 'desktop_action', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.2,
        timestamp: Date.now(),
      };

      const evidence2: GoalEvidence = {
        evidenceId: 'E_cross2',
        goalId: 'G_task2',
        decisionId: 'D_cross2',
        observation: 'task 2 failed',
        action: { type: 'desktop_action', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.15,
        timestamp: Date.now(),
      };

      la.learn(evidence1, 'proposer_cross');
      la.learn(evidence2, 'proposer_cross');

      const belief = la.getBelief('proposer_cross::desktop_action');
      expect(belief).not.toBeNull();
      expect(belief!.sampleCount).toBe(2);
      expect(belief!.confidenceBias).toBeLessThan(0);

      const candidate: DecisionCandidate = {
        candidateId: 'C_new_task',
        proposerId: 'proposer_cross',
        action: { type: 'desktop_action', payload: {} },
        confidence: 0.8,
        reasoning: 'new task same proposer',
        estimatedGoalProgress: 0.5,
      };

      const adjusted = la.adjustCandidate(candidate);
      expect(adjusted.confidence).toBeLessThan(0.8);
    });
  });
});
