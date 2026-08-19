import React from 'react';

export interface ChatSession {
  id: string;
  title: string;
  timestamp: number;
  unread?: boolean;
}

interface SessionListProps {
  sessions?: ChatSession[];
  activeSessionId?: string;
  onSelectSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  collapsed?: boolean;
}

export const SessionList: React.FC<SessionListProps> = ({
  sessions = [],
  activeSessionId,
  onSelectSession,
  onNewSession,
  collapsed = false,
}) => {
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  if (collapsed) {
    return (
      <div className="session-list session-list--collapsed">
        <button className="new-session-btn new-session-btn--collapsed" onClick={onNewSession} title="新建会话">
          +
        </button>
        {sessions.slice(0, 5).map((session) => (
          <button
            key={session.id}
            className={`session-item session-item--collapsed ${activeSessionId === session.id ? 'active' : ''}`}
            onClick={() => onSelectSession?.(session.id)}
            title={session.title}
          >
            💬
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="session-list">
      <button className="new-session-btn" onClick={onNewSession}>
        <span className="new-session-icon">+</span>
        <span>新建会话</span>
      </button>

      {sessions.length === 0 ? (
        <div className="session-empty">暂无会话</div>
      ) : (
        <div className="session-items">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-item ${activeSessionId === session.id ? 'active' : ''} ${session.unread ? 'unread' : ''}`}
              onClick={() => onSelectSession?.(session.id)}
              title={session.title}
            >
              <span className="session-title">{session.title}</span>
              <span className="session-time">{formatTime(session.timestamp)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default SessionList;
