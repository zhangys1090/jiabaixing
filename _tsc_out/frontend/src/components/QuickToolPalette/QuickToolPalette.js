"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuickToolPalette = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
require("./QuickToolPalette.css");
const TOOL_CATEGORIES = [
    {
        id: 'file',
        label: '文件',
        tools: [
            { id: 'file.read', name: '读取文件', icon: '📄', category: 'file' },
            { id: 'file.write', name: '写入文件', icon: '✏️', category: 'file' },
            { id: 'file.search', name: '文件搜索', icon: '🔍', category: 'file' },
        ],
    },
    {
        id: 'code',
        label: '代码',
        tools: [
            { id: 'code.analysis', name: '代码分析', icon: '🔬', category: 'code' },
            { id: 'code.refactor', name: '重构建议', icon: '🧹', category: 'code' },
            { id: 'code.generate', name: '生成代码', icon: '⚡', category: 'code' },
        ],
    },
    {
        id: 'search',
        label: '搜索',
        tools: [
            { id: 'search.web', name: '联网搜索', icon: '🌐', category: 'search' },
            { id: 'search.local', name: '本地搜索', icon: '🗂️', category: 'search' },
            { id: 'search.memory', name: '记忆搜索', icon: '🧠', category: 'search' },
        ],
    },
    {
        id: 'plan',
        label: '规划',
        tools: [
            { id: 'plan.task', name: '任务规划', icon: '📋', category: 'plan' },
            { id: 'plan.breakdown', name: '拆解目标', icon: '🎯', category: 'plan' },
            { id: 'plan.schedule', name: '定时执行', icon: '⏰', category: 'plan' },
        ],
    },
    {
        id: 'approval',
        label: '审批',
        tools: [
            { id: 'approval.request', name: '请求审批', icon: '✋', category: 'approval' },
            { id: 'approval.history', name: '审批记录', icon: '📜', category: 'approval' },
            { id: 'approval.policy', name: '策略配置', icon: '⚖️', category: 'approval' },
        ],
    },
    {
        id: 'security',
        label: '安全',
        tools: [
            { id: 'security.scan', name: '安全扫描', icon: '🛡️', category: 'security' },
            { id: 'security.audit', name: '审计日志', icon: '🔒', category: 'security' },
            { id: 'secret.mask', name: '密钥脱敏', icon: '🔑', category: 'security' },
        ],
    },
];
/**
 * 快捷工具面板
 * 聊天输入框左侧 "+" 按钮触发的工具选择弹窗
 */
const QuickToolPalette = ({ isOpen, onClose, onSelectTool }) => {
    const panelRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        const handleClickOutside = (event) => {
            if (panelRef.current && !panelRef.current.contains(event.target)) {
                onClose();
            }
        };
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('keydown', handleKeyDown);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, onClose]);
    const handleSelect = (toolId) => {
        onSelectTool(toolId);
        onClose();
    };
    if (!isOpen)
        return null;
    return ((0, jsx_runtime_1.jsx)("div", { className: "quick-tool-palette-overlay", children: (0, jsx_runtime_1.jsxs)("div", { className: "quick-tool-palette", ref: panelRef, role: "dialog", "aria-modal": "true", children: [(0, jsx_runtime_1.jsxs)("div", { className: "quick-tool-palette-header", children: [(0, jsx_runtime_1.jsx)("span", { className: "quick-tool-palette-title", children: "\u5FEB\u6377\u5DE5\u5177" }), (0, jsx_runtime_1.jsx)("button", { className: "quick-tool-palette-close", onClick: onClose, "aria-label": "\u5173\u95ED", children: "\u00D7" })] }), (0, jsx_runtime_1.jsx)("div", { className: "quick-tool-palette-grid", children: TOOL_CATEGORIES.map((category) => ((0, jsx_runtime_1.jsxs)("div", { className: "quick-tool-category", children: [(0, jsx_runtime_1.jsx)("div", { className: "quick-tool-category-label", children: category.label }), (0, jsx_runtime_1.jsx)("div", { className: "quick-tool-category-items", children: category.tools.map((tool) => ((0, jsx_runtime_1.jsxs)("button", { className: "quick-tool-item", onClick: () => handleSelect(tool.id), title: tool.name, children: [(0, jsx_runtime_1.jsx)("span", { className: "quick-tool-item-icon", children: tool.icon }), (0, jsx_runtime_1.jsx)("span", { className: "quick-tool-item-name", children: tool.name })] }, tool.id))) })] }, category.id))) })] }) }));
};
exports.QuickToolPalette = QuickToolPalette;
exports.default = exports.QuickToolPalette;
