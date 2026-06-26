/**
 * 预算压力警告测试
 *
 * 验证 ConstraintsService.getBudgetPressure 和 Executor 的 _budget_warning 注入
 */
import { ConstraintsService } from '../../src/harness/constraints/ConstraintsService';
import type { BudgetState } from '../../src/harness/types';

jest.mock('../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('预算压力警告', () => {
  let service: ConstraintsService;

  beforeEach(() => {
    service = new ConstraintsService({
      permissionGuard: {
        check: jest.fn().mockReturnValue({ allowed: true, missing: [] }),
      },
    });
  });

  function makeBudget(overrides: Partial<BudgetState> = {}): BudgetState {
    return {
      roundsUsed: 3,
      softRoundLimit: 6,
      hardRoundLimit: 10,
      tokensUsed: 1000,
      tokenWarningLimit: 5000,
      tokenHardLimit: 10000,
      startTime: Date.now() - 10000,
      maxDurationMs: 60000,
      toolCallsUsed: 2,
      maxToolCalls: 10,
      ...overrides,
    };
  }

  describe('getBudgetPressure', () => {
    it('预算充裕时返回 none', () => {
      const pressure = service.getBudgetPressure(makeBudget());
      expect(pressure.level).toBe('none');
      expect(pressure.warning).toBeUndefined();
    });

    it('轮次使用达 70% 时返回 caution', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ roundsUsed: 7, hardRoundLimit: 10 })
      );
      expect(pressure.level).toBe('caution');
      expect(pressure.warning).toBeDefined();
      expect(pressure.warning).toContain('轮次');
    });

    it('token 使用达 70% 时返回 caution', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ tokensUsed: 7000, tokenHardLimit: 10000 })
      );
      expect(pressure.level).toBe('caution');
      expect(pressure.warning).toContain('Token');
    });

    it('工具调用达 70% 时返回 caution', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ toolCallsUsed: 7, maxToolCalls: 10 })
      );
      expect(pressure.level).toBe('caution');
      expect(pressure.warning).toContain('工具调用');
    });

    it('轮次使用达 90% 时返回 critical', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ roundsUsed: 9, hardRoundLimit: 10 })
      );
      expect(pressure.level).toBe('critical');
      expect(pressure.warning).toContain('轮次');
    });

    it('token 使用达 90% 时返回 critical', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ tokensUsed: 9000, tokenHardLimit: 10000 })
      );
      expect(pressure.level).toBe('critical');
      expect(pressure.warning).toContain('Token');
    });

    it('多维度同时高压时返回 critical（取最高级别）', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({
          roundsUsed: 9,
          hardRoundLimit: 10,
          tokensUsed: 8000,
          tokenHardLimit: 10000,
        })
      );
      expect(pressure.level).toBe('critical');
    });

    it('返回的 warning 包含具体数值', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ roundsUsed: 8, hardRoundLimit: 10 })
      );
      expect(pressure.warning).toMatch(/\d+/);
    });

    it('返回的 details 包含各维度使用率', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ roundsUsed: 7, hardRoundLimit: 10 })
      );
      expect(pressure.details).toBeDefined();
      expect(pressure.details.rounds).toBe(0.7);
    });
  });

  describe('formatBudgetWarning', () => {
    it('none 级别返回空字符串', () => {
      const pressure = service.getBudgetPressure(makeBudget());
      const formatted = ConstraintsService.formatBudgetWarning(pressure);
      expect(formatted).toBe('');
    });

    it('caution 级别返回含 _budget_warning 的 JSON', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ roundsUsed: 7, hardRoundLimit: 10 })
      );
      const formatted = ConstraintsService.formatBudgetWarning(pressure);
      expect(formatted).toContain('_budget_warning');
      expect(formatted).toContain('caution');
    });

    it('critical 级别返回含 _budget_warning 的 JSON', () => {
      const pressure = service.getBudgetPressure(
        makeBudget({ roundsUsed: 9, hardRoundLimit: 10 })
      );
      const formatted = ConstraintsService.formatBudgetWarning(pressure);
      expect(formatted).toContain('_budget_warning');
      expect(formatted).toContain('critical');
    });
  });
});
