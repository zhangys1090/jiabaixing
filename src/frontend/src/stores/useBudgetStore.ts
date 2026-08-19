import { create } from 'zustand';
import { apiService } from '../api/apiService';
import { createLogger } from '../utils/logger';

const log = createLogger('BudgetStore');

export interface BudgetState {
  tokenUsed: number;
  tokenBudget: number;
  costUsed: number;
  costBudget: number;
  period: 'daily' | 'weekly' | 'monthly';
  warningThreshold: number;
  loading: boolean;
  error: string | null;

  setBudget: (budget: { tokenBudget: number; costBudget: number; period: string }) => void;
  recordUsage: (tokens: number, cost: number) => void;
  getUsagePercentage: () => number;
  isWarning: () => boolean;
  reset: () => void;
  loadMockBudget: () => void;
  fetchBudgetStatus: () => Promise<void>;
}

const initialState = {
  tokenUsed: 0,
  tokenBudget: 500000,
  costUsed: 0,
  costBudget: 10.0,
  period: 'daily' as const,
  warningThreshold: 0.8,
  loading: false,
  error: null as string | null,
};

export const useBudgetStore = create<BudgetState>((set, get) => ({
  ...initialState,

  setBudget: (budget) => {
    const validPeriods: Array<BudgetState['period']> = ['daily', 'weekly', 'monthly'];
    const period = validPeriods.includes(budget.period as BudgetState['period'])
      ? (budget.period as BudgetState['period'])
      : get().period;
    set({
      tokenBudget: budget.tokenBudget,
      costBudget: budget.costBudget,
      period,
    });
  },

  recordUsage: (tokens, cost) =>
    set((state) => ({
      tokenUsed: state.tokenUsed + tokens,
      costUsed: state.costUsed + cost,
    })),

  getUsagePercentage: () => {
    const state = get();
    if (state.tokenBudget <= 0) return 0;
    return Math.min(1, state.tokenUsed / state.tokenBudget);
  },

  isWarning: () => {
    const state = get();
    return state.getUsagePercentage() >= state.warningThreshold;
  },

  reset: () => set({ ...initialState }),

  loadMockBudget: () => {
    log.info('加载 mock budget');
    set({ ...initialState });
  },

  fetchBudgetStatus: async () => {
    set({ loading: true, error: null });
    try {
      const result = await apiService.getBudgetStatus();
      if (result.success && result.data) {
        const { tokenUsed, tokenBudget, costUsed, costBudget, period } = result.data;
        const validPeriods: Array<BudgetState['period']> = ['daily', 'weekly', 'monthly'];
        set({
          tokenUsed: tokenUsed ?? 0,
          tokenBudget: tokenBudget ?? 500000,
          costUsed: costUsed ?? 0,
          costBudget: costBudget ?? 10.0,
          period: validPeriods.includes(period as BudgetState['period']) ? (period as BudgetState['period']) : 'daily',
          loading: false,
        });
      } else {
        set({ ...initialState, loading: false });
      }
    } catch (err) {
      log.error('fetchBudgetStatus 失败:', err);
      set({ ...initialState, loading: false });
    }
  },
}));
