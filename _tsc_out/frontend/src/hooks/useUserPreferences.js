"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PREFERENCES = void 0;
exports.useUserPreferences = useUserPreferences;
const react_1 = require("react");
const STORAGE_PREFIX = 'jbx_pref_';
function getKey(key) {
    return `${STORAGE_PREFIX}${key}`;
}
function readValue(key, fallback) {
    try {
        const raw = localStorage.getItem(getKey(key));
        if (raw === null)
            return fallback;
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function writeValue(key, value) {
    try {
        localStorage.setItem(getKey(key), JSON.stringify(value));
    }
    catch {
        // localStorage may be full or unavailable
    }
}
function removeValue(key) {
    try {
        localStorage.removeItem(getKey(key));
    }
    catch {
        // ignore
    }
}
exports.DEFAULT_PREFERENCES = {
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
function useUserPreferences() {
    const [preferences, setPreferences] = (0, react_1.useState)(() => {
        const saved = readValue('preferences', {});
        return { ...exports.DEFAULT_PREFERENCES, ...saved };
    });
    (0, react_1.useEffect)(() => {
        writeValue('preferences', preferences);
    }, [preferences]);
    const setPreference = (0, react_1.useCallback)((key, value) => {
        setPreferences((prev) => ({ ...prev, [key]: value }));
    }, []);
    const resetPreferences = (0, react_1.useCallback)(() => {
        setPreferences(exports.DEFAULT_PREFERENCES);
        removeValue('preferences');
    }, []);
    const addRecentCommand = (0, react_1.useCallback)((cmd) => {
        setPreferences((prev) => {
            const filtered = prev.recentCommands.filter((c) => c !== cmd);
            const updated = [cmd, ...filtered].slice(0, 20);
            return { ...prev, recentCommands: updated };
        });
    }, []);
    const clearRecentCommands = (0, react_1.useCallback)(() => {
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
