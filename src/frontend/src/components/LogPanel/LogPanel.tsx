import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './LogPanel.css';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
  traceId?: string;
}

type LogLevel = 'all' | 'debug' | 'info' | 'warn' | 'error';

interface LogPanelProps {
  wsLogs?: LogEntry[];
  initialLogs?: LogEntry[];
  onClear?: () => void;
  maxLogs?: number;
}

const LEVEL_BTN_ACTIVE_CLASS: Record<LogLevel, string> = {
  all: 'log-panel__level-btn--active-all',
  debug: 'log-panel__level-btn--active-debug',
  info: 'log-panel__level-btn--active-info',
  warn: 'log-panel__level-btn--active-warn',
  error: 'log-panel__level-btn--active-error',
};

const ENTRY_LEVEL_CLASS: Record<string, string> = {
  error: 'log-panel__entry--error',
  warn: 'log-panel__entry--warn',
  info: 'log-panel__entry--info',
  debug: 'log-panel__entry--debug',
};

const LEVEL_CLASS: Record<string, string> = {
  error: 'log-panel__level--error',
  warn: 'log-panel__level--warn',
  info: 'log-panel__level--info',
  debug: 'log-panel__level--debug',
};

export const LogPanel: React.FC<LogPanelProps> = ({ wsLogs = [], initialLogs = [], onClear, maxLogs = 500 }) => {
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const logs = useMemo(() => {
    const combined = [...initialLogs, ...wsLogs];
    return combined.length > maxLogs ? combined.slice(combined.length - maxLogs) : combined;
  }, [initialLogs, wsLogs, maxLogs]);

  const prevLogsLength = useRef(0);

  useEffect(() => {
    if (autoScroll && containerRef.current && logs.length > prevLogsLength.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevLogsLength.current = logs.length;
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (levelFilter !== 'all') {
      result = result.filter((l) => l.level === levelFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (l) =>
          l.message.toLowerCase().includes(q) ||
          l.module.toLowerCase().includes(q) ||
          l.traceId?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [logs, levelFilter, searchQuery]);

  const levelCounts = useMemo(
    () => ({
      all: logs.length,
      debug: logs.filter((l) => l.level === 'debug').length,
      info: logs.filter((l) => l.level === 'info').length,
      warn: logs.filter((l) => l.level === 'warn').length,
      error: logs.filter((l) => l.level === 'error').length,
    }),
    [logs]
  );

  const handleClear = useCallback(() => {
    onClear?.();
  }, [onClear]);

  const activeLogCount = filteredLogs.length;

  return (
    <div className="log-panel">
      <div className="log-panel__header" onClick={() => setCollapsed((p) => !p)}>
        <div className="log-panel__header-left">
          <span>📋 日志</span>
          <span className="log-panel__count">
            {activeLogCount}/{logs.length}
          </span>
        </div>
        <span>{collapsed ? '▶' : '▼'}</span>
      </div>

      {!collapsed && (
        <>
          <div className="log-panel__toolbar">
            <input
              type="text"
              className="log-panel__search"
              placeholder="搜索日志..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <div className="log-panel__levels">
              {(['all', 'debug', 'info', 'warn', 'error'] as LogLevel[]).map((level) => (
                <button
                  key={level}
                  className={`log-panel__level-btn${levelFilter === level ? ` ${LEVEL_BTN_ACTIVE_CLASS[level]}` : ''}`}
                  onClick={() => setLevelFilter(level)}
                  title={`${levelCounts[level]} 条`}
                >
                  {level.toUpperCase()} {level !== 'all' && `(${levelCounts[level]})`}
                </button>
              ))}
            </div>

            <div className="log-panel__actions">
              <label className="log-panel__auto-scroll-label">
                <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                自动滚动
              </label>
              <button className="log-panel__clear-btn" onClick={handleClear}>
                清空
              </button>
            </div>
          </div>

          <div ref={containerRef} className="log-panel__list">
            {filteredLogs.length === 0 && (
              <div className="log-panel__empty">{searchQuery ? '无匹配日志' : '暂无日志'}</div>
            )}

            {filteredLogs.map((log) => (
              <div
                key={log.id}
                className={`log-panel__entry${ENTRY_LEVEL_CLASS[log.level] ? ` ${ENTRY_LEVEL_CLASS[log.level]}` : ''}`}
              >
                <span className="log-panel__timestamp">{log.timestamp}</span>
                <span className={`log-panel__level${LEVEL_CLASS[log.level] ? ` ${LEVEL_CLASS[log.level]}` : ''}`}>
                  {log.level.toUpperCase()}
                </span>
                <span className="log-panel__module">[{log.module}]</span>
                <span className="log-panel__message">{log.message}</span>
                {log.traceId && <span className="log-panel__trace">#{log.traceId}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
