import { create } from 'zustand';
import type { MemorySearchResponse, MemoryProfileResponse, MemoryStatsResponse } from '@shared/contracts';

interface MemoryState {
  searchResults: MemorySearchResponse | null;
  profile: MemoryProfileResponse | null;
  stats: MemoryStatsResponse | null;
  loading: boolean;
  error: string | null;

  setSearchResults: (results: MemorySearchResponse) => void;
  setProfile: (profile: MemoryProfileResponse) => void;
  setStats: (stats: MemoryStatsResponse) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  searchResults: null,
  profile: null,
  stats: null,
  loading: false,
  error: null,
};

export const useMemoryStore = create<MemoryState>((set) => ({
  ...initialState,

  setSearchResults: (results) => set({ searchResults: results, loading: false }),
  setProfile: (profile) => set({ profile }),
  setStats: (stats) => set({ stats }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  reset: () => set(initialState),
}));
