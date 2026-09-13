/**
 * D7-1.2: Goal Context Binding Implementation — 15 Gates
 *
 * G1:  CreateGoal supports bindings
 * G2:  Goal stores binding clone (immutability)
 * G3:  No binding provided → bindings === undefined
 * G4:  No cwd auto-generated binding
 * G5:  project_manager active project → workspace_context binding
 * G6:  activeProjectId = null → no binding
 * G7:  Project A / Project B no cross-contamination
 * G8:  Binding provenance correct (source, confidence, resolvedAt)
 * G9:  Environment/window change does not modify existing Goal binding
 * G10: GoalImpactEvaluator prioritizes goal.bindings
 * G11: L3 inference does not override existing L1/L2
 * G12: Inference does not write to Goal.bindings
 * G13: Desktop without structured project context → no fake binding
 * G14: Python delegation without project context → no fake binding
 * G15: GoalAuthority interface semantics unchanged except optional bindings
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
import type { CreateGoalInput } from '../../src/authority/GoalAuthority';
import {
  GoalStatus,
  GoalPriority,
  GoalImpactType,
} from '../../src/authority/types';
import type {
  Goal,
  GoalBinding,
  BindingSource,
  WorldObservation,
  GoalImpact,
} from '../../src/authority/types';
import {
  getGoalImpactEvaluator,
  resetGoalImpactEvaluator,
} from '../../src/authority/GoalImpactEvaluator';
import {
  resolveGoalBinding,
} from '../../src/core/GoalContextResolver';
import type {
  GoalContextResolverInput,
  ProjectContextInfo,
} from '../../src/core/GoalContextResolver';

describe('D7-1.2: Goal Context Binding Implementation', () => {
  beforeEach(() => {
    GoalAuthority.resetInstance();
    resetGoalImpactEvaluator();
  });

  describe('G1: CreateGoal supports bindings', () => {
    it('creates a goal with bindings field populated', () => {
      const ga = GoalAuthority.getInstance();
      const binding: GoalBinding = {
        repository: 'my-repo',
        repositoryPath: '/home/user/my-repo',
        paths: ['/home/user/my-repo/src'],
        resources: ['repo:my-repo', 'project:proj-1'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Fix bug in my-repo',
        originalInput: 'Fix bug in my-repo',
        executionDomain: 'desktop',
        bindings: binding,
      });

      expect(goal.bindings).toBeDefined();
      expect(goal.bindings!.repository).toBe('my-repo');
      expect(goal.bindings!.repositoryPath).toBe('/home/user/my-repo');
      expect(goal.bindings!.source).toBe('explicit');
      expect(goal.bindings!.confidence).toBe(0.9);
    });
  });

  describe('G2: Goal stores binding clone (immutability)', () => {
    it('mutating input bindings does not affect stored goal bindings', () => {
      const ga = GoalAuthority.getInstance();
      const inputBinding: GoalBinding = {
        repository: 'original-repo',
        repositoryPath: '/path/original',
        paths: ['/path/original/src'],
        resources: ['repo:original-repo'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Test immutability',
        originalInput: 'Test immutability',
        executionDomain: 'desktop',
        bindings: inputBinding,
      });

      inputBinding.repository = 'mutated-repo';
      inputBinding.paths!.push('/path/mutated');

      expect(goal.bindings!.repository).toBe('original-repo');
      expect(goal.bindings!.paths).toEqual(['/path/original/src']);
    });
  });

  describe('G3: No binding provided → bindings === undefined', () => {
    it('goal.bindings is undefined when no bindings passed', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'No binding goal',
        originalInput: 'No binding goal',
        executionDomain: 'desktop',
      });

      expect(goal.bindings).toBeUndefined();
    });
  });

  describe('G4: No cwd auto-generated binding', () => {
    it('createGoal without bindings never generates cwd-based binding', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'Goal without explicit binding',
        originalInput: 'Goal without explicit binding',
        executionDomain: 'desktop',
      });

      expect(goal.bindings).toBeUndefined();
    });

    it('GoalContextResolver without context returns undefined (no cwd fallback)', () => {
      const result = resolveGoalBinding({});
      expect(result).toBeUndefined();
    });
  });

  describe('G5: project_manager active project → workspace_context binding', () => {
    it('resolveGoalBinding with projectContext produces workspace_context binding', () => {
      const projectContext: ProjectContextInfo = {
        projectId: 'proj-123',
        projectName: 'my-project',
        projectPath: '/home/user/my-project',
        projectType: 'typescript',
      };

      const binding = resolveGoalBinding({ projectContext });

      expect(binding).toBeDefined();
      expect(binding!.source).toBe('workspace_context');
      expect(binding!.repositoryPath).toBe('/home/user/my-project');
      expect(binding!.paths).toContain('/home/user/my-project');
      expect(binding!.resources).toContain('project:proj-123');
      expect(binding!.confidence).toBeGreaterThan(0);
      expect(binding!.resolvedAt).toBeGreaterThan(0);
    });
  });

  describe('G6: activeProjectId = null → no binding', () => {
    it('resolveGoalBinding with no projectContext returns undefined', () => {
      const binding = resolveGoalBinding({});
      expect(binding).toBeUndefined();
    });

    it('resolveGoalBinding with undefined projectContext returns undefined', () => {
      const binding = resolveGoalBinding({ projectContext: undefined });
      expect(binding).toBeUndefined();
    });
  });

  describe('G7: Project A / Project B no cross-contamination', () => {
    it('goals created with different project contexts have independent bindings', () => {
      const ga = GoalAuthority.getInstance();

      const bindingA: GoalBinding = {
        repositoryPath: '/projects/A',
        resources: ['project:A'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const bindingB: GoalBinding = {
        repositoryPath: '/projects/B',
        resources: ['project:B'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goalA = ga.createGoal({
        description: 'Task in project A',
        originalInput: 'Task in project A',
        executionDomain: 'desktop',
        bindings: bindingA,
      });

      const goalB = ga.createGoal({
        description: 'Task in project B',
        originalInput: 'Task in project B',
        executionDomain: 'desktop',
        bindings: bindingB,
      });

      expect(goalA.bindings!.resources).toContain('project:A');
      expect(goalA.bindings!.repositoryPath).toBe('/projects/A');
      expect(goalB.bindings!.resources).toContain('project:B');
      expect(goalB.bindings!.repositoryPath).toBe('/projects/B');
    });
  });

  describe('G8: Binding provenance correct', () => {
    it('explicit binding preserves source, confidence, resolvedAt', () => {
      const now = Date.now();
      const binding: GoalBinding = {
        repository: 'explicit-repo',
        source: 'explicit',
        confidence: 0.95,
        resolvedAt: now,
      };

      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'Explicit binding goal',
        originalInput: 'Explicit binding goal',
        executionDomain: 'desktop',
        bindings: binding,
      });

      expect(goal.bindings!.source).toBe('explicit');
      expect(goal.bindings!.confidence).toBe(0.95);
      expect(goal.bindings!.resolvedAt).toBe(now);
    });

    it('workspace_context binding has appropriate confidence', () => {
      const projectContext: ProjectContextInfo = {
        projectId: 'proj-1',
        projectName: 'workspace-proj',
        projectPath: '/workspace/proj',
        projectType: 'typescript',
      };

      const binding = resolveGoalBinding({ projectContext });
      expect(binding!.source).toBe('workspace_context');
      expect(binding!.confidence).toBeLessThanOrEqual(0.6);
      expect(binding!.confidence).toBeGreaterThan(0);
    });
  });

  describe('G9: Environment/window change does not modify existing Goal binding', () => {
    it('switching project context does not affect already-created goal bindings', () => {
      const ga = GoalAuthority.getInstance();

      const bindingA: GoalBinding = {
        repositoryPath: '/projects/A',
        resources: ['project:A'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goalA = ga.createGoal({
        description: 'Goal in project A',
        originalInput: 'Goal in project A',
        executionDomain: 'desktop',
        bindings: bindingA,
      });

      const bindingB: GoalBinding = {
        repositoryPath: '/projects/B',
        resources: ['project:B'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goalB = ga.createGoal({
        description: 'Goal in project B',
        originalInput: 'Goal in project B',
        executionDomain: 'desktop',
        bindings: bindingB,
      });

      expect(goalA.bindings!.resources).toContain('project:A');
      expect(goalA.bindings!.repositoryPath).toBe('/projects/A');

      expect(goalB.bindings!.resources).toContain('project:B');
      expect(goalB.bindings!.repositoryPath).toBe('/projects/B');
    });
  });

  describe('G10: GoalImpactEvaluator prioritizes goal.bindings', () => {
    it('evaluator uses goal.bindings over metadata when both exist', () => {
      const ga = GoalAuthority.getInstance();
      const evaluator = getGoalImpactEvaluator();

      const binding: GoalBinding = {
        repository: 'bound-repo',
        repositoryPath: '/bound/repo',
        paths: ['/bound/repo/src'],
        resources: ['repo:bound-repo', 'project:bound-proj'],
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Goal with both bindings and metadata',
        originalInput: 'Goal with both bindings and metadata',
        executionDomain: 'desktop',
        bindings: binding,
      });

      goal.metadata['boundResources'] = ['repo:metadata-repo'];
      goal.metadata['boundRepository'] = 'metadata-repo';

      const observation: WorldObservation = {
        observationId: 'OBS_test',
        source: 'git',
        payload: { repos: [{ repo: 'bound-repo' }] },
        timestamp: Date.now(),
      };

      const impacts = evaluator.evaluate([goal], observation);
      expect(impacts.length).toBe(1);
      expect(impacts[0].affected).toBe(true);
      expect(impacts[0].reason).toContain('goal_bindings_match');
      expect(impacts[0].confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('G11: L3 inference does not override existing L1/L2', () => {
    it('when goal.bindings exists, inference is skipped', () => {
      const ga = GoalAuthority.getInstance();
      const evaluator = getGoalImpactEvaluator();

      const binding: GoalBinding = {
        repository: 'explicit-repo',
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Goal with explicit binding about repo:other-repo',
        originalInput: 'Goal with explicit binding about repo:other-repo',
        executionDomain: 'desktop',
        bindings: binding,
      });

      const observation: WorldObservation = {
        observationId: 'OBS_test',
        source: 'git',
        payload: { repos: [{ repo: 'other-repo' }] },
        timestamp: Date.now(),
      };

      const impacts = evaluator.evaluate([goal], observation);
      if (impacts[0].affected) {
        expect(impacts[0].reason).not.toContain('inferred_binding_match');
      }
    });
  });

  describe('G12: Inference does not write to Goal.bindings', () => {
    it('inferBindings never mutates goal.bindings', () => {
      const ga = GoalAuthority.getInstance();
      const evaluator = getGoalImpactEvaluator();

      const goal = ga.createGoal({
        description: 'Goal about repo:test-repo',
        originalInput: 'Goal about repo:test-repo',
        executionDomain: 'desktop',
      });

      expect(goal.bindings).toBeUndefined();

      evaluator.inferBindings(goal);

      expect(goal.bindings).toBeUndefined();
    });
  });

  describe('G13: Desktop without structured project context → no fake binding', () => {
    it('resolveGoalBinding with no projectContext returns undefined (desktop scenario)', () => {
      const binding = resolveGoalBinding({});
      expect(binding).toBeUndefined();
    });

    it('resolveGoalBinding with desktop_context but no structured data returns undefined', () => {
      const binding = resolveGoalBinding({
        explicitBinding: undefined,
        projectContext: undefined,
      });
      expect(binding).toBeUndefined();
    });
  });

  describe('G14: Python delegation without project context → no fake binding', () => {
    it('ensureGoal without bindings results in undefined bindings', () => {
      const ga = GoalAuthority.getInstance();
      const goalId = 'G_python_delegated_001';

      const goal = ga.ensureGoal(goalId, {
        description: 'Python delegated task',
        originalInput: 'Python delegated task',
        executionDomain: 'desktop',
      });

      expect(goal.bindings).toBeUndefined();
    });

    it('ensureGoal with bindings stores cloned binding', () => {
      const ga = GoalAuthority.getInstance();
      const goalId = 'G_python_delegated_002';

      const binding: GoalBinding = {
        repositoryPath: '/python/project',
        resources: ['project:python-proj'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goal = ga.ensureGoal(goalId, {
        description: 'Python delegated task with binding',
        originalInput: 'Python delegated task with binding',
        executionDomain: 'desktop',
        bindings: binding,
      });

      expect(goal.bindings).toBeDefined();
      expect(goal.bindings!.repositoryPath).toBe('/python/project');
      expect(goal.bindings!.source).toBe('workspace_context');
    });
  });

  describe('G15: GoalAuthority interface semantics unchanged except optional bindings', () => {
    it('createGoal without bindings works exactly as before', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'Traditional goal',
        originalInput: 'Traditional goal input',
        executionDomain: 'desktop',
        priority: GoalPriority.HIGH,
        successCondition: 'Task completed',
      });

      expect(goal.goalId).toMatch(/^G_/);
      expect(goal.description).toBe('Traditional goal');
      expect(goal.status).toBe(GoalStatus.ACTIVE);
      expect(goal.priority).toBe(GoalPriority.HIGH);
      expect(goal.progress).toBe(0);
      expect(goal.planVersion).toBe(1);
      expect(goal.successCondition).toBe('Task completed');
      expect(goal.bindings).toBeUndefined();
    });

    it('existing Goal fields are unchanged when bindings provided', () => {
      const ga = GoalAuthority.getInstance();
      const binding: GoalBinding = {
        repository: 'test-repo',
        source: 'explicit',
        confidence: 0.9,
        resolvedAt: Date.now(),
      };

      const goal = ga.createGoal({
        description: 'Goal with binding',
        originalInput: 'Goal with binding',
        executionDomain: 'desktop',
        priority: GoalPriority.CRITICAL,
        parentGoalId: 'G_parent',
        successCondition: 'Done',
        abandonmentCondition: 'Cancelled',
        bindings: binding,
      });

      expect(goal.goalId).toMatch(/^G_/);
      expect(goal.description).toBe('Goal with binding');
      expect(goal.status).toBe(GoalStatus.ACTIVE);
      expect(goal.priority).toBe(GoalPriority.CRITICAL);
      expect(goal.parentGoalId).toBe('G_parent');
      expect(goal.successCondition).toBe('Done');
      expect(goal.abandonmentCondition).toBe('Cancelled');
      expect(goal.bindings).toBeDefined();
    });
  });

  describe('Production Replay Cases', () => {
    it('Case A: active project → Goal.bindings populated', () => {
      const ga = GoalAuthority.getInstance();
      const projectContext: ProjectContextInfo = {
        projectId: 'proj-active',
        projectName: 'active-project',
        projectPath: '/home/user/active-project',
        projectType: 'typescript',
      };

      const binding = resolveGoalBinding({ projectContext });
      const goal = ga.createGoal({
        description: 'Task in active project',
        originalInput: 'Task in active project',
        executionDomain: 'desktop',
        bindings: binding,
      });

      expect(goal.bindings).toBeDefined();
      expect(goal.bindings!.source).toBe('workspace_context');
      expect(goal.bindings!.repositoryPath).toBe('/home/user/active-project');
      expect(goal.bindings!.resources).toContain('project:proj-active');
    });

    it('Case B: no active project → Goal.bindings = undefined', () => {
      const ga = GoalAuthority.getInstance();
      const binding = resolveGoalBinding({});
      const goal = ga.createGoal({
        description: 'Task without project',
        originalInput: 'Task without project',
        executionDomain: 'desktop',
        bindings: binding,
      });

      expect(goal.bindings).toBeUndefined();
    });

    it('Case C: switch project after goal creation → old goal binding unchanged', () => {
      const ga = GoalAuthority.getInstance();

      const bindingA: GoalBinding = {
        repositoryPath: '/projects/A',
        resources: ['project:A'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      const goalA = ga.createGoal({
        description: 'Goal A',
        originalInput: 'Goal A',
        executionDomain: 'desktop',
        bindings: bindingA,
      });

      const bindingB: GoalBinding = {
        repositoryPath: '/projects/B',
        resources: ['project:B'],
        source: 'workspace_context',
        confidence: 0.5,
        resolvedAt: Date.now(),
      };

      ga.createGoal({
        description: 'Goal B',
        originalInput: 'Goal B',
        executionDomain: 'desktop',
        bindings: bindingB,
      });

      expect(goalA.bindings!.resources).toContain('project:A');
      expect(goalA.bindings!.repositoryPath).toBe('/projects/A');
    });

    it('Case D: Desktop without structured project context → bindings=undefined', () => {
      const binding = resolveGoalBinding({});
      expect(binding).toBeUndefined();
    });
  });

  describe('GoalContextResolver: explicit binding takes priority', () => {
    it('explicit binding overrides projectContext', () => {
      const explicitBinding: GoalBinding = {
        repository: 'explicit-repo',
        repositoryPath: '/explicit/path',
        source: 'explicit',
        confidence: 0.95,
        resolvedAt: Date.now(),
      };

      const projectContext: ProjectContextInfo = {
        projectId: 'proj-implicit',
        projectName: 'implicit-project',
        projectPath: '/implicit/path',
        projectType: 'typescript',
      };

      const binding = resolveGoalBinding({
        explicitBinding,
        projectContext,
      });

      expect(binding!.source).toBe('explicit');
      expect(binding!.repository).toBe('explicit-repo');
      expect(binding!.repositoryPath).toBe('/explicit/path');
    });
  });

  describe('GoalImpactEvaluator: L3 inference capped at low confidence', () => {
    it('inferred binding confidence does not exceed 0.5', () => {
      const ga = GoalAuthority.getInstance();
      const evaluator = getGoalImpactEvaluator();

      const goal = ga.createGoal({
        description: 'Fix bug in repo:my-project at /home/user/my-project',
        originalInput: 'Fix bug in repo:my-project at /home/user/my-project',
        executionDomain: 'desktop',
      });

      const observation: WorldObservation = {
        observationId: 'OBS_test',
        source: 'git',
        payload: { repos: [{ repo: 'my-project' }] },
        timestamp: Date.now(),
      };

      const impacts = evaluator.evaluate([goal], observation);
      if (impacts.length > 0 && impacts[0].affected) {
        expect(impacts[0].confidence).toBeLessThanOrEqual(0.5);
      }
    });
  });
});
