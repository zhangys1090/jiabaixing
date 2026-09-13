"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useUIStore = void 0;
const zustand_1 = require("zustand");
const middleware_1 = require("zustand/middleware");
const DEFAULT_PANEL_WIDTHS = {
    left: 48,
    right: 320,
};
const STORAGE_KEY = 'jiabaixing-ui-state';
exports.useUIStore = (0, zustand_1.create)()((0, middleware_1.persist)((set, _get) => ({
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
    setActiveModule: (moduleId) => set((state) => ({
        activeModule: moduleId,
        rightPanel: {
            ...state.rightPanel,
            collapsed: moduleId === 'chat',
        },
    })),
    toggleRightPanel: () => set((state) => ({
        rightPanel: {
            ...state.rightPanel,
            collapsed: !state.rightPanel.collapsed,
        },
    })),
    setRightPanelCollapsed: (collapsed) => set((state) => ({
        rightPanel: {
            ...state.rightPanel,
            collapsed,
        },
    })),
    setRightPanelWidth: (width) => set((state) => ({
        rightPanel: {
            ...state.rightPanel,
            width: Math.max(240, Math.min(600, width)),
        },
    })),
    toggleLeftPanel: () => set((state) => ({
        leftPanel: {
            ...state.leftPanel,
            collapsed: !state.leftPanel.collapsed,
        },
    })),
    setLeftPanelCollapsed: (collapsed) => set((state) => ({
        leftPanel: {
            ...state.leftPanel,
            collapsed,
        },
    })),
    setLeftPanelWidth: (width) => set((state) => ({
        leftPanel: {
            ...state.leftPanel,
            width: Math.max(48, Math.min(200, width)),
        },
    })),
    setTheme: (theme) => set({ theme }),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setSkillConsoleOpen: (open) => set({ skillConsoleOpen: open }),
    setDeviceType: (isMobile, isTablet, isDesktop) => set({ isMobile, isTablet, isDesktop }),
    resetPanels: () => set({
        leftPanel: {
            collapsed: false,
            width: DEFAULT_PANEL_WIDTHS.left,
        },
        rightPanel: {
            collapsed: false,
            width: DEFAULT_PANEL_WIDTHS.right,
        },
    }),
}), {
    name: STORAGE_KEY,
    storage: (0, middleware_1.createJSONStorage)(() => localStorage),
    partialize: (state) => ({
        theme: state.theme,
        activeModule: state.activeModule,
        leftPanel: state.leftPanel,
        rightPanel: state.rightPanel,
    }),
}));
