"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = __importStar(require("react"));
require("./App.css");
const DesktopDashboard_1 = require("./components/DesktopDashboard/DesktopDashboard");
const SessionList_1 = require("./components/SessionList/SessionList");
const PanelSkeleton_1 = require("./components/Skeleton/PanelSkeleton");
const ToastContainer_1 = require("./components/Toast/ToastContainer");
const ChatContext_1 = require("./contexts/ChatContext");
const I18nContext_1 = require("./contexts/I18nContext");
const ThemeContext_1 = require("./contexts/ThemeContext");
const ToastContext_1 = require("./contexts/ToastContext");
const websocket_1 = require("./hooks/websocket");
const useAgentStore_1 = require("./stores/useAgentStore");
const useWorkspaceStore_1 = require("./stores/useWorkspaceStore");
// 懒加载其余面板，减少首屏加载体积
// 兼容 default 导出和命名导出
const loadPanel = (mod, name) => {
    if (mod.default)
        return mod.default;
    const key = Object.keys(mod).find((k) => k === name || k === 'default');
    return key ? mod[key] : mod;
};
const SettingsPanel = (0, react_1.lazy)(() => Promise.resolve().then(() => __importStar(require('./components/SettingsPanel/SettingsPanel'))).then((m) => ({ default: loadPanel(m, 'SettingsPanel') })));
const NAV_GROUPS = [
    {
        title: '设置',
        items: [{ id: 'settings', label: '偏好设置', icon: '⚙️' }],
    },
];
const isElectron = typeof window !== 'undefined' && window.electronAPI?.isElectron;
const TitleBar = react_1.default.memo(() => {
    const { theme, toggleTheme } = (0, ThemeContext_1.useTheme)();
    const handleMinimize = (0, react_1.useCallback)(() => window.electronAPI?.window?.minimize(), []);
    const handleMaximize = (0, react_1.useCallback)(() => window.electronAPI?.window?.maximize(), []);
    const handleClose = (0, react_1.useCallback)(() => window.electronAPI?.window?.close(), []);
    const themeIcon = theme === 'dark' ? '☀️' : '🌙';
    if (!isElectron)
        return null;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "titlebar", children: [(0, jsx_runtime_1.jsxs)("div", { className: "titlebar-drag", children: [(0, jsx_runtime_1.jsx)("span", { className: "titlebar-icon", children: "\u2B50" }), (0, jsx_runtime_1.jsx)("span", { className: "titlebar-title", children: "\u5BB6\u767E\u661F Desktop" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "titlebar-controls", children: [(0, jsx_runtime_1.jsx)("button", { className: "theme-toggle-btn", onClick: toggleTheme, title: `切换到${theme === 'dark' ? '亮色' : '暗色'}主题`, children: themeIcon }), (0, jsx_runtime_1.jsx)("button", { className: "titlebar-btn", onClick: handleMinimize, title: "\u6700\u5C0F\u5316", children: (0, jsx_runtime_1.jsx)("svg", { width: "12", height: "12", viewBox: "0 0 12 12", children: (0, jsx_runtime_1.jsx)("rect", { y: "5", width: "12", height: "1.5", fill: "currentColor" }) }) }), (0, jsx_runtime_1.jsx)("button", { className: "titlebar-btn", onClick: handleMaximize, title: "\u6700\u5927\u5316", children: (0, jsx_runtime_1.jsx)("svg", { width: "12", height: "12", viewBox: "0 0 12 12", children: (0, jsx_runtime_1.jsx)("rect", { x: "1", y: "1", width: "10", height: "10", stroke: "currentColor", strokeWidth: "1.5", fill: "none" }) }) }), (0, jsx_runtime_1.jsx)("button", { className: "titlebar-btn titlebar-btn-close", onClick: handleClose, title: "\u5173\u95ED", children: (0, jsx_runtime_1.jsx)("svg", { width: "12", height: "12", viewBox: "0 0 12 12", children: (0, jsx_runtime_1.jsx)("path", { d: "M1 1L11 11M11 1L1 11", stroke: "currentColor", strokeWidth: "1.5" }) }) })] })] }));
});
TitleBar.displayName = 'TitleBar';
const App = () => {
    const [view, setView] = (0, react_1.useState)('chat');
    const [sidebarCollapsed, setSidebarCollapsed] = (0, react_1.useState)(false);
    const addAgentExecutionUpdate = (0, useAgentStore_1.useAgentStore)((s) => s.addExecutionUpdate);
    const addBrainStageUpdate = (0, useAgentStore_1.useAgentStore)((s) => s.addBrainStageUpdate);
    const addToolTrace = (0, useAgentStore_1.useAgentStore)((s) => s.addToolTrace);
    const sessions = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.sessions);
    const activeSessionId = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.activeSessionId);
    const fetchSessions = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.fetchSessions);
    const setActiveSession = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.setActiveSession);
    const createSession = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.createSession);
    const renameSession = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.renameSession);
    const deleteSession = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.deleteSession);
    const reorderSessions = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.reorderSessions);
    (0, react_1.useEffect)(() => {
        fetchSessions();
    }, [fetchSessions]);
    (0, react_1.useEffect)(() => {
        const handlers = {
            onAgentExecution: (update) => addAgentExecutionUpdate(update),
            onBrainStageUpdate: (update) => addBrainStageUpdate(update),
            onToolTrace: (trace) => addToolTrace(trace),
        };
        websocket_1.connectionManager.onAgentExecution(handlers.onAgentExecution);
        websocket_1.connectionManager.onBrainStageUpdate(handlers.onBrainStageUpdate);
        websocket_1.connectionManager.onToolTrace(handlers.onToolTrace);
        return () => {
            websocket_1.connectionManager.offAgentExecution(handlers.onAgentExecution);
            websocket_1.connectionManager.offBrainStageUpdate(handlers.onBrainStageUpdate);
            websocket_1.connectionManager.offToolTrace(handlers.onToolTrace);
        };
    }, [addAgentExecutionUpdate, addBrainStageUpdate, addToolTrace]);
    const handleSetView = (0, react_1.useCallback)((newView) => {
        setView(newView);
    }, []);
    const renderView = (0, react_1.useCallback)(() => {
        const viewComponents = {
            dashboard: (0, jsx_runtime_1.jsx)(DesktopDashboard_1.DesktopDashboard, { onNavigate: handleSetView }),
            chat: (0, jsx_runtime_1.jsx)(DesktopDashboard_1.DesktopDashboard, { onNavigate: handleSetView }),
            settings: (0, jsx_runtime_1.jsx)(SettingsPanel, {}),
        };
        return viewComponents[view] || (0, jsx_runtime_1.jsx)(DesktopDashboard_1.DesktopDashboard, { onNavigate: handleSetView });
    }, [view, handleSetView]);
    const handleToggleSidebar = (0, react_1.useCallback)(() => {
        setSidebarCollapsed((prev) => !prev);
    }, []);
    return ((0, jsx_runtime_1.jsx)(I18nContext_1.I18nProvider, { children: (0, jsx_runtime_1.jsx)(ThemeContext_1.ThemeProvider, { children: (0, jsx_runtime_1.jsx)(ChatContext_1.ChatProvider, { children: (0, jsx_runtime_1.jsxs)(ToastContext_1.ToastProvider, { children: [(0, jsx_runtime_1.jsx)(TitleBar, {}), (0, jsx_runtime_1.jsxs)("div", { className: "app-container", children: [(0, jsx_runtime_1.jsxs)("aside", { className: `app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`, children: [(0, jsx_runtime_1.jsxs)("div", { className: "sidebar-header", children: [(0, jsx_runtime_1.jsx)("span", { className: "sidebar-logo", children: sidebarCollapsed ? '家' : '家百星' }), (0, jsx_runtime_1.jsx)("button", { className: "sidebar-toggle", onClick: handleToggleSidebar, title: sidebarCollapsed ? '展开侧边栏' : '收起侧边栏', children: sidebarCollapsed ? '→' : '←' })] }), (0, jsx_runtime_1.jsx)("div", { className: "sidebar-session-section", children: (0, jsx_runtime_1.jsx)(SessionList_1.SessionList, { sessions: sessions, activeSessionId: activeSessionId ?? '', onSelect: (sessionId) => {
                                                    setActiveSession(sessionId);
                                                    setView('chat');
                                                }, onCreate: () => {
                                                    createSession();
                                                    setView('chat');
                                                }, onRename: (id, title) => renameSession(id, title), onDelete: (id) => deleteSession(id), onReorder: (reordered) => reorderSessions(reordered), collapsed: sidebarCollapsed }) }), (0, jsx_runtime_1.jsx)("nav", { className: "sidebar-nav", children: NAV_GROUPS.map((group) => ((0, jsx_runtime_1.jsxs)("div", { className: "sidebar-group", children: [!sidebarCollapsed && (0, jsx_runtime_1.jsx)("div", { className: "sidebar-group-title", children: group.title }), group.items.map((item) => ((0, jsx_runtime_1.jsxs)("button", { className: `sidebar-item ${view === item.id ? 'active' : ''}`, onClick: () => handleSetView(item.id), title: item.label, "aria-label": item.label, "data-testid": `nav-${item.id}`, children: [(0, jsx_runtime_1.jsx)("span", { className: "sidebar-icon", children: item.icon }), !sidebarCollapsed && (0, jsx_runtime_1.jsx)("span", { className: "sidebar-label", children: item.label })] }, item.id)))] }, group.title))) })] }), (0, jsx_runtime_1.jsx)("div", { className: "app-main", children: (0, jsx_runtime_1.jsx)("div", { className: "app-content", children: (0, jsx_runtime_1.jsx)(react_1.Suspense, { fallback: (0, jsx_runtime_1.jsx)(PanelSkeleton_1.PanelSkeleton, { statsCount: 4, sectionCount: 2, hasTabs: true }), children: renderView() }) }) })] }), (0, jsx_runtime_1.jsx)(ToastContainer_1.ToastContainer, {})] }) }) }) }));
};
exports.default = App;
