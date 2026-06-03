import React, { useEffect, useState } from 'react';
import './App.css';
import ChatInterface from './components/ChatInterface/ChatInterface';
import ConsolePanel from './components/ConsolePanel/ConsolePanel';
import { ChatProvider } from './contexts/ChatContext';
import { useWebSocket } from './hooks/useWebSocket';
import { connectionManager } from './hooks/websocket';
import { useConnectionStore } from './stores/useConnectionStore';
import { useEvolutionStore } from './stores/useEvolutionStore';
import { useSkillStore } from './stores/useSkillStore';
import { useAgentStore } from './stores/useAgentStore';
import { useMonitorStore } from './stores/useMonitorStore';

type View = 'chat' | 'console';

const App: React.FC = () => {
  const [view, setView] = useState<View>('chat');
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
    const handleConnectionStatus = (status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting') => {
      setConnectionStatus(status);
    };

    const handleDialogState = (state: 'idle' | 'listening' | 'processing' | 'speaking') => {
      setDialogState(state);
    };

    const handleEvolutionEvent = (event: unknown) => {
      addEvolutionEvent(event as Parameters<typeof addEvolutionEvent>[0]);
    };

    const handleSkillExecutionUpdate = (update: unknown) => {
      addSkillExecutionUpdate(update as Parameters<typeof addSkillExecutionUpdate>[0]);
    };

    const handleWeightUpdate = (update: unknown) => {
      updateSkillWeight(update as Parameters<typeof updateSkillWeight>[0]);
    };

    const handleAgentExecutionUpdate = (update: unknown) => {
      addAgentExecutionUpdate(update as Parameters<typeof addAgentExecutionUpdate>[0]);
    };

    const handleBrainStageUpdate = (update: unknown) => {
      addBrainStageUpdate(update as Parameters<typeof addBrainStageUpdate>[0]);
    };

    const handleToolTrace = (trace: unknown) => {
      addToolTrace(trace as Parameters<typeof addToolTrace>[0]);
    };

    const handleClarificationRequest = (request: unknown) => {
      setClarificationRequest(request as Parameters<typeof setClarificationRequest>[0]);
    };

    const handleExecutionPreview = (preview: unknown) => {
      setExecutionPreview(preview as Parameters<typeof setExecutionPreview>[0]);
    };

    const handleFileModified = (event: unknown) => {
      addFileEvent(event as Parameters<typeof addFileEvent>[0]);
    };

    const handleFileRollback = (event: unknown) => {
      addFileEvent(event as Parameters<typeof addFileEvent>[0]);
    };

    const handleServerLog = (entry: unknown) => {
      addMonitorLog(entry as Parameters<typeof addMonitorLog>[0]);
    };

    const handleProactiveMessage = (message: unknown) => {
      console.log('[App] 收到主动消息:', message);
    };

    connectionManager.onConnectionStatus(handleConnectionStatus);
    connectionManager.onDialogState(handleDialogState);
    connectionManager.onEvolutionEvent(handleEvolutionEvent);
    connectionManager.onSkillExecutionUpdate(handleSkillExecutionUpdate);
    connectionManager.onWeightUpdate(handleWeightUpdate);
    connectionManager.onAgentExecution(handleAgentExecutionUpdate);
    connectionManager.onBrainStageUpdate(handleBrainStageUpdate);
    connectionManager.onToolTrace(handleToolTrace);
    connectionManager.onClarificationRequest(handleClarificationRequest);
    connectionManager.onExecutionPreview(handleExecutionPreview);
    connectionManager.onFileModified(handleFileModified);
    connectionManager.onFileRollback(handleFileRollback);
    connectionManager.onServerLog(handleServerLog);
    connectionManager.onProactiveMessage(handleProactiveMessage);

    return () => {
      connectionManager.offConnectionStatus(handleConnectionStatus);
      connectionManager.offDialogState(handleDialogState);
      connectionManager.offEvolutionEvent(handleEvolutionEvent);
      connectionManager.offSkillExecutionUpdate(handleSkillExecutionUpdate);
      connectionManager.offWeightUpdate(handleWeightUpdate);
      connectionManager.offAgentExecution(handleAgentExecutionUpdate);
      connectionManager.offBrainStageUpdate(handleBrainStageUpdate);
      connectionManager.offToolTrace(handleToolTrace);
      connectionManager.offClarificationRequest(handleClarificationRequest);
      connectionManager.offExecutionPreview(handleExecutionPreview);
      connectionManager.offFileModified(handleFileModified);
      connectionManager.offFileRollback(handleFileRollback);
      connectionManager.offServerLog(handleServerLog);
      connectionManager.offProactiveMessage(handleProactiveMessage);
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

  return (
    <ChatProvider>
      <div className="app-container">
        <div className="app-topbar">
          <span className="app-logo">家百星 · 御姐秘书</span>
          <div className="app-nav">
            <button
              className={`app-nav-btn ${view === 'chat' ? 'active' : ''}`}
              onClick={() => setView('chat')}
            >
              💬 对话
            </button>
            <button
              className={`app-nav-btn ${view === 'console' ? 'active' : ''}`}
              onClick={() => setView('console')}
            >
              🖥 控制台
            </button>
          </div>
          <span className={`connection-badge ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中...' : '未连接'}
          </span>
        </div>

        <div className="app-content">
          {view === 'chat' ? (
            <ChatInterface />
          ) : (
            <ConsolePanel />
          )}
        </div>
      </div>
    </ChatProvider>
  );
};

export default App;
