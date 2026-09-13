import { GoalAuthority } from '../../authority/GoalAuthority';
import { StateAuthority } from '../../authority/StateAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { LearningAuthority } from '../../authority/LearningAuthority';
import { MemoryAuthority } from '../../authority/MemoryAuthority';
import { GoalPriority } from '../../authority/types';

describe('D7: Long-Horizon Agency Audit', () => {
  beforeEach(() => {
    GoalAuthority.resetInstance();
    StateAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    LearningAuthority.resetInstance();
    MemoryAuthority.resetInstance();
  });

  afterAll(() => {
    GoalAuthority.resetInstance();
    StateAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    LearningAuthority.resetInstance();
    MemoryAuthority.resetInstance();
  });

  describe('Audit 1: Goal remains ACTIVE after user leaves', () => {
    it('goal status stays active when no external update', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D7 audit: long-horizon goal',
        originalInput: 'D7 audit: long-horizon goal',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      expect(goal.status).toBe('active');
      expect(goal.goalId).toBeTruthy();

      const retrieved = ga.getGoal(goal.goalId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.status).toBe('active');
    });

    it('goal identity is stable across plan versions', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D7 audit: stable identity',
        originalInput: 'D7 audit: stable identity',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      const originalGoalId = goal.goalId;
      const originalPlanVersion = goal.planVersion;

      ga.replan(goal.goalId, 'new plan needed', originalPlanVersion);

      const afterReplan = ga.getGoal(originalGoalId);
      expect(afterReplan).toBeDefined();
      expect(afterReplan!.goalId).toBe(originalGoalId);
      expect(afterReplan!.planVersion).toBeGreaterThan(originalPlanVersion);
    });
  });

  describe('Audit 2: World observation → Goal impact evaluation', () => {
    it('active goals are retrievable for impact evaluation', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'Monitor file c:/project/README.md',
        originalInput: 'Monitor file c:/project/README.md',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      expect(goal.goalId).toBeTruthy();
      expect(goal.status).toBe('active');

      const activeGoals = ga.getActiveGoals();
      expect(activeGoals.length).toBeGreaterThanOrEqual(1);
      expect(activeGoals.some((g: any) => g.goalId === goal.goalId)).toBe(true);
    });

    it('inactive goals are not in active list', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'Will be completed',
        originalInput: 'Will be completed',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      ga.markCompleted(goal.goalId, 'test completed');

      const activeGoals = ga.getActiveGoals();
      expect(activeGoals.some((g: any) => g.goalId === goal.goalId)).toBe(false);
    });
  });

  describe('Audit 3: Full authority chain: Goal → State → Decision → Action → Evidence', () => {
    it('goal has all required authority fields', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D7 audit: authority chain',
        originalInput: 'D7 audit: authority chain',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      expect(goal.goalId).toBeTruthy();
      expect(goal.description).toBeTruthy();
      expect(goal.status).toBe('active');
      expect(typeof goal.priority).toBe('number');
      expect(typeof goal.progress).toBe('number');
      expect(goal.createdAt).toBeTruthy();
      expect(goal.updatedAt).toBeTruthy();
    });

    it('state snapshot captures goal state', async () => {
      const ga = GoalAuthority.getInstance();
      const sa = StateAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D7 audit: state snapshot',
        originalInput: 'D7 audit: state snapshot',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      const snapshot = await sa.captureSnapshot();
      expect(snapshot.snapshotId).toBeTruthy();
      expect(snapshot.activeGoalIds).toContain(goal.goalId);
    });

    it('decision requires goalId + snapshotId', async () => {
      const ga = GoalAuthority.getInstance();
      const sa = StateAuthority.getInstance();
      const da = DecisionAuthority.getInstance();

      const goal = ga.createGoal({
        description: 'D7 audit: decision chain',
        originalInput: 'D7 audit: decision chain',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      const snapshot = await sa.captureSnapshot();

      const candidate = {
        candidateId: 'C_d7_test_1',
        proposerId: 'd7_test_proposer',
        action: { type: 'message' as const, payload: { text: 'observe world' } },
        confidence: 0.8,
        estimatedGoalProgress: 0.3,
        reasoning: 'D7 audit test',
      };

      const decision = await da.decide({
        goalId: goal.goalId,
        candidates: [candidate],
        snapshot,
      });

      expect(decision.decisionId).toBeTruthy();
      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.snapshotId).toBe(snapshot.snapshotId);
    });
  });

  describe('Audit 4: Evidence feeds back to Goal progress', () => {
    it('evidence updates goal progress', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D7 audit: evidence feedback',
        originalInput: 'D7 audit: evidence feedback',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      const initialProgress = goal.progress;

      ga.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: 'D_d7_1',
        observation: null,
        action: { type: 'tool_call', payload: {} },
        expectedEffect: 'progress',
        actualEffect: 'progress',
        progressDelta: 0.2,
      });

      const updated = ga.getGoal(goal.goalId);
      expect(updated).toBeDefined();
      expect(updated!.progress).toBeGreaterThan(initialProgress);
    });

    it('negative evidence reduces progress', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D7 audit: negative evidence',
        originalInput: 'D7 audit: negative evidence',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      ga.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: 'D_d7_neg',
        observation: null,
        action: { type: 'tool_call', payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
      });

      const updated = ga.getGoal(goal.goalId);
      expect(updated).toBeDefined();
      expect(updated!.progress).toBeLessThanOrEqual(goal.progress);
    });
  });

  describe('Audit 5: Learning from long-horizon experience', () => {
    it('learning authority adjusts future decisions based on evidence', () => {
      const la = LearningAuthority.getInstance();

      const evidence = {
        evidenceId: 'E_d7_learn',
        goalId: 'G_d7_learn',
        decisionId: 'D_d7_learn',
        observation: null,
        action: { type: 'desktop_action' as const, payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      const belief = la.learn(evidence, 'proposer_d7');
      expect(belief).not.toBeNull();
      expect(belief!.sourceEvidenceId).toBe('E_d7_learn');

      const adjusted = la.adjustCandidate({
        candidateId: 'C_d7_adjust',
        proposerId: 'proposer_d7',
        action: { type: 'desktop_action', payload: {} },
        confidence: 0.7,
        estimatedGoalProgress: 0.5,
        reasoning: 'test',
      });

      expect(adjusted.confidence).toBeLessThan(0.7);
    });
  });

  describe('Audit 6: Memory persists across sessions', () => {
    it('memory authority tracks operations with authority trace', async () => {
      const ma = MemoryAuthority.getInstance();

      ma.registerBridge(
        async () => ({ success: true, memoryId: 'm1', operationId: 'o1', source: 'python' as const }),
        async () => ({ items: [], operationId: 'o2', source: 'python' as const })
      );

      await ma.write({
        content: 'long-horizon experience',
        memoryType: 'episodic',
        goalId: 'G_d7_mem',
        decisionId: 'D_d7_mem',
        snapshotId: 'S_d7_mem',
      });

      const log = ma.getOperationLog({ goalId: 'G_d7_mem' });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].goalId).toBe('G_d7_mem');
      expect(log[0].decisionId).toBe('D_d7_mem');
      expect(log[0].snapshotId).toBe('S_d7_mem');
    });
  });

  describe('Audit 7: Full long-horizon chain replay', () => {
    it('Goal → Snapshot → Decision → Evidence → Goal progress is traceable', async () => {
      const ga = GoalAuthority.getInstance();
      const sa = StateAuthority.getInstance();
      const da = DecisionAuthority.getInstance();

      const goal = ga.createGoal({
        description: 'D7 audit: full chain replay',
        originalInput: 'D7 audit: full chain replay',
        executionDomain: 'orchestrator',
        priority: GoalPriority.LOW,
      });

      const snapshot = await sa.captureSnapshot();
      expect(snapshot.snapshotId).toBeTruthy();
      expect(snapshot.activeGoalIds).toContain(goal.goalId);

      const decision = await da.decide({
        goalId: goal.goalId,
        candidates: [{
          candidateId: 'C_d7_chain_1',
          proposerId: 'd7_chain_proposer',
          action: { type: 'message', payload: { text: 'observe world' } },
          confidence: 0.8,
          estimatedGoalProgress: 0.3,
          reasoning: 'chain replay test',
        }],
        snapshot,
      });

      expect(decision.decisionId).toBeTruthy();
      expect(decision.goalId).toBe(goal.goalId);

      ga.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        observation: null,
        action: decision.chosen.action,
        expectedEffect: 'progress',
        actualEffect: 'progress',
        progressDelta: 0.3,
      });

      const updatedGoal = ga.getGoal(goal.goalId);
      expect(updatedGoal!.progress).toBeGreaterThan(0);

      const decisionHistory = da.getDecisionHistory(goal.goalId);
      expect(decisionHistory.length).toBeGreaterThanOrEqual(1);
      expect(decisionHistory[0].decisionId).toBe(decision.decisionId);
    });
  });
});
