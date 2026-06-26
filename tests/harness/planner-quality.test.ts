/**
 * Planner 质量增强功能测试
 *
 * 测试 recordBudgetAccuracy、getAdjustedBudgetMultiplier、getReplanRate 等方法
 */

import { Planner, type PlannerDeps } from '../../src/harness/loop/Planner';
import { LoopState } from '../../src/harness/types';
import { createMockLoopContext } from './helpers/loopContext';

function createMockDeps(): PlannerDeps {
  return {
    llm: {
      chat: jest.fn().mockResolvedValue('NO'),
    },
  };
}

describe('Planner 质量增强', () => {
  let planner: Planner;

  beforeEach(() => {
    planner = new Planner(createMockDeps());
  });

  describe('recordBudgetAccuracy', () => {
    it('应该记录预算准确度数据', () => {
      planner.recordBudgetAccuracy(100, 120);
      planner.recordBudgetAccuracy(200, 180);
      expect(planner.getAdjustedBudgetMultiplier()).toBe(1.5);
    });

    it('应该记录多条预算准确度数据', () => {
      planner.recordBudgetAccuracy(100, 100);
      planner.recordBudgetAccuracy(100, 150);
      planner.recordBudgetAccuracy(100, 200);
      const multiplier = planner.getAdjustedBudgetMultiplier();
      const expected = (100 / 100 + 150 / 100 + 200 / 100) / 3;
      expect(multiplier).toBeCloseTo(expected, 5);
    });
  });

  describe('getAdjustedBudgetMultiplier', () => {
    it('应该在数据不足3条时返回1.5', () => {
      planner.recordBudgetAccuracy(100, 120);
      expect(planner.getAdjustedBudgetMultiplier()).toBe(1.5);

      planner.recordBudgetAccuracy(100, 110);
      expect(planner.getAdjustedBudgetMultiplier()).toBe(1.5);
    });

    it('应该在数据达到3条时返回计算比率', () => {
      planner.recordBudgetAccuracy(100, 120);
      planner.recordBudgetAccuracy(100, 130);
      planner.recordBudgetAccuracy(100, 110);
      const multiplier = planner.getAdjustedBudgetMultiplier();
      const avgRatio = (120 / 100 + 130 / 100 + 110 / 100) / 3;
      expect(multiplier).toBeCloseTo(avgRatio, 5);
    });

    it('应该在估算完全准确时返回接近1.0的值', () => {
      planner.recordBudgetAccuracy(100, 100);
      planner.recordBudgetAccuracy(200, 200);
      planner.recordBudgetAccuracy(300, 300);
      expect(planner.getAdjustedBudgetMultiplier()).toBeCloseTo(1.0, 5);
    });

    it('应该在实际消耗远超估算时返回较高值', () => {
      planner.recordBudgetAccuracy(100, 200);
      planner.recordBudgetAccuracy(100, 250);
      planner.recordBudgetAccuracy(100, 300);
      const multiplier = planner.getAdjustedBudgetMultiplier();
      expect(multiplier).toBeGreaterThan(1.5);
    });

    it('应该将结果限制在最小值1.0', () => {
      planner.recordBudgetAccuracy(100, 50);
      planner.recordBudgetAccuracy(100, 30);
      planner.recordBudgetAccuracy(100, 40);
      const multiplier = planner.getAdjustedBudgetMultiplier();
      expect(multiplier).toBeGreaterThanOrEqual(1.0);
    });

    it('应该将结果限制在最大值2.0', () => {
      planner.recordBudgetAccuracy(100, 500);
      planner.recordBudgetAccuracy(100, 600);
      planner.recordBudgetAccuracy(100, 700);
      const multiplier = planner.getAdjustedBudgetMultiplier();
      expect(multiplier).toBeLessThanOrEqual(2.0);
    });

    it('应该在估算为0时使用比率1', () => {
      planner.recordBudgetAccuracy(0, 100);
      planner.recordBudgetAccuracy(0, 200);
      planner.recordBudgetAccuracy(0, 300);
      const multiplier = planner.getAdjustedBudgetMultiplier();
      expect(multiplier).toBe(1.0);
    });

    it('应该在混合0估算和非0估算时正确计算', () => {
      planner.recordBudgetAccuracy(0, 100);
      planner.recordBudgetAccuracy(100, 150);
      planner.recordBudgetAccuracy(100, 180);
      const multiplier = planner.getAdjustedBudgetMultiplier();
      const expected = (1 + 150 / 100 + 180 / 100) / 3;
      expect(multiplier).toBeCloseTo(expected, 5);
    });

    it('应该随着更多数据动态调整', () => {
      planner.recordBudgetAccuracy(100, 200);
      planner.recordBudgetAccuracy(100, 200);
      planner.recordBudgetAccuracy(100, 200);
      const multiplier3 = planner.getAdjustedBudgetMultiplier();

      planner.recordBudgetAccuracy(100, 100);
      planner.recordBudgetAccuracy(100, 100);
      planner.recordBudgetAccuracy(100, 100);
      const multiplier6 = planner.getAdjustedBudgetMultiplier();

      expect(multiplier6).toBeLessThan(multiplier3);
    });
  });

  describe('getReplanRate', () => {
    it('应该在没有计划时返回0', () => {
      expect(planner.getReplanRate()).toBe(0);
    });

    it('应该在只有初始计划时返回0', async () => {
      const mockDeps: PlannerDeps = {
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      };
      const testPlanner = new Planner(mockDeps);

      await testPlanner.plan(
        { text: '你好' },
        createMockLoopContext({
          budget: {
            roundsUsed: 0,
            softRoundLimit: 4,
            hardRoundLimit: 8,
            tokensUsed: 0,
            tokenWarningLimit: 4500,
            tokenHardLimit: 8000,
            startTime: Date.now(),
            maxDurationMs: 60000,
            toolCallsUsed: 0,
            maxToolCalls: 10,
          },
          trace: {
            traceId: 'test-trace',
            state: LoopState.PLANNING,
            stateTransitions: [],
            trajectory: [],
            totalDuration: 0,
            totalToolCalls: 0,
            budgetState: {
              roundsUsed: 0,
              softRoundLimit: 4,
              hardRoundLimit: 8,
              tokensUsed: 0,
              tokenWarningLimit: 4500,
              tokenHardLimit: 8000,
              startTime: Date.now(),
              maxDurationMs: 60000,
              toolCallsUsed: 0,
              maxToolCalls: 10,
            },
          },
        })
      );

      expect(testPlanner.getReplanRate()).toBe(0);
    });
  });

  describe('预算乘数与计划生成集成', () => {
    it('简单任务应不受预算乘数影响', async () => {
      const mockDeps: PlannerDeps = {
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      };
      const testPlanner = new Planner(mockDeps);

      const plan = await testPlanner.plan(
        { text: '你好' },
        createMockLoopContext({
          budget: {
            roundsUsed: 0,
            softRoundLimit: 4,
            hardRoundLimit: 8,
            tokensUsed: 0,
            tokenWarningLimit: 4500,
            tokenHardLimit: 8000,
            startTime: Date.now(),
            maxDurationMs: 60000,
            toolCallsUsed: 0,
            maxToolCalls: 10,
          },
          trace: {
            traceId: 'test-trace',
            state: LoopState.PLANNING,
            stateTransitions: [],
            trajectory: [],
            totalDuration: 0,
            totalToolCalls: 0,
            budgetState: {
              roundsUsed: 0,
              softRoundLimit: 4,
              hardRoundLimit: 8,
              tokensUsed: 0,
              tokenWarningLimit: 4500,
              tokenHardLimit: 8000,
              startTime: Date.now(),
              maxDurationMs: 60000,
              toolCallsUsed: 0,
              maxToolCalls: 10,
            },
          },
        })
      );

      expect(plan.simple).toBe(true);
      expect(plan.estimatedBudget.maxRounds).toBe(1);
    });
  });
});
