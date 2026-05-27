import { create } from 'zustand';

interface DesktopState {
  screenshot: string | null;
  ocrResult: string[];
  actionHistory: Array<{
    type: 'click' | 'type' | 'screenshot' | 'ocr';
    detail: string;
    timestamp: number;
  }>;
  isRunning: boolean;
  safeMode: boolean;
  loading: boolean;
  error: string | null;

  setScreenshot: (data: string | null) => void;
  setOcrResult: (result: string[]) => void;
  addAction: (action: DesktopState['actionHistory'][number]) => void;
  setIsRunning: (running: boolean) => void;
  setSafeMode: (safe: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  screenshot: null,
  ocrResult: [],
  actionHistory: [],
  isRunning: false,
  safeMode: true,
  loading: false,
  error: null,
};

export const useDesktopStore = create<DesktopState>((set) => ({
  ...initialState,

  setScreenshot: (data) => set({ screenshot: data, loading: false }),
  setOcrResult: (result) => set({ ocrResult: result }),
  addAction: (action) =>
    set((state) => ({
      actionHistory: [...state.actionHistory.slice(-49), action],
    })),
  setIsRunning: (running) => set({ isRunning: running }),
  setSafeMode: (safe) => set({ safeMode: safe }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  reset: () => set(initialState),
}));
