import React, { useState } from 'react';
import './App.css';
import ChatInterface from './components/ChatInterface/ChatInterface';
import SkillConsole from './components/SkillConsole/SkillConsole';
import { ChatProvider } from './contexts/ChatContext';
import { useWebSocket } from './hooks/useWebSocket';

type View = 'chat' | 'skills';

const App: React.FC = () => {
  const [view, setView] = useState<View>('chat');
  const { connectionStatus } = useWebSocket({
    url: `ws://${window.location.hostname}:3111`,
  });

  return (
    <ChatProvider>
      <div className="app-container">
        {/* 顶部导航 */}
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
              className={`app-nav-btn ${view === 'skills' ? 'active' : ''}`}
              onClick={() => setView('skills')}
            >
              🔧 技能
            </button>
          </div>
          <span className={`connection-badge ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中...' : '未连接'}
          </span>
        </div>

        {/* 内容区 */}
        <div className="app-content">
          {view === 'chat' ? (
            <ChatInterface />
          ) : (
            <SkillConsole />
          )}
        </div>
      </div>
    </ChatProvider>
  );
};

export default App;
