import { create } from 'zustand';
import type { WsSkillExecutionUpdateData, WsWeightUpdateData } from '@shared/contracts';

interface SkillState {
  skills: Array<Record<string, unknown>>;
  executionUpdates: WsSkillExecutionUpdateData[];
  weights: Record<string, number>;
  weightUpdates: WsWeightUpdateData[];
  loading: boolean;
  error: string | null;

  setSkills: (skills: Array<Record<string, unknown>>) => void;
  addExecutionUpdate: (update: WsSkillExecutionUpdateData) => void;
  updateWeight: (update: WsWeightUpdateData) => void;
  setWeights: (weights: Record<string, number>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  skills: [],
  executionUpdates: [],
  weights: {},
  weightUpdates: [],
  loading: false,
  error: null,
};

export const useSkillStore = create<SkillState>((set) => ({
  ...initialState,

  setSkills: (skills) => set({ skills, loading: false }),

  addExecutionUpdate: (update) =>
    set((state) => ({
      executionUpdates: [...state.executionUpdates.slice(-49), update],
    })),

  updateWeight: (update) =>
    set((state) => ({
      weightUpdates: [...state.weightUpdates.slice(-19), update],
      weights:
        update.updateType === 'full' && update.weights
          ? update.weights
          : update.toolId
            ? { ...state.weights, [update.toolId]: update.newWeight || 0 }
            : state.weights,
    })),

  setWeights: (weights) => set({ weights }),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  reset: () => set(initialState),
}));
