/**
 * 内置工具集定义
 *
 * 按 Agent 角色/任务场景预组装的工具包
 * 参考 Hermes Agent 的 toolset 设计
 */

import { ToolCategory } from '../../types';
import { getToolsetRegistry, type ToolsetDefinition } from './ToolsetRegistry';

/**
 * 基础工具集 — 所有 Agent 共用的最小工具集
 *
 * 包含: 记忆 + 认知 + 系统基础
 */
const BASE_TOOLSET: ToolsetDefinition = {
  id: 'base',
  displayName: '基础工具集',
  description: '所有 Agent 共用的最小工具集（记忆+认知+系统基础）',
  includes: [
    { category: ToolCategory.MEMORY },
    { category: ToolCategory.COGNITION },
    { name: 'ask_clarification' },
    { name: 'system_status' },
    { name: 'context_manage' },
  ],
  maxTools: 0,
};

/**
 * 编码工具集 — CodingAgent 使用
 *
 * 继承 base + 文件操作 + 代码工具 + Shell 执行
 */
const CODING_TOOLSET: ToolsetDefinition = {
  id: 'coding',
  displayName: '编码工具集',
  description: 'CodingAgent 专用：文件操作 + 代码工具 + Shell 执行',
  extends: 'base',
  includes: [
    { category: ToolCategory.FILE },
    { category: ToolCategory.CODE },
    { name: 'shell_exec' },
    { name: 'execute_code' },
    { name: 'preview_execution' },
    { name: 'rollback_changes' },
    { name: 'delegate_task' },
  ],
  maxTools: 20,
};

/**
 * 桌面工具集 — DesktopAgent 使用
 *
 * 继承 base + 桌面自动化 + 截图
 */
const DESKTOP_TOOLSET: ToolsetDefinition = {
  id: 'desktop',
  displayName: '桌面工具集',
  description: 'DesktopAgent 专用：桌面自动化 + 截图 + 视觉',
  extends: 'base',
  includes: [
    { category: ToolCategory.DESKTOP },
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
const DAILY_TOOLSET: ToolsetDefinition = {
  id: 'daily',
  displayName: '日常管理工具集',
  description: 'DailyAgent 专用：日程/任务/提醒/笔记',
  extends: 'base',
  includes: [{ category: ToolCategory.DAILY }],
  maxTools: 20,
};

/**
 * 网络工具集 — ResearchAgent 使用
 *
 * 继承 base + 网络搜索/抓取 + 图表生成
 */
const NETWORK_TOOLSET: ToolsetDefinition = {
  id: 'network',
  displayName: '网络工具集',
  description: 'ResearchAgent 专用：搜索/抓取/图表/图像生成',
  extends: 'base',
  includes: [{ category: ToolCategory.NETWORK }, { name: 'knowledge_query' }],
  maxTools: 15,
};

/**
 * 全能工具集 — OrchestratorAgent 使用
 *
 * 包含所有工具（无限制）
 */
const FULL_TOOLSET: ToolsetDefinition = {
  id: 'full',
  displayName: '全能工具集',
  description: 'OrchestratorAgent 专用：包含所有已注册工具',
  includes: [
    { category: ToolCategory.MEMORY },
    { category: ToolCategory.COGNITION },
    { category: ToolCategory.FILE },
    { category: ToolCategory.CODE },
    { category: ToolCategory.DESKTOP },
    { category: ToolCategory.DAILY },
    { category: ToolCategory.NETWORK },
    { category: ToolCategory.SYSTEM },
  ],
  maxTools: 0,
};

/**
 * 最小工具集 — 仅认知+系统状态（用于轻量对话）
 */
const MINIMAL_TOOLSET: ToolsetDefinition = {
  id: 'minimal',
  displayName: '最小工具集',
  description: '轻量对话场景：仅认知 + 系统状态',
  includes: [
    { category: ToolCategory.COGNITION },
    { name: 'system_status' },
    { name: 'ask_clarification' },
  ],
  maxTools: 0,
};

/** 所有内置工具集定义 */
export const BUILTIN_TOOLSETS: ToolsetDefinition[] = [
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
export function registerBuiltinToolsets(): void {
  const registry = getToolsetRegistry();
  for (const def of BUILTIN_TOOLSETS) {
    registry.register(def);
  }
}

/** Agent 角色 → 默认工具集映射 */
export const AGENT_TOOLSET_MAP: Record<string, string> = {
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
export function getDefaultToolsetForAgent(agentType: string): string {
  return AGENT_TOOLSET_MAP[agentType] || 'base';
}
