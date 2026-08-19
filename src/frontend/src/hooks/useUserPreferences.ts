import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

const STORAGE_PREFIX = 'jbx_pref_';

function getKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function readValue<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(getKey(key));
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeValue<T>(key: string, value: T): void {
  try {
    localStorage.setItem(getKey(key), JSON.stringify(value));
  } catch {
    // localStorage may be full or unavailable
  }
}

function removeValue(key: string): void {
  try {
    localStorage.removeItem(getKey(key));
  } catch {
    // ignore
  }
}

export interface UserPreferences {
  fontSize: number;
  messageLayout: 'compact' | 'comfortable' | 'spacious';
  showTimestamps: boolean;
  showAvatars: boolean;
  sendOnEnter: boolean;
  soundEnabled: boolean;
  notificationEnabled: boolean;
  autoScroll: boolean;
  maxMessages: number;
  sidebarCollapsed: boolean;
  recentCommands: string[];
  pinnedShortcuts: string[];
  lastWorkspace: string;
  dashboardGreeting: string;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  fontSize: 14,
  messageLayout: 'compact',
  showTimestamps: true,
  showAvatars: true,
  sendOnEnter: true,
  soundEnabled: false,
  notificationEnabled: true,
  autoScroll: true,
  maxMessages: 500,
  sidebarCollapsed: false,
  recentCommands: [],
  pinnedShortcuts: ['new-chat', 'batch', 'automation', 'code', 'memory', 'monitor'],
  lastWorkspace: '',
  dashboardGreeting: '',
};

export function useUserPreferences(): {
  preferences: UserPreferences;
  setPreference: <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => void;
  setPreferences: Dispatch<SetStateAction<UserPreferences>>;
  resetPreferences: () => void;
  addRecentCommand: (cmd: string) => void;
  clearRecentCommands: () => void;
} {
  const [preferences, setPreferences] = useState<UserPreferences>(() => {
    const saved = readValue<Partial<UserPreferences>>('preferences', {});
    return { ...DEFAULT_PREFERENCES, ...saved };
  });

  useEffect(() => {
    writeValue('preferences', preferences);
  }, [preferences]);

  const setPreference = useCallback(<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => {
    setPreferences((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences(DEFAULT_PREFERENCES);
    removeValue('preferences');
  }, []);

  const addRecentCommand = useCallback((cmd: string) => {
    setPreferences((prev) => {
      const filtered = prev.recentCommands.filter((c) => c !== cmd);
      const updated = [cmd, ...filtered].slice(0, 20);
      return { ...prev, recentCommands: updated };
    });
  }, []);

  const clearRecentCommands = useCallback(() => {
    setPreferences((prev) => ({ ...prev, recentCommands: [] }));
  }, []);

  return {
    preferences,
    setPreference,
    setPreferences,
    resetPreferences,
    addRecentCommand,
    clearRecentCommands,
  };
}
