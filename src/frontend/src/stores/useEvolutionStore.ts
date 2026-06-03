import { create } from 'zustand';
import type { WsEvolutionEventData, EvolutionCycleStatus } from '@shared/contracts';
import { apiService } from '../api/apiService';

interface EvolutionState {
  cycleStatus: EvolutionCycleStatus | null;
  events: WsEvolutionEventData[];
  metrics: {
    totalOptimizations: number;
    successRate: number;
    averageImprovement: number;
    lastUpdate: string;
  } | null;
  loading: boolean;
  error: string | null;

  setCycleStatus: (status: EvolutionCycleStatus) => void;
  addEvent: (event: WsEvolutionEventData) => void;
  setMetrics: (metrics: EvolutionState['metrics']) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  fetchEvolutionStatus: () => Promise<void>;
  fetchEvolutionMetrics: () => Promise<void>;
  triggerEvolution: (reason?: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  cycleStatus: null,
  events: [],
  metrics: null,
  loading: false,
  error: null,
};

export const useEvolutionStore = create<EvolutionState>((set) => ({
  ...initialState,

  setCycleStatus: (status) => set({ cycleStatus: status, loading: false }),
  addEvent: (event) =>
    set((state) => ({
      events: [...state.events.slice(-99), event],
    })),
  setMetrics: (metrics) => set({ metrics }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),

  fetchEvolutionStatus: async () => {
    set({ loading: true });
    try {
      const result = await apiService.getEvolutionStatus();
      if (result.success && result.data) {
        set({ cycleStatus: result.data as EvolutionCycleStatus, loading: false });
      } else {
        set({ error: result.error || '获取演化状态失败', loading: false });
      }
    } catch (error) {
      console.error('[EvolutionStore] fetchEvolutionStatus 失败:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  fetchEvolutionMetrics: async () => {
    try {
      const result = await apiService.getEvolutionMetrics();
      if (result.success && result.data) {
        set({ metrics: result.data as EvolutionState['metrics'] });
      } else {
        console.warn('[EvolutionStore] fetchEvolutionMetrics 失败:', result.error);
      }
    } catch (error) {
      console.error('[EvolutionStore] fetchEvolutionMetrics 异常:', error);
    }
  },

  triggerEvolution: async (reason?: string) => {
    set({ loading: true });
    try {
      const result = await apiService.triggerEvolution(reason);
      if (result.success) {
        console.log('[EvolutionStore] 演化触发成功:', result.data);
      } else {
        set({ error: result.error || '触发演化失败', loading: false });
      }
    } catch (error) {
      console.error('[EvolutionStore] triggerEvolution 异常:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  reset: () => set(initialState),
}));
