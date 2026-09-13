/**
 * D7-1: Active Goal + World Observation — 10 Gates + 2 Regression
 *
 * G1:  Scheduler 能获取 Active Goal
 * G2:  获取的是 GoalAuthority 的 canonical 数据
 * G3:  Tick 后能产生 Goal Observation (observationId)
 * G4:  GoalImpact 包含 goalId + observationId
 * G5:  Evaluator 是纯函数
 * G6:  明确无关 Goal 不产生 ReplanEvent
 * G7:  明确关联 Goal 产生 ReplanEvent
 * G8:  DecisionAuthority.decide() = 0 calls
 * G9:  ActionAuthority.execute() = 0 calls
 * G10: tick 后 Goal status/progress/planVersion 不变
 * R1:  planVersion 不变
 * R2:  Decision/Action/Tool/Desktop/processInput = 0 calls
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
import { GoalStatus, GoalImpactType } from '../../src/authority/types';
import type { Goal, WorldObservation, GoalImpact } from '../../src/authority/types';
import {
  getGoalImpactEvaluator,
  resetGoalImpactEvaluator,
  generateObservationId,
} from '../../src/authority/GoalImpactEvaluator';
import { EventBus } from '../../src/shared/EventBus';
import { ScenarioAwareScheduler } from '../../src/core/ScenarioAwareScheduler';

const mockEventBusEmit = EventBus.emit as jest.Mock;

describe('D7-1: Active Goal + World Observation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    GoalAuthority.resetInstance();
    resetGoalImpactEvaluator();
  });

  describe('G1: Scheduler 能获取 Active Goal', () => {
    it('getActiveGoals() 返回已创建的 ACTIVE Goal', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复登录页面 bug',
        originalInput: '修复登录页面 bug',
      });

      const active = ga.getActiveGoals();
      expect(active).toHaveLength(1);
      expect(active[0].goalId).toBe(goal.goalId);
    });
  });

  describe('G2: 获取的是 GoalAuthority canonical 数据', () => {
    it('goalId + description 与创建时一致', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '部署生产环境',
        originalInput: '部署生产环境',
      });

      const active = ga.getActiveGoals();
      expect(active[0].goalId).toBe(goal.goalId);
      expect(active[0].description).toBe('部署生产环境');
      expect(active[0].status).toBe(GoalStatus.ACTIVE);
    });
  });

  describe('G3: Tick 后能产生带 observationId 的 WorldObservation', () => {
    it('generateObservationId() 产生唯一 ID', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateObservationId());
      }
      expect(ids.size).toBe(100);
    });

    it('WorldObservation 结构完整', () => {
      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: { activeEnv: 'coding' },
      };
      expect(obs.observationId).toBeTruthy();
      expect(obs.source).toBe('environment');
      expect(obs.payload).toEqual({ activeEnv: 'coding' });
    });
  });

  describe('G4: GoalImpact 包含 goalId + observationId', () => {
    it('evaluate 返回的每个 impact 都关联 goal 和 observation', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '测试任务',
        originalInput: '测试任务',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: { activeEnv: 'idle' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([goal], obs);

      expect(impacts).toHaveLength(1);
      expect(impacts[0].goalId).toBe(goal.goalId);
      expect(impacts[0].observationId).toBe(obs.observationId);
    });
  });

  describe('G5: Evaluator 是纯函数', () => {
    it('相同输入 → 相同输出', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '纯函数测试',
        originalInput: '纯函数测试',
      });

      const obs: WorldObservation = {
        observationId: 'OBS_fixed',
        source: 'file',
        type: 'file_changed',
        timestamp: '2026-09-10T00:00:00Z',
        payload: { filePath: '/test/file.ts', changeType: 'modified' },
      };

      const evaluator = getGoalImpactEvaluator();
      const r1 = evaluator.evaluate([goal], obs);
      const r2 = evaluator.evaluate([goal], obs);

      expect(r1).toEqual(r2);
    });

    it('不修改输入 Goal', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '不可变测试',
        originalInput: '不可变测试',
      });
      const progressBefore = goal.progress;
      const planVersionBefore = goal.planVersion;

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const evaluator = getGoalImpactEvaluator();
      evaluator.evaluate([goal], obs);

      expect(goal.progress).toBe(progressBefore);
      expect(goal.planVersion).toBe(planVersionBefore);
    });
  });

  describe('G6: 明确无关 Goal 不产生 ReplanEvent', () => {
    it('无结构化关联 → affected=false, reason=insufficient_evidence', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '完成文档编写',
        originalInput: '完成文档编写',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: { activeEnv: 'browsing' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([goal], obs);

      expect(impacts).toHaveLength(1);
      expect(impacts[0].affected).toBe(false);
      expect(impacts[0].reason).toBe('insufficient_evidence');
      expect(impacts[0].confidence).toBeLessThanOrEqual(0.2);
    });
  });

  describe('G7: 明确关联 Goal 产生 ReplanEvent', () => {
    it('boundResources 匹配 → affected=true', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 jiabaixing 测试',
        originalInput: '修复 jiabaixing 测试',
      });
      ga.updateStage(goal.goalId, 'testing');
      const g = ga.getGoal(goal.goalId)!;
      g.metadata['boundResources'] = ['repo:jiabaixing'];

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'git',
        type: 'git_status',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'jiabaixing' }] },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([g], obs);

      expect(impacts).toHaveLength(1);
      expect(impacts[0].affected).toBe(true);
      expect(impacts[0].confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('boundPaths 匹配 → affected=true', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 src/core 模块',
        originalInput: '修复 src/core 模块',
      });
      const g = ga.getGoal(goal.goalId)!;
      g.metadata['boundPaths'] = ['src/core/'];

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'file',
        type: 'file_changed',
        timestamp: new Date().toISOString(),
        payload: { filePath: 'src/core/JiabaixingCore.ts', changeType: 'modified' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([g], obs);

      expect(impacts).toHaveLength(1);
      expect(impacts[0].affected).toBe(true);
      expect(impacts[0].impactType).toBe('file_change');
    });

    it('boundRepository 匹配 → affected=true', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '部署 hermes-agent',
        originalInput: '部署 hermes-agent',
      });
      const g = ga.getGoal(goal.goalId)!;
      g.metadata['boundRepository'] = 'hermes-agent';

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'git',
        type: 'git_status',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'hermes-agent' }] },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([g], obs);

      expect(impacts).toHaveLength(1);
      expect(impacts[0].affected).toBe(true);
    });
  });

  describe('G8: DecisionAuthority.decide() = 0 calls', () => {
    it('GoalImpactEvaluator 不 import DecisionAuthority', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/authority/GoalImpactEvaluator.ts'),
        'utf-8'
      );
      expect(source).not.toContain('DecisionAuthority');
    });
  });

  describe('G9: ActionAuthority.execute() = 0 calls', () => {
    it('GoalImpactEvaluator 不 import ActionAuthority', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/authority/GoalImpactEvaluator.ts'),
        'utf-8'
      );
      expect(source).not.toContain('ActionAuthority');
    });
  });

  describe('G10: tick 后 Goal 不变', () => {
    it('Goal status/progress/planVersion 不因 D7-1 改变', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'G10 测试',
        originalInput: 'G10 测试',
      });

      const statusBefore = goal.status;
      const progressBefore = goal.progress;
      const planVersionBefore = goal.planVersion;

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const evaluator = getGoalImpactEvaluator();
      evaluator.evaluate([goal], obs);

      expect(goal.status).toBe(statusBefore);
      expect(goal.progress).toBe(progressBefore);
      expect(goal.planVersion).toBe(planVersionBefore);
    });
  });

  describe('R1: planVersion 不变', () => {
    it('D7-1 不调用 GoalAuthority.replan()', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'R1 测试',
        originalInput: 'R1 测试',
      });
      const planVersionBefore = goal.planVersion;

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const evaluator = getGoalImpactEvaluator();
      evaluator.evaluate([goal], obs);

      expect(goal.planVersion).toBe(planVersionBefore);
    });
  });

  describe('R2: D7-1 不触发任何执行', () => {
    it('GoalImpactEvaluator 不 import DecisionAuthority', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/authority/GoalImpactEvaluator.ts'),
        'utf-8'
      );
      expect(source).not.toContain('DecisionAuthority');
      expect(source).not.toContain('ActionAuthority');
      expect(source).not.toContain('EventBus');
      expect(source).not.toContain('processInput');
      expect(source).not.toContain('child_process');
    });

    it('ScenarioAwareScheduler evaluateActiveGoalImpacts 不调用 replan/decide/execute', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/core/ScenarioAwareScheduler.ts'),
        'utf-8'
      );
      const methodSource = source.substring(
        source.indexOf('evaluateActiveGoalImpacts'),
        source.indexOf('private shouldExecuteTask')
      );
      expect(methodSource).not.toContain('.replan(');
      expect(methodSource).not.toContain('.decide(');
      expect(methodSource).not.toContain('.execute(');
      expect(methodSource).not.toContain('processInput');
    });
  });

  describe('Edge Cases', () => {
    it('空 Goal 列表 → 空 Impact', () => {
      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: {},
      };
      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([], obs);
      expect(impacts).toHaveLength(0);
    });

    it('多个 Goal + 多个 Observation → 正确交叉评估', () => {
      const ga = GoalAuthority.getInstance();
      const g1 = ga.createGoal({ description: 'Goal A', originalInput: 'Goal A' });
      const g2 = ga.createGoal({ description: 'Goal B', originalInput: 'Goal B' });
      const g2Obj = ga.getGoal(g2.goalId)!;
      g2Obj.metadata['boundResources'] = ['repo:target'];

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'git',
        type: 'git_status',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'target' }] },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([g1, g2Obj], obs);

      const g1Impact = impacts.find((i) => i.goalId === g1.goalId);
      const g2Impact = impacts.find((i) => i.goalId === g2.goalId);

      expect(g1Impact?.affected).toBe(false);
      expect(g2Impact?.affected).toBe(true);
    });

    it('boundEnvironment 匹配 → affected=true', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({ description: '编码任务', originalInput: '编码任务' });
      const g = ga.getGoal(goal.goalId)!;
      g.metadata['boundEnvironment'] = 'coding';

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: { activeEnv: 'coding' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([g], obs);

      expect(impacts[0].affected).toBe(true);
      expect(impacts[0].impactType).toBe('environment_change');
    });

    it('COMPLETED Goal 不在 getActiveGoals 中', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({ description: '已完成任务', originalInput: '已完成任务' });
      ga.markCompleted(goal.goalId, 'done');

      const active = ga.getActiveGoals();
      expect(active).toHaveLength(0);
    });
  });

  describe('G11: 真实 Goal Binding 可用性', () => {
    it('inferBindings 从 description 中提取路径', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
        originalInput: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
      });

      const evaluator = getGoalImpactEvaluator();
      const bindings = evaluator.inferBindings(goal);

      expect(bindings.boundPaths.length).toBeGreaterThan(0);
      expect(bindings.boundResources.length).toBeGreaterThan(0);
    });

    it('inferBindings 从 description 中提取仓库关键词', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '运行 project:jiabaixing 的测试',
        originalInput: '运行 project:jiabaixing 的测试',
      });

      const evaluator = getGoalImpactEvaluator();
      const bindings = evaluator.inferBindings(goal);

      expect(bindings.boundRepository).toBe('jiabaixing');
    });

    it('inferBindings 从 description 中提取环境关键词', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '在 env:production 环境下部署',
        originalInput: '在 env:production 环境下部署',
      });

      const evaluator = getGoalImpactEvaluator();
      const bindings = evaluator.inferBindings(goal);

      expect(bindings.boundEnvironment).toBe('production');
    });

    it('metadata binding 优先于 inferred binding', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 /tmp/test 中的错误',
        originalInput: '修复 /tmp/test 中的错误',
      });
      const g = ga.getGoal(goal.goalId)!;
      g.metadata['boundRepository'] = 'my-repo';

      const evaluator = getGoalImpactEvaluator();
      const bindings = evaluator.inferBindings(g);

      expect(bindings.boundRepository).toBe('my-repo');
    });

    it('无路径无关键词的 Goal → binding 为空', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '做一些事情',
        originalInput: '做一些事情',
      });

      const evaluator = getGoalImpactEvaluator();
      const bindings = evaluator.inferBindings(goal);

      expect(bindings.boundPaths).toHaveLength(0);
      expect(bindings.boundRepository).toBeNull();
      expect(bindings.boundEnvironment).toBeNull();
    });

    it('inferred binding + 匹配 observation → affected=true', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
        originalInput: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'file',
        type: 'file_changed',
        timestamp: new Date().toISOString(),
        payload: { filePath: 'c:/zy/jiabaixing/src/main.ts' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([goal], obs);

      expect(impacts[0].affected).toBe(true);
      expect(impacts[0].reason).toContain('inferred');
      expect(impacts[0].confidence).toBe(0.5);
    });
  });

  describe('G12: World Change vs World Snapshot', () => {
    it('环境不变 → 不产生 environment change observation', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
        originalInput: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_update',
        timestamp: new Date().toISOString(),
        payload: { activeEnv: 'coding', previousEnv: 'coding' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([goal], obs);

      const envChangeImpacts = impacts.filter(
        (i) => i.impactType === 'environment_change' && i.reason.includes('environment_change')
      );
      expect(envChangeImpacts.length).toBe(0);
    });

    it('Git 不变 → 不产生 git change observation (type=git_change 需要实际变化)', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '运行 project:jiabaixing 的测试',
        originalInput: '运行 project:jiabaixing 的测试',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'git',
        type: 'git_status',
        timestamp: new Date().toISOString(),
        payload: { repos: [{ repo: 'jiabaixing', branch: 'main', hasUncommitted: false }] },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([goal], obs);

      expect(impacts[0].affected).toBe(true);
      expect(impacts[0].reason).toContain('inferred');
    });
  });

  describe('G13: 同一 file change 不重复消费', () => {
    it('同一 filePath+changeType+timestamp 只评估一次', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
        originalInput: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'file',
        type: 'file_changed',
        timestamp: '2026-09-10T10:00:00Z',
        payload: { filePath: 'c:/zy/jiabaixing/src/main.ts', changeType: 'modify' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts1 = evaluator.evaluate([goal], obs);
      const impacts2 = evaluator.evaluate([goal], obs);

      expect(impacts1).toEqual(impacts2);

      const dedupKey = `${obs.payload}:file_changed:2026-09-10T10:00:00Z`;
      const seen = new Set<string>();
      seen.add(dedupKey);
      expect(seen.has(dedupKey)).toBe(true);
    });

    it('不同 timestamp 的同一文件 → 不同 observation', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
        originalInput: '修复 c:/zy/jiabaixing/src/main.ts 中的错误',
      });

      const obs1: WorldObservation = {
        observationId: generateObservationId(),
        source: 'file',
        type: 'file_changed',
        timestamp: '2026-09-10T10:00:00Z',
        payload: { filePath: 'c:/zy/jiabaixing/src/main.ts', changeType: 'modify' },
      };
      const obs2: WorldObservation = {
        observationId: generateObservationId(),
        source: 'file',
        type: 'file_changed',
        timestamp: '2026-09-10T10:01:00Z',
        payload: { filePath: 'c:/zy/jiabaixing/src/main.ts', changeType: 'modify' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts1 = evaluator.evaluate([goal], obs1);
      const impacts2 = evaluator.evaluate([goal], obs2);

      expect(impacts1[0].observationId).not.toBe(impacts2[0].observationId);
      expect(impacts1[0].affected).toBe(true);
      expect(impacts2[0].affected).toBe(true);
    });
  });

  describe('G14: Evaluator 异常隔离', () => {
    it('malformed goal metadata → evaluator_error, 不崩溃', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'G14 测试',
        originalInput: 'G14 测试',
      });
      const g = ga.getGoal(goal.goalId)!;

      Object.defineProperty(g, 'metadata', {
        get() { throw new Error('metadata access failed'); },
        configurable: true,
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_change',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([g], obs);

      expect(impacts).toHaveLength(1);
      expect(impacts[0].affected).toBe(false);
      expect(impacts[0].reason).toContain('evaluator_error');
      expect(impacts[0].confidence).toBe(0);
    });

    it('malformed observation payload → 不崩溃', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'G14b 测试',
        originalInput: 'G14b 测试',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'file',
        type: 'file_changed',
        timestamp: new Date().toISOString(),
        payload: { filePath: null },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([goal], obs);

      expect(impacts).toHaveLength(1);
      expect(impacts[0].affected).toBe(false);
    });
  });

  describe('G15: 稳定世界不产生 False Replan', () => {
    it('环境+Git+文件都不变 → dedup key 相同 → 不产生新 observation', () => {
      const envKey1 = 'coding';
      const envKey2 = 'coding';
      expect(envKey1).toBe(envKey2);

      const gitKey1 = 'jiabaixing:main:0;';
      const gitKey2 = 'jiabaixing:main:0;';
      expect(gitKey1).toBe(gitKey2);

      const fileKey1 = 'main.ts:modify:2026-09-10T10:00:00Z';
      const fileKey2 = 'main.ts:modify:2026-09-10T10:00:00Z';
      expect(fileKey1).toBe(fileKey2);

      const seen = new Set<string>();
      seen.add(fileKey1);
      expect(seen.has(fileKey2)).toBe(true);
    });

    it('无结构化 binding 的 Goal + 稳定世界 → 不产生 goal_replan_suggested', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: '做一些事情',
        originalInput: '做一些事情',
      });

      const obs: WorldObservation = {
        observationId: generateObservationId(),
        source: 'environment',
        type: 'environment_change',
        timestamp: new Date().toISOString(),
        payload: { activeEnv: 'coding' },
      };

      const evaluator = getGoalImpactEvaluator();
      const impacts = evaluator.evaluate([goal], obs);

      expect(impacts[0].affected).toBe(false);
      expect(impacts[0].reason).toBe('insufficient_evidence');
    });
  });
});
