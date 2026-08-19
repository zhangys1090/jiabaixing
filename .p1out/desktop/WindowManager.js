"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowManager = void 0;
const child_process_1 = require("child_process");
const Logger_1 = require("../utils/Logger");
const SystemInput_1 = require("./SystemInput");
const WIN_API_ENUM_TYPE = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI_Enum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@`;
class WindowManager {
    constructor() {
        this.initialized = false;
        this.systemInput = SystemInput_1.SystemInput.getInstance();
    }
    static getInstance() {
        if (!WindowManager.instance) {
            WindowManager.instance = new WindowManager();
        }
        return WindowManager.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🪟 WindowManager 初始化', 'WindowManager');
        await this.systemInput.initialize();
        this.initialized = true;
    }
    _ensureType() {
        return this.systemInput._ensureType('WinAPI_Enum', WIN_API_ENUM_TYPE);
    }
    _ensureWinForms() {
        return this.systemInput._ensureType('WinForms', `Add-Type -AssemblyName System.Windows.Forms`);
    }
    async _executePs(psScript, timeoutMs = 10000) {
        try {
            return await this.systemInput.executePs(psScript, timeoutMs);
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 常驻PS执行失败，降级execSync: ${err.message}`, 'WindowManager');
            return (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', timeout: timeoutMs });
        }
    }
    async listWindows() {
        try {
            const typeDef = this._ensureType();
            const psScript = `${typeDef}
$windows = @()
$callback = {
  param([IntPtr]$hwnd, [IntPtr]$lParam)
  if ([WinAPI_Enum]::IsWindowVisible($hwnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinAPI_Enum]::GetWindowText($hwnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    if ($title -and $title.Trim()) {
      $rect = New-Object WinAPI_Enum+RECT
      [WinAPI_Enum]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
      $pid = 0
      [WinAPI_Enum]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
      $proc = try { (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName } catch { "" }
      $windows += [PSCustomObject]@{
        handle = $hwnd.ToInt64()
        title = $title
        processId = $pid
        processName = $proc
        x = $rect.Left
        y = $rect.Top
        width = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
        isMinimized = [WinAPI_Enum]::IsIconic($hwnd)
        isMaximized = [WinAPI_Enum]::IsZoomed($hwnd)
      }
    }
  }
  return $true
}
$delegate = [WinAPI_Enum+EnumWindowsProc]$callback
[WinAPI_Enum]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
$windows | ConvertTo-Json -Compress`;
            const result = await this._executePs(psScript, 10000);
            const output = (result ?? '').toString().trim();
            if (!output)
                return [];
            const windows = JSON.parse(output);
            const windowList = Array.isArray(windows) ? windows : [windows];
            Logger_1.Logger.info(`🪟 发现 ${windowList.length} 个窗口`, 'WindowManager');
            return windowList.map((w) => ({
                handle: w.handle,
                title: w.title || '',
                className: '',
                processName: w.processName || '',
                processId: w.processId || 0,
                bounds: {
                    x: w.x || 0,
                    y: w.y || 0,
                    width: w.width || 0,
                    height: w.height || 0,
                },
                isVisible: true,
                isMinimized: w.isMinimized || false,
                isMaximized: w.isMaximized || false,
                zOrder: 0,
            }));
        }
        catch (error) {
            Logger_1.Logger.error('❌ 枚举窗口失败', error, 'WindowManager');
            return [];
        }
    }
    async findWindow(titlePattern) {
        const windows = await this.listWindows();
        const pattern = new RegExp(titlePattern, 'i');
        return windows.find((w) => pattern.test(w.title)) || null;
    }
    async findWindowByProcess(processName) {
        const windows = await this.listWindows();
        return (windows.find((w) => w.processName.toLowerCase() === processName.toLowerCase()) || null);
    }
    async activateWindow(handle) {
        try {
            const typeDef = this._ensureType();
            const psScript = `${typeDef}
$hwnd = [IntPtr]::new(${handle})
if ([WinAPI_Enum]::IsIconic($hwnd)) {
  [WinAPI_Enum]::ShowWindow($hwnd, 9) | Out-Null
}
[WinAPI_Enum]::SetForegroundWindow($hwnd) | Out-Null`;
            await this._executePs(psScript, 5000);
            Logger_1.Logger.info(`🪟 窗口已激活: ${handle}`, 'WindowManager');
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 激活窗口失败', error, 'WindowManager');
            return { success: false, error: error.message };
        }
    }
    async activateWindowByTitle(title) {
        const window = await this.findWindow(title);
        if (!window) {
            return { success: false, error: `未找到窗口: ${title}` };
        }
        return this.activateWindow(window.handle);
    }
    async moveWindow(handle, x, y, width, height) {
        try {
            const typeDef = this._ensureType();
            const psScript = `${typeDef}
$hwnd = [IntPtr]::new(${handle})
[WinAPI_Enum]::MoveWindow($hwnd, ${x}, ${y}, ${width || 800}, ${height || 600}, $true) | Out-Null`;
            await this._executePs(psScript, 5000);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async maximizeWindow(handle) {
        try {
            const typeDef = this._ensureType();
            const psScript = `${typeDef}
$hwnd = [IntPtr]::new(${handle})
[WinAPI_Enum]::ShowWindow($hwnd, 3) | Out-Null`;
            await this._executePs(psScript, 5000);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async minimizeWindow(handle) {
        try {
            const typeDef = this._ensureType();
            const psScript = `${typeDef}
$hwnd = [IntPtr]::new(${handle})
[WinAPI_Enum]::ShowWindow($hwnd, 6) | Out-Null`;
            await this._executePs(psScript, 5000);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async closeWindow(handle) {
        try {
            const typeDef = this._ensureType();
            const psScript = `${typeDef}
$hwnd = [IntPtr]::new(${handle})
[WinAPI_Enum]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`;
            await this._executePs(psScript, 5000);
            Logger_1.Logger.info(`🪟 窗口已关闭: ${handle}`, 'WindowManager');
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 关闭窗口失败', error, 'WindowManager');
            return { success: false, error: error.message };
        }
    }
    async getForegroundWindow() {
        try {
            const typeDef = this._ensureType();
            const psScript = `${typeDef}
$hwnd = [WinAPI_Enum]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NULL"; exit 0 }
$sb = New-Object System.Text.StringBuilder 256
[WinAPI_Enum]::GetWindowText($hwnd, $sb, 256) | Out-Null
$title = $sb.ToString()
$rect = New-Object WinAPI_Enum+RECT
[WinAPI_Enum]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$pid = 0
[WinAPI_Enum]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$proc = try { (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName } catch { "" }
[PSCustomObject]@{
  handle = $hwnd.ToInt64()
  title = $title
  processId = $pid
  processName = $proc
  x = $rect.Left
  y = $rect.Top
  width = $rect.Right - $rect.Left
  height = $rect.Bottom - $rect.Top
  isMinimized = [WinAPI_Enum]::IsIconic($hwnd)
  isMaximized = [WinAPI_Enum]::IsZoomed($hwnd)
} | ConvertTo-Json -Compress`;
            const result = await this._executePs(psScript, 5000);
            const output = result.trim();
            if (!output || output === 'NULL')
                return null;
            const window = JSON.parse(output);
            if (!window || !window.handle)
                return null;
            return {
                handle: window.handle,
                title: window.title || '',
                className: '',
                processName: window.processName || '',
                processId: window.processId || 0,
                bounds: {
                    x: window.x || 0,
                    y: window.y || 0,
                    width: window.width || 0,
                    height: window.height || 0,
                },
                isVisible: true,
                isMinimized: window.isMinimized || false,
                isMaximized: window.isMaximized || false,
                zOrder: 0,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取前台窗口失败', error, 'WindowManager');
            return null;
        }
    }
    async getScreenSize() {
        try {
            const winForms = this._ensureWinForms();
            const psScript = `${winForms}
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
"$($screen.Bounds.Width),$($screen.Bounds.Height)"`;
            const result = await this._executePs(psScript, 5000);
            const [width, height] = result.trim().split(',').map(Number);
            return { width, height };
        }
        catch {
            return { width: 1920, height: 1080 };
        }
    }
    async shutdown() {
        this.initialized = false;
        Logger_1.Logger.info('🪟 WindowManager 已关闭', 'WindowManager');
    }
}
exports.WindowManager = WindowManager;
WindowManager.instance = null;
exports.default = WindowManager;
