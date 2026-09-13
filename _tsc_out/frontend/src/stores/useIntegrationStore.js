"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useIntegrationStore = void 0;
const zustand_1 = require("zustand");
const apiService_1 = require("../api/apiService");
exports.useIntegrationStore = (0, zustand_1.create)((set, get) => ({
    platforms: [],
    platformStatuses: new Map(),
    messages: [],
    isLoading: false,
    error: null,
    fetchPlatforms: async () => {
        set({ isLoading: true, error: null });
        try {
            const result = await apiService_1.apiService.getIntegrationPlatforms();
            if (result.success && result.data) {
                set({ platforms: result.data.platforms });
            }
            else {
                set({ error: result.error || '获取平台列表失败' });
            }
        }
        catch (error) {
            set({ error: error.message });
        }
        finally {
            set({ isLoading: false });
        }
    },
    fetchPlatformStatus: async (platform) => {
        set({ isLoading: true, error: null });
        try {
            const result = await apiService_1.apiService.getIntegrationPlatformStatus(platform);
            if (result.success && result.data) {
                set((state) => {
                    const newStatuses = new Map(state.platformStatuses);
                    newStatuses.set(platform, result.data.status);
                    return { platformStatuses: newStatuses };
                });
            }
            else {
                set({ error: result.error || `获取${platform}状态失败` });
            }
        }
        catch (error) {
            set({ error: error.message });
        }
        finally {
            set({ isLoading: false });
        }
    },
    connectPlatform: async (platform, config) => {
        set({ isLoading: true, error: null });
        try {
            const result = await apiService_1.apiService.connectIntegrationPlatform(platform, config);
            if (result.success) {
                await get().fetchPlatformStatus(platform);
            }
            else {
                set({ error: result.error || `连接${platform}失败` });
            }
        }
        catch (error) {
            set({ error: error.message });
        }
        finally {
            set({ isLoading: false });
        }
    },
    disconnectPlatform: async (platform) => {
        set({ isLoading: true, error: null });
        try {
            const result = await apiService_1.apiService.disconnectIntegrationPlatform(platform);
            if (result.success) {
                await get().fetchPlatformStatus(platform);
            }
            else {
                set({ error: result.error || `断开${platform}失败` });
            }
        }
        catch (error) {
            set({ error: error.message });
        }
        finally {
            set({ isLoading: false });
        }
    },
    sendMessage: async (platform, request) => {
        set({ isLoading: true, error: null });
        try {
            const result = await apiService_1.apiService.sendIntegrationMessage(request);
            if (result.success) {
                get().addMessage({
                    platform,
                    type: 'text',
                    content: request.message,
                    direction: 'outgoing',
                });
            }
            else {
                set({ error: result.error || '发送消息失败' });
            }
        }
        catch (error) {
            set({ error: error.message });
        }
        finally {
            set({ isLoading: false });
        }
    },
    addMessage: (message) => {
        set((state) => ({
            messages: [
                ...state.messages,
                {
                    ...message,
                    id: `${Date.now()}-${Math.random()}`,
                    timestamp: new Date().toISOString(),
                },
            ],
        }));
    },
    clearMessages: () => {
        set({ messages: [] });
    },
}));
