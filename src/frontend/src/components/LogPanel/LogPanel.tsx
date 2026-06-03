import React from 'react';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
}

interface LogPanelProps {
  wsLogs: LogEntry[];
}

/**
 * LogPanel - 系统日志面板
 * TODO: 实现完整的日志面板，展示后端日志、工具调用记录
 */
const LogPanel: React.FC<LogPanelProps> = ({ wsLogs }) => {
  if (wsLogs.length === 0) return null;

  const levelColors: Record<string, string> = {
    debug: '#8080b0',
    info: '#60a5fa',
    warn: '#fbbf24',
    error: '#f87171',
  };

  return (
    <div style={{
      background: '#0d0d1a',
      border: '1px solid #2a2a5a',
      borderRadius: '10px',
      padding: '12px 16px',
      marginBottom: '12px',
      maxHeight: '200px',
      overflowY: 'auto',
      fontSize: '12px',
      fontFamily: 'monospace',
    }}>
      <div style={{ color: '#8080b0', marginBottom: '8px', fontSize: '11px' }}>
        📋 服务器日志
      </div>
      {wsLogs.map((log) => (
        <div
          key={log.id}
          style={{
            display: 'flex',
            gap: '8px',
            padding: '2px 0',
            borderBottom: '1px solid #1a1a3e',
          }}
        >
          <span style={{ color: '#555', minWidth: '60px', fontSize: '11px' }}>
            {log.timestamp?.split('T')[1]?.split('.')[0] || ''}
          </span>
          <span style={{ color: levelColors[log.level] || '#8080b0', minWidth: '40px' }}>
            {log.level.toUpperCase()}
          </span>
          <span style={{ color: '#8080b0', minWidth: '80px' }}>{log.module}</span>
          <span style={{ color: '#e0e0f0' }}>{log.message}</span>
        </div>
      ))}
    </div>
  );
};

export { LogPanel };
export default LogPanel;
