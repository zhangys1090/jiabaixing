import { create } from 'zustand';
import type { WsServerLogData } from '@shared/contracts';

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

  addLog: (entry: WsServerLogData) => void;
  setPerformanceSnapshot: (snapshot: Record<string, unknown>) => void;
  setSystemResources: (resources: Record<string, unknown>) => void;
  setLlmPerformance: (perf: Record<string, unknown>) => void;
  setIntegrityChecks: (checks: Array<{ name: string; status: string; message: string }>) => void;
  clearLogs: () => void;
  reset: () => void;
}

const initialState = {
  logs: [],
  performanceSnapshot: null,
  systemResources: null,
  llmPerformance: null,
  integrityChecks: null,
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

  clearLogs: () => set({ logs: [] }),
  reset: () => set(initialState),
}));
