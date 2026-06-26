import type { AutomationPattern, AutomationTask, AutomationTrigger } from '@shared/contracts';
import { create } from 'zustand';
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
  createTask: (task: unknown) => Promise<void>;
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

  createTask: async (task: unknown) => {
    set({ loading: true });
    try {
      const result = await apiService.createAutomationTask(task);
      if (result.success) {
        console.log('[AutomationStore] 任务创建成功');
        await get().fetchTasks();
      } else {
        set({ error: result.error || '创建任务失败', loading: false });
      }
    } catch (error) {
      console.error('[AutomationStore] createTask 失败:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

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
        triggers: result.data.triggers || [],
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
