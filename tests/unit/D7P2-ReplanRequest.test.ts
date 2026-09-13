/**
 * D7-2: Goal Impact → ReplanRequest — 10 Gates + 3 Negative Gates
 *
 * G1:  unaffected → no ReplanRequest
 * G2:  affected but ordinary file modification → goal_replan_suggested, no goal_replan_requested
 * G3:  explicit binding + strong invalidation signal → ReplanRequest
 * G4:  workspace_context + strong invalidation → ReplanRequest
 * G5:  inferred binding → no ReplanRequest
 * G6:  same goalId+planVersion+observationId → only one ReplanRequest
 * G7:  different observationId → can generate another request
 * G8:  planVersion recorded correctly
 * G9:  GoalAuthority.replan() not called
 * G10: DecisionAuthority/ActionAuthority/Tool/Desktop/Shell not called
 *
 * R1: goal_replan_suggested → planVersion unchanged
 * R2: goal_replan_requested → planVersion still unchanged
 * R3: D7-2 complete run → Goal status/progress/bindings unchanged
 */

jest.mock('../../src/utils/Logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { __esModule: true, default: mockLogger, Logger: mockLogger };
});

jest.mock('../../src/shared/EventBus', () => {
  const mockInstance = { emit: jest.fn(), on: jest.fn() };
  return { __esModule: true, default: mockInstance, EventBus: mockInstance };
});

jest.mock('../../src/ide/bridgeRegistry', () => ({
  getActivePythonBridge: jest.fn(),
}));

import { GoalAuthority } from '../../src/authority/GoalAuthority';
import {
  GoalStatus,
  GoalPriority,
  GoalImpactType,
} from '../../src/authority/types';
import type {
  Goal,
  GoalBinding,
  GoalImpact,
  ReplanRequest,
  WorldObservation,
  GoalEvidence,
} from '../../src/authority/types';
import {
  getGoalImpactEvaluator,
  resetGoalImpactEvaluator,
} from '../../src/authority/GoalImpactEvaluator';
import {
  getReplanEvaluator,
  resetReplanEvaluator,
} from '../../src/authority/ReplanEvaluator';

describe('D7-2: Goal Impact → ReplanRequest', () => {
  beforeEach(() => {
    GoalAuthority.resetInstance();
    resetGoalImpactEvaluator();
    resetReplanEvaluator();
  });

  describe('G1: unaffected → no ReplanRequest', () => {
    it('returns null when impact.affected is false', () => {
      const ga = GoalAuthority.getInstance();
      const evaluator = getReplanEvaluator();

      const goal = ga.createGoal({
        description: 'Unaffected goal',
        originalInput: 'Unaffected goal',
        executionDomain: 'desktop',
      });

      const impact: GoalImpact = {
        goalId: goal.goalId,
        observationId: 'OBS_1',
        affected: false,
        impactType: 'file_change',
        reason: 'no_match',
        confidence: 0,
      };

      const result = evaluator.evaluate(goal, impact, []);
      expect(result).toBeNull();
    });
  });

  describe('G2: affected but ordinary file modification → no ReplanRequest', () => {
    it('ordinary file change does not produce ReplanRequest', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repositoryPath: '/home/user/project',
        paths: ['/home/user/project/src'],
        resources: ['project:proj-1'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Goal in project',
        originalInput: 'Goal in project',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const observation: WorldObservation = {
        observationId: 'OBS_file_mod',
        source: 'file',
        type: 'file_changed',
        timestamp: new Date().toISOString(),
        payload: { filePath: '/home/user/project/src/index.ts', changeType: 'modified' },
      };

      const impacts = impactEvaluator.evaluate([goal], observation);
      expect(impacts.length).toBe(1);
      expect(impacts[0].affected).toBe(true);

      const replanResult = replanEvaluator.evaluate(goal, impacts[0], []);
      expect(replanResult).toBeNull();
    });
  });

  describe('G3: explicit binding + strong invalidation signal → ReplanRequest', () => {
    it('git structural change on bound repository produces ReplanRequest', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'my-repo',
        repositoryPath: '/home/user/my-repo',
        paths: ['/home/user/my-repo/src'],
        resources: ['repo:my-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Goal in my-repo',
        originalInput: 'Goal in my-repo',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const observation: WorldObservation = {
        observationId: 'OBS_git_struct',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'my-repo', branch: 'main', hasUncommitted: true }] },
      };

      const impacts = impactEvaluator.evaluate([goal], observation);
      expect(impacts.length).toBe(1);
      expect(impacts[0].affected).toBe(true);

      const replanResult = replanEvaluator.evaluate(goal, impacts[0], []);
      expect(replanResult).not.toBeNull();
      expect(replanResult!.goalId).toBe(goal.goalId);
      expect(replanResult!.planVersion).toBe(1);
      expect(replanResult!.reason).toContain('bound_repository_structural_change');
    });
  });

  describe('G4: workspace_context + strong invalidation → ReplanRequest', () => {
    it('workspace_context binding with git structural change produces ReplanRequest', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'workspace-repo',
        repositoryPath: '/projects/workspace-repo',
        resources: ['project:ws-1'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Goal in workspace project',
        originalInput: 'Goal in workspace project',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const observation: WorldObservation = {
        observationId: 'OBS_git_ws',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'workspace-repo', branch: 'develop', hasUncommitted: false }] },
      };

      const impacts = impactEvaluator.evaluate([goal], observation);
      expect(impacts[0].affected).toBe(true);

      const replanResult = replanEvaluator.evaluate(goal, impacts[0], []);
      expect(replanResult).not.toBeNull();
      expect(replanResult!.goalId).toBe(goal.goalId);
      expect(replanResult!.reason).toContain('bound_repository_structural_change');
    });
  });

  describe('G5: inferred binding → no ReplanRequest', () => {
    it('inferred-only impact never produces ReplanRequest', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const goal = ga.createGoal({
        description: 'Goal about repo:inferred-repo at /path/inferred',
        originalInput: 'Goal about repo:inferred-repo at /path/inferred',
        executionDomain: 'desktop',
      });

      const observation: WorldObservation = {
        observationId: 'OBS_inferred',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'inferred-repo' }] },
      };

      const impacts = impactEvaluator.evaluate([goal], observation);
      expect(impacts.length).toBe(1);
      expect(impacts[0].affected).toBe(true);
      expect(impacts[0].reason).toContain('inferred');

      const replanResult = replanEvaluator.evaluate(goal, impacts[0], []);
      expect(replanResult).toBeNull();
    });
  });

  describe('G6: same goalId+planVersion+observationId → only one ReplanRequest', () => {
    it('duplicate evaluation returns null', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'dedup-repo',
        repositoryPath: '/dedup/repo',
        resources: ['repo:dedup-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Dedup test goal',
        originalInput: 'Dedup test goal',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const observation: WorldObservation = {
        observationId: 'OBS_dedup',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'dedup-repo' }] },
      };

      const impacts = impactEvaluator.evaluate([goal], observation);
      const first = replanEvaluator.evaluate(goal, impacts[0], []);
      expect(first).not.toBeNull();

      const second = replanEvaluator.evaluate(goal, impacts[0], []);
      expect(second).toBeNull();
    });
  });

  describe('G7: different observationId → can generate another request', () => {
    it('different observation produces different ReplanRequest', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'multi-obs-repo',
        repositoryPath: '/multi/obs',
        resources: ['repo:multi-obs-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Multi observation goal',
        originalInput: 'Multi observation goal',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const obs1: WorldObservation = {
        observationId: 'OBS_1',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'multi-obs-repo' }] },
      };

      const obs2: WorldObservation = {
        observationId: 'OBS_2',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'multi-obs-repo' }] },
      };

      const impacts1 = impactEvaluator.evaluate([goal], obs1);
      const impacts2 = impactEvaluator.evaluate([goal], obs2);

      const req1 = replanEvaluator.evaluate(goal, impacts1[0], []);
      expect(req1).not.toBeNull();

      const req2 = replanEvaluator.evaluate(goal, impacts2[0], []);
      expect(req2).not.toBeNull();
      expect(req2!.requestId).not.toBe(req1!.requestId);
      expect(req2!.observationId).toBe('OBS_2');
    });
  });

  describe('G8: planVersion recorded correctly', () => {
    it('request.planVersion matches goal.planVersion at creation time', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'pv-repo',
        repositoryPath: '/pv/repo',
        resources: ['repo:pv-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'PlanVersion test',
        originalInput: 'PlanVersion test',
        executionDomain: 'desktop',
        bindings: binding,
      });

      expect(goal.planVersion).toBe(1);

      const observation: WorldObservation = {
        observationId: 'OBS_pv',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'pv-repo' }] },
      };

      const impacts = impactEvaluator.evaluate([goal], observation);
      const req = replanEvaluator.evaluate(goal, impacts[0], []);

      expect(req).not.toBeNull();
      expect(req!.planVersion).toBe(1);
    });
  });

  describe('G9: GoalAuthority.replan() not called', () => {
    it('ReplanEvaluator never calls GoalAuthority.replan()', () => {
      const ga = GoalAuthority.getInstance();
      const replanEvaluator = getReplanEvaluator();
      const replanSpy = jest.spyOn(ga, 'replan');

      const binding: GoalBinding = {
        repository: 'no-replan-repo',
        repositoryPath: '/no/replan',
        resources: ['repo:no-replan-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'No replan call test',
        originalInput: 'No replan call test',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const impact: GoalImpact = {
        goalId: goal.goalId,
        observationId: 'OBS_test',
        affected: true,
        impactType: 'git_change',
        reason: 'goal_bindings_match[explicit]: repo:no-replan-repo',
        confidence: 0.9,
      };

      replanEvaluator.evaluate(goal, impact, []);

      expect(replanSpy).not.toHaveBeenCalled();
      replanSpy.mockRestore();
    });
  });

  describe('G10: DecisionAuthority/ActionAuthority/Tool/Desktop/Shell not called', () => {
    it('ReplanEvaluator has zero external side effects', () => {
      const ga = GoalAuthority.getInstance();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'pure-repo',
        repositoryPath: '/pure/repo',
        resources: ['repo:pure-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Pure evaluation test',
        originalInput: 'Pure evaluation test',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const impact: GoalImpact = {
        goalId: goal.goalId,
        observationId: 'OBS_pure',
        affected: true,
        impactType: 'git_change',
        reason: 'goal_bindings_match[explicit]: repo:pure-repo',
        confidence: 0.9,
      };

      const beforeGoal = ga.getGoal(goal.goalId)!;
      const beforeStatus = beforeGoal.status;
      const beforeProgress = beforeGoal.progress;
      const beforePlanVersion = beforeGoal.planVersion;
      const beforeBindings = beforeGoal.bindings;

      replanEvaluator.evaluate(goal, impact, []);

      const afterGoal = ga.getGoal(goal.goalId)!;
      expect(afterGoal.status).toBe(beforeStatus);
      expect(afterGoal.progress).toBe(beforeProgress);
      expect(afterGoal.planVersion).toBe(beforePlanVersion);
      expect(afterGoal.bindings).toBe(beforeBindings);
    });
  });

  describe('R1: goal_replan_suggested → planVersion unchanged', () => {
    it('receiving goal_replan_suggested does not change planVersion', () => {
      const ga = GoalAuthority.getInstance();

      const goal = ga.createGoal({
        description: 'R1 test',
        originalInput: 'R1 test',
        executionDomain: 'desktop',
      });

      const beforePV = goal.planVersion;

      const impact: GoalImpact = {
        goalId: goal.goalId,
        observationId: 'OBS_r1',
        affected: true,
        impactType: 'file_change',
        reason: 'some_match',
        confidence: 0.5,
      };

      const afterGoal = ga.getGoal(goal.goalId)!;
      expect(afterGoal.planVersion).toBe(beforePV);
    });
  });

  describe('R2: goal_replan_requested → planVersion still unchanged', () => {
    it('producing ReplanRequest does not change planVersion', () => {
      const ga = GoalAuthority.getInstance();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'r2-repo',
        repositoryPath: '/r2/repo',
        resources: ['repo:r2-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'R2 test',
        originalInput: 'R2 test',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const beforePV = goal.planVersion;

      const impact: GoalImpact = {
        goalId: goal.goalId,
        observationId: 'OBS_r2',
        affected: true,
        impactType: 'git_change',
        reason: 'goal_bindings_match[explicit]: repo:r2-repo',
        confidence: 0.9,
      };

      replanEvaluator.evaluate(goal, impact, []);

      const afterGoal = ga.getGoal(goal.goalId)!;
      expect(afterGoal.planVersion).toBe(beforePV);
    });
  });

  describe('R3: D7-2 complete run → Goal status/progress/bindings unchanged', () => {
    it('full D7-2 flow preserves all Goal fields', () => {
      const ga = GoalAuthority.getInstance();
      const impactEvaluator = getGoalImpactEvaluator();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'r3-repo',
        repositoryPath: '/r3/repo',
        paths: ['/r3/repo/src'],
        resources: ['repo:r3-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'R3 full flow test',
        originalInput: 'R3 full flow test',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const beforeStatus = goal.status;
      const beforeProgress = goal.progress;
      const beforePlanVersion = goal.planVersion;
      const beforeBindings = goal.bindings;

      const observation: WorldObservation = {
        observationId: 'OBS_r3',
        source: 'git',
        type: 'git_change',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'r3-repo' }] },
      };

      const impacts = impactEvaluator.evaluate([goal], observation);
      replanEvaluator.evaluate(goal, impacts[0], []);

      const afterGoal = ga.getGoal(goal.goalId)!;
      expect(afterGoal.status).toBe(beforeStatus);
      expect(afterGoal.progress).toBe(beforeProgress);
      expect(afterGoal.planVersion).toBe(beforePlanVersion);
      expect(afterGoal.bindings?.repository).toBe(beforeBindings?.repository);
      expect(afterGoal.bindings?.source).toBe(beforeBindings?.source);
    });
  });

  describe('Consecutive negative evidence → ReplanRequest', () => {
    it('2+ recent evidence with delta <= -0.3 produces ReplanRequest', () => {
      const ga = GoalAuthority.getInstance();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'neg-repo',
        repositoryPath: '/neg/repo',
        resources: ['repo:neg-repo'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Negative evidence goal',
        originalInput: 'Negative evidence goal',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const evidence: GoalEvidence[] = [
        {
          evidenceId: 'E_1',
          goalId: goal.goalId,
          decisionId: 'D_1',
          observation: null,
          action: { type: 'tool_call', payload: {} },
          expectedEffect: 'success',
          actualEffect: 'failed',
          progressDelta: -0.4,
          timestamp: Date.now() - 2000,
        },
        {
          evidenceId: 'E_2',
          goalId: goal.goalId,
          decisionId: 'D_2',
          observation: null,
          action: { type: 'tool_call', payload: {} },
          expectedEffect: 'success',
          actualEffect: 'failed',
          progressDelta: -0.5,
          timestamp: Date.now() - 1000,
        },
      ];

      const impact: GoalImpact = {
        goalId: goal.goalId,
        observationId: 'OBS_neg',
        affected: true,
        impactType: 'file_change',
        reason: 'goal_bindings_match[workspace_context]: repo:neg-repo',
        confidence: 0.5,
      };

      const result = replanEvaluator.evaluate(goal, impact, evidence);
      expect(result).not.toBeNull();
      expect(result!.reason).toContain('consecutive_negative_evidence');
    });
  });

  describe('Non-ACTIVE goal → no ReplanRequest', () => {
    it('COMPLETED goal never produces ReplanRequest', () => {
      const ga = GoalAuthority.getInstance();
      const replanEvaluator = getReplanEvaluator();

      const binding: GoalBinding = {
        repository: 'completed-repo',
        repositoryPath: '/completed/repo',
        resources: ['repo:completed-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Completed goal',
        originalInput: 'Completed goal',
        executionDomain: 'desktop',
        bindings: binding,
      });

      ga.markCompleted(goal.goalId, 'done');

      const impact: GoalImpact = {
        goalId: goal.goalId,
        observationId: 'OBS_completed',
        affected: true,
        impactType: 'git_change',
        reason: 'goal_bindings_match[explicit]: repo:completed-repo',
        confidence: 0.9,
      };

      const result = replanEvaluator.evaluate(ga.getGoal(goal.goalId)!, impact, []);
      expect(result).toBeNull();
    });
  });
});
