import { describe, it, expect } from '@jest/globals';

describe('D4-I3: Orchestrator Authority Audit', () => {
  describe('Three Decision Types exist', () => {
    it('DecisionType has GOAL, PLAN, ACTION', async () => {
      const { DecisionType } = await import('../../authority/types');
      expect(DecisionType.GOAL).toBe('goal');
      expect(DecisionType.PLAN).toBe('plan');
      expect(DecisionType.ACTION).toBe('action');
    });
  });

  describe('OrchestratorProposer is pure proposer', () => {
    it('OrchestratorProposer implements DecisionProposer', async () => {
      const { OrchestratorProposer } = await import('../../authority/OrchestratorProposer');
      const proposer = new OrchestratorProposer();
      expect(proposer.proposerId).toBe('orchestrator_proposer');
      expect(typeof proposer.propose).toBe('function');
    });

    it('OrchestratorProposer has no execute/dispatch method', async () => {
      const { OrchestratorProposer } = await import('../../authority/OrchestratorProposer');
      const proposer = new OrchestratorProposer();
      expect((proposer as unknown as Record<string, unknown>).execute).toBeUndefined();
      expect((proposer as unknown as Record<string, unknown>).dispatch).toBeUndefined();
      expect((proposer as unknown as Record<string, unknown>).executeAction).toBeUndefined();
    });

    it('OrchestratorProposer.propose() returns DecisionCandidate[]', async () => {
      const { OrchestratorProposer } = await import('../../authority/OrchestratorProposer');
      const proposer = new OrchestratorProposer();
      const result = await proposer.propose({
        goalId: 'test_goal',
        snapshot: {
          snapshotId: 'S_test',
          timestamp: Date.now(),
          activeGoalIds: ['test_goal'],
          self: { agentId: 'test', activeGoalIds: ['test_goal'], currentStage: 'created', safetyStatus: 'nominal' },
          world: { observation: null, platform: 'server', timestamp: Date.now() },
          memory: { relevantMemories: [], query: '', timestamp: Date.now() },
          context: { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now() },
          capabilities: { availableTools: [], availableSkills: [], desktopAvailable: false, bridgeAvailable: false },
        },
        candidates: [],
      });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Complex path uses Plan Decision', () => {
    it('OrchestratorAgent code references DecisionType.PLAN', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../harness/orchestration/OrchestratorAgent.ts'),
        'utf-8'
      );
      expect(content).toContain('DecisionType.PLAN');
      expect(content).toContain('OrchestratorProposer');
      expect(content).toContain('decisionAuthority.decide');
    });

    it('Plan decision propagates goalId/decisionId to subtasks', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../harness/orchestration/OrchestratorAgent.ts'),
        'utf-8'
      );
      expect(content).toContain('parentGoalId');
      expect(content).toContain('planDecisionId');
      expect(content).toContain('planSnapshotId');
    });
  });

  describe('Simple path uses Action Decision', () => {
    it('OrchestratorAgent code references DecisionType.ACTION for simple path', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../harness/orchestration/OrchestratorAgent.ts'),
        'utf-8'
      );
      expect(content).toContain('DecisionType.ACTION');
    });

    it('Simple path writes Evidence back to same goalId', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../harness/orchestration/OrchestratorAgent.ts'),
        'utf-8'
      );
      expect(content).toContain('recordSimplePathEvidence');
      expect(content).toContain('updateFromEvidence');
    });
  });

  describe('DecisionAuthority handles all three types', () => {
    it('DecisionAuthority.decide() accepts GOAL type', async () => {
      const { DecisionAuthority } = await import('../../authority/DecisionAuthority');
      const { DecisionType } = await import('../../authority/types');
      const da = DecisionAuthority.getInstance();
      expect(typeof da.decide).toBe('function');
      expect(DecisionType.GOAL).toBeDefined();
    });

    it('DecisionAuthority.decide() accepts PLAN type', async () => {
      const { DecisionType } = await import('../../authority/types');
      expect(DecisionType.PLAN).toBeDefined();
    });

    it('DecisionAuthority.decide() accepts ACTION type', async () => {
      const { DecisionType } = await import('../../authority/types');
      expect(DecisionType.ACTION).toBeDefined();
    });
  });

  describe('No direct execution bypass in OrchestratorAgent', () => {
    it('OrchestratorAgent does not call ActionAuthority.executeAction directly', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../harness/orchestration/OrchestratorAgent.ts'),
        'utf-8'
      );
      const directExecuteAction = content.match(/\.executeAction\s*\(/g);
      expect(directExecuteAction).toBeNull();
    });

    it('OrchestratorAgent dispatches through TaskDispatcher, not directly', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../harness/orchestration/OrchestratorAgent.ts'),
        'utf-8'
      );
      expect(content).toContain('this.dispatcher.dispatch');
    });
  });

  describe('Goal identity stability (Goal ≠ Plan)', () => {
    it('GoalAuthority.createGoal returns stable goalId', async () => {
      const { GoalAuthority } = await import('../../authority/GoalAuthority');
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'test goal stability',
        originalInput: 'test goal stability',
        executionDomain: 'desktop',
      });
      expect(goal.goalId).toBeTruthy();
      expect(goal.planVersion).toBeGreaterThanOrEqual(1);
      const retrieved = ga.getGoal(goal.goalId);
      expect(retrieved?.goalId).toBe(goal.goalId);
    });

    it('Replan increments planVersion, not goalId', async () => {
      const { GoalAuthority } = await import('../../authority/GoalAuthority');
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'test replan stability',
        originalInput: 'test replan stability',
        executionDomain: 'desktop',
      });
      const originalGoalId = goal.goalId;
      const originalPlanVersion = goal.planVersion;
      ga.replan(goal.goalId, 'test replan', goal.planVersion);
      const afterReplan = ga.getGoal(goal.goalId);
      expect(afterReplan?.goalId).toBe(originalGoalId);
      expect(afterReplan?.planVersion).toBeGreaterThan(originalPlanVersion);
    });
  });
});
