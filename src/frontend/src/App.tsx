import React, { Suspense, lazy, useEffect, useState } from 'react';
import './App.css';
import ChatInterface from './components/ChatInterface/ChatInterface';
import { HermesPanel } from './components/HermesPanel/HermesPanel';
import { ChatProvider } from './contexts/ChatContext';
import { useWebSocket } from './hooks/useWebSocket';
import { connectionManager } from './hooks/websocket';
import { useAgentStore } from './stores/useAgentStore';
import { useConnectionStore } from './stores/useConnectionStore';
import { useEvolutionStore } from './stores/useEvolutionStore';
import { useMonitorStore } from './stores/useMonitorStore';
import { useSkillStore } from './stores/useSkillStore';

// 懒加载其余面板，减少首屏加载体积
// 兼容 default 导出和命名导出
const loadPanel = (mod: any, name: string) => {
  if (mod.default) return mod.default;
  const key = Object.keys(mod).find((k) => k === name || k === 'default');
  return key ? mod[key] : mod;
};

const ConsolePanel = lazy(() => import('./components/ConsolePanel/ConsolePanel').then((m) => ({ default: loadPanel(m, 'ConsolePanel') })));
const AutomationPanel = lazy(() => import('./components/AutomationPanel/AutomationPanel').then((m) => ({ default: loadPanel(m, 'AutomationPanel') })));
const DesktopPanel = lazy(() => import('./components/DesktopPanel/DesktopPanel').then((m) => ({ default: loadPanel(m, 'DesktopPanel') })));
const MemoryPanel = lazy(() => import('./components/MemoryPanel/MemoryPanel').then((m) => ({ default: loadPanel(m, 'MemoryPanel') })));
const EvolutionPanel = lazy(() => import('./components/EvolutionPanel/EvolutionPanel').then((m) => ({ default: loadPanel(m, 'EvolutionPanel') })));
const SecurityPanel = lazy(() => import('./components/SecurityPanel/SecurityPanel').then((m) => ({ default: loadPanel(m, 'SecurityPanel') })));
const SettingsPanel = lazy(() => import('./components/SettingsPanel/SettingsPanel').then((m) => ({ default: loadPanel(m, 'SettingsPanel') })));
const MonitorPanel = lazy(() => import('./components/MonitorPanel/MonitorPanel').then((m) => ({ default: loadPanel(m, 'MonitorPanel') })));
const IntegrationPanel = lazy(() => import('./components/IntegrationPanel/IntegrationPanel').then((m) => ({ default: loadPanel(m, 'IntegrationPanel') })));
const CLIPanel = lazy(() => import('./components/CLIPanel/CLIPanel').then((m) => ({ default: loadPanel(m, 'CLIPanel') })));
const VibeCodingPanel = lazy(() => import('./components/VibeCodingPanel/VibeCodingPanel').then((m) => ({ default: loadPanel(m, 'VibeCodingPanel') })));


type View =
  | 'chat'
  | 'console'
  | 'hermes'
  | 'automation'
  | 'desktop'
  | 'memory'
  | 'evolution'
  | 'security'
  | 'settings'
  | 'monitor'
  | 'integration'
  | 'cli'
  | 'vibe';

interface NavGroup {
  title: string;
  items: { id: View; label: string; icon: string }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '工作区',
    items: [
      { id: 'chat', label: '对话', icon: '💬' },
      { id: 'hermes', label: 'Hermes', icon: '⚡' },
      { id: 'vibe', label: 'Vibe 编码', icon: '✨' },
    ],
  },
  {
    title: '执行与自动化',
    items: [
      { id: 'automation', label: '自动化', icon: '🤖' },
      { id: 'desktop', label: '桌面自动化', icon: '🖥️' },
      { id: 'cli', label: 'CLI 终端', icon: '⌨️' },
    ],
  },
  {
    title: '大脑与记忆',
    items: [
      { id: 'memory', label: '记忆', icon: '🧠' },
      { id: 'evolution', label: '进化', icon: '🧬' },
    ],
  },
  {
    title: '系统',
    items: [
      { id: 'monitor', label: '监控', icon: '📊' },
      { id: 'security', label: '安全', icon: '🛡️' },
      { id: 'integration', label: '集成', icon: '🔗' },
      { id: 'settings', label: '设置', icon: '⚙️' },
      { id: 'console', label: '控制台', icon: '🖥️' },
    ],
  },
];

const App: React.FC = () => {
  const [view, setView] = useState<View>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { connectionStatus } = useWebSocket({
    url: `ws://${window.location.hostname}:3111`,
  });

  const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);
  const setDialogState = useConnectionStore((s) => s.setDialogState);
  const addEvolutionEvent = useEvolutionStore((s) => s.addEvent);
  const addSkillExecutionUpdate = useSkillStore((s) => s.addExecutionUpdate);
  const updateSkillWeight = useSkillStore((s) => s.updateWeight);
  const addAgentExecutionUpdate = useAgentStore((s) => s.addExecutionUpdate);
  const addBrainStageUpdate = useAgentStore((s) => s.addBrainStageUpdate);
  const addToolTrace = useAgentStore((s) => s.addToolTrace);
  const setClarificationRequest = useAgentStore((s) => s.setClarificationRequest);
  const setExecutionPreview = useAgentStore((s) => s.setExecutionPreview);
  const addFileEvent = useAgentStore((s) => s.addFileEvent);
  const addMonitorLog = useMonitorStore((s) => s.addLog);

  useEffect(() => {
    setConnectionStatus(connectionStatus as 'connected' | 'connecting' | 'disconnected' | 'reconnecting');
  }, [connectionStatus, setConnectionStatus]);

  useEffect(() => {
    const handlers = {
      onConnectionStatus: (status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting') =>
        setConnectionStatus(status),
      onDialogState: (state: 'idle' | 'listening' | 'processing' | 'speaking') => setDialogState(state),
      onEvolutionEvent: (event: unknown) => addEvolutionEvent(event as Parameters<typeof addEvolutionEvent>[0]),
      onSkillExecutionUpdate: (update: unknown) =>
        addSkillExecutionUpdate(update as Parameters<typeof addSkillExecutionUpdate>[0]),
      onWeightUpdate: (update: unknown) => updateSkillWeight(update as Parameters<typeof updateSkillWeight>[0]),
      onAgentExecution: (update: unknown) =>
        addAgentExecutionUpdate(update as Parameters<typeof addAgentExecutionUpdate>[0]),
      onBrainStageUpdate: (update: unknown) =>
        addBrainStageUpdate(update as Parameters<typeof addBrainStageUpdate>[0]),
      onToolTrace: (trace: unknown) => addToolTrace(trace as Parameters<typeof addToolTrace>[0]),
      onClarificationRequest: (request: unknown) =>
        setClarificationRequest(request as Parameters<typeof setClarificationRequest>[0]),
      onExecutionPreview: (preview: unknown) =>
        setExecutionPreview(preview as Parameters<typeof setExecutionPreview>[0]),
      onFileModified: (event: unknown) => addFileEvent(event as Parameters<typeof addFileEvent>[0]),
      onFileRollback: (event: unknown) => addFileEvent(event as Parameters<typeof addFileEvent>[0]),
      onServerLog: (entry: unknown) => addMonitorLog(entry as Parameters<typeof addMonitorLog>[0]),
      onProactiveMessage: (message: unknown) => {
        console.log('[App] 收到主动消息:', message);
      },
    };

    connectionManager.onConnectionStatus(handlers.onConnectionStatus);
    connectionManager.onDialogState(handlers.onDialogState);
    connectionManager.onEvolutionEvent(handlers.onEvolutionEvent);
    connectionManager.onSkillExecutionUpdate(handlers.onSkillExecutionUpdate);
    connectionManager.onWeightUpdate(handlers.onWeightUpdate);
    connectionManager.onAgentExecution(handlers.onAgentExecution);
    connectionManager.onBrainStageUpdate(handlers.onBrainStageUpdate);
    connectionManager.onToolTrace(handlers.onToolTrace);
    connectionManager.onClarificationRequest(handlers.onClarificationRequest);
    connectionManager.onExecutionPreview(handlers.onExecutionPreview);
    connectionManager.onFileModified(handlers.onFileModified);
    connectionManager.onFileRollback(handlers.onFileRollback);
    connectionManager.onServerLog(handlers.onServerLog);
    connectionManager.onProactiveMessage(handlers.onProactiveMessage);

    return () => {
      connectionManager.offConnectionStatus(handlers.onConnectionStatus);
      connectionManager.offDialogState(handlers.onDialogState);
      connectionManager.offEvolutionEvent(handlers.onEvolutionEvent);
      connectionManager.offSkillExecutionUpdate(handlers.onSkillExecutionUpdate);
      connectionManager.offWeightUpdate(handlers.onWeightUpdate);
      connectionManager.offAgentExecution(handlers.onAgentExecution);
      connectionManager.offBrainStageUpdate(handlers.onBrainStageUpdate);
      connectionManager.offToolTrace(handlers.onToolTrace);
      connectionManager.offClarificationRequest(handlers.onClarificationRequest);
      connectionManager.offExecutionPreview(handlers.onExecutionPreview);
      connectionManager.offFileModified(handlers.onFileModified);
      connectionManager.offFileRollback(handlers.onFileRollback);
      connectionManager.offServerLog(handlers.onServerLog);
      connectionManager.offProactiveMessage(handlers.onProactiveMessage);
    };
  }, [
    setConnectionStatus,
    setDialogState,
    addEvolutionEvent,
    addSkillExecutionUpdate,
    updateSkillWeight,
    addAgentExecutionUpdate,
    addBrainStageUpdate,
    addToolTrace,
    setClarificationRequest,
    setExecutionPreview,
    addFileEvent,
    addMonitorLog,
  ]);

  const renderView = () => {
    switch (view) {
      case 'chat':
        return <ChatInterface />;
      case 'hermes':
        return <HermesPanel />;
      case 'console':
        return <ConsolePanel />;
      case 'automation':
        return <AutomationPanel />;
      case 'desktop':
        return <DesktopPanel />;
      case 'memory':
        return <MemoryPanel />;
      case 'evolution':
        return <EvolutionPanel />;
      case 'security':
        return <SecurityPanel />;
      case 'settings':
        return <SettingsPanel />;
      case 'monitor':
        return <MonitorPanel />;
      case 'integration':
        return <IntegrationPanel />;
      case 'cli':
        return <CLIPanel />;
      case 'vibe':
        return <VibeCodingPanel />;
      default:
        return <ChatInterface />;
    }
  };

  const statusLabel =
    connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中...' : '未连接';

  return (
    <ChatProvider>
      <div className="app-container">
        <aside className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-header">
            <span className="sidebar-logo">{sidebarCollapsed ? '家' : '家百星'}</span>
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              {sidebarCollapsed ? '→' : '←'}
            </button>
          </div>
          <nav className="sidebar-nav">
            {NAV_GROUPS.map((group) => (
              <div key={group.title} className="sidebar-group">
                {!sidebarCollapsed && <div className="sidebar-group-title">{group.title}</div>}
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={`sidebar-item ${view === item.id ? 'active' : ''}`}
                    onClick={() => setView(item.id)}
                    title={item.label}
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
          <div className="app-topbar">
            <span className="app-logo">家百星 · 御姐秘书</span>
            <span className={`connection-badge ${connectionStatus}`}>{statusLabel}</span>
          </div>
          <div className="app-content">
            <Suspense fallback={<div className="loading-fallback">正在加载面板...</div>}>
              {renderView()}
            </Suspense>
          </div>
        </div>
      </div>
    </ChatProvider>
  );
};

export default App;
