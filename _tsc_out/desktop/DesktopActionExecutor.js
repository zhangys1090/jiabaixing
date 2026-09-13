"use strict";
/**
 * DesktopActionExecutor - 桌面操作执行器
 * 统一封装：截图 + 窗口管理 + 鼠标键盘操作 + UI元素交互 + 剪贴板
 * v2: 新增 rightClick, keyCombo, clipboardRead, clipboardWrite,
 *     clickElement, typeIntoElement, getElementText
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopActionExecutor = void 0;
const child_process_1 = require("child_process");
const shell_exec_1 = require("../harness/tools/system/shell_exec");
const Logger_1 = require("../utils/Logger");
const DesktopUIInspector_1 = require("./DesktopUIInspector");
const DesktopVisionEngine_1 = require("./DesktopVisionEngine");
const ScreenCapture_1 = require("./ScreenCapture");
const SystemInput_1 = require("./SystemInput");
const WindowManager_1 = require("./WindowManager");
class DesktopActionExecutor {
    static instance = null;
    screenCapture;
    windowManager;
    systemInput;
    visionEngine;
    uiInspector;
    initialized = false;
    constructor() {
        this.screenCapture = ScreenCapture_1.ScreenCapture.getInstance();
        this.windowManager = WindowManager_1.WindowManager.getInstance();
        this.systemInput = SystemInput_1.SystemInput.getInstance();
        this.visionEngine = DesktopVisionEngine_1.DesktopVisionEngine.getInstance();
        this.uiInspector = DesktopUIInspector_1.DesktopUIInspector.getInstance();
    }
    static create() {
        return new DesktopActionExecutor();
    }
    static getInstance() {
        if (!DesktopActionExecutor.instance) {
            DesktopActionExecutor.instance = new DesktopActionExecutor();
        }
        return DesktopActionExecutor.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🎮 DesktopActionExecutor 初始化', 'DesktopActionExecutor');
        await this.screenCapture.initialize();
        await this.windowManager.initialize();
        await this.systemInput.initialize();
        await this.visionEngine.initialize();
        await this.uiInspector.initialize();
        this.initialized = true;
        Logger_1.Logger.info('🎮 DesktopActionExecutor 初始化完成', 'DesktopActionExecutor');
    }
    /**
     * 执行单个动作
     */
    async executeAction(action) {
        this.ensureInitialized();
        Logger_1.Logger.info(`🎮 执行: ${action.description || action.type}`, 'DesktopActionExecutor');
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
                case 'restoreWindowState':
                    return this.handleRestoreWindowState(action);
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
        }
        catch (error) {
            Logger_1.Logger.error(`❌ 动作执行失败: ${action.type}`, error, 'DesktopActionExecutor');
            return {
                success: false,
                action,
                error: error.message,
            };
        }
    }
    /**
     * 执行动作序列
     */
    async executeTask(actions) {
        Logger_1.Logger.info(`🎮 开始执行任务，共 ${actions.length} 个动作`, 'DesktopActionExecutor');
        const results = [];
        let finalObservation;
        for (const action of actions) {
            const result = await this.executeAction(action);
            results.push(result);
            if (result.observation) {
                finalObservation = result.observation;
            }
            if (!result.success) {
                Logger_1.Logger.warn(`⚠️ 动作失败，停止执行: ${action.description || action.type}`, 'DesktopActionExecutor');
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
        }
        catch {
            // 忽略
        }
        const successCount = results.filter((r) => r.success).length;
        const summary = `执行完成: ${successCount}/${results.length} 个动作成功`;
        Logger_1.Logger.info(`🎮 ${summary}`, 'DesktopActionExecutor');
        return {
            success: successCount === results.length,
            actions: results,
            summary,
            finalObservation,
        };
    }
    // ═════════════════════════ 动作处理器 ═════════════════════════
    async handleScreenshot(action) {
        const result = await this.screenCapture.captureFullScreen();
        return {
            success: result.success,
            action,
            output: result.success
                ? `截图完成: ${result.buffer.length} bytes`
                : result.error,
        };
    }
    async handleClick(action) {
        const x = action.params.x;
        const y = action.params.y;
        const result = await this.systemInput.click(x, y);
        return {
            success: result.success,
            action,
            output: `点击 (${x ?? '当前位置'}, ${y ?? '当前位置'})`,
            error: result.error,
        };
    }
    async handleType(action) {
        const text = action.params.text;
        const result = await this.systemInput.typeText(text);
        return {
            success: result.success,
            action,
            output: `输入文字: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`,
            error: result.error,
        };
    }
    async handleKey(action) {
        const key = action.params.key;
        const keyCode = SystemInput_1.SystemInput.Keys[key];
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
    async handleMoveMouse(action) {
        const x = action.params.x;
        const y = action.params.y;
        const result = await this.systemInput.moveMouse(x, y);
        return {
            success: result.success,
            action,
            output: `移动鼠标到 (${x}, ${y})`,
            error: result.error,
        };
    }
    async handleScroll(action) {
        const delta = action.params.delta;
        const result = await this.systemInput.scroll(delta);
        return {
            success: result.success,
            action,
            output: `滚动: ${delta}`,
            error: result.error,
        };
    }
    async handleDrag(action) {
        const fromX = action.params.fromX;
        const fromY = action.params.fromY;
        const toX = action.params.toX;
        const toY = action.params.toY;
        const result = await this.systemInput.drag(fromX, fromY, toX, toY);
        return {
            success: result.success,
            action,
            output: `拖拽: (${fromX},${fromY}) → (${toX},${toY})`,
            error: result.error,
        };
    }
    handleOpenApp(action) {
        const appName = action.params.app;
        try {
            (0, child_process_1.execSync)(`start "" "${appName}"`, { timeout: 10000 });
            return {
                success: true,
                action,
                output: `打开应用: ${appName}`,
            };
        }
        catch (error) {
            return {
                success: false,
                action,
                error: error.message,
            };
        }
    }
    handleActivateWindow(action) {
        const title = action.params.title;
        const result = this.windowManager.activateWindowByTitle(title);
        return {
            success: result.success,
            action,
            output: `激活窗口: ${title}`,
            error: result.error,
        };
    }
    handleRestoreWindowState(action) {
        const handle = action.params.handle;
        const result = this.windowManager.activateWindow(handle);
        return {
            success: result.success,
            action,
            output: `恢复窗口状态: handle=${handle}`,
            error: result.error,
        };
    }
    handleCloseWindow(action) {
        const title = action.params.title;
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
            (0, child_process_1.execSync)(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`, {
                encoding: 'utf-8',
                timeout: 5000,
            });
            return { success: true, action, output: `关闭窗口: ${title}` };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    handleMaximize(action) {
        const title = action.params.title;
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
    handleMinimize(action) {
        const title = action.params.title;
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
    async handleObserve(action) {
        const observation = await this.visionEngine.observe();
        return {
            success: true,
            action,
            output: this.visionEngine.generateReport(observation),
            observation,
        };
    }
    async handleWait(action) {
        const ms = action.params.ms;
        await this.sleep(ms);
        return {
            success: true,
            action,
            output: `等待 ${ms}ms`,
        };
    }
    async handleRightClick(action) {
        const x = action.params.x;
        const y = action.params.y;
        const result = await this.systemInput.rightClick(x, y);
        return {
            success: result.success,
            action,
            output: `右键点击 (${x ?? '当前位置'}, ${y ?? '当前位置'})`,
            error: result.error,
        };
    }
    async handleKeyCombo(action) {
        const keys = action.params.keys;
        if (!keys || !Array.isArray(keys) || keys.length < 2) {
            return { success: false, action, error: 'keyCombo 需要至少2个按键' };
        }
        try {
            const keyCodes = keys.map((k) => {
                const code = SystemInput_1.SystemInput.Keys[k.toUpperCase()];
                if (!code)
                    throw new Error(`未知按键: ${k}`);
                return code;
            });
            const result = await this.systemInput.keyCombo(...keyCodes);
            return {
                success: result.success,
                action,
                output: `组合键: ${keys.join('+')}`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    handleClipboardRead(action) {
        try {
            const content = (0, child_process_1.execSync)('powershell -NoProfile -Command "Get-Clipboard"', { encoding: 'utf-8', timeout: 5000 });
            return {
                success: true,
                action,
                output: content.substring(0, 500),
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    handleClipboardWrite(action) {
        const text = action.params.text;
        try {
            const escaped = text.replace(/'/g, "''");
            (0, child_process_1.execSync)(`powershell -NoProfile -Command "Set-Clipboard -Value '${escaped}'"`, { encoding: 'utf-8', timeout: 5000 });
            return {
                success: true,
                action,
                output: `写入剪贴板: ${text.substring(0, 50)}`,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleClickElement(action) {
        const description = action.params.description;
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
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleTypeIntoElement(action) {
        const description = action.params.description;
        const text = action.params.text;
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
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleGetElementText(action) {
        const description = action.params.description;
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
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleShell(action) {
        const command = action.params.command;
        if (!command || typeof command !== 'string') {
            return {
                success: false,
                action,
                error: 'shell 命令不能为空',
            };
        }
        const dangerCheck = (0, shell_exec_1.isShellCommandDangerous)(command);
        if (dangerCheck.blocked) {
            Logger_1.Logger.warn(`🛡️ Desktop shell 命令被安全策略拦截: ${dangerCheck.reason}`, 'DesktopActionExecutor');
            return {
                success: false,
                action,
                error: `命令被安全策略拦截: ${dangerCheck.reason}`,
            };
        }
        try {
            const output = await new Promise((resolve, reject) => {
                (0, child_process_1.exec)(command, {
                    encoding: 'utf-8',
                    timeout: 30000,
                    maxBuffer: 1024 * 1024,
                    windowsHide: true,
                }, (err, stdout, stderr) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(stdout || stderr || '(无输出)');
                    }
                });
            });
            return {
                success: true,
                action,
                output: output.substring(0, 500),
            };
        }
        catch (error) {
            return {
                success: false,
                action,
                error: error.message,
            };
        }
    }
    // ═════════════════════════ 快捷任务 ═════════════════════════
    /**
     * 快捷任务：打开记事本，输入文字，保存
     */
    async openNotepadAndType(text, savePath) {
        const actions = [
            {
                type: 'shell',
                params: { command: 'start notepad' },
                description: '打开记事本',
            },
            { type: 'wait', params: { ms: 1000 }, description: '等待记事本启动' },
            { type: 'type', params: { text }, description: '输入文字' },
        ];
        if (savePath) {
            actions.push({ type: 'key', params: { key: 'CTRL' }, description: '按下 Ctrl' }, { type: 'key', params: { key: 'S' }, description: '按下 S (保存)' }, { type: 'wait', params: { ms: 500 }, description: '等待保存对话框' }, {
                type: 'type',
                params: { text: savePath },
                description: '输入保存路径',
            }, { type: 'key', params: { key: 'ENTER' }, description: '确认保存' });
        }
        return this.executeTask(actions);
    }
    /**
     * 快捷任务：观察桌面并汇报
     */
    async observeAndReport() {
        const actions = [
            { type: 'observe', params: {}, description: '观察桌面' },
        ];
        return this.executeTask(actions);
    }
    /**
     * 快捷任务：点击指定坐标
     */
    async clickAt(x, y) {
        const actions = [
            {
                type: 'moveMouse',
                params: { x, y },
                description: `移动鼠标到 (${x}, ${y})`,
            },
            { type: 'click', params: { x, y }, description: '点击' },
        ];
        return this.executeTask(actions);
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('DesktopActionExecutor 未初始化！请先调用 initialize()');
        }
    }
    async shutdown() {
        await this.visionEngine.shutdown();
        await this.systemInput.shutdown();
        await this.windowManager.shutdown();
        await this.screenCapture.shutdown();
        this.initialized = false;
        Logger_1.Logger.info('🎮 DesktopActionExecutor 已关闭', 'DesktopActionExecutor');
    }
}
exports.DesktopActionExecutor = DesktopActionExecutor;
exports.default = DesktopActionExecutor;
