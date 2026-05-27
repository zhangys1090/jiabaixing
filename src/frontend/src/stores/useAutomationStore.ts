import { create } from 'zustand';
import type { AutomationTask, AutomationTrigger, AutomationPattern } from '@shared/contracts';
import { apiService } from '../api/apiService';

interface AutomationState {
  tasks: AutomationTask[];
  triggers: AutomationTrigger[];
  patterns: AutomationPattern | null;
  loading: boolean;
  error: string | null;

  setTasks: (tasks: AutomationTask[]) => void;
  setTriggers: (triggers: AutomationTrigger[]) => void;
  setPatterns: (patterns: AutomationPattern) => void;
  toggleTask: (taskId: string) => void;
  fetchTasks: () => Promise<void>;
  fetchTriggers: () => Promise<void>;
  fetchPatterns: () => Promise<void>;
  fetchAll: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  tasks: [],
  triggers: [],
  patterns: null,
  loading: false,
  error: null,
};

export const useAutomationStore = create<AutomationState>((set, get) => ({
  ...initialState,

  setTasks: (tasks) => set({ tasks, loading: false }),
  setTriggers: (triggers) => set({ triggers }),
  setPatterns: (patterns) => set({ patterns }),

  toggleTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, enabled: !t.enabled } : t)),
    })),

  fetchTasks: async () => {
    set({ loading: true });
    const result = await apiService.getAutomationTasks();
    if (result.success && result.data) {
      set({
        tasks: (result.data as { tasks: AutomationTask[] }).tasks || [],
        loading: false,
      });
    } else {
      set({ loading: false });
    }
  },

  fetchTriggers: async () => {
    const result = await apiService.getAutomationTriggers();
    if (result.success && result.data) {
      set({
        triggers: (result.data as { triggers: AutomationTrigger[] }).triggers || [],
      });
    }
  },

  fetchPatterns: async () => {
    const result = await apiService.getAutomationPatterns();
    if (result.success && result.data) {
      const patternsArr = (result.data as { patterns: AutomationPattern[] }).patterns;
      if (patternsArr && patternsArr.length > 0) {
        set({ patterns: patternsArr[0] });
      }
    }
  },

  fetchAll: async () => {
    set({ loading: true });
    await Promise.all([get().fetchTasks(), get().fetchTriggers(), get().fetchPatterns()]);
    set({ loading: false });
  },

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  reset: () => set(initialState),
}));
