import { create } from 'zustand';
import type { WsEvolutionEventData, EvolutionCycleStatus } from '@shared/contracts';

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
  reset: () => set(initialState),
}));
