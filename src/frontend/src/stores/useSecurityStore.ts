import { create } from 'zustand';
import { apiService } from '../api/apiService';

interface SecurityState {
  logs: Array<Record<string, unknown>>;
  validationResult: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    riskLevel: 'low' | 'high';
  } | null;
  overallStatus: 'secure' | 'warning' | 'danger';
  report: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;

  setLogs: (logs: Array<Record<string, unknown>>) => void;
  setValidationResult: (result: SecurityState['validationResult']) => void;
  setOverallStatus: (status: SecurityState['overallStatus']) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  fetchSecurityLogs: (limit?: number, level?: string, category?: string) => Promise<void>;
  fetchSecurityReport: () => Promise<void>;
  validateInput: (input: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  logs: [],
  validationResult: null,
  overallStatus: 'secure' as const,
  report: null,
  loading: false,
  error: null,
};

export const useSecurityStore = create<SecurityState>((set) => ({
  ...initialState,

  setLogs: (logs) => set({ logs, loading: false }),
  setValidationResult: (result) => set({ validationResult: result }),
  setOverallStatus: (status) => set({ overallStatus: status }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),

  fetchSecurityLogs: async (limit?: number, level?: string, category?: string) => {
    set({ loading: true });
    try {
      const result = await apiService.getSecurityLogs(limit, level, category);
      if (result.success && result.data) {
        set({ logs: result.data as Array<Record<string, unknown>>, loading: false });
      } else {
        set({ error: result.error || '获取安全日志失败', loading: false });
      }
    } catch (error) {
      console.error('[SecurityStore] fetchSecurityLogs 失败:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  fetchSecurityReport: async () => {
    set({ loading: true });
    try {
      const result = await apiService.getSecurityReport();
      if (result.success && result.data) {
        set({ report: result.data as Record<string, unknown>, loading: false });
      } else {
        set({ error: result.error || '获取安全报告失败', loading: false });
      }
    } catch (error) {
      console.error('[SecurityStore] fetchSecurityReport 失败:', error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  validateInput: async (input: string) => {
    try {
      const result = await apiService.validateSecurityInput(input);
      if (result.success && result.data) {
        const data = result.data as {
          valid: boolean;
          errors: string[];
          warnings: string[];
          riskLevel: 'low' | 'high';
        };
        set({
          validationResult: data,
          overallStatus: data.valid ? 'secure' : data.riskLevel === 'high' ? 'danger' : 'warning',
        });
      }
    } catch (error) {
      console.error('[SecurityStore] validateInput 失败:', error);
    }
  },

  reset: () => set(initialState),
}));
