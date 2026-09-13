"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useWorkspaceStore = void 0;
const zustand_1 = require("zustand");
const apiService_1 = require("../api/apiService");
const logger_1 = require("../utils/logger");
const log = (0, logger_1.createLogger)('WorkspaceStore');
const initialState = {
    workspaces: [],
    activeWorkspaceId: null,
    sessions: [],
    activeSessionId: null,
    loading: false,
    error: null,
};
const MOCK_WORKSPACES = [
    {
        id: 'ws-jbx',
        name: '家百星项目',
        path: 'c:\\zy\\jiabaixing',
        description: '家百星 Agent 桌面端主项目',
        projectType: 'typescript',
        lastActive: new Date().toISOString(),
    },
    {
        id: 'ws-personal',
        name: '个人工作区',
        path: '~/workspace',
        description: '个人日常工作目录',
        projectType: 'workspace',
        lastActive: new Date().toISOString(),
    },
];
const MOCK_SESSIONS = [
    {
        id: 'session-1',
        title: '产品需求讨论',
        lastActive: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    },
    {
        id: 'session-2',
        title: '代码审查助手',
        lastActive: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    },
    {
        id: 'session-3',
        title: '周末旅行规划',
        lastActive: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    },
];
exports.useWorkspaceStore = (0, zustand_1.create)((set, get) => ({
    ...initialState,
    setWorkspaces: (workspaces) => set({ workspaces }),
    setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
    addWorkspace: (workspace) => {
        const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const newWorkspace = {
            ...workspace,
            id,
            lastActive: new Date().toISOString(),
        };
        set((state) => ({ workspaces: [...state.workspaces, newWorkspace] }));
        return newWorkspace;
    },
    createWorkspace: async (name, path, description) => {
        set({ loading: true, error: null });
        try {
            const result = await apiService_1.apiService.createWorkspace(name, path, description);
            if (result.success && result.data) {
                const workspace = result.data;
                set((state) => ({
                    workspaces: [...state.workspaces, workspace],
                    activeWorkspaceId: workspace.id,
                    loading: false,
                }));
                return workspace;
            }
            set({ error: result.error || '创建工作区失败', loading: false });
            return null;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : '未知错误';
            log.error('createWorkspace 失败:', err);
            set({ error: message, loading: false });
            return null;
        }
    },
    updateWorkspace: (id, updates) => set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, ...updates } : w)),
    })),
    removeWorkspace: (id) => set((state) => ({
        workspaces: state.workspaces.filter((w) => w.id !== id),
        activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
    })),
    getActiveWorkspace: () => {
        const state = get();
        if (!state.activeWorkspaceId)
            return null;
        return state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null;
    },
    loadMockWorkspaces: () => {
        log.info('加载 mock workspaces');
        set({ workspaces: MOCK_WORKSPACES, activeWorkspaceId: 'ws-jbx' });
    },
    fetchWorkspaces: async () => {
        set({ loading: true, error: null });
        try {
            const result = await apiService_1.apiService.getWorkspaces();
            if (result.success && Array.isArray(result.data)) {
                const workspaces = result.data.length > 0 ? result.data : MOCK_WORKSPACES;
                set({
                    workspaces,
                    activeWorkspaceId: workspaces[0]?.id || null,
                    loading: false,
                });
            }
            else {
                set({ workspaces: MOCK_WORKSPACES, activeWorkspaceId: 'ws-jbx', loading: false });
            }
        }
        catch (err) {
            log.error('fetchWorkspaces 失败:', err);
            set({ workspaces: MOCK_WORKSPACES, activeWorkspaceId: 'ws-jbx', loading: false });
        }
    },
    setSessions: (sessions) => set({ sessions }),
    setActiveSession: (id) => set({ activeSessionId: id }),
    createSession: (title) => {
        const newSession = {
            id: `session-${Date.now()}`,
            title: title || '新会话',
            lastActive: new Date().toISOString(),
        };
        set((state) => ({
            sessions: [newSession, ...state.sessions],
            activeSessionId: newSession.id,
        }));
        return newSession;
    },
    renameSession: (id, title) => set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    })),
    deleteSession: (id) => set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== id),
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
    })),
    reorderSessions: (sessions) => set({ sessions }),
    pinSession: (id, pinned) => set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, pinned: pinned ?? !s.pinned } : s)),
    })),
    loadMockSessions: () => {
        log.info('加载 mock sessions');
        set({ sessions: MOCK_SESSIONS, activeSessionId: null });
    },
    fetchSessions: async () => {
        set({ loading: true, error: null });
        try {
            const result = await apiService_1.apiService.getSessions();
            if (result.success && Array.isArray(result.data)) {
                const sessions = result.data.length > 0 ? result.data : MOCK_SESSIONS;
                set({ sessions, activeSessionId: sessions[0]?.id || null, loading: false });
            }
            else {
                set({ sessions: MOCK_SESSIONS, activeSessionId: MOCK_SESSIONS[0]?.id || null, loading: false });
            }
        }
        catch (err) {
            log.error('fetchSessions 失败:', err);
            set({ sessions: MOCK_SESSIONS, activeSessionId: MOCK_SESSIONS[0]?.id || null, loading: false });
        }
    },
}));
