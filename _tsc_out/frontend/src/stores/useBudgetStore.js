"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useBudgetStore = void 0;
const zustand_1 = require("zustand");
const apiService_1 = require("../api/apiService");
const logger_1 = require("../utils/logger");
const log = (0, logger_1.createLogger)('BudgetStore');
const initialState = {
    tokenUsed: 0,
    tokenBudget: 500000,
    costUsed: 0,
    costBudget: 10.0,
    period: 'daily',
    warningThreshold: 0.8,
    loading: false,
    error: null,
};
exports.useBudgetStore = (0, zustand_1.create)((set, get) => ({
    ...initialState,
    setBudget: (budget) => {
        const validPeriods = ['daily', 'weekly', 'monthly'];
        const period = validPeriods.includes(budget.period)
            ? budget.period
            : get().period;
        set({
            tokenBudget: budget.tokenBudget,
            costBudget: budget.costBudget,
            period,
        });
    },
    recordUsage: (tokens, cost) => set((state) => ({
        tokenUsed: state.tokenUsed + tokens,
        costUsed: state.costUsed + cost,
    })),
    getUsagePercentage: () => {
        const state = get();
        if (state.tokenBudget <= 0)
            return 0;
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
            const result = await apiService_1.apiService.getBudgetStatus();
            if (result.success && result.data) {
                const { tokenUsed, tokenBudget, costUsed, costBudget, period } = result.data;
                const validPeriods = ['daily', 'weekly', 'monthly'];
                set({
                    tokenUsed: tokenUsed ?? 0,
                    tokenBudget: tokenBudget ?? 500000,
                    costUsed: costUsed ?? 0,
                    costBudget: costBudget ?? 10.0,
                    period: validPeriods.includes(period) ? period : 'daily',
                    loading: false,
                });
            }
            else {
                set({ ...initialState, loading: false });
            }
        }
        catch (err) {
            log.error('fetchBudgetStatus 失败:', err);
            set({ ...initialState, loading: false });
        }
    },
}));
