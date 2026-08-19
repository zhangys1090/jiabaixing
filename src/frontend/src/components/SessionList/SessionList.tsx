import React, { useEffect, useRef, useState } from 'react';
import './SessionList.css';

export interface Session {
  id: string;
  title: string;
  lastActive: string;
  pinned?: boolean;
}

export interface SessionListProps {
  sessions: Session[];
  activeSessionId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onReorder: (sessions: Session[]) => void;
  collapsed?: boolean;
}

/**
 * 会话列表
 * Sidebar 中的会话列表，支持切换、右键菜单、新建与拖拽排序
 */
export const SessionList: React.FC<SessionListProps> = ({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onReorder,
  collapsed = false,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };

    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [contextMenu]);

  const sortedSessions = [...sessions].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
  });

  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      if (isToday) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    } catch {
      return isoString;
    }
  };

  const handleContextMenu = (event: React.MouseEvent, sessionId: string) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, sessionId });
  };

  const handleRenameStart = (sessionId: string, currentTitle: string) => {
    setEditingId(sessionId);
    setEditTitle(currentTitle);
    setContextMenu(null);
  };

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle('');
  };

  const handleDelete = (sessionId: string) => {
    onDelete(sessionId);
    setContextMenu(null);
  };

  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    if (sessionId === editingId) {
      e.preventDefault();
      return;
    }
    setDraggingId(sessionId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionId);
  };

  const handleDragOver = (e: React.DragEvent, sessionId: string) => {
    e.preventDefault();
    if (sessionId !== draggingId) {
      setDragOverId(sessionId);
    }
  };

  const handleDragLeave = () => {
    setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const sourceId = e.dataTransfer.getData('text/plain') || draggingId;
    setDraggingId(null);

    if (!sourceId || sourceId === targetId) return;

    const sourceIndex = sortedSessions.findIndex((s) => s.id === sourceId);
    const targetIndex = sortedSessions.findIndex((s) => s.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const reordered = [...sortedSessions];
    const [removed] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, removed);
    onReorder(reordered);
  };

  if (collapsed) {
    return (
      <div className="session-list session-list--collapsed">
        <div className="session-list-header session-list-header--collapsed">
          <button
            className="session-create-btn session-create-btn--collapsed"
            onClick={onCreate}
            title="新建会话"
            aria-label="新建会话"
          >
            ＋
          </button>
        </div>
        <ul className="session-list-items session-list-items--collapsed">
          {sortedSessions.slice(0, 5).map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <li
                key={session.id}
                className={`session-list-item session-list-item--collapsed ${isActive ? 'active' : ''}`}
                title={session.title}
              >
                <button
                  className="session-item-button session-item-button--collapsed"
                  onClick={() => onSelect(session.id)}
                >
                  <span className="session-item-icon">{session.pinned ? '📌' : '💬'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span className="session-list-title">会话</span>
        <button className="session-create-btn" onClick={onCreate} title="新建会话" aria-label="新建会话">
          ＋
        </button>
      </div>

      <ul className="session-list-items">
        {sortedSessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const isDragging = session.id === draggingId;
          const isDragOver = session.id === dragOverId;

          return (
            <li
              key={session.id}
              className={`session-list-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              draggable={editingId !== session.id}
              onDragStart={(e) => handleDragStart(e, session.id)}
              onDragOver={(e) => handleDragOver(e, session.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, session.id)}
            >
              {editingId === session.id ? (
                <form className="session-edit-form" onSubmit={handleRenameSubmit}>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="session-edit-input"
                    autoFocus
                    onBlur={handleRenameSubmit}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setEditingId(null);
                        setEditTitle('');
                      }
                    }}
                  />
                </form>
              ) : (
                <button
                  className="session-item-button"
                  onClick={() => onSelect(session.id)}
                  onContextMenu={(e) => handleContextMenu(e, session.id)}
                  title={session.title}
                >
                  <span className="session-item-icon">{session.pinned ? '📌' : '💬'}</span>
                  <span className="session-item-info">
                    <span className="session-item-title">{session.title}</span>
                    <span className="session-item-time">{formatTime(session.lastActive)}</span>
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {contextMenu && (
        <div
          className="session-context-menu"
          ref={menuRef}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="session-context-item"
            onClick={() => {
              const session = sessions.find((s) => s.id === contextMenu.sessionId);
              if (session) handleRenameStart(session.id, session.title);
            }}
          >
            <span>✏️</span>
            <span>重命名</span>
          </button>
          <button
            className="session-context-item danger"
            onClick={() => handleDelete(contextMenu.sessionId)}
          >
            <span>🗑️</span>
            <span>删除</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default SessionList;
