import { create } from 'zustand';
import type { WsSkillExecutionUpdateData, WsWeightUpdateData } from '@shared/contracts';
import { apiService } from '../api/apiService';

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
  fetchSkills: () => Promise<void>;
  executeSkill: (skillName: string, params?: Record<string, unknown>, userId?: string) => Promise<void>;
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

  fetchSkills: async () => {
    set({ loading: true });
    try {
      const result = await apiService.listSkills();
      if (result.success && result.data) {
        const skillsList = (result.data as { skills: Array<Record<string, unknown>> }).skills || [];
        set({ skills: skillsList, loading: false });
      } else {
        set({ error: result.error || '获取技能列表失败', loading: false });
      }
    } catch (error) {
      console.error('[SkillStore] fetchSkills 失败:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  executeSkill: async (skillName: string, params?: Record<string, unknown>, userId?: string) => {
    set({ loading: true });
    try {
      const result = await apiService.executeSkill(skillName, params, userId);
      if (result.success) {
        console.log('[SkillStore] 技能执行成功:', skillName);
        set({ loading: false });
      } else {
        set({ error: result.error || '技能执行失败', loading: false });
      }
    } catch (error) {
      console.error('[SkillStore] executeSkill 异常:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  reset: () => set(initialState),
}));
