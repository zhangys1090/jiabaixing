"use strict";
/**
 * SystemInput - 系统鼠标键盘控制
 * Windows 平台：通过 PowerShell + user32.dll SendInput API 实现
 * v3: 全异步 + 常驻 PowerShell 进程，所有操作走常驻进程避免 200-500ms 启动开销
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemInput = void 0;
const child_process_1 = require("child_process");
const Logger_1 = require("../utils/Logger");
class SystemInput {
    constructor() {
        this.initialized = false;
        this.psProcess = null;
        this.commandId = 0;
        this.pendingCommands = new Map();
        this.outputBuffer = '';
        this.usePersistentSession = true;
        this._psTypesLoaded = new Set();
    }
    static getInstance() {
        if (!SystemInput.instance) {
            SystemInput.instance = new SystemInput();
        }
        return SystemInput.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🖱️ SystemInput 初始化', 'SystemInput');
        try {
            await this.startPersistentSession();
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 常驻PowerShell启动失败，降级为execSync: ${err.message}`, 'SystemInput');
            this.usePersistentSession = false;
        }
        this.initialized = true;
    }
    async startPersistentSession() {
        return new Promise((resolve, reject) => {
            this.psProcess = (0, child_process_1.spawn)('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let initBuffer = '';
            const initTimeout = setTimeout(() => {
                reject(new Error('PowerShell 初始化超时'));
            }, 10000);
            const onReady = () => {
                clearTimeout(initTimeout);
                Logger_1.Logger.info('🖱️ 常驻PowerShell进程已启动', 'SystemInput');
                resolve();
            };
            this.psProcess.stdout.on('data', (data) => {
                const chunk = data.toString();
                if (!this.initialized) {
                    initBuffer += chunk;
                    if (initBuffer.includes('__INIT_OK__')) {
                        this.psProcess.stdout.removeListener('data', onReady);
                        onReady();
                        return;
                    }
                }
                this.handleOutput(chunk);
            });
            this.psProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    Logger_1.Logger.warn(`⚠️ PS stderr: ${msg.substring(0, 100)}`, 'SystemInput');
                }
            });
            this.psProcess.on('error', (err) => {
                Logger_1.Logger.error('❌ PowerShell进程错误', err, 'SystemInput');
                this.usePersistentSession = false;
                clearTimeout(initTimeout);
                reject(err);
            });
            this.psProcess.on('exit', (code) => {
                Logger_1.Logger.warn(`⚠️ PowerShell进程退出: code=${code}`, 'SystemInput');
                this.psProcess = null;
                this.usePersistentSession = false;
                for (const [id, pending] of this.pendingCommands) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error('PowerShell进程已退出'));
                    this.pendingCommands.delete(id);
                }
            });
            this.psProcess.stdin.write("Write-Output '__INIT_OK__'\n");
        });
    }
    handleOutput(chunk) {
        this.outputBuffer += chunk;
        if (this.outputBuffer.length > SystemInput.MAX_OUTPUT_BUFFER) {
            this.outputBuffer = this.outputBuffer.substring(this.outputBuffer.length - SystemInput.MAX_OUTPUT_BUFFER / 2);
            Logger_1.Logger.warn('⚠️ PowerShell输出缓冲区接近上限，已截断', 'SystemInput');
        }
        const markerRegex = /__CMD_END_(\d+)__/g;
        let match;
        while ((match = markerRegex.exec(this.outputBuffer)) !== null) {
            const cmdId = parseInt(match[1]);
            const endPos = match.index + match[0].length;
            const outputBefore = this.outputBuffer.substring(0, match.index);
            this.outputBuffer = this.outputBuffer.substring(endPos);
            const pending = this.pendingCommands.get(cmdId);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingCommands.delete(cmdId);
                pending.resolve(outputBefore.trim());
            }
        }
    }
    async executePs(psScript, timeoutMs = 5000) {
        if (this.usePersistentSession && this.psProcess && !this.psProcess.killed) {
            return this.executeViaSession(psScript, timeoutMs);
        }
        if (this.usePersistentSession && (!this.psProcess || this.psProcess.killed)) {
            try {
                await this.startPersistentSession();
                if (this.psProcess && !this.psProcess.killed) {
                    return this.executeViaSession(psScript, timeoutMs);
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`⚠️ PowerShell 重连失败，降级为execSync: ${err.message}`, 'SystemInput');
                this.usePersistentSession = false;
            }
        }
        return this.executeViaExecSyncAsync(psScript, timeoutMs);
    }
    executeViaSession(psScript, timeoutMs) {
        return new Promise((resolve, reject) => {
            const id = ++this.commandId;
            const timer = setTimeout(() => {
                this.pendingCommands.delete(id);
                reject(new Error(`命令超时 (${timeoutMs}ms)`));
            }, timeoutMs);
            this.pendingCommands.set(id, { resolve, reject, timer });
            const wrappedScript = `${psScript}\nWrite-Output '__CMD_END_${id}__'\n`;
            this.psProcess.stdin.write(wrappedScript);
        });
    }
    _ensureType(typeName, typeDef) {
        if (this._psTypesLoaded.has(typeName)) {
            return '';
        }
        this._psTypesLoaded.add(typeName);
        return typeDef;
    }
    _mouseClickTypeDef() {
        return this._ensureType('MouseClick', `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClick {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint LEFTDOWN = 0x02;
  public const uint LEFTUP = 0x04;
  public const uint RIGHTDOWN = 0x08;
  public const uint RIGHTUP = 0x10;
  public const uint WHEEL = 0x800;
}
"@`);
    }
    _keyPressTypeDef() {
        return this._ensureType('KeyPress', `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyPress {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
  public const uint KEYDOWN = 0x00;
  public const uint KEYUP = 0x02;
}
"@`);
    }
    _winFormsInit() {
        return this._ensureType('WinForms', `Add-Type -AssemblyName System.Windows.Forms`);
    }
    executeViaExecSyncAsync(psScript, timeoutMs) {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');
            exec(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(stdout);
                }
            });
        });
    }
    async getMousePosition() {
        try {
            const winForms = this._winFormsInit();
            const psScript = `${winForms}
$pos = [System.Windows.Forms.Cursor]::Position
"$($pos.X),$($pos.Y)"`;
            const result = await this.executePs(psScript);
            const [x, y] = result.trim().split(',').map(Number);
            return { x, y };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取鼠标位置失败', error, 'SystemInput');
            return { x: 0, y: 0 };
        }
    }
    async moveMouse(x, y) {
        try {
            const winForms = this._winFormsInit();
            const psScript = `${winForms}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async click(x, y) {
        try {
            const typeDef = this._mouseClickTypeDef();
            const winForms = (x !== undefined && y !== undefined) ? this._winFormsInit() : '';
            let movePart = '';
            if (x !== undefined && y !== undefined) {
                movePart = `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 50`;
            }
            const psScript = `${typeDef}${winForms}
${movePart}
[MouseClick]::mouse_event([MouseClick]::LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::LEFTUP, 0, 0, 0, 0)`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async rightClick(x, y) {
        try {
            const typeDef = this._mouseClickTypeDef();
            const winForms = (x !== undefined && y !== undefined) ? this._winFormsInit() : '';
            let movePart = '';
            if (x !== undefined && y !== undefined) {
                movePart = `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 50`;
            }
            const psScript = `${typeDef}${winForms}
${movePart}
[MouseClick]::mouse_event([MouseClick]::RIGHTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::RIGHTUP, 0, 0, 0, 0)`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async doubleClick(x, y) {
        try {
            const typeDef = this._mouseClickTypeDef();
            const winForms = (x !== undefined && y !== undefined) ? this._winFormsInit() : '';
            let movePart = '';
            if (x !== undefined && y !== undefined) {
                movePart = `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 50`;
            }
            const psScript = `${typeDef}${winForms}
${movePart}
[MouseClick]::mouse_event([MouseClick]::LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 100
[MouseClick]::mouse_event([MouseClick]::LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::LEFTUP, 0, 0, 0, 0)`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async scroll(delta) {
        try {
            const typeDef = this._mouseClickTypeDef();
            const psScript = `${typeDef}
[MouseClick]::mouse_event([MouseClick]::WHEEL, 0, 0, ${delta}, 0)`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async drag(fromX, fromY, toX, toY) {
        try {
            const typeDef = this._mouseClickTypeDef();
            const winForms = this._winFormsInit();
            const psScript = `${typeDef}${winForms}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${fromX}, ${fromY})
Start-Sleep -Milliseconds 100
[MouseClick]::mouse_event([MouseClick]::LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 100
$steps = 20
$dx = (${toX} - ${fromX}) / $steps
$dy = (${toY} - ${fromY}) / $steps
for ($i = 1; $i -le $steps; $i++) {
  $nx = [int](${fromX} + $dx * $i)
  $ny = [int](${fromY} + $dy * $i)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($nx, $ny)
  Start-Sleep -Milliseconds 10
}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${toX}, ${toY})
Start-Sleep -Milliseconds 100
[MouseClick]::mouse_event([MouseClick]::LEFTUP, 0, 0, 0, 0)`;
            await this.executePs(psScript, 10000);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async keyPress(keyCode) {
        try {
            const typeDef = this._keyPressTypeDef();
            const psScript = `${typeDef}
[KeyPress]::keybd_event(${keyCode}, 0, [KeyPress]::KEYDOWN, 0)
Start-Sleep -Milliseconds 50
[KeyPress]::keybd_event(${keyCode}, 0, [KeyPress]::KEYUP, 0)`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async keyCombo(...keyCodes) {
        try {
            const typeDef = this._keyPressTypeDef();
            const downScript = keyCodes
                .map((k) => `[KeyPress]::keybd_event(${k}, 0, [KeyPress]::KEYDOWN, 0)\nStart-Sleep -Milliseconds 50`)
                .join('\n');
            const upScript = [...keyCodes]
                .reverse()
                .map((k) => `[KeyPress]::keybd_event(${k}, 0, [KeyPress]::KEYUP, 0)\nStart-Sleep -Milliseconds 50`)
                .join('\n');
            const psScript = `${typeDef}
${downScript}
${upScript}`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async typeText(text) {
        try {
            const escaped = text
                .replace(/\{/g, '{{')
                .replace(/\}/g, '}}')
                .replace(/\+/g, '{+}')
                .replace(/\^/g, '{^}')
                .replace(/%/g, '{%}')
                .replace(/~/g, '{~}')
                .replace(/\(/g, '{(}')
                .replace(/\)/g, '{)}')
                .replace(/"/g, '`"');
            const winForms = this._winFormsInit();
            const psScript = `${winForms}
[System.Windows.Forms.SendKeys]::SendWait("${escaped}")`;
            await this.executePs(psScript);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async shutdown() {
        if (this.psProcess && !this.psProcess.killed) {
            this.psProcess.stdin.write('exit\n');
            this.psProcess.kill();
            this.psProcess = null;
        }
        this._psTypesLoaded.clear();
        this.initialized = false;
        Logger_1.Logger.info('🖱️ SystemInput 已关闭', 'SystemInput');
    }
}
exports.SystemInput = SystemInput;
SystemInput.instance = null;
SystemInput.MAX_OUTPUT_BUFFER = 1024 * 1024;
SystemInput.Keys = {
    ENTER: 0x0d,
    ESCAPE: 0x1b,
    TAB: 0x09,
    SPACE: 0x20,
    BACKSPACE: 0x08,
    DELETE: 0x2e,
    UP: 0x26,
    DOWN: 0x28,
    LEFT: 0x25,
    RIGHT: 0x27,
    HOME: 0x24,
    END: 0x23,
    PAGE_UP: 0x21,
    PAGE_DOWN: 0x22,
    CTRL: 0x11,
    SHIFT: 0x10,
    ALT: 0x12,
    WIN: 0x5b,
    A: 0x41,
    B: 0x42,
    C: 0x43,
    D: 0x44,
    E: 0x45,
    F: 0x46,
    I: 0x49,
    N: 0x4e,
    R: 0x52,
    S: 0x53,
    V: 0x56,
    X: 0x58,
    Z: 0x5a,
    F1: 0x70,
    F2: 0x71,
    F3: 0x72,
    F4: 0x73,
    F5: 0x74,
    F6: 0x75,
    F7: 0x76,
    F8: 0x77,
    F9: 0x78,
    F10: 0x79,
    F11: 0x7a,
    F12: 0x7b,
};
exports.default = SystemInput;
