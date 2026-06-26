/**
 * Harness Tool: desktop_automate - 桌面自动化操作
 * v2: 使用增强版 DesktopExecutionAgent (Codex风格)
 *
 * 整合：
 * - 归一化坐标系统
 * - MCP 工具调用
 * - 事件流实时推送
 * - 安全防护系统
 * - 技能包系统
 */

import { DesktopExecutionAgent } from '../../../desktop/DesktopExecutionAgent';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const DESKTOP_AUTOMATE_DEF: ToolDefinition = {
  name: 'desktop_automate',
  description:
    '在用户电脑上执行桌面自动化操作（Codex风格增强版）。支持的操作类型：截图(screenshot)、点击(click/rightClick)、输入文字(type)、按键(key/keyCombo)、移动鼠标(moveMouse)、滚动(scroll)、拖拽(drag)、等待(wait)、读取/写入剪贴板(clipboardRead/clipboardWrite)、执行Shell命令(shell)、点击UI元素(clickElement/typeIntoElement/getElementText)、窗口管理(openApp/activateWindow/closeWindow/maximize/minimize)。系统会自动截图分析屏幕、规划操作步骤、执行并验证结果。适用场景：用户要求操作电脑（打开应用、截图、点击、输入文字、管理窗口等）。不适用：纯文字对话、信息查询。',
  category: ToolCategory.DESKTOP,
  parameters: {
    task: {
      type: 'string',
      description:
        '桌面操作描述，如"打开记事本并输入Hello World"、"截图保存桌面"、"点击屏幕上的确定按钮"、"在搜索框中输入关键词"、"最大化当前窗口"',
    },
  },
  requiredParams: ['task'],
  requiredPermissions: [Permission.DESKTOP_CONTROL],
  riskLevel: 'high',
  idempotent: false,
  timeout: 120000,
  requiresConfirmation: true,
};

/** 创建 desktop_automate 执行器 */
export function createDesktopAutomateExecutor() {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const task = String(params.task || '');
    if (!task) {
      return {
        success: false,
        output: null,
        error: '请提供要执行的桌面操作任务描述',
        duration: 0,
        validated: false,
      };
    }

    const startTime = Date.now();

    try {
      const agent = DesktopExecutionAgent.getInstance();

      // 确保Agent已初始化
      if (!(agent as any).initialized) {
        await agent.initialize();
      }

      const result = await agent.executeTask(task);

      const duration = Date.now() - startTime;

      return {
        success: result.success,
        output:
          result.report ||
          (result.success
            ? '操作完成'
            : `操作失败: ${result.error || '未知错误'}`),
        duration,
        validated: false,
        metadata: {
          stepsCompleted: result.stepsCompleted,
          totalSteps: result.totalSteps,
          usedSkill: result.usedSkill,
          observationCount: result.observations.length,
        },
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        output: null,
        error: `桌面操作失败: ${(err as Error).message}`,
        duration,
        validated: false,
      };
    }
  };
}
