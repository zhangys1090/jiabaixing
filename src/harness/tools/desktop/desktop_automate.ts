/**
 * Harness Tool: desktop_automate - 桌面自动化操作
 */

import { DesktopAgentLoop } from '../../../desktop/DesktopAgentLoop';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const DESKTOP_AUTOMATE_DEF: ToolDefinition = {
  name: 'desktop_automate',
  description:
    '在用户电脑上执行桌面自动化操作。适用场景：用户要求操作电脑（打开应用、截图、点击、输入文字、移动鼠标、管理窗口等）。不适用：纯文字对话、信息查询。',
  category: ToolCategory.DESKTOP,
  parameters: {
    task: {
      type: 'string',
      description:
        '桌面操作描述，如"打开记事本"、"截图"、"点击(100,200)"、"输入Hello"',
    },
  },
  requiredParams: ['task'],
  requiredPermissions: [Permission.DESKTOP_CONTROL],
  riskLevel: 'high',
  idempotent: false,
  timeout: 30000,
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

    try {
      const agent = DesktopAgentLoop.getInstance();
      const result = await agent.execute(task);
      return {
        success: result.success,
        output:
          result.report ||
          (result.success
            ? '操作完成'
            : `操作失败: ${result.error || '未知错误'}`),
        duration: 0,
        validated: false,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `桌面操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
