import React, { useCallback, useEffect } from 'react';
import './App.css';
import { AgentExecutionPanel } from './components/AgentExecutionPanel/AgentExecutionPanel';
import AutomationPanel from './components/AutomationPanel/AutomationPanel';
import ChatInterface from './components/ChatInterface/ChatInterface';
import { EvolutionPanel } from './components/EvolutionPanel/EvolutionPanel';
import { LogPanel, LogEntry } from './components/LogPanel/LogPanel';
import PerformancePanel from './components/PerformancePanel';
import SettingsPanel from './components/SettingsPanel/SettingsPanel';
import SkillConsole from './components/SkillConsole/SkillConsole';
import VibeCodingPanel from './components/VibeCodingPanel/VibeCodingPanel';
import { ChatProvider } from './contexts/ChatContext';
import { useWebSocket } from './hooks/useWebSocket';
import { LeftRail, ModuleId } from './components/layout/LeftRail';
import { RightPanel } from './components/layout/RightPanel';
import { MainLayoutContainer, CenterPanel } from './components/layout/MainLayout';
import {
  AppHeaderContainer,
  BrandMark,
  ConnectionBadge,
  HeaderSpacer,
  ThemeToggle,
  SettingsButton,
} from './components/layout/AppHeader';
import { StatusBarContainer, StatusItem, StatusDot, StatusSeparator } from './components/layout/StatusBar';
import { useUIStore } from './stores/useUIStore';
import { useConnectionStore } from './stores/useConnectionStore';
import { useAgentStore } from './stores/useAgentStore';
import { useEvolutionStore } from './stores/useEvolutionStore';
import { useSkillStore } from './stores/useSkillStore';
import { useMonitorStore } from './stores/useMonitorStore';
import { useAutomationStore } from './stores/useAutomationStore';
import { MemoryPanel } from './components/MemoryPanel/MemoryPanel';
import { DesktopPanel } from './components/DesktopPanel/DesktopPanel';
import { SecurityPanel } from './components/SecurityPanel/SecurityPanel';
import { MonitorPanel } from './components/MonitorPanel/MonitorPanel';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useResponsive } from './hooks/useResponsive';
import { KeyboardShortcutsPanel } from './components/common/KeyboardShortcutsPanel';
import { AnimatedPanel } from './components/common/AnimatedTransition';
import './styles/components.css';
import './styles/variables.css';
import './styles/animations.css';

const WS_URL = `ws://${window.location.hostname}:3111`;

const MODULE_TITLES: Record<ModuleId, string> = {
  chat: '',
  memory: '🧠 记忆管理',
  agent: '🤖 Agent执行',
  evolution: '🧬 进化监控',
  skills: '🔧 技能控制台',
  desktop: '🖥 桌面代理',
  automation: '⚡ 自动化',
  security: '🛡 安全仪表盘',
  monitor: '📊 系统监控',
};

const App: React.FC = () => {
  const {
    activeModule,
    rightPanel,
    leftPanel,
    theme,
    settingsOpen,
    skillConsoleOpen,
    setActiveModule,
    toggleRightPanel,
    setRightPanelCollapsed,
    setRightPanelWidth,
    toggleLeftPanel,
    setLeftPanelCollapsed,
    setLeftPanelWidth,
    setTheme,
    setSettingsOpen,
    setSkillConsoleOpen,
    resetPanels,
    isMobile,
    isTablet,
    isDesktop,
  } = useUIStore();

  // Register hooks
  useKeyboardShortcuts();
  useResponsive();

  const { connected, model, uptime, setConnected, setDialogState, setStatusData } = useConnectionStore();

  const agentStore = useAgentStore();
  const evolutionStore = useEvolutionStore();
  const skillStore = useSkillStore();
  const monitorStore = useMonitorStore();
  const automationStore = useAutomationStore();

  const { isConnected, send } = useWebSocket({
    url: WS_URL,
    onConnectionChange: (conn) => {
      setConnected(conn);
    },
    onDialogStateChange: (state) => {
      setDialogState(state);
    },
    onBrainStageUpdate: (update) => {
      agentStore.addBrainStageUpdate(update);
    },
    onPerceptionUpdate: (update) => {
      agentStore.addExecutionUpdate({
        traceId: update.traceId || 'unknown',
        phase: update.modality || 'unknown',
        status: update.status || 'unknown',
        result: update.result,
        timestamp: update.timestamp || new Date().toISOString(),
      });
    },
    onSkillExecutionUpdate: (update) => {
      skillStore.addExecutionUpdate(update);
    },
    onEvolutionEvent: (event) => {
      evolutionStore.addEvent(event);
    },
    onServerLog: (entry) => {
      const logEntry: LogEntry = {
        id: `${entry.timestamp}_${Math.random().toString(36).substr(2, 6)}`,
        timestamp: entry.timestamp,
        level: (entry.level as LogEntry['level']) || 'info',
        module: entry.module || 'system',
        message: entry.message,
        traceId: entry.traceId,
      };
      monitorStore.addLog(logEntry as unknown as import('@shared/contracts').WsServerLogData);
    },
    onClarificationRequest: (request) => {
      agentStore.setClarificationRequest(request);
    },
    onExecutionPreview: (preview) => {
      agentStore.setExecutionPreview(preview);
    },
    onFileModified: (event) => {
      agentStore.addFileEvent(event);
    },
    onToolTrace: (trace) => {
      agentStore.addToolTrace(trace);
    },
    onResponseReady: () => {
      setDialogState('idle');
    },
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const sendWsMessage = useCallback(
    (data: Record<string, unknown>) => {
      return send(data);
    },
    [send]
  );

  const handleModuleChange = useCallback(
    (moduleId: ModuleId) => {
      if (moduleId === 'skills') {
        setSkillConsoleOpen(true);
        return;
      }
      setActiveModule(moduleId);
      if (moduleId === 'automation') {
        automationStore.fetchAll();
      }
    },
    [setActiveModule, setSkillConsoleOpen, automationStore]
  );

  const showRightPanel = activeModule !== 'chat';

  const formatUptime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const renderRightPanelContent = () => {
    switch (activeModule) {
      case 'memory':
        return <MemoryPanel />;
      case 'agent':
        return (
          <AgentExecutionPanel
            brainStageUpdates={agentStore.brainStageUpdates}
            perceptionUpdates={[]}
            skillExecutionUpdates={skillStore.executionUpdates}
          />
        );
      case 'evolution':
        return (
          <EvolutionPanel
            visible={true}
            onClose={() => setActiveModule('chat')}
            evolutionEvents={evolutionStore.events}
          />
        );
      case 'desktop':
        return <DesktopPanel />;
      case 'automation':
        return (
          <AutomationPanel
            tasks={automationStore.tasks}
            proactiveTriggers={automationStore.triggers}
            behaviorPatterns={automationStore.patterns || undefined}
            onTaskToggle={(taskId, enabled) => {
              sendWsMessage({
                type: 'automation_task_toggle',
                taskId,
                enabled,
              });
            }}
            onTaskCreate={(task) => {
              sendWsMessage({ type: 'automation_task_create', task });
            }}
            onTriggerExecute={(trigger) => {
              sendWsMessage({ type: 'automation_trigger_execute', trigger });
            }}
          />
        );
      case 'security':
        return <SecurityPanel />;
      case 'monitor':
        return <MonitorPanel />;
      default:
        return null;
    }
  };

  return (
    <div className="app-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppHeaderContainer>
        <BrandMark>✦ jiabaixing</BrandMark>
        <ConnectionBadge $connected={isConnected}>{isConnected ? '已连接' : '未连接'}</ConnectionBadge>
        <HeaderSpacer />
        <ThemeToggle onClick={toggleTheme} className="hover-scale transition-fast">
          {theme === 'dark' ? '☀️' : '🌙'}
        </ThemeToggle>
        <SettingsButton onClick={() => setSettingsOpen(true)} className="hover-scale transition-fast">
          ⌨️
        </SettingsButton>
      </AppHeaderContainer>

      <MainLayoutContainer>
        {/* Left Rail - Responsive */}
        {(!isMobile || !leftPanel.collapsed) && (
          <AnimatedPanel isOpen={!leftPanel.collapsed} position="left">
            <LeftRail activeModule={activeModule} onModuleChange={handleModuleChange} />
          </AnimatedPanel>
        )}

        {/* Center Panel */}
        <CenterPanel>
          <ChatProvider>
            <ChatInterface />
          </ChatProvider>
        </CenterPanel>

        {/* Right Panel - Responsive & Animated */}
        {showRightPanel && (
          <AnimatedPanel isOpen={!rightPanel.collapsed} position="right">
            <RightPanel
              title={MODULE_TITLES[activeModule]}
              collapsed={rightPanel.collapsed}
              onToggleCollapse={toggleRightPanel}
              width={rightPanel.width}
              onWidthChange={setRightPanelWidth}
            >
              {renderRightPanelContent()}
            </RightPanel>
          </AnimatedPanel>
        )}
      </MainLayoutContainer>

      <StatusBarContainer>
        <StatusItem>
          <StatusDot $color={isConnected ? '#4caf50' : '#f44336'} />
          {model || '未连接'}
        </StatusItem>
        <StatusSeparator>|</StatusSeparator>
        <StatusItem>运行: {formatUptime(uptime)}</StatusItem>
        <StatusSeparator>|</StatusSeparator>
        <StatusItem>模块: {activeModule}</StatusItem>
        {isMobile && <StatusSeparator>|</StatusSeparator>}
        {isMobile && (
          <StatusItem onClick={toggleRightPanel} className="cursor-pointer hover:text-blue-400 transition-colors">
            {rightPanel.collapsed ? '📂 展开' : '📁 收起'}
          </StatusItem>
        )}
        <StatusSeparator>|</StatusSeparator>
        <StatusItem>家百星 · 你的私人御姐秘书</StatusItem>
      </StatusBarContainer>

      <SkillConsole />

      {/* Use new Keyboard Shortcuts Panel instead of old SettingsPanel */}
      <KeyboardShortcutsPanel />

      <VibeCodingPanel
        clarificationRequest={
          agentStore.clarificationRequest as unknown as
            | import('./components/VibeCodingPanel/VibeCodingPanel').ClarificationRequest
            | null
        }
        executionPreview={
          agentStore.executionPreview as unknown as
            | import('./components/VibeCodingPanel/VibeCodingPanel').ExecutionPreview
            | null
        }
        toolTraces={
          agentStore.toolTraces as unknown as import('./components/VibeCodingPanel/VibeCodingPanel').ToolTraceEvent[]
        }
        onClarificationResponse={(response) => {
          agentStore.setClarificationRequest(null);
          if (agentStore.clarificationRequest) {
            sendWsMessage({
              type: 'clarification_response',
              traceId: agentStore.clarificationRequest.traceId,
              response,
            });
          }
        }}
        onExecutionConfirm={(confirmed) => {
          agentStore.setExecutionPreview(null);
          if (agentStore.executionPreview) {
            sendWsMessage({
              type: 'execution_confirm',
              traceId: agentStore.executionPreview.traceId,
              confirmed,
            });
          }
        }}
      />
    </div>
  );
};

export default App;
