"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionList = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
require("./SessionList.css");
/**
 * 会话列表
 * Sidebar 中的会话列表，支持切换、右键菜单、新建与拖拽排序
 */
const SessionList = ({ sessions, activeSessionId, onSelect, onCreate, onRename, onDelete, onReorder, collapsed = false, }) => {
    const [contextMenu, setContextMenu] = (0, react_1.useState)(null);
    const [editingId, setEditingId] = (0, react_1.useState)(null);
    const [editTitle, setEditTitle] = (0, react_1.useState)('');
    const [draggingId, setDraggingId] = (0, react_1.useState)(null);
    const [dragOverId, setDragOverId] = (0, react_1.useState)(null);
    const menuRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
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
        if (a.pinned && !b.pinned)
            return -1;
        if (!a.pinned && b.pinned)
            return 1;
        return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
    });
    const formatTime = (isoString) => {
        try {
            const date = new Date(isoString);
            const now = new Date();
            const isToday = date.toDateString() === now.toDateString();
            if (isToday) {
                return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            }
            return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        }
        catch {
            return isoString;
        }
    };
    const handleContextMenu = (event, sessionId) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, sessionId });
    };
    const handleRenameStart = (sessionId, currentTitle) => {
        setEditingId(sessionId);
        setEditTitle(currentTitle);
        setContextMenu(null);
    };
    const handleRenameSubmit = (e) => {
        e.preventDefault();
        if (editingId && editTitle.trim()) {
            onRename(editingId, editTitle.trim());
        }
        setEditingId(null);
        setEditTitle('');
    };
    const handleDelete = (sessionId) => {
        onDelete(sessionId);
        setContextMenu(null);
    };
    const handleDragStart = (e, sessionId) => {
        if (sessionId === editingId) {
            e.preventDefault();
            return;
        }
        setDraggingId(sessionId);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', sessionId);
    };
    const handleDragOver = (e, sessionId) => {
        e.preventDefault();
        if (sessionId !== draggingId) {
            setDragOverId(sessionId);
        }
    };
    const handleDragLeave = () => {
        setDragOverId(null);
    };
    const handleDrop = (e, targetId) => {
        e.preventDefault();
        setDragOverId(null);
        const sourceId = e.dataTransfer.getData('text/plain') || draggingId;
        setDraggingId(null);
        if (!sourceId || sourceId === targetId)
            return;
        const sourceIndex = sortedSessions.findIndex((s) => s.id === sourceId);
        const targetIndex = sortedSessions.findIndex((s) => s.id === targetId);
        if (sourceIndex === -1 || targetIndex === -1)
            return;
        const reordered = [...sortedSessions];
        const [removed] = reordered.splice(sourceIndex, 1);
        reordered.splice(targetIndex, 0, removed);
        onReorder(reordered);
    };
    if (collapsed) {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "session-list session-list--collapsed", children: [(0, jsx_runtime_1.jsx)("div", { className: "session-list-header session-list-header--collapsed", children: (0, jsx_runtime_1.jsx)("button", { className: "session-create-btn session-create-btn--collapsed", onClick: onCreate, title: "\u65B0\u5EFA\u4F1A\u8BDD", "aria-label": "\u65B0\u5EFA\u4F1A\u8BDD", children: "\uFF0B" }) }), (0, jsx_runtime_1.jsx)("ul", { className: "session-list-items session-list-items--collapsed", children: sortedSessions.slice(0, 5).map((session) => {
                        const isActive = session.id === activeSessionId;
                        return ((0, jsx_runtime_1.jsx)("li", { className: `session-list-item session-list-item--collapsed ${isActive ? 'active' : ''}`, title: session.title, children: (0, jsx_runtime_1.jsx)("button", { className: "session-item-button session-item-button--collapsed", onClick: () => onSelect(session.id), children: (0, jsx_runtime_1.jsx)("span", { className: "session-item-icon", children: session.pinned ? '📌' : '💬' }) }) }, session.id));
                    }) })] }));
    }
    return ((0, jsx_runtime_1.jsxs)("div", { className: "session-list", children: [(0, jsx_runtime_1.jsxs)("div", { className: "session-list-header", children: [(0, jsx_runtime_1.jsx)("span", { className: "session-list-title", children: "\u4F1A\u8BDD" }), (0, jsx_runtime_1.jsx)("button", { className: "session-create-btn", onClick: onCreate, title: "\u65B0\u5EFA\u4F1A\u8BDD", "aria-label": "\u65B0\u5EFA\u4F1A\u8BDD", children: "\uFF0B" })] }), (0, jsx_runtime_1.jsx)("ul", { className: "session-list-items", children: sortedSessions.map((session) => {
                    const isActive = session.id === activeSessionId;
                    const isDragging = session.id === draggingId;
                    const isDragOver = session.id === dragOverId;
                    return ((0, jsx_runtime_1.jsx)("li", { className: `session-list-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`, draggable: editingId !== session.id, onDragStart: (e) => handleDragStart(e, session.id), onDragOver: (e) => handleDragOver(e, session.id), onDragLeave: handleDragLeave, onDrop: (e) => handleDrop(e, session.id), children: editingId === session.id ? ((0, jsx_runtime_1.jsx)("form", { className: "session-edit-form", onSubmit: handleRenameSubmit, children: (0, jsx_runtime_1.jsx)("input", { type: "text", value: editTitle, onChange: (e) => setEditTitle(e.target.value), className: "session-edit-input", autoFocus: true, onBlur: handleRenameSubmit, onKeyDown: (e) => {
                                    if (e.key === 'Escape') {
                                        setEditingId(null);
                                        setEditTitle('');
                                    }
                                } }) })) : ((0, jsx_runtime_1.jsxs)("button", { className: "session-item-button", onClick: () => onSelect(session.id), onContextMenu: (e) => handleContextMenu(e, session.id), title: session.title, children: [(0, jsx_runtime_1.jsx)("span", { className: "session-item-icon", children: session.pinned ? '📌' : '💬' }), (0, jsx_runtime_1.jsxs)("span", { className: "session-item-info", children: [(0, jsx_runtime_1.jsx)("span", { className: "session-item-title", children: session.title }), (0, jsx_runtime_1.jsx)("span", { className: "session-item-time", children: formatTime(session.lastActive) })] })] })) }, session.id));
                }) }), contextMenu && ((0, jsx_runtime_1.jsxs)("div", { className: "session-context-menu", ref: menuRef, style: { top: contextMenu.y, left: contextMenu.x }, children: [(0, jsx_runtime_1.jsxs)("button", { className: "session-context-item", onClick: () => {
                            const session = sessions.find((s) => s.id === contextMenu.sessionId);
                            if (session)
                                handleRenameStart(session.id, session.title);
                        }, children: [(0, jsx_runtime_1.jsx)("span", { children: "\u270F\uFE0F" }), (0, jsx_runtime_1.jsx)("span", { children: "\u91CD\u547D\u540D" })] }), (0, jsx_runtime_1.jsxs)("button", { className: "session-context-item danger", onClick: () => handleDelete(contextMenu.sessionId), children: [(0, jsx_runtime_1.jsx)("span", { children: "\uD83D\uDDD1\uFE0F" }), (0, jsx_runtime_1.jsx)("span", { children: "\u5220\u9664" })] })] }))] }));
};
exports.SessionList = SessionList;
exports.default = exports.SessionList;
