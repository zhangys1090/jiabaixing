"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionList = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const SessionList = ({ sessions = [], activeSessionId, onSelectSession, onNewSession, collapsed = false, }) => {
    const formatTime = (timestamp) => {
        const date = new Date(timestamp);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) {
            return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    };
    if (collapsed) {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "session-list session-list--collapsed", children: [(0, jsx_runtime_1.jsx)("button", { className: "new-session-btn new-session-btn--collapsed", onClick: onNewSession, title: "\u65B0\u5EFA\u4F1A\u8BDD", children: "+" }), sessions.slice(0, 5).map((session) => ((0, jsx_runtime_1.jsx)("button", { className: `session-item session-item--collapsed ${activeSessionId === session.id ? 'active' : ''}`, onClick: () => onSelectSession?.(session.id), title: session.title, children: "\uD83D\uDCAC" }, session.id)))] }));
    }
    return ((0, jsx_runtime_1.jsxs)("div", { className: "session-list", children: [(0, jsx_runtime_1.jsxs)("button", { className: "new-session-btn", onClick: onNewSession, children: [(0, jsx_runtime_1.jsx)("span", { className: "new-session-icon", children: "+" }), (0, jsx_runtime_1.jsx)("span", { children: "\u65B0\u5EFA\u4F1A\u8BDD" })] }), sessions.length === 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "session-empty", children: "\u6682\u65E0\u4F1A\u8BDD" })) : ((0, jsx_runtime_1.jsx)("div", { className: "session-items", children: sessions.map((session) => ((0, jsx_runtime_1.jsxs)("button", { className: `session-item ${activeSessionId === session.id ? 'active' : ''} ${session.unread ? 'unread' : ''}`, onClick: () => onSelectSession?.(session.id), title: session.title, children: [(0, jsx_runtime_1.jsx)("span", { className: "session-title", children: session.title }), (0, jsx_runtime_1.jsx)("span", { className: "session-time", children: formatTime(session.timestamp) })] }, session.id))) }))] }));
};
exports.SessionList = SessionList;
exports.default = exports.SessionList;
