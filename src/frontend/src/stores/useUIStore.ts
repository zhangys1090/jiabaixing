import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ModuleId } from '../types/chat';

// 面板状态接口
interface PanelState {
  collapsed: boolean;
  width: number;
}

interface UIState {
  activeModule: ModuleId;
  theme: 'dark' | 'light';
  settingsOpen: boolean;
  skillConsoleOpen: boolean;
  // 面板状态
  leftPanel: PanelState;
  rightPanel: PanelState;
  // 响应式相关
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;

  // Actions
  setActiveModule: (moduleId: ModuleId) => void;
  toggleRightPanel: () => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  toggleLeftPanel: () => void;
  setLeftPanelCollapsed: (collapsed: boolean) => void;
  setLeftPanelWidth: (width: number) => void;
  setTheme: (theme: 'dark' | 'light') => void;
  setSettingsOpen: (open: boolean) => void;
  setSkillConsoleOpen: (open: boolean) => void;
  setDeviceType: (isMobile: boolean, isTablet: boolean, isDesktop: boolean) => void;
  resetPanels: () => void;
}

const DEFAULT_PANEL_WIDTHS = {
  left: 48,
  right: 320,
};

const STORAGE_KEY = 'jiabaixing-ui-state';

export const useUIStore = create<UIState>()(
  persist(
    (set, _get) => ({
      activeModule: 'chat',
      theme: 'dark',
      settingsOpen: false,
      skillConsoleOpen: false,
      leftPanel: {
        collapsed: false,
        width: DEFAULT_PANEL_WIDTHS.left,
      },
      rightPanel: {
        collapsed: false,
        width: DEFAULT_PANEL_WIDTHS.right,
      },
      isMobile: false,
      isTablet: false,
      isDesktop: true,

      setActiveModule: (moduleId) =>
        set((state) => ({
          activeModule: moduleId,
          rightPanel: {
            ...state.rightPanel,
            collapsed: moduleId === 'chat',
          },
        })),

      toggleRightPanel: () =>
        set((state) => ({
          rightPanel: {
            ...state.rightPanel,
            collapsed: !state.rightPanel.collapsed,
          },
        })),

      setRightPanelCollapsed: (collapsed) =>
        set((state) => ({
          rightPanel: {
            ...state.rightPanel,
            collapsed,
          },
        })),

      setRightPanelWidth: (width) =>
        set((state) => ({
          rightPanel: {
            ...state.rightPanel,
            width: Math.max(240, Math.min(600, width)),
          },
        })),

      toggleLeftPanel: () =>
        set((state) => ({
          leftPanel: {
            ...state.leftPanel,
            collapsed: !state.leftPanel.collapsed,
          },
        })),

      setLeftPanelCollapsed: (collapsed) =>
        set((state) => ({
          leftPanel: {
            ...state.leftPanel,
            collapsed,
          },
        })),

      setLeftPanelWidth: (width) =>
        set((state) => ({
          leftPanel: {
            ...state.leftPanel,
            width: Math.max(48, Math.min(200, width)),
          },
        })),

      setTheme: (theme) => set({ theme }),

      setSettingsOpen: (open) => set({ settingsOpen: open }),

      setSkillConsoleOpen: (open) => set({ skillConsoleOpen: open }),

      setDeviceType: (isMobile, isTablet, isDesktop) => set({ isMobile, isTablet, isDesktop }),

      resetPanels: () =>
        set({
          leftPanel: {
            collapsed: false,
            width: DEFAULT_PANEL_WIDTHS.left,
          },
          rightPanel: {
            collapsed: false,
            width: DEFAULT_PANEL_WIDTHS.right,
          },
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        activeModule: state.activeModule,
        leftPanel: state.leftPanel,
        rightPanel: state.rightPanel,
      }),
    }
  )
);
