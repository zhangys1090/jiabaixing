import { create } from 'zustand';
import {
  IntegrationPlatform,
  IntegrationStatus,
  IntegrationPlatformInfo,
  SendMessageRequest,
  PlatformConfig,
} from '@shared/contracts';
import { apiService } from '../api/apiService';

interface IntegrationState {
  platforms: IntegrationPlatformInfo[];
  platformStatuses: Map<IntegrationPlatform, IntegrationStatus>;
  messages: Array<{
    id: string;
    platform: IntegrationPlatform;
    type: string;
    content: string;
    from?: string;
    fromName?: string;
    timestamp: string;
    direction: 'incoming' | 'outgoing';
  }>;
  isLoading: boolean;
  error: string | null;
  fetchPlatforms: () => Promise<void>;
  fetchPlatformStatus: (platform: IntegrationPlatform) => Promise<void>;
  connectPlatform: (platform: IntegrationPlatform, config: PlatformConfig) => Promise<void>;
  disconnectPlatform: (platform: IntegrationPlatform) => Promise<void>;
  sendMessage: (platform: IntegrationPlatform, request: SendMessageRequest) => Promise<void>;
  addMessage: (message: {
    platform: IntegrationPlatform;
    type: string;
    content: string;
    from?: string;
    fromName?: string;
    direction: 'incoming' | 'outgoing';
  }) => void;
  clearMessages: () => void;
}

export const useIntegrationStore = create<IntegrationState>((set, get) => ({
  platforms: [],
  platformStatuses: new Map(),
  messages: [],
  isLoading: false,
  error: null,

  fetchPlatforms: async () => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiService.getIntegrationPlatforms();
      if (result.success && result.data) {
        set({ platforms: result.data.platforms });
      } else {
        set({ error: result.error || '获取平台列表失败' });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ isLoading: false });
    }
  },

  fetchPlatformStatus: async (platform: IntegrationPlatform) => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiService.getIntegrationPlatformStatus(platform);
      if (result.success && result.data) {
        set((state) => {
          const newStatuses = new Map(state.platformStatuses);
          newStatuses.set(platform, (result.data as { status: IntegrationStatus }).status);
          return { platformStatuses: newStatuses };
        });
      } else {
        set({ error: result.error || `获取${platform}状态失败` });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ isLoading: false });
    }
  },

  connectPlatform: async (platform: IntegrationPlatform, config: PlatformConfig) => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiService.connectIntegrationPlatform(platform, config);
      if (result.success) {
        await get().fetchPlatformStatus(platform);
      } else {
        set({ error: result.error || `连接${platform}失败` });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ isLoading: false });
    }
  },

  disconnectPlatform: async (platform: IntegrationPlatform) => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiService.disconnectIntegrationPlatform(platform);
      if (result.success) {
        await get().fetchPlatformStatus(platform);
      } else {
        set({ error: result.error || `断开${platform}失败` });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ isLoading: false });
    }
  },

  sendMessage: async (platform: IntegrationPlatform, request: SendMessageRequest) => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiService.sendIntegrationMessage(request);
      if (result.success) {
        get().addMessage({
          platform,
          type: 'text',
          content: request.message,
          direction: 'outgoing',
        });
      } else {
        set({ error: result.error || '发送消息失败' });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
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
