"use strict";
/**
 * 内置工具集定义
 *
 * 按 Agent 角色/任务场景预组装的工具包
 * 参考 Hermes Agent 的 toolset 设计
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_TOOLSET_MAP = exports.BUILTIN_TOOLSETS = void 0;
exports.registerBuiltinToolsets = registerBuiltinToolsets;
exports.getDefaultToolsetForAgent = getDefaultToolsetForAgent;
const types_1 = require("../../types");
const ToolsetRegistry_1 = require("./ToolsetRegistry");
/**
 * 基础工具集 — 所有 Agent 共用的最小工具集
 *
 * 包含: 记忆 + 认知 + 系统基础
 */
const BASE_TOOLSET = {
    id: 'base',
    displayName: '基础工具集',
    description: '所有 Agent 共用的最小工具集（记忆+认知+系统基础）',
    includes: [
        { category: types_1.ToolCategory.MEMORY },
        { category: types_1.ToolCategory.COGNITION },
        { name: 'ask_clarification' },
        { name: 'system_status' },
        { name: 'context_manage' },
        { name: 'tool_inspect' },
    ],
    maxTools: 0,
};
/**
 * 编码工具集 — CodingAgent 使用
 *
 * 继承 base + 文件操作 + 代码工具 + Shell 执行
 */
const CODING_TOOLSET = {
    id: 'coding',
    displayName: '编码工具集',
    description: 'CodingAgent 专用：文件操作 + 代码工具 + Shell 执行',
    extends: 'base',
    includes: [
        { category: types_1.ToolCategory.FILE },
        { category: types_1.ToolCategory.CODE },
        { name: 'shell_exec' },
        { name: 'execute_code' },
        { name: 'preview_execution' },
        { name: 'rollback_changes' },
        { name: 'delegate_task' },
        { name: 'tool_define' },
        { name: 'tool_undefine' },
    ],
    maxTools: 20,
};
/**
 * 桌面工具集 — DesktopAgent 使用
 *
 * 继承 base + 桌面自动化 + 截图
 */
const DESKTOP_TOOLSET = {
    id: 'desktop',
    displayName: '桌面工具集',
    description: 'DesktopAgent 专用：桌面自动化 + 截图 + 视觉',
    extends: 'base',
    includes: [
        { category: types_1.ToolCategory.DESKTOP },
        { name: 'execute_code' },
        { name: 'shell_exec' },
        { name: 'voice_interact' },
    ],
    maxTools: 15,
};
/**
 * 日常管理工具集 — DailyAgent 使用
 *
 * 继承 base + 日程/任务/提醒
 */
const DAILY_TOOLSET = {
    id: 'daily',
    displayName: '日常管理工具集',
    description: 'DailyAgent 专用：日程/任务/提醒/笔记',
    extends: 'base',
    includes: [{ category: types_1.ToolCategory.DAILY }],
    maxTools: 20,
};
/**
 * 网络工具集 — ResearchAgent 使用
 *
 * 继承 base + 网络搜索/抓取 + 图表生成
 */
const NETWORK_TOOLSET = {
    id: 'network',
    displayName: '网络工具集',
    description: 'ResearchAgent 专用：搜索/抓取/图表/图像生成',
    extends: 'base',
    includes: [{ category: types_1.ToolCategory.NETWORK }, { name: 'knowledge_query' }],
    maxTools: 15,
};
/**
 * 全能工具集 — OrchestratorAgent 使用
 *
 * 包含所有工具（无限制）
 */
const FULL_TOOLSET = {
    id: 'full',
    displayName: '全能工具集',
    description: 'OrchestratorAgent 专用：包含所有已注册工具',
    includes: [
        { category: types_1.ToolCategory.MEMORY },
        { category: types_1.ToolCategory.COGNITION },
        { category: types_1.ToolCategory.FILE },
        { category: types_1.ToolCategory.CODE },
        { category: types_1.ToolCategory.DESKTOP },
        { category: types_1.ToolCategory.DAILY },
        { category: types_1.ToolCategory.NETWORK },
        { category: types_1.ToolCategory.SYSTEM },
    ],
    maxTools: 0,
};
/**
 * 最小工具集 — 仅认知+系统状态（用于轻量对话）
 */
const MINIMAL_TOOLSET = {
    id: 'minimal',
    displayName: '最小工具集',
    description: '轻量对话场景：仅认知 + 系统状态',
    includes: [
        { category: types_1.ToolCategory.COGNITION },
        { name: 'system_status' },
        { name: 'ask_clarification' },
    ],
    maxTools: 0,
};
/** 所有内置工具集定义 */
exports.BUILTIN_TOOLSETS = [
    BASE_TOOLSET,
    MINIMAL_TOOLSET,
    CODING_TOOLSET,
    DESKTOP_TOOLSET,
    DAILY_TOOLSET,
    NETWORK_TOOLSET,
    FULL_TOOLSET,
];
/**
 * 注册所有内置工具集到全局 ToolsetRegistry
 */
function registerBuiltinToolsets() {
    const registry = (0, ToolsetRegistry_1.getToolsetRegistry)();
    for (const def of exports.BUILTIN_TOOLSETS) {
        registry.register(def);
    }
}
/** Agent 角色 → 默认工具集映射 */
exports.AGENT_TOOLSET_MAP = {
    coding: 'coding',
    desktop: 'desktop',
    daily: 'daily',
    research: 'network',
    orchestrator: 'full',
    base: 'base',
    minimal: 'minimal',
};
/**
 * 根据 Agent 类型获取默认工具集 id
 */
function getDefaultToolsetForAgent(agentType) {
    return exports.AGENT_TOOLSET_MAP[agentType] || 'base';
}
