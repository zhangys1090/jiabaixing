"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceSelector = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const WorkspaceSelector = ({ workspaces = [], currentWorkspaceId, onSelect, collapsed = false, }) => {
    const current = workspaces.find((w) => w.id === currentWorkspaceId) || workspaces[0];
    return ((0, jsx_runtime_1.jsx)("div", { className: "workspace-selector", children: (0, jsx_runtime_1.jsxs)("button", { className: "workspace-selector-trigger", onClick: () => current && onSelect?.(current.id), title: current?.name || '选择工作区', children: [(0, jsx_runtime_1.jsx)("span", { className: "workspace-icon", children: current?.icon || '💼' }), !collapsed && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: "workspace-name", children: current?.name || '未命名工作区' }), (0, jsx_runtime_1.jsx)("span", { className: "workspace-chevron", children: "\u25BE" })] }))] }) }));
};
exports.WorkspaceSelector = WorkspaceSelector;
exports.default = exports.WorkspaceSelector;
