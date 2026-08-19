import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import './App.css';
import { DesktopDashboard } from './components/DesktopDashboard/DesktopDashboard';
import { SessionList } from './components/SessionList/SessionList';
import { PanelSkeleton } from './components/Skeleton/PanelSkeleton';
import { ToastContainer } from './components/Toast/ToastContainer';
import { ChatProvider } from './contexts/ChatContext';
import { I18nProvider } from './contexts/I18nContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { connectionManager } from './hooks/websocket';
import { useAgentStore } from './stores/useAgentStore';
import { useWorkspaceStore } from './stores/useWorkspaceStore';

// 懒加载其余面板，减少首屏加载体积
// 兼容 default 导出和命名导出
const loadPanel = (mod: any, name: string) => {
  if (mod.default) return mod.default;
  const key = Object.keys(mod).find((k) => k === name || k === 'default');
  return key ? mod[key] : mod;
};

const SettingsPanel = lazy(() =>
  import('./components/SettingsPanel/SettingsPanel').then((m) => ({ default: loadPanel(m, 'SettingsPanel') }))
);

type View = 'dashboard' | 'chat' | 'settings';

export type { View };

interface NavGroup {
  title: string;
  items: { id: View; label: string; icon: string; beta?: boolean }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '设置',
    items: [{ id: 'settings', label: '偏好设置', icon: '⚙️' }],
  },
];

const isElectron = typeof window !== 'undefined' && (window as any).electronAPI?.isElectron;

const TitleBar: React.FC = React.memo(() => {
  const { theme, toggleTheme } = useTheme();
  const handleMinimize = useCallback(() => (window as any).electronAPI?.window?.minimize(), []);
  const handleMaximize = useCallback(() => (window as any).electronAPI?.window?.maximize(), []);
  const handleClose = useCallback(() => (window as any).electronAPI?.window?.close(), []);

  const themeIcon = theme === 'dark' ? '☀️' : '🌙';

  if (!isElectron) return null;

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <span className="titlebar-icon">⭐</span>
        <span className="titlebar-title">家百星 Desktop</span>
      </div>
      <div className="titlebar-controls">
        <button
          className="theme-toggle-btn"
          onClick={toggleTheme}
          title={`切换到${theme === 'dark' ? '亮色' : '暗色'}主题`}
        >
          {themeIcon}
        </button>
        <button className="titlebar-btn" onClick={handleMinimize} title="最小化">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect y="5" width="12" height="1.5" fill="currentColor" />
          </svg>
        </button>
        <button className="titlebar-btn" onClick={handleMaximize} title="最大化">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="1" y="1" width="10" height="10" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>
        <button className="titlebar-btn titlebar-btn-close" onClick={handleClose} title="关闭">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    </div>
  );
});

TitleBar.displayName = 'TitleBar';

const App: React.FC = () => {
  const [view, setView] = useState<View>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const addAgentExecutionUpdate = useAgentStore((s) => s.addExecutionUpdate);
  const addBrainStageUpdate = useAgentStore((s) => s.addBrainStageUpdate);
  const addToolTrace = useAgentStore((s) => s.addToolTrace);

  const sessions = useWorkspaceStore((s) => s.sessions);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const fetchSessions = useWorkspaceStore((s) => s.fetchSessions);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const createSession = useWorkspaceStore((s) => s.createSession);
  const renameSession = useWorkspaceStore((s) => s.renameSession);
  const deleteSession = useWorkspaceStore((s) => s.deleteSession);
  const reorderSessions = useWorkspaceStore((s) => s.reorderSessions);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    const handlers = {
      onAgentExecution: (update: unknown) =>
        addAgentExecutionUpdate(update as Parameters<typeof addAgentExecutionUpdate>[0]),
      onBrainStageUpdate: (update: unknown) => addBrainStageUpdate(update as Parameters<typeof addBrainStageUpdate>[0]),
      onToolTrace: (trace: unknown) => addToolTrace(trace as Parameters<typeof addToolTrace>[0]),
    };

    connectionManager.onAgentExecution(handlers.onAgentExecution);
    connectionManager.onBrainStageUpdate(handlers.onBrainStageUpdate);
    connectionManager.onToolTrace(handlers.onToolTrace);

    return () => {
      connectionManager.offAgentExecution(handlers.onAgentExecution);
      connectionManager.offBrainStageUpdate(handlers.onBrainStageUpdate);
      connectionManager.offToolTrace(handlers.onToolTrace);
    };
  }, [addAgentExecutionUpdate, addBrainStageUpdate, addToolTrace]);

  const handleSetView = useCallback((newView: View) => {
    setView(newView);
  }, []);

  const renderView = useCallback(() => {
    const viewComponents: Record<View, React.ReactNode> = {
      dashboard: <DesktopDashboard onNavigate={handleSetView} />,
      chat: <DesktopDashboard onNavigate={handleSetView} />,
      settings: <SettingsPanel />,
    };

    return viewComponents[view] || <DesktopDashboard onNavigate={handleSetView} />;
  }, [view, handleSetView]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  return (
    <I18nProvider>
      <ThemeProvider>
        <ChatProvider>
          <ToastProvider>
            <TitleBar />
            <div className="app-container">
              <aside className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
                <div className="sidebar-header">
                  <span className="sidebar-logo">{sidebarCollapsed ? '家' : '家百星'}</span>
                  <button
                    className="sidebar-toggle"
                    onClick={handleToggleSidebar}
                    title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                  >
                    {sidebarCollapsed ? '→' : '←'}
                  </button>
                </div>
                <div className="sidebar-session-section">
                  <SessionList
                    sessions={sessions}
                    activeSessionId={activeSessionId ?? ''}
                    onSelect={(sessionId) => {
                      setActiveSession(sessionId);
                      setView('chat');
                    }}
                    onCreate={() => {
                      createSession();
                      setView('chat');
                    }}
                    onRename={(id, title) => renameSession(id, title)}
                    onDelete={(id) => deleteSession(id)}
                    onReorder={(reordered) => reorderSessions(reordered)}
                    collapsed={sidebarCollapsed}
                  />
                </div>
                <nav className="sidebar-nav">
                  {NAV_GROUPS.map((group) => (
                    <div key={group.title} className="sidebar-group">
                      {!sidebarCollapsed && <div className="sidebar-group-title">{group.title}</div>}
                      {group.items.map((item) => (
                        <button
                          key={item.id}
                          className={`sidebar-item ${view === item.id ? 'active' : ''}`}
                          onClick={() => handleSetView(item.id)}
                          title={item.label}
                          aria-label={item.label}
                          data-testid={`nav-${item.id}`}
                        >
                          <span className="sidebar-icon">{item.icon}</span>
                          {!sidebarCollapsed && <span className="sidebar-label">{item.label}</span>}
                        </button>
                      ))}
                    </div>
                  ))}
                </nav>
              </aside>

              <div className="app-main">
                <div className="app-content">
                  <Suspense fallback={<PanelSkeleton statsCount={4} sectionCount={2} hasTabs />}>
                    {renderView()}
                  </Suspense>
                </div>
              </div>
            </div>
            <ToastContainer />
          </ToastProvider>
        </ChatProvider>
      </ThemeProvider>
    </I18nProvider>
  );
};

export default App;
