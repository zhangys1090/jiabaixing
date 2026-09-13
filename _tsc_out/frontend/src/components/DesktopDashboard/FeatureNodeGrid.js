"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FEATURE_NODES = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
exports.FEATURE_NODES = [
    {
        id: 'clarify',
        icon: '🔍',
        label: '澄清工具',
        description: '需求澄清与边界确认',
        color: '#6366f1',
    },
    {
        id: 'todo',
        icon: '📝',
        label: 'TODO规划',
        description: '自动拆解任务清单',
        color: '#22c55e',
    },
    {
        id: 'sandbox',
        icon: '🧪',
        label: '代码沙箱',
        description: '安全执行代码片段',
        color: '#f59e0b',
    },
    {
        id: 'subagent',
        icon: '🤖',
        label: '子Agent委托',
        description: '分配子任务给专用Agent',
        color: '#8b5cf6',
    },
    {
        id: 'approval',
        icon: '✅',
        label: '写入审批',
        description: '文件变更需审批',
        color: '#10b981',
    },
    {
        id: 'budget',
        icon: '💰',
        label: '预算守卫',
        description: 'Token与成本监控',
        color: '#ef4444',
    },
    {
        id: 'osv',
        icon: '🛡️',
        label: '漏洞检查',
        description: '依赖漏洞扫描',
        color: '#f97316',
    },
    {
        id: 'cleanup',
        icon: '🧹',
        label: '磁盘清理',
        description: '预览并清理临时文件',
        color: '#06b6d4',
    },
    {
        id: 'voice',
        icon: '🎙️',
        label: '语音对话',
        description: '语音输入与播报',
        color: '#ec4899',
    },
    {
        id: 'workspace',
        icon: '🏢',
        label: '多项目工作区',
        description: '切换项目上下文',
        color: '#3b82f6',
    },
    {
        id: 'i18n',
        icon: '🌐',
        label: '国际化',
        description: '多语言界面支持',
        color: '#14b8a6',
    },
    {
        id: 'plugin',
        icon: '🔌',
        label: '插件系统',
        description: '扩展Agent能力',
        color: '#a855f7',
    },
];
/**
 * 家百星执行Agent特色功能节点网格
 * 展示T0-T4批次沉淀的核心能力入口
 */
const FeatureNodeGrid = ({ onNodeClick }) => {
    return ((0, jsx_runtime_1.jsxs)("div", { className: "feature-node-section", children: [(0, jsx_runtime_1.jsxs)("div", { className: "feature-node-header", children: [(0, jsx_runtime_1.jsx)("span", { className: "feature-node-title", children: "\u26A1 \u6267\u884CAgent\u7279\u8272\u80FD\u529B" }), (0, jsx_runtime_1.jsx)("span", { className: "feature-node-subtitle", children: "\u70B9\u51FB\u5361\u7247\u5FEB\u901F\u4F53\u9A8C" })] }), (0, jsx_runtime_1.jsx)("ul", { className: "feature-node-grid", "aria-label": "\u6267\u884CAgent\u7279\u8272\u80FD\u529B", children: exports.FEATURE_NODES.map((node) => ((0, jsx_runtime_1.jsx)("li", { children: (0, jsx_runtime_1.jsxs)("button", { className: "feature-node-card", onClick: () => onNodeClick(node), title: node.description, "aria-label": `${node.label}: ${node.description}`, style: { '--node-accent': node.color }, children: [(0, jsx_runtime_1.jsx)("span", { className: "feature-node-icon", "aria-hidden": "true", children: node.icon }), (0, jsx_runtime_1.jsx)("span", { className: "feature-node-label", children: node.label }), (0, jsx_runtime_1.jsx)("span", { className: "feature-node-desc", children: node.description })] }) }, node.id))) })] }));
};
exports.default = FeatureNodeGrid;
