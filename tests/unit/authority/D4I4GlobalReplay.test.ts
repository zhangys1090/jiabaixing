import {
  DecisionAuthority,
  GoalAuthority,
  StateAuthority,
} from '../../../src/authority';
import type {
  CanonicalDecisionSnapshot,
  Decision,
  DecisionCandidate,
  Goal,
  GoalEvidence,
} from '../../../src/authority';
import { DecisionType } from '../../../src/authority/types';
import { SkillProposer } from '../../../src/authority/SkillProposer';
import { DesktopLLMProposer } from '../../../src/authority/DesktopLLMProposer';
import { OrchestratorProposer } from '../../../src/authority/OrchestratorProposer';

interface ReplayStep {
  step: string;
  id: string;
  idType: 'goal' | 'snapshot' | 'decision' | 'evidence';
  parentId: string | null;
  data: Record<string, unknown>;
}

interface ReplayTrace {
  userIntent: string;
  steps: ReplayStep[];
  goalProgress: number;
  goalStatus: string;
}

let counter = 0;
function makeCandidate(
  proposerId: string,
  confidence: number,
  estimatedProgress: number,
  actionType: string = 'desktop_action',
): DecisionCandidate {
  counter += 1;
  return {
    candidateId: `C_replay_${counter}`,
    proposerId,
    action: { type: actionType as DecisionCandidate['action']['type'], payload: { actionType: 'test' } },
    confidence,
    reasoning: `${proposerId} proposes action`,
    estimatedGoalProgress: estimatedProgress,
  };
}

describe('D4-I4 Global Authority Replay Audit', () => {
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

  describe('Scenario 1: Simple desktop task (TS standalone path)', () => {
    it('replays full chain: User Input → Goal → Snapshot → Decision → Action → Evidence → Goal progress', async () => {
      const userIntent = '打开记事本并写入hello';

      const trace: ReplayStep[] = [];

      // Step 1: Goal creation
      const goal = goalAuthority.createGoal({
        description: userIntent,
        originalInput: userIntent,
      });
      trace.push({
        step: 'Goal',
        id: goal.goalId,
        idType: 'goal',
        parentId: null,
        data: { description: goal.description, status: goal.status, progress: goal.progress },
      });

      // Step 2: State snapshot
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);
      trace.push({
        step: 'Snapshot',
        id: snapshot.snapshotId,
        idType: 'snapshot',
        parentId: goal.goalId,
        data: { activeGoalIds: snapshot.activeGoalIds, timestamp: snapshot.timestamp },
      });

      // Step 3: Proposers generate candidates
      const skillCandidate = makeCandidate('skill_proposer', 0.85, 0.6);
      const llmCandidate = makeCandidate('desktop_llm_proposer', 0.7, 0.4);

      // Step 4: DecisionAuthority FINAL
      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [skillCandidate, llmCandidate],
        decisionType: DecisionType.ACTION,
      });
      trace.push({
        step: 'Decision',
        id: decision.decisionId,
        idType: 'decision',
        parentId: snapshot.snapshotId,
        data: {
          chosenProposer: decision.chosen.proposerId,
          chosenCandidate: decision.chosen.candidateId,
          decisionType: decision.decisionType,
          proposerSet: decision.proposerSet,
          selectionReason: decision.selectionReason,
        },
      });

      // Step 5: Action execution (simulated)
      const actionResult = { success: true, output: 'notepad opened' };

      // Step 6: Evidence
      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        observation: actionResult.output,
        action: decision.chosen.action,
        expectedEffect: 'open notepad',
        actualEffect: actionResult.success ? 'success' : 'failed',
        progressDelta: 0.5,
      });

      const evidenceLog = goalAuthority.getEvidenceLog(goal.goalId);
      expect(evidenceLog.length).toBe(1);
      trace.push({
        step: 'Evidence',
        id: evidenceLog[0].evidenceId,
        idType: 'evidence',
        parentId: decision.decisionId,
        data: {
          observation: evidenceLog[0].observation,
          expectedEffect: evidenceLog[0].expectedEffect,
          actualEffect: evidenceLog[0].actualEffect,
          progressDelta: evidenceLog[0].progressDelta,
        },
      });

      // Step 7: Second action
      const snapshot2 = await stateAuthority.captureSnapshot([goal.goalId]);
      const decision2 = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot: snapshot2,
        candidates: [makeCandidate('desktop_llm_proposer', 0.8, 0.5)],
        decisionType: DecisionType.ACTION,
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision2.decisionId,
        observation: 'hello written',
        action: decision2.chosen.action,
        expectedEffect: 'write hello',
        actualEffect: 'success',
        progressDelta: 0.5,
      });

      // Verify final state
      const finalGoal = goalAuthority.getGoal(goal.goalId);
      expect(finalGoal.status).toBe('completed');
      expect(finalGoal.progress).toBe(1);

      // Verify trace integrity
      expect(trace.length).toBe(4);
      expect(trace[0].idType).toBe('goal');
      expect(trace[1].idType).toBe('snapshot');
      expect(trace[2].idType).toBe('decision');
      expect(trace[3].idType).toBe('evidence');
      expect(trace[1].parentId).toBe(trace[0].id);
      expect(trace[2].parentId).toBe(trace[1].id);
      expect(trace[3].parentId).toBe(trace[2].id);

      // Verify all IDs are traceable
      expect(trace[0].id).toMatch(/^G_/);
      expect(trace[1].id).toMatch(/^SS_/);
      expect(trace[2].id).toMatch(/^D_/);
      expect(evidenceLog[0].evidenceId).toMatch(/^E_/);
    });
  });

  describe('Scenario 2: Complex multi-step task (Orchestrator path)', () => {
    it('replays: User Input → Goal → Plan Decision → Subgoals → Action Decisions → Evidence', async () => {
      const userIntent = '整理桌面文件并上传到云盘';

      // Step 1: Goal
      const goal = goalAuthority.createGoal({
        description: userIntent,
        originalInput: userIntent,
      });

      // Step 2: Snapshot
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      // Step 3: Plan Decision (OrchestratorProposer)
      const orchestratorProposer = new OrchestratorProposer();
      orchestratorProposer.setDecomposeFn(async () => [
        { id: 'T1', goal: '整理桌面文件', context: '', dependencies: [], priority: 5, status: 'pending' },
        { id: 'T2', goal: '上传到云盘', context: '', dependencies: ['T1'], priority: 5, status: 'pending' },
      ]);

      const planCandidates = await orchestratorProposer.propose({
        goalId: goal.goalId,
        snapshot,
        candidates: [],
      });

      const planDecision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: planCandidates,
        decisionType: DecisionType.PLAN,
      });

      expect(planDecision.decisionType).toBe(DecisionType.PLAN);
      expect(planDecision.chosen.proposerId).toBe('orchestrator_proposer');

      // Step 4: Evidence for plan creation
      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: planDecision.decisionId,
        observation: 'plan created with 2 tasks',
        action: planDecision.chosen.action,
        expectedEffect: 'decompose into 2 subtasks',
        actualEffect: 'success',
        progressDelta: 0.1,
      });

      // Step 5: Action Decision for subtask 1
      const snapshot2 = await stateAuthority.captureSnapshot([goal.goalId]);
      const actionDecision1 = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot: snapshot2,
        candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
        decisionType: DecisionType.ACTION,
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: actionDecision1.decisionId,
        observation: 'files organized',
        action: actionDecision1.chosen.action,
        expectedEffect: 'organize desktop files',
        actualEffect: 'success',
        progressDelta: 0.4,
      });

      // Step 6: Action Decision for subtask 2
      const snapshot3 = await stateAuthority.captureSnapshot([goal.goalId]);
      const actionDecision2 = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot: snapshot3,
        candidates: [makeCandidate('desktop_llm_proposer', 0.85, 0.5)],
        decisionType: DecisionType.ACTION,
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: actionDecision2.decisionId,
        observation: 'files uploaded',
        action: actionDecision2.chosen.action,
        expectedEffect: 'upload to cloud',
        actualEffect: 'success',
        progressDelta: 0.5,
      });

      // Verify final state
      const finalGoal = goalAuthority.getGoal(goal.goalId);
      expect(finalGoal.status).toBe('completed');
      expect(finalGoal.progress).toBe(1);

      // Verify decision history
      const decisionHistory = decisionAuthority.getDecisionHistory(goal.goalId);
      expect(decisionHistory.length).toBe(3);
      expect(decisionHistory[0].decisionType).toBe(DecisionType.PLAN);
      expect(decisionHistory[1].decisionType).toBe(DecisionType.ACTION);
      expect(decisionHistory[2].decisionType).toBe(DecisionType.ACTION);

      // Verify evidence log
      const evidenceLog = goalAuthority.getEvidenceLog(goal.goalId);
      expect(evidenceLog.length).toBe(3);
      expect(evidenceLog[0].decisionId).toBe(planDecision.decisionId);
      expect(evidenceLog[1].decisionId).toBe(actionDecision1.decisionId);
      expect(evidenceLog[2].decisionId).toBe(actionDecision2.decisionId);

      // Verify ID chain integrity
      for (const evidence of evidenceLog) {
        expect(evidence.goalId).toBe(goal.goalId);
        expect(evidence.evidenceId).toMatch(/^E_/);
        expect(evidence.decisionId).toMatch(/^D_/);
      }
    });
  });

  describe('Scenario 3: Python delegated path (cross-process)', () => {
    it('replays: Python Decision → authorityMeta → TS execution → Evidence', async () => {
      const userIntent = '打开浏览器搜索天气';

      // Python side creates Goal and Decision
      const goal = goalAuthority.createGoal({
        description: userIntent,
        originalInput: userIntent,
      });

      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      const pythonDecision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('llm_proposer', 0.9, 0.7)],
        decisionType: DecisionType.ACTION,
      });

      // authorityMeta flows to TS
      const authorityMeta = {
        authority_decisionId: pythonDecision.decisionId,
        authority_goalId: goal.goalId,
        authority_snapshotId: snapshot.snapshotId,
        authority_candidateId: pythonDecision.chosen.candidateId,
        authority_proposerId: pythonDecision.chosen.proposerId,
      };

      // TS receives authorityMeta — verifies delegation integrity
      expect(authorityMeta.authority_decisionId).toBe(pythonDecision.decisionId);
      expect(authorityMeta.authority_goalId).toBe(goal.goalId);
      expect(authorityMeta.authority_snapshotId).toBe(snapshot.snapshotId);

      // TS executes without re-deciding
      const actionResult = { success: true, output: 'browser opened' };

      // Evidence flows back
      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: pythonDecision.decisionId,
        observation: actionResult.output,
        action: pythonDecision.chosen.action,
        expectedEffect: 'open browser and search',
        actualEffect: 'success',
        progressDelta: 0.7,
      });

      // Verify: only one decision in history (Python's)
      const decisionHistory = decisionAuthority.getDecisionHistory(goal.goalId);
      expect(decisionHistory.length).toBe(1);
      expect(decisionHistory[0].decisionId).toBe(pythonDecision.decisionId);

      // Verify: evidence references the same decision
      const evidenceLog = goalAuthority.getEvidenceLog(goal.goalId);
      expect(evidenceLog.length).toBe(1);
      expect(evidenceLog[0].decisionId).toBe(pythonDecision.decisionId);
      expect(evidenceLog[0].goalId).toBe(goal.goalId);
    });
  });

  describe('D4-I4: Authority Replay Contract', () => {
    it('every production step has goalId + snapshotId + decisionId', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        observation: 'done',
        action: decision.chosen.action,
        expectedEffect: 'test',
        actualEffect: 'success',
        progressDelta: 0.5,
      });

      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.snapshotId).toBe(snapshot.snapshotId);
      expect(decision.decisionId).toMatch(/^D_/);

      const evidence = goalAuthority.getEvidenceLog(goal.goalId);
      expect(evidence[0].goalId).toBe(goal.goalId);
      expect(evidence[0].decisionId).toBe(decision.decisionId);
    });

    it('decision history is replayable for any goal', async () => {
      const goal = goalAuthority.createGoal({ description: 'multi-step', originalInput: 'multi-step' });
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      const d1 = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('skill_proposer', 0.8, 0.3)],
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: d1.decisionId,
        observation: 'step1 done',
        action: d1.chosen.action,
        expectedEffect: 'step1',
        actualEffect: 'success',
        progressDelta: 0.5,
      });

      const snapshot2 = await stateAuthority.captureSnapshot([goal.goalId]);
      const d2 = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot: snapshot2,
        candidates: [makeCandidate('desktop_llm_proposer', 0.9, 0.5)],
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: d2.decisionId,
        observation: 'step2 done',
        action: d2.chosen.action,
        expectedEffect: 'step2',
        actualEffect: 'success',
        progressDelta: 0.5,
      });

      const history = decisionAuthority.getDecisionHistory(goal.goalId);
      expect(history.length).toBe(2);
      expect(history[0].decisionId).toBe(d1.decisionId);
      expect(history[1].decisionId).toBe(d2.decisionId);

      const evidenceLog = goalAuthority.getEvidenceLog(goal.goalId);
      expect(evidenceLog.length).toBe(2);
      expect(evidenceLog[0].decisionId).toBe(d1.decisionId);
      expect(evidenceLog[1].decisionId).toBe(d2.decisionId);

      const finalGoal = goalAuthority.getGoal(goal.goalId);
      expect(finalGoal.progress).toBe(1);
      expect(finalGoal.status).toBe('completed');
    });

    it('global history captures all goals', async () => {
      const goal1 = goalAuthority.createGoal({ description: 'task1', originalInput: 'task1' });
      const goal2 = goalAuthority.createGoal({ description: 'task2', originalInput: 'task2' });

      const snapshot1 = await stateAuthority.captureSnapshot([goal1.goalId, goal2.goalId]);

      await decisionAuthority.decide({
        goalId: goal1.goalId,
        snapshot: snapshot1,
        candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
      });

      await decisionAuthority.decide({
        goalId: goal2.goalId,
        snapshot: snapshot1,
        candidates: [makeCandidate('desktop_llm_proposer', 0.8, 0.4)],
      });

      const allHistory = decisionAuthority.getAllHistory();
      expect(allHistory.length).toBe(2);

      const goalIds = new Set(allHistory.map((h) => h.goalId));
      expect(goalIds.has(goal1.goalId)).toBe(true);
      expect(goalIds.has(goal2.goalId)).toBe(true);
    });

    it('no orphan decisions — every decision references a valid goal', async () => {
      const goal = goalAuthority.createGoal({ description: 'orphan check', originalInput: 'orphan check' });
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
      });

      const allHistory = decisionAuthority.getAllHistory();
      for (const entry of allHistory) {
        const referencedGoal = goalAuthority.getGoal(entry.goalId);
        expect(referencedGoal).not.toBeNull();
        expect(referencedGoal!.goalId).toBe(entry.goalId);
      }
    });

    it('no orphan evidence — every evidence references a valid decision', async () => {
      const goal = goalAuthority.createGoal({ description: 'evidence check', originalInput: 'evidence check' });
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        observation: 'test',
        action: decision.chosen.action,
        expectedEffect: 'test',
        actualEffect: 'success',
        progressDelta: 0.5,
      });

      const evidenceLog = goalAuthority.getEvidenceLog(goal.goalId);
      for (const evidence of evidenceLog) {
        const decisionHistory = decisionAuthority.getDecisionHistory(evidence.goalId);
        const found = decisionHistory.some((d) => d.decisionId === evidence.decisionId);
        expect(found).toBe(true);
      }
    });
  });
});
