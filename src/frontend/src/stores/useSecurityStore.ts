import { create } from 'zustand';

interface SecurityState {
  logs: Array<Record<string, unknown>>;
  validationResult: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    riskLevel: 'low' | 'high';
  } | null;
  overallStatus: 'secure' | 'warning' | 'danger';
  loading: boolean;
  error: string | null;

  setLogs: (logs: Array<Record<string, unknown>>) => void;
  setValidationResult: (result: SecurityState['validationResult']) => void;
  setOverallStatus: (status: SecurityState['overallStatus']) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  logs: [],
  validationResult: null,
  overallStatus: 'secure' as const,
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
  reset: () => set(initialState),
}));
