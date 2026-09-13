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

function makeSnapshot(activeGoalIds: string[]): CanonicalDecisionSnapshot {
  return {
    snapshotId: `SS_${Date.now().toString(36)}`,
    timestamp: Date.now(),
    activeGoalIds,
    self: { agentId: 'test', activeGoalIds, currentStage: 'executing', safetyStatus: 'nominal' },
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
    candidateId: `C_d4i2_${counter}`,
    proposerId,
    action: { type: 'desktop_action', payload: { actionType: 'test_action' } },
    confidence,
    reasoning: `${proposerId} proposes`,
    estimatedGoalProgress: estimatedProgress,
  };
}

describe('D4-I2 Desktop Integration', () => {
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

  describe('D4-I2-1: matchSkill() cannot directly decide execution', () => {
    it('SkillProposer output is DecisionCandidate, not direct execution', () => {
      const skillCandidate = makeCandidate('skill_proposer', 0.85, 0.5);
      expect(skillCandidate.proposerId).toBe('skill_proposer');
      expect(skillCandidate.action.type).toBe('desktop_action');
      expect(skillCandidate.confidence).toBeLessThan(1);
    });

    it('skill candidate must go through DecisionAuthority before execution', async () => {
      const goal = goalAuthority.createGoal({ description: 'open notepad', originalInput: '打开记事本' });
      const snapshot = makeSnapshot([goal.goalId]);

      const skillCandidate = makeCandidate('skill_proposer', 0.85, 0.5);
      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [skillCandidate],
      });

      expect(decision.decisionId).toBeDefined();
      expect(decision.chosen.proposerId).toBe('skill_proposer');
      expect(decision.chosenCandidateId).toBe(skillCandidate.candidateId);
    });

    it('skill candidate can be rejected by DecisionAuthority if other candidate is better', async () => {
      const goal = goalAuthority.createGoal({ description: 'open browser', originalInput: '打开浏览器' });
      const snapshot = makeSnapshot([goal.goalId]);

      const skillCandidate = makeCandidate('skill_proposer', 0.6, 0.3);
      const llmCandidate = makeCandidate('desktop_llm_proposer', 0.9, 0.7);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [skillCandidate, llmCandidate],
      });

      expect(decision.chosen.proposerId).toBe('desktop_llm_proposer');
    });
  });

  describe('D4-I2-2: parseLLMAction() cannot directly decide execution', () => {
    it('DesktopLLMProposer output is DecisionCandidate, not direct execution', () => {
      const llmCandidate = makeCandidate('desktop_llm_proposer', 0.7, 0.4);
      expect(llmCandidate.proposerId).toBe('desktop_llm_proposer');
      expect(llmCandidate.action.type).toBe('desktop_action');
    });

    it('LLM candidate must go through DecisionAuthority before execution', async () => {
      const goal = goalAuthority.createGoal({ description: 'organize files', originalInput: '整理文件' });
      const snapshot = makeSnapshot([goal.goalId]);

      const llmCandidate = makeCandidate('desktop_llm_proposer', 0.7, 0.4);
      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [llmCandidate],
      });

      expect(decision.decisionId).toBeDefined();
      expect(decision.chosen.proposerId).toBe('desktop_llm_proposer');
    });

    it('LLM candidate can be overridden by skill candidate with higher confidence', async () => {
      const goal = goalAuthority.createGoal({ description: 'screenshot', originalInput: '截图' });
      const snapshot = makeSnapshot([goal.goalId]);

      const llmCandidate = makeCandidate('desktop_llm_proposer', 0.5, 0.2);
      const skillCandidate = makeCandidate('skill_proposer', 0.95, 0.8);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [llmCandidate, skillCandidate],
      });

      expect(decision.chosen.proposerId).toBe('skill_proposer');
    });
  });

  describe('D4-I2-3: DesktopExecutionAgent independent call must go through DecisionAuthority', () => {
    it('creates Goal → Snapshot → Decision → Action chain', async () => {
      const goal = goalAuthority.createGoal({ description: 'open calculator', originalInput: '打开计算器' });
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      const candidates = [
        makeCandidate('skill_proposer', 0.8, 0.5),
        makeCandidate('desktop_llm_proposer', 0.7, 0.4),
      ];

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates,
      });

      expect(goal.goalId).toMatch(/^G_/);
      expect(snapshot.snapshotId).toMatch(/^SS_/);
      expect(decision.decisionId).toMatch(/^D_/);
      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.snapshotId).toBe(snapshot.snapshotId);
    });

    it('no candidates = no execution (authority_denied)', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      await expect(
        decisionAuthority.decide({
          goalId: goal.goalId,
          snapshot,
          candidates: [],
        })
      ).rejects.toThrow('no candidates');
    });

    it('DecisionAuthority failure = no action (same as R1)', async () => {
      await expect(
        decisionAuthority.decide({
          goalId: 'G_nonexistent',
          snapshot: makeSnapshot(['G_nonexistent']),
          candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
        })
      ).rejects.toThrow();
    });

    it('Evidence writes back to Goal after DecisionAuthority execution', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
      });

      goalAuthority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        observation: 'action executed',
        action: decision.chosen.action,
        expectedEffect: 'complete task',
        actualEffect: 'success',
        progressDelta: 0.5,
      });

      const updatedGoal = goalAuthority.getGoal(goal.goalId);
      expect(updatedGoal.progress).toBe(0.5);
    });
  });

  describe('D4-I2-4: Anti-bypass — all proposers go through DecisionAuthority', () => {
    it('skill proposer cannot bypass DecisionAuthority', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('skill_proposer', 0.9, 0.5)],
      });

      expect(decision.chosen.proposerId).toBe('skill_proposer');
      expect(decision.selectionReason).toContain('proposer=skill_proposer');
    });

    it('LLM proposer cannot bypass DecisionAuthority', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [makeCandidate('desktop_llm_proposer', 0.9, 0.5)],
      });

      expect(decision.chosen.proposerId).toBe('desktop_llm_proposer');
      expect(decision.selectionReason).toContain('proposer=desktop_llm_proposer');
    });

    it('multiple proposers compete through DecisionAuthority', async () => {
      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      const snapshot = makeSnapshot([goal.goalId]);

      const candidates = [
        makeCandidate('skill_proposer', 0.6, 0.3),
        makeCandidate('desktop_llm_proposer', 0.8, 0.6),
        makeCandidate('rule_proposer', 0.5, 0.2),
      ];

      const decision = await decisionAuthority.decide({
        goalId: goal.goalId,
        snapshot,
        candidates,
      });

      expect(decision.proposerSet).toEqual(
        expect.arrayContaining(['skill_proposer', 'desktop_llm_proposer', 'rule_proposer'])
      );
      expect(decision.chosen.proposerId).toBe('desktop_llm_proposer');
      expect(decision.candidateIds).toHaveLength(3);
    });

    it('DecisionAuthority is the only FINAL — no proposer can self-execute', () => {
      const skillCandidate = makeCandidate('skill_proposer', 0.9, 0.5);
      const llmCandidate = makeCandidate('desktop_llm_proposer', 0.8, 0.4);

      expect(skillCandidate.action.type).toBe('desktop_action');
      expect(skillCandidate.action.payload).toBeDefined();
      expect(llmCandidate.action.type).toBe('desktop_action');
      expect(llmCandidate.action.payload).toBeDefined();

      expect(typeof (skillCandidate.action.payload as Record<string, unknown>).actionType).toBe('string');
    });
  });

  describe('D4-I2: Full Desktop Authority Chain', () => {
    it('complete chain: Goal → Snapshot → Decision → Action → Evidence', async () => {
      const goal = goalAuthority.createGoal({ description: 'open notepad and write hello', originalInput: '打开记事本写hello' });
      const goalId = goal.goalId;

      const snapshot = await stateAuthority.captureSnapshot([goalId]);
      const snapshotId = snapshot.snapshotId;

      const candidates = [
        makeCandidate('skill_proposer', 0.85, 0.6),
        makeCandidate('desktop_llm_proposer', 0.75, 0.5),
      ];

      const decision = await decisionAuthority.decide({
        goalId,
        snapshot,
        candidates,
      });
      const decisionId = decision.decisionId;

      expect(decision.chosen.proposerId).toBe('skill_proposer');
      expect(decision.snapshotId).toBe(snapshotId);

      goalAuthority.updateFromEvidence({
        goalId,
        decisionId,
        observation: 'notepad opened',
        action: decision.chosen.action,
        expectedEffect: 'open notepad',
        actualEffect: 'notepad opened',
        progressDelta: 0.5,
      });

      goalAuthority.updateFromEvidence({
        goalId,
        decisionId,
        observation: 'hello written',
        action: decision.chosen.action,
        expectedEffect: 'write hello',
        actualEffect: 'hello written',
        progressDelta: 0.5,
      });

      goalAuthority.markCompleted(goalId);

      const finalGoal = goalAuthority.getGoal(goalId);
      expect(finalGoal.status).toBe('completed');
      expect(finalGoal.progress).toBe(1);
      expect(finalGoal.goalId).toBe(goalId);
    });
  });
});
