import {
  DecisionAuthority,
  GoalAuthority,
  StateAuthority,
} from '../../../src/authority';
import type {
  CanonicalDecisionSnapshot,
  Decision,
  DecisionCandidate,
} from '../../../src/authority';
import { DecisionType } from '../../../src/authority/types';
import { OrchestratorProposer } from '../../../src/authority/OrchestratorProposer';

function makeSnapshot(activeGoalIds: string[]): CanonicalDecisionSnapshot {
  return {
    snapshotId: `SS_${Date.now().toString(36)}`,
    timestamp: Date.now(),
    activeGoalIds,
    self: { agentId: 'test', activeGoalIds, currentStage: 'planning', safetyStatus: 'nominal' },
    world: { observation: null, platform: 'desktop', timestamp: Date.now() },
    memory: { relevantMemories: [], query: '', timestamp: Date.now() },
    context: { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now() },
    capabilities: { availableTools: [], availableSkills: [], desktopAvailable: true, bridgeAvailable: true },
  };
}

let counter = 0;
function makeCandidate(
  proposerId: string,
  confidence: number,
  estimatedProgress: number,
): DecisionCandidate {
  counter += 1;
  return {
    candidateId: `C_d4i3_${counter}`,
    proposerId,
    action: { type: 'composite', payload: { planType: 'decompose', taskCount: 2 } },
    confidence,
    reasoning: `${proposerId} proposes`,
    estimatedGoalProgress: estimatedProgress,
  };
}

describe('D4-I3 Orchestrator Integration', () => {
  let goalAuthority: GoalAuthority;
  let decisionAuthority: DecisionAuthority;
  let stateAuthority: StateAuthority;

  beforeEach(() => {
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    StateAuthority.resetInstance();
    goalAuthority = GoalAuthority.getInstance();
    decisionAuthority = DecisionAuthority.getInstance();
    stateAuthority = StateAuthority.getInstance();
    counter = 0;
  });

  afterAll(() => {
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    StateAuthority.resetInstance();
  });

  describe('D4-I3-1: decomposeGoal() cannot directly decide execution', () => {
    it('OrchestratorProposer output is DecisionCandidate, not direct execution', () => {
      const orchestratorCandidate = makeCandidate('orchestrator_proposer', 0.8, 0.3);
      expect(orchestratorCandidate.proposerId).toBe('orchestrator_proposer');
      expect(orchestratorCandidate.action.type).toBe('composite');
      expect(orchestratorCandidate.confidence).toBeLessThan(1);
    });

    it('OrchestratorProposer.propose() returns DecisionCandidate[]', async () => {
      const proposer = new OrchestratorProposer();
      proposer.setDecomposeFn(async () => [
        { id: 'T1', goal: 'step1', context: '', dependencies: [], priority: 5, status: 'pending' },
        { id: 'T2', goal: 'step2', context: '', dependencies: ['T1'], priority: 5, status: 'pending' },
      ]);

      const goal = goalAuthority.createGoal({ description: 'complex task', originalInput: 'complex task' });
      const snapshot = makeSnapshot([goal.goalId]);

      const candidates = await proposer.propose({ goalId: goal.goalId, snapshot, candidates: [] });

      expect(candidates.length).toBe(1);
      expect(candidates[0].proposerId).toBe('orchestrator_proposer');
      expect(candidates[0].action.type).toBe('composite');
      expect((candidates[0].action.payload as Record<string, unknown>).taskCount).toBe(2);
    });

    it('OrchestratorProposer with no decomposeFn returns empty', async () => {
      const proposer = new OrchestratorProposer();
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const candidates = await proposer.propose({ goalId: goal.goalId, snapshot, candidates: [] });
      expect(candidates).toEqual([]);
    });
  });

  describe('D4-I3-2: Plan Decision goes through DecisionAuthority', () => {
    it('plan decomposition must go through DecisionAuthority with DecisionType.PLAN', async () => {
      const goal = goalAuthority.createGoal({ description: 'organize files and send email', originalInput: '整理文件并发邮件' });
      const snapshot = makeSnapshot([goal.goalId]);

      const planCandidate = makeCandidate('orchestrator_proposer', 0.8, 0.3);
      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [planCandidate],
        decisionType: DecisionType.PLAN,
      });

      expect(decision.decisionId).toMatch(/^D_/);
      expect(decision.decisionType).toBe(DecisionType.PLAN);
      expect(decision.chosen.proposerId).toBe('orchestrator_proposer');
    });

    it('plan decision can be rejected if another proposer has better plan', async () => {
      const goal = goalAuthority.createGoal({ description: 'complex task', originalInput: '复杂任务' });
      const snapshot = makeSnapshot([goal.goalId]);

      const orchestratorCandidate = makeCandidate('orchestrator_proposer', 0.5, 0.2);
      const ruleCandidate = makeCandidate('rule_proposer', 0.9, 0.7);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [orchestratorCandidate, ruleCandidate],
        decisionType: DecisionType.PLAN,
      });

      expect(decision.decisionType).toBe(DecisionType.PLAN);
      expect(decision.chosen.proposerId).toBe('rule_proposer');
    });
  });

  describe('D4-I3-3: Action Decision vs Plan Decision distinction', () => {
    it('DecisionType.PLAN and DecisionType.ACTION produce different decision types', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const candidate = makeCandidate('skill_proposer', 0.9, 0.5);

      const planDecision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [candidate],
        decisionType: DecisionType.PLAN,
      });

      const goal2 = goalAuthority.createGoal({ description: 'test2', originalInput: 'test2' });
      const snapshot2 = makeSnapshot([goal2.goalId]);
      const candidate2 = makeCandidate('skill_proposer', 0.9, 0.5);

      const actionDecision = await decisionAuthority.decide({
        goalId: goal2.goalId,
        snapshot: snapshot2,
        candidates: [candidate2],
        decisionType: DecisionType.ACTION,
      });

      expect(planDecision.decisionType).toBe(DecisionType.PLAN);
      expect(actionDecision.decisionType).toBe(DecisionType.ACTION);
      expect(planDecision.decisionId).not.toBe(actionDecision.decisionId);
    });

    it('default decisionType is ACTION when not specified', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const candidate = makeCandidate('skill_proposer', 0.9, 0.5);
      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [candidate],
      });

      expect(decision.decisionType).toBe(DecisionType.ACTION);
    });
  });

  describe('D4-I3-4: OrchestratorProposer is pure proposer (anti-bypass)', () => {
    it('OrchestratorProposer does not call executeAction or dispatch', () => {
      const proposer = new OrchestratorProposer();
      expect(typeof proposer.propose).toBe('function');
      expect(typeof proposer.setDecomposeFn).toBe('function');
      expect((proposer as unknown as Record<string, unknown>).executeAction).toBeUndefined();
      expect((proposer as unknown as Record<string, unknown>).dispatch).toBeUndefined();
    });

    it('OrchestratorProposer cannot self-execute — only generates candidates', async () => {
      const proposer = new OrchestratorProposer();
      proposer.setDecomposeFn(async () => [
        { id: 'T1', goal: 'step1', context: '', dependencies: [], priority: 5, status: 'pending' },
      ]);

      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const candidates = await proposer.propose({ goalId: goal.goalId, snapshot, candidates: [] });

      expect(candidates.length).toBe(1);
      expect(candidates[0].action.type).toBe('composite');
      expect(candidates[0].confidence).toBeLessThan(1);
      expect(candidates[0].estimatedGoalProgress).toBeLessThan(1);
    });

    it('OrchestratorProposer handles decompose failure gracefully', async () => {
      const proposer = new OrchestratorProposer();
      proposer.setDecomposeFn(async () => {
        throw new Error('LLM unavailable');
      });

      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const candidates = await proposer.propose({ goalId: goal.goalId, snapshot, candidates: [] });
      expect(candidates).toEqual([]);
    });
  });

  describe('D4-I3: Full Orchestrator Authority Chain', () => {
    it('complete chain: Goal → Snapshot → OrchestratorProposer → Plan Decision → Tasks', async () => {
      const goal = goalAuthority.createGoal({ description: 'organize desktop and update software', originalInput: '整理桌面并更新软件' });
      const goalId = goal.goalId;

      const snapshot = await stateAuthority.captureSnapshot([goalId]);

      const proposer = new OrchestratorProposer();
      proposer.setDecomposeFn(async () => [
        { id: 'T1', goal: 'organize desktop', context: '', dependencies: [], priority: 5, status: 'pending' },
        { id: 'T2', goal: 'update software', context: '', dependencies: ['T1'], priority: 5, status: 'pending' },
      ]);

      const planCandidates = await proposer.propose({ goalId, snapshot, candidates: [] });
      expect(planCandidates.length).toBe(1);

      const planDecision = await decisionAuthority.decide({
        goalId,
        snapshot,
        candidates: planCandidates,
        decisionType: DecisionType.PLAN,
      });

      expect(planDecision.decisionType).toBe(DecisionType.PLAN);
      expect(planDecision.chosen.proposerId).toBe('orchestrator_proposer');
      expect(planDecision.goalId).toBe(goalId);

      const planPayload = planDecision.chosen.action.payload as Record<string, unknown>;
      expect(planPayload.taskCount).toBe(2);
      expect(planPayload.planType).toBe('decompose');

      goalAuthority.updateFromEvidence({
        goalId,
        decisionId: planDecision.decisionId,
        observation: 'plan created',
        action: planDecision.chosen.action,
        expectedEffect: 'create 2-task plan',
        actualEffect: 'plan created',
        progressDelta: 0.2,
      });

      const updatedGoal = goalAuthority.getGoal(goalId);
      expect(updatedGoal.progress).toBe(0.2);
    });
  });
});
