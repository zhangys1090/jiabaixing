/**
 * DesktopActionExecutor - 桌面操作执行器
 * 统一封装：截图 + 窗口管理 + 鼠标键盘操作 + UI元素交互 + 剪贴板
 * v2: 新增 rightClick, keyCombo, clipboardRead, clipboardWrite,
 *     clickElement, typeIntoElement, getElementText
 */

import { ScreenCapture } from './ScreenCapture';
import { WindowManager } from './WindowManager';
import { SystemInput } from './SystemInput';
import { DesktopVisionEngine, DesktopObservation } from './DesktopVisionEngine';
import { DesktopUIInspector } from './DesktopUIInspector';
import { Logger } from '../utils/Logger';
import { exec, execSync } from 'child_process';

export interface DesktopAction {
  type:
    | 'screenshot'
    | 'click'
    | 'rightClick'
    | 'type'
    | 'key'
    | 'keyCombo'
    | 'moveMouse'
    | 'scroll'
    | 'drag'
    | 'openApp'
    | 'activateWindow'
    | 'closeWindow'
    | 'maximize'
    | 'minimize'
    | 'observe'
    | 'wait'
    | 'shell'
    | 'clipboardRead'
    | 'clipboardWrite'
    | 'clickElement'
    | 'typeIntoElement'
    | 'getElementText';
  params: Record<string, unknown>;
  description?: string;
}

export interface DesktopActionResult {
  success: boolean;
  action: DesktopAction;
  output?: string;
  observation?: DesktopObservation;
  error?: string;
}

export interface DesktopTaskResult {
  success: boolean;
  actions: DesktopActionResult[];
  summary: string;
  finalObservation?: DesktopObservation;
  error?: string;
}

export class DesktopActionExecutor {
  private static instance: DesktopActionExecutor | null = null;
  private screenCapture: ScreenCapture;
  private windowManager: WindowManager;
  private systemInput: SystemInput;
  private visionEngine: DesktopVisionEngine;
  private uiInspector: DesktopUIInspector;
  private initialized: boolean = false;

  private constructor() {
    this.screenCapture = ScreenCapture.getInstance();
    this.windowManager = WindowManager.getInstance();
    this.systemInput = SystemInput.getInstance();
    this.visionEngine = DesktopVisionEngine.getInstance();
    this.uiInspector = DesktopUIInspector.getInstance();
  }

  public static getInstance(): DesktopActionExecutor {
    if (!DesktopActionExecutor.instance) {
      DesktopActionExecutor.instance = new DesktopActionExecutor();
    }
    return DesktopActionExecutor.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    Logger.info('🎮 DesktopActionExecutor 初始化', 'DesktopActionExecutor');
    await this.screenCapture.initialize();
    await this.windowManager.initialize();
    await this.systemInput.initialize();
    await this.visionEngine.initialize();
    await this.uiInspector.initialize();

    this.initialized = true;
    Logger.info('🎮 DesktopActionExecutor 初始化完成', 'DesktopActionExecutor');
  }

  /**
   * 执行单个动作
   */
  public async executeAction(
    action: DesktopAction
  ): Promise<DesktopActionResult> {
    this.ensureInitialized();
    Logger.info(
      `🎮 执行: ${action.description || action.type}`,
      'DesktopActionExecutor'
    );

    try {
      switch (action.type) {
        case 'screenshot':
          return await this.handleScreenshot(action);
        case 'click':
          return this.handleClick(action);
        case 'rightClick':
          return this.handleRightClick(action);
        case 'type':
          return this.handleType(action);
        case 'key':
          return this.handleKey(action);
        case 'keyCombo':
          return this.handleKeyCombo(action);
        case 'moveMouse':
          return this.handleMoveMouse(action);
        case 'scroll':
          return this.handleScroll(action);
        case 'drag':
          return this.handleDrag(action);
        case 'openApp':
          return this.handleOpenApp(action);
        case 'activateWindow':
          return this.handleActivateWindow(action);
        case 'closeWindow':
          return this.handleCloseWindow(action);
        case 'maximize':
          return this.handleMaximize(action);
        case 'minimize':
          return this.handleMinimize(action);
        case 'observe':
          return await this.handleObserve(action);
        case 'wait':
          return this.handleWait(action);
        case 'shell':
          return this.handleShell(action);
        case 'clipboardRead':
          return this.handleClipboardRead(action);
        case 'clipboardWrite':
          return this.handleClipboardWrite(action);
        case 'clickElement':
          return await this.handleClickElement(action);
        case 'typeIntoElement':
          return await this.handleTypeIntoElement(action);
        case 'getElementText':
          return await this.handleGetElementText(action);
        default:
          return {
            success: false,
            action,
            error: `未知动作类型: ${action.type}`,
          };
      }
    } catch (error) {
      Logger.error(
        `❌ 动作执行失败: ${action.type}`,
        error as Error,
        'DesktopActionExecutor'
      );
      return {
        success: false,
        action,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 执行动作序列
   */
  public async executeTask(
    actions: DesktopAction[]
  ): Promise<DesktopTaskResult> {
    Logger.info(
      `🎮 开始执行任务，共 ${actions.length} 个动作`,
      'DesktopActionExecutor'
    );

    const results: DesktopActionResult[] = [];
    let finalObservation: DesktopObservation | undefined;

    for (const action of actions) {
      const result = await this.executeAction(action);
      results.push(result);

      if (result.observation) {
        finalObservation = result.observation;
      }

      if (!result.success) {
        Logger.warn(
          `⚠️ 动作失败，停止执行: ${action.description || action.type}`,
          'DesktopActionExecutor'
        );
        return {
          success: false,
          actions: results,
          summary: `执行失败: ${result.error || '未知错误'}`,
          finalObservation,
        };
      }

      // 每个动作间短暂等待
      await this.sleep(200);
    }

    // 最后观察一次桌面
    try {
      finalObservation = await this.visionEngine.observe();
    } catch {
      // 忽略
    }

    const successCount = results.filter((r) => r.success).length;
    const summary = `执行完成: ${successCount}/${results.length} 个动作成功`;

    Logger.info(`🎮 ${summary}`, 'DesktopActionExecutor');

    return {
      success: successCount === results.length,
      actions: results,
      summary,
      finalObservation,
    };
  }

  // ═════════════════════════ 动作处理器 ═════════════════════════

  private async handleScreenshot(
    action: DesktopAction
  ): Promise<DesktopActionResult> {
    const result = await this.screenCapture.captureFullScreen();
    return {
      success: result.success,
      action,
      output: result.success
        ? `截图完成: ${result.buffer.length} bytes`
        : result.error,
    };
  }

  private async handleClick(action: DesktopAction): Promise<DesktopActionResult> {
    const x = action.params.x as number | undefined;
    const y = action.params.y as number | undefined;
    const result = await this.systemInput.click(x, y);
    return {
      success: result.success,
      action,
      output: `点击 (${x ?? '当前位置'}, ${y ?? '当前位置'})`,
      error: result.error,
    };
  }

  private async handleType(action: DesktopAction): Promise<DesktopActionResult> {
    const text = action.params.text as string;
    const result = await this.systemInput.typeText(text);
    return {
      success: result.success,
      action,
      output: `输入文字: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`,
      error: result.error,
    };
  }

  private async handleKey(action: DesktopAction): Promise<DesktopActionResult> {
    const key = action.params.key as string;
    const keyCode = (SystemInput.Keys as Record<string, number>)[key];
    if (!keyCode) {
      return { success: false, action, error: `未知按键: ${key}` };
    }
    const result = await this.systemInput.keyPress(keyCode);
    return {
      success: result.success,
      action,
      output: `按键: ${key}`,
      error: result.error,
    };
  }

  private async handleMoveMouse(action: DesktopAction): Promise<DesktopActionResult> {
    const x = action.params.x as number;
    const y = action.params.y as number;
    const result = await this.systemInput.moveMouse(x, y);
    return {
      success: result.success,
      action,
      output: `移动鼠标到 (${x}, ${y})`,
      error: result.error,
    };
  }

  private async handleScroll(action: DesktopAction): Promise<DesktopActionResult> {
    const delta = action.params.delta as number;
    const result = await this.systemInput.scroll(delta);
    return {
      success: result.success,
      action,
      output: `滚动: ${delta}`,
      error: result.error,
    };
  }

  private async handleDrag(action: DesktopAction): Promise<DesktopActionResult> {
    const fromX = action.params.fromX as number;
    const fromY = action.params.fromY as number;
    const toX = action.params.toX as number;
    const toY = action.params.toY as number;
    const result = await this.systemInput.drag(fromX, fromY, toX, toY);
    return {
      success: result.success,
      action,
      output: `拖拽: (${fromX},${fromY}) → (${toX},${toY})`,
      error: result.error,
    };
  }

  private handleOpenApp(action: DesktopAction): DesktopActionResult {
    const appName = action.params.app as string;
    try {
      execSync(`start "" "${appName}"`, { timeout: 10000 });
      return {
        success: true,
        action,
        output: `打开应用: ${appName}`,
      };
    } catch (error) {
      return {
        success: false,
        action,
        error: (error as Error).message,
      };
    }
  }

  private handleActivateWindow(action: DesktopAction): DesktopActionResult {
    const title = action.params.title as string;
    const result = this.windowManager.activateWindowByTitle(title);
    return {
      success: result.success,
      action,
      output: `激活窗口: ${title}`,
      error: result.error,
    };
  }

  private handleCloseWindow(action: DesktopAction): DesktopActionResult {
    const title = action.params.title as string;
    const window = this.windowManager.findWindow(title);
    if (!window) {
      return { success: false, action, error: `未找到窗口: ${title}` };
    }
    try {
      const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
$hwnd = [IntPtr]::new(${window.handle})
[WinAPI]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
`;
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        {
          encoding: 'utf-8',
          timeout: 5000,
        }
      );
      return { success: true, action, output: `关闭窗口: ${title}` };
    } catch (error) {
      return { success: false, action, error: (error as Error).message };
    }
  }

  private handleMaximize(action: DesktopAction): DesktopActionResult {
    const title = action.params.title as string;
    const window = this.windowManager.findWindow(title);
    if (!window) {
      return { success: false, action, error: `未找到窗口: ${title}` };
    }
    const result = this.windowManager.maximizeWindow(window.handle);
    return {
      success: result.success,
      action,
      output: `最大化窗口: ${title}`,
      error: result.error,
    };
  }

  private handleMinimize(action: DesktopAction): DesktopActionResult {
    const title = action.params.title as string;
    const window = this.windowManager.findWindow(title);
    if (!window) {
      return { success: false, action, error: `未找到窗口: ${title}` };
    }
    const result = this.windowManager.minimizeWindow(window.handle);
    return {
      success: result.success,
      action,
      output: `最小化窗口: ${title}`,
      error: result.error,
    };
  }

  private async handleObserve(
    action: DesktopAction
  ): Promise<DesktopActionResult> {
    const observation = await this.visionEngine.observe();
    return {
      success: true,
      action,
      output: this.visionEngine.generateReport(observation),
      observation,
    };
  }

  private async handleWait(action: DesktopAction): Promise<DesktopActionResult> {
    const ms = action.params.ms as number;
    await this.sleep(ms);
    return {
      success: true,
      action,
      output: `等待 ${ms}ms`,
    };
  }

  private async handleRightClick(action: DesktopAction): Promise<DesktopActionResult> {
    const x = action.params.x as number | undefined;
    const y = action.params.y as number | undefined;
    const result = await this.systemInput.rightClick(x, y);
    return {
      success: result.success,
      action,
      output: `右键点击 (${x ?? '当前位置'}, ${y ?? '当前位置'})`,
      error: result.error,
    };
  }

  private async handleKeyCombo(action: DesktopAction): Promise<DesktopActionResult> {
    const keys = action.params.keys as string[];
    if (!keys || !Array.isArray(keys) || keys.length < 2) {
      return { success: false, action, error: 'keyCombo 需要至少2个按键' };
    }
    try {
      const keyCodes = keys.map((k) => {
        const code = (SystemInput.Keys as Record<string, number>)[k.toUpperCase()];
        if (!code) throw new Error(`未知按键: ${k}`);
        return code;
      });
      const result = await this.systemInput.keyCombo(...keyCodes);
      return {
        success: result.success,
        action,
        output: `组合键: ${keys.join('+')}`,
        error: result.error,
      };
    } catch (error) {
      return { success: false, action, error: (error as Error).message };
    }
  }

  private handleClipboardRead(action: DesktopAction): DesktopActionResult {
    try {
      const content = execSync(
        'powershell -NoProfile -Command "Get-Clipboard"',
        { encoding: 'utf-8', timeout: 5000 }
      );
      return {
        success: true,
        action,
        output: content.substring(0, 500),
      };
    } catch (error) {
      return { success: false, action, error: (error as Error).message };
    }
  }

  private handleClipboardWrite(action: DesktopAction): DesktopActionResult {
    const text = action.params.text as string;
    try {
      const escaped = text.replace(/'/g, "''");
      execSync(
        `powershell -NoProfile -Command "Set-Clipboard -Value '${escaped}'"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return {
        success: true,
        action,
        output: `写入剪贴板: ${text.substring(0, 50)}`,
      };
    } catch (error) {
      return { success: false, action, error: (error as Error).message };
    }
  }

  private async handleClickElement(
    action: DesktopAction
  ): Promise<DesktopActionResult> {
    const description = action.params.description as string;
    try {
      const element = this.uiInspector.findElementByDescription(description);
      if (!element) {
        return {
          success: false,
          action,
          error: `未找到UI元素: ${description}`,
        };
      }
      const clickX = element.boundingRect.x + Math.floor(element.boundingRect.width / 2);
      const clickY = element.boundingRect.y + Math.floor(element.boundingRect.height / 2);
      const result = await this.systemInput.click(clickX, clickY);
      return {
        success: result.success,
        action,
        output: `点击元素 "${description}" 于 (${clickX}, ${clickY})`,
        error: result.error,
      };
    } catch (error) {
      return { success: false, action, error: (error as Error).message };
    }
  }

  private async handleTypeIntoElement(
    action: DesktopAction
  ): Promise<DesktopActionResult> {
    const description = action.params.description as string;
    const text = action.params.text as string;
    try {
      const element = this.uiInspector.findElementByDescription(description);
      if (!element) {
        return {
          success: false,
          action,
          error: `未找到UI元素: ${description}`,
        };
      }
      const clickX = element.boundingRect.x + Math.floor(element.boundingRect.width / 2);
      const clickY = element.boundingRect.y + Math.floor(element.boundingRect.height / 2);
      await this.systemInput.click(clickX, clickY);
      await this.sleep(200);
      const result = await this.systemInput.typeText(text);
      return {
        success: result.success,
        action,
        output: `在 "${description}" 中输入: ${text.substring(0, 50)}`,
        error: result.error,
      };
    } catch (error) {
      return { success: false, action, error: (error as Error).message };
    }
  }

  private async handleGetElementText(
    action: DesktopAction
  ): Promise<DesktopActionResult> {
    const description = action.params.description as string;
    try {
      const element = this.uiInspector.findElementByDescription(description);
      if (!element) {
        return {
          success: false,
          action,
          error: `未找到UI元素: ${description}`,
        };
      }
      return {
        success: true,
        action,
        output: element.name || '(无文本)',
      };
    } catch (error) {
      return { success: false, action, error: (error as Error).message };
    }
  }

  private async handleShell(action: DesktopAction): Promise<DesktopActionResult> {
    const command = action.params.command as string;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        exec(command, { encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout || stderr || '(无输出)');
          }
        });
      });
      return {
        success: true,
        action,
        output: output.substring(0, 500),
      };
    } catch (error) {
      return {
        success: false,
        action,
        error: (error as Error).message,
      };
    }
  }

  // ═════════════════════════ 快捷任务 ═════════════════════════

  /**
   * 快捷任务：打开记事本，输入文字，保存
   */
  public async openNotepadAndType(
    text: string,
    savePath?: string
  ): Promise<DesktopTaskResult> {
    const actions: DesktopAction[] = [
      {
        type: 'shell',
        params: { command: 'start notepad' },
        description: '打开记事本',
      },
      { type: 'wait', params: { ms: 1000 }, description: '等待记事本启动' },
      { type: 'type', params: { text }, description: '输入文字' },
    ];

    if (savePath) {
      actions.push(
        { type: 'key', params: { key: 'CTRL' }, description: '按下 Ctrl' },
        { type: 'key', params: { key: 'S' }, description: '按下 S (保存)' },
        { type: 'wait', params: { ms: 500 }, description: '等待保存对话框' },
        {
          type: 'type',
          params: { text: savePath },
          description: '输入保存路径',
        },
        { type: 'key', params: { key: 'ENTER' }, description: '确认保存' }
      );
    }

    return this.executeTask(actions);
  }

  /**
   * 快捷任务：观察桌面并汇报
   */
  public async observeAndReport(): Promise<DesktopTaskResult> {
    const actions: DesktopAction[] = [
      { type: 'observe', params: {}, description: '观察桌面' },
    ];
    return this.executeTask(actions);
  }

  /**
   * 快捷任务：点击指定坐标
   */
  public async clickAt(x: number, y: number): Promise<DesktopTaskResult> {
    const actions: DesktopAction[] = [
      {
        type: 'moveMouse',
        params: { x, y },
        description: `移动鼠标到 (${x}, ${y})`,
      },
      { type: 'click', params: { x, y }, description: '点击' },
    ];
    return this.executeTask(actions);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('DesktopActionExecutor 未初始化！请先调用 initialize()');
    }
  }

  public async shutdown(): Promise<void> {
    await this.visionEngine.shutdown();
    await this.systemInput.shutdown();
    await this.windowManager.shutdown();
    await this.screenCapture.shutdown();
    this.initialized = false;
    Logger.info('🎮 DesktopActionExecutor 已关闭', 'DesktopActionExecutor');
  }
}

export default DesktopActionExecutor;
