import { create } from 'zustand';
import type { WsServerLogData } from '@shared/contracts';
import { apiService } from '../api/apiService';

interface MonitorState {
  logs: WsServerLogData[];
  performanceSnapshot: Record<string, unknown> | null;
  systemResources: Record<string, unknown> | null;
  llmPerformance: Record<string, unknown> | null;
  integrityChecks: Array<{
    name: string;
    status: string;
    message: string;
  }> | null;
  loading: boolean;
  error: string | null;

  addLog: (entry: WsServerLogData) => void;
  setPerformanceSnapshot: (snapshot: Record<string, unknown>) => void;
  setSystemResources: (resources: Record<string, unknown>) => void;
  setLlmPerformance: (perf: Record<string, unknown>) => void;
  setIntegrityChecks: (checks: Array<{ name: string; status: string; message: string }>) => void;
  fetchSystemResources: () => Promise<void>;
  fetchPerformanceSnapshot: () => Promise<void>;
  fetchLlmPerformance: () => Promise<void>;
  fetchSystemIntegrity: () => Promise<void>;
  clearLogs: () => void;
  reset: () => void;
}

const initialState = {
  logs: [],
  performanceSnapshot: null,
  systemResources: null,
  llmPerformance: null,
  integrityChecks: null,
  loading: false,
  error: null,
};

export const useMonitorStore = create<MonitorState>((set) => ({
  ...initialState,

  addLog: (entry) =>
    set((state) => ({
      logs: [...state.logs.slice(-499), entry],
    })),

  setPerformanceSnapshot: (snapshot) => set({ performanceSnapshot: snapshot }),

  setSystemResources: (resources) => set({ systemResources: resources }),

  setLlmPerformance: (perf) => set({ llmPerformance: perf }),

  setIntegrityChecks: (checks) => set({ integrityChecks: checks }),

  fetchSystemResources: async () => {
    set({ loading: true });
    try {
      const result = await apiService.getSystemResources();
      if (result.success && result.data) {
        set({ systemResources: result.data as unknown as Record<string, unknown>, loading: false });
      } else {
        set({ error: result.error || '获取系统资源失败', loading: false });
      }
    } catch (error) {
      console.error('[MonitorStore] fetchSystemResources 失败:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  fetchPerformanceSnapshot: async () => {
    try {
      const result = await apiService.getPerformanceSnapshot();
      if (result.success && result.data) {
        set({ performanceSnapshot: result.data as Record<string, unknown> });
      } else {
        console.warn('[MonitorStore] fetchPerformanceSnapshot 失败:', result.error);
      }
    } catch (error) {
      console.error('[MonitorStore] fetchPerformanceSnapshot 异常:', error);
    }
  },

  fetchLlmPerformance: async () => {
    try {
      const result = await apiService.getLLMPerformance();
      if (result.success && result.data) {
        set({ llmPerformance: result.data as Record<string, unknown> });
      } else {
        console.warn('[MonitorStore] fetchLlmPerformance 失败:', result.error);
      }
    } catch (error) {
      console.error('[MonitorStore] fetchLlmPerformance 异常:', error);
    }
  },

  fetchSystemIntegrity: async () => {
    try {
      const result = await apiService.getSystemIntegrity();
      if (result.success && result.data) {
        const data = result.data as {
          checks: Array<{ name: string; status: string; message: string }>;
        };
        set({ integrityChecks: data.checks });
      } else {
        console.warn('[MonitorStore] fetchSystemIntegrity 失败:', result.error);
      }
    } catch (error) {
      console.error('[MonitorStore] fetchSystemIntegrity 异常:', error);
    }
  },

  clearLogs: () => set({ logs: [] }),
  reset: () => set(initialState),
}));
