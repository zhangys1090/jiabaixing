/**
 * 桌面操作 MCP Server
 * 参考 Codex / UI-TARS 设计
 * 将桌面操控能力封装为标准 MCP (Model Context Protocol) 工具
 *
 * 基于 DesktopActionExecutor 实现，复用所有现有桌面操作能力
 * 支持归一化坐标系统 [0-1000] × [0-1000]
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';
import {
    DesktopAction,
    DesktopActionExecutor,
    DesktopActionResult,
} from './DesktopActionExecutor';
import { NormalizedCoordinateSystem } from './NormalizedCoordinates';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export class DesktopMCPServer extends EventEmitter {
  private static instance: DesktopMCPServer | null = null;
  private executor: DesktopActionExecutor;
  private coords: NormalizedCoordinateSystem;
  private initialized: boolean = false;

  private tools: MCPTool[] = [
    {
      name: 'screenshot',
      description:
        '截取当前屏幕图像，返回base64编码的PNG图片。用于观察屏幕状态。',
      inputSchema: {
        type: 'object',
        properties: {
          monitor: {
            type: 'number',
            description: '显示器编号，默认为0（主显示器）',
          },
        },
      },
    },
    {
      name: 'click',
      description:
        '在指定位置点击鼠标左键。使用归一化坐标 [0-1000, 0-1000]，左上角为(0,0)，右下角为(1000,1000)。',
      inputSchema: {
        type: 'object',
        properties: {
          x: {
            type: 'number',
            description: '归一化X坐标 (0-1000)',
            minimum: 0,
            maximum: 1000,
          },
          y: {
            type: 'number',
            description: '归一化Y坐标 (0-1000)',
            minimum: 0,
            maximum: 1000,
          },
          button: {
            type: 'string',
            description: '鼠标按钮',
            enum: ['left', 'right', 'middle'],
            default: 'left',
          },
          clicks: {
            type: 'number',
            description: '点击次数',
            default: 1,
          },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'double_click',
      description: '双击指定位置。使用归一化坐标 [0-1000, 0-1000]。',
      inputSchema: {
        type: 'object',
        properties: {
          x: {
            type: 'number',
            description: '归一化X坐标 (0-1000)',
            minimum: 0,
            maximum: 1000,
          },
          y: {
            type: 'number',
            description: '归一化Y坐标 (0-1000)',
            minimum: 0,
            maximum: 1000,
          },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'type',
      description: '在当前焦点位置输入文字。',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要输入的文字内容',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'key',
      description: '按下并释放单个按键。',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              '按键名称，如 enter, backspace, tab, escape, arrow_up, arrow_down, arrow_left, arrow_right 等',
          },
        },
        required: ['key'],
      },
    },
    {
      name: 'key_combo',
      description: '按下组合键，如 Ctrl+C, Alt+Tab 等。',
      inputSchema: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description:
              '按键数组，按顺序按下，逆序释放。如 ["ctrl", "c"] 表示 Ctrl+C',
          },
        },
        required: ['keys'],
      },
    },
    {
      name: 'scroll',
      description: '滚动鼠标滚轮。',
      inputSchema: {
        type: 'object',
        properties: {
          delta: {
            type: 'number',
            description: '滚动量，正数向上，负数向下',
            default: 3,
          },
          x: {
            type: 'number',
            description: '归一化X坐标，滚动位置（可选）',
          },
          y: {
            type: 'number',
            description: '归一化Y坐标，滚动位置（可选）',
          },
        },
      },
    },
    {
      name: 'drag',
      description: '拖拽鼠标从一个位置到另一个位置。使用归一化坐标。',
      inputSchema: {
        type: 'object',
        properties: {
          from_x: {
            type: 'number',
            description: '起始归一化X坐标',
            minimum: 0,
            maximum: 1000,
          },
          from_y: {
            type: 'number',
            description: '起始归一化Y坐标',
            minimum: 0,
            maximum: 1000,
          },
          to_x: {
            type: 'number',
            description: '目标归一化X坐标',
            minimum: 0,
            maximum: 1000,
          },
          to_y: {
            type: 'number',
            description: '目标归一化Y坐标',
            minimum: 0,
            maximum: 1000,
          },
          duration: {
            type: 'number',
            description: '拖拽持续时间（毫秒）',
            default: 500,
          },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
    },
    {
      name: 'get_windows',
      description: '获取当前所有打开的窗口列表。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'activate_window',
      description: '激活（前置）指定标题的窗口。',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '窗口标题（支持部分匹配）',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'open_app',
      description: '打开指定应用程序。',
      inputSchema: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: '应用名称或路径，如 notepad, calc, chrome 等',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '启动参数',
          },
        },
        required: ['app'],
      },
    },
    {
      name: 'wait',
      description: '等待指定时间。',
      inputSchema: {
        type: 'object',
        properties: {
          ms: {
            type: 'number',
            description: '等待毫秒数',
            default: 1000,
          },
        },
      },
    },
    {
      name: 'get_clipboard',
      description: '获取当前剪贴板内容。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'set_clipboard',
      description: '设置剪贴板内容。',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要设置的文本内容',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'get_screen_size',
      description: '获取屏幕尺寸信息。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'maximize_window',
      description: '最大化当前或指定窗口。',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '窗口标题（可选，不指定则最大化当前窗口）',
          },
        },
      },
    },
    {
      name: 'minimize_window',
      description: '最小化当前或指定窗口。',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '窗口标题（可选）',
          },
        },
      },
    },
    {
      name: 'close_window',
      description: '关闭指定窗口。',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '窗口标题',
          },
        },
        required: ['title'],
      },
    },
  ];

  private constructor() {
    super();
    this.executor = DesktopActionExecutor.getInstance();
    this.coords = NormalizedCoordinateSystem.getInstance();
  }

  public static create(): DesktopMCPServer {
    return new DesktopMCPServer();
  }

  public static getInstance(): DesktopMCPServer {
    if (!DesktopMCPServer.instance) {
      DesktopMCPServer.instance = new DesktopMCPServer();
    }
    return DesktopMCPServer.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    Logger.info('🔧 DesktopMCP Server 初始化', 'DesktopMCP');
    await this.executor.initialize();
    this.initialized = true;
  }

  /**
   * 获取所有可用工具列表
   */
  public listTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * 调用工具
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    this.ensureInitialized();

    Logger.debug(`🔧 MCP工具调用: ${name}`, 'DesktopMCP');
    this.emit('tool_call', { name, args });

    try {
      const result = await this.executeTool(name, args);
      this.emit('tool_result', { name, result });
      return result;
    } catch (error) {
      const errorResult: MCPToolResult = {
        content: [
          {
            type: 'text',
            text: `工具执行失败: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
      this.emit('tool_error', { name, error: (error as Error).message });
      return errorResult;
    }
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    switch (name) {
      case 'screenshot':
        return await this.handleScreenshot(args);
      case 'click':
        return await this.handleClick(args);
      case 'double_click':
        return await this.handleDoubleClick(args);
      case 'type':
        return await this.handleType(args);
      case 'key':
        return await this.handleKey(args);
      case 'key_combo':
        return await this.handleKeyCombo(args);
      case 'scroll':
        return await this.handleScroll(args);
      case 'drag':
        return await this.handleDrag(args);
      case 'get_windows':
        return await this.handleGetWindows(args);
      case 'activate_window':
        return await this.handleActivateWindow(args);
      case 'open_app':
        return await this.handleOpenApp(args);
      case 'wait':
        return await this.handleWait(args);
      case 'get_clipboard':
        return await this.handleGetClipboard(args);
      case 'set_clipboard':
        return await this.handleSetClipboard(args);
      case 'get_screen_size':
        return this.handleGetScreenSize();
      case 'maximize_window':
        return await this.handleMaximizeWindow(args);
      case 'minimize_window':
        return await this.handleMinimizeWindow(args);
      case 'close_window':
        return await this.handleCloseWindow(args);
      default:
        return {
          content: [{ type: 'text', text: `未知工具: ${name}` }],
          isError: true,
        };
    }
  }

  private async handleScreenshot(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'screenshot',
      params: { monitor: args.monitor || 0 },
      description: '截图',
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleClick(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const pixel = this.coords.toPixel({
      x: args.x as number,
      y: args.y as number,
    });

    const button = (args.button as string) || 'left';
    const actionType = button === 'right' ? 'rightClick' : 'click';

    const action: DesktopAction = {
      type: actionType as 'click' | 'rightClick',
      params: {
        x: pixel.x,
        y: pixel.y,
        clicks: args.clicks || 1,
      },
      description: `点击 (${args.x}, ${args.y}) [${pixel.x}, ${pixel.y}]`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleDoubleClick(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const pixel = this.coords.toPixel({
      x: args.x as number,
      y: args.y as number,
    });

    const action: DesktopAction = {
      type: 'click',
      params: {
        x: pixel.x,
        y: pixel.y,
        clicks: 2,
      },
      description: `双击 (${args.x}, ${args.y})`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleType(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'type',
      params: { text: args.text },
      description: `输入文字: ${args.text}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleKey(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'key',
      params: { key: args.key },
      description: `按键: ${args.key}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleKeyCombo(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'keyCombo',
      params: { keys: args.keys },
      description: `组合键: ${(args.keys as string[]).join('+')}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleScroll(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'scroll',
      params: {
        delta: args.delta || 3,
        x: args.x
          ? this.coords.toPixel({ x: args.x as number, y: 0 }).x
          : undefined,
        y: args.y
          ? this.coords.toPixel({ x: 0, y: args.y as number }).y
          : undefined,
      },
      description: `滚动: ${args.delta}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleDrag(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const fromPixel = this.coords.toPixel({
      x: args.from_x as number,
      y: args.from_y as number,
    });
    const toPixel = this.coords.toPixel({
      x: args.to_x as number,
      y: args.to_y as number,
    });

    const action: DesktopAction = {
      type: 'drag',
      params: {
        fromX: fromPixel.x,
        fromY: fromPixel.y,
        toX: toPixel.x,
        toY: toPixel.y,
        duration: args.duration || 500,
      },
      description: `拖拽 (${args.from_x}, ${args.from_y}) → (${args.to_x}, ${args.to_y})`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleGetWindows(
    _args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    // 注意：DesktopActionExecutor 没有直接的 get_windows 动作
    // 这里使用 shell 命令获取窗口列表作为降级方案
    const action: DesktopAction = {
      type: 'shell',
      params: {
        command:
          'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object MainWindowTitle | ConvertTo-Json',
      },
      description: '获取窗口列表',
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleActivateWindow(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'activateWindow',
      params: { title: args.title },
      description: `激活窗口: ${args.title}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleOpenApp(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'openApp',
      params: {
        app: args.app,
        args: args.args || [],
      },
      description: `打开应用: ${args.app}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleWait(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'wait',
      params: { ms: args.ms || 1000 },
      description: `等待 ${args.ms || 1000}ms`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleGetClipboard(
    _args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'clipboardRead',
      params: {},
      description: '读取剪贴板',
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleSetClipboard(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'clipboardWrite',
      params: { text: args.text },
      description: `设置剪贴板: ${args.text}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private handleGetScreenSize(): MCPToolResult {
    const pixelSize = this.coords.getPixelScreenSize();
    const normalizedSize = this.coords.getNormalizedScreenSize();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              pixel_width: pixelSize.width,
              pixel_height: pixelSize.height,
              normalized_width: normalizedSize.width,
              normalized_height: normalizedSize.height,
              coordinate_system: '[0-1000] × [0-1000] 归一化坐标',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleMaximizeWindow(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'maximize',
      params: { title: args.title },
      description: `最大化窗口: ${args.title || '当前窗口'}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleMinimizeWindow(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'minimize',
      params: { title: args.title },
      description: `最小化窗口: ${args.title || '当前窗口'}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private async handleCloseWindow(
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const action: DesktopAction = {
      type: 'closeWindow',
      params: { title: args.title },
      description: `关闭窗口: ${args.title}`,
    };
    const result = await this.executor.executeAction(action);
    return this.actionResultToMCP(result);
  }

  private actionResultToMCP(result: DesktopActionResult): MCPToolResult {
    if (result.success) {
      const content: MCPToolResult['content'] = [];

      if (result.output) {
        content.push({ type: 'text', text: result.output });
      }

      if (result.observation) {
        content.push({
          type: 'text',
          text: JSON.stringify(result.observation, null, 2),
        });
      }

      if (content.length === 0) {
        content.push({ type: 'text', text: '操作成功' });
      }

      return { content };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: result.error || '操作失败',
          },
        ],
        isError: true,
      };
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('DesktopMCPServer 未初始化，请先调用 initialize()');
    }
  }

  public async shutdown(): Promise<void> {
    if (this.executor) {
      await this.executor.shutdown();
    }
    this.initialized = false;
    Logger.info('🔧 DesktopMCP Server 已关闭', 'DesktopMCP');
  }
}

// 便捷导出
export const desktopMCPServer = DesktopMCPServer.getInstance();

export default DesktopMCPServer;
