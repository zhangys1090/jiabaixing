/**
 * Harness Tool: desktop_screenshot - 截取屏幕截图
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const DESKTOP_SCREENSHOT_DEF: ToolDefinition = {
  name: 'desktop_screenshot',
  description:
    '截取屏幕截图并可选进行视觉分析。适用场景：用户说"看看我屏幕上是什么"、"帮我截个图"、需要了解用户桌面状态时。不适用：自动化操作桌面（用 desktop_automate）。',
  category: ToolCategory.DESKTOP,
  parameters: {
    region: {
      type: 'object',
      description: '截取区域 {x, y, width, height}，不指定则截取全屏',
      properties: {
        x: { type: 'number', description: '起始X坐标' },
        y: { type: 'number', description: '起始Y坐标' },
        width: { type: 'number', description: '宽度' },
        height: { type: 'number', description: '高度' },
      },
    },
    screenIndex: {
      type: 'number',
      description: '显示器索引（多显示器时使用），默认0为主显示器',
      default: 0,
    },
    analyze: {
      type: 'boolean',
      description: '是否对截图进行视觉分析（描述截图内容）',
      default: false,
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.DESKTOP_CONTROL],
  riskLevel: 'high',
  idempotent: true,
  timeout: 15000,
  requiresConfirmation: true,
};

/** desktop_screenshot 依赖接口 */
export interface DesktopScreenshotDeps {
  captureScreen?: (params: {
    region?: { x: number; y: number; width: number; height: number };
    screenIndex?: number;
  }) => Promise<{
    buffer: Buffer;
    width: number;
    height: number;
  }>;
  analyzeImage?: (imageBuffer: Buffer) => Promise<string>;
}

/** 创建 desktop_screenshot 执行器 */
export function createDesktopScreenshotExecutor(deps: DesktopScreenshotDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const region = params.region as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    const screenIndex = Number(params.screenIndex) || 0;
    const analyze = Boolean(params.analyze);

    if (!deps.captureScreen) {
      return {
        success: false,
        output: '截图服务不可用。请确保已安装 screenshot-desktop 依赖。',
        duration: 0,
        validated: false,
      };
    }

    try {
      const screenshot = await deps.captureScreen({
        region,
        screenIndex,
      });

      let output = `截图成功: ${screenshot.width}x${screenshot.height}, 大小 ${(screenshot.buffer.length / 1024).toFixed(1)}KB`;

      if (analyze && deps.analyzeImage) {
        const analysis = await deps.analyzeImage(screenshot.buffer);
        output += `\n\n视觉分析: ${analysis}`;
      } else if (analyze) {
        output += '\n\n视觉分析不可用，仅返回截图数据。';
      }

      return {
        success: true,
        output,
        duration: 0,
        validated: false,
        metadata: {
          width: screenshot.width,
          height: screenshot.height,
          sizeKB: Math.round(screenshot.buffer.length / 1024),
          analyzed: analyze && !!deps.analyzeImage,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: `截图失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: 0,
        validated: false,
      };
    }
  };
}
