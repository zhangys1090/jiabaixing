"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAgentStore = void 0;
const zustand_1 = require("zustand");
const apiService_1 = require("../api/apiService");
const logger_1 = require("../utils/logger");
const log = (0, logger_1.createLogger)('AgentStore');
const initialState = {
    executionUpdates: [],
    brainStageUpdates: [],
    toolTraces: [],
    clarificationRequest: null,
    executionPreview: null,
    fileEvents: [],
    crossSessionTasks: [],
    fcLoopCount: 0,
    fcLoopMax: 8,
    tokenBudget: 6000,
    tokenUsed: 0,
    harnessStatus: null,
    loading: false,
    error: null,
};
exports.useAgentStore = (0, zustand_1.create)((set) => ({
    ...initialState,
    addExecutionUpdate: (update) => set((state) => ({
        executionUpdates: [...state.executionUpdates.slice(-49), update],
    })),
    addBrainStageUpdate: (update) => set((state) => ({
        brainStageUpdates: [...state.brainStageUpdates.slice(-49), update],
    })),
    addToolTrace: (trace) => set((state) => ({
        toolTraces: [...state.toolTraces.slice(-99), trace],
    })),
    setClarificationRequest: (request) => set({ clarificationRequest: request }),
    setExecutionPreview: (preview) => set({ executionPreview: preview }),
    addFileEvent: (event) => set((state) => ({
        fileEvents: [...state.fileEvents.slice(-49), event],
    })),
    setCrossSessionTasks: (tasks) => set({ crossSessionTasks: tasks }),
    updateFcLoop: (count, tokenUsed) => set({ fcLoopCount: count, tokenUsed }),
    fetchHarnessStatus: async () => {
        set({ loading: true });
        try {
            const result = await apiService_1.apiService.getHarnessStatus();
            if (result.success && result.data) {
                set({ harnessStatus: result.data, loading: false });
            }
            else {
                set({ error: result.error || '获取 Harness 状态失败', loading: false });
            }
        }
        catch (error) {
            log.error('fetchHarnessStatus 失败:', error);
            set({ error: error.message, loading: false });
        }
    },
    reset: () => set(initialState),
}));
