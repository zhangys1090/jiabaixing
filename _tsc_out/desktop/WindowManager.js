"use strict";
/**
 * WindowManager - 窗口管理服务
 * Windows 平台：通过 PowerShell + user32.dll API 实现
 * 支持窗口枚举、激活、移动、调整大小、截图
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowManager = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
class WindowManager {
    static instance = null;
    initialized = false;
    constructor() { }
    static create() {
        return new WindowManager();
    }
    static getInstance() {
        if (!WindowManager.instance) {
            WindowManager.instance = WindowManager.create();
        }
        return WindowManager.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🪟 WindowManager 初始化', 'WindowManager');
        this.initialized = true;
    }
    /**
     * 枚举所有可见窗口
     */
    listWindows() {
        try {
            const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$windows = @()
$callback = {
  param([IntPtr]$hwnd, [IntPtr]$lParam)
  if ([WinAPI]::IsWindowVisible($hwnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    if ($title -and $title.Trim()) {
      $rect = New-Object WinAPI+RECT
      [WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
      $pid = 0
      [WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
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
        isMinimized = [WinAPI]::IsIconic($hwnd)
        isMaximized = [WinAPI]::IsZoomed($hwnd)
      }
    }
  }
  return $true
}
$delegate = [WinAPI+EnumWindowsProc]$callback
[WinAPI]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
$windows | ConvertTo-Json -Compress
`;
            const tmpDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir))
                fs.mkdirSync(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `jiabaixing_windows_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile, psScript, 'utf8');
            const result = (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { encoding: 'utf-8', timeout: 10000 });
            fs.unlinkSync(tmpFile);
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
    /**
     * 根据标题查找窗口
     */
    findWindow(titlePattern) {
        const windows = this.listWindows();
        const pattern = new RegExp(titlePattern, 'i');
        return windows.find((w) => pattern.test(w.title)) || null;
    }
    /**
     * 根据进程名查找窗口
     */
    findWindowByProcess(processName) {
        const windows = this.listWindows();
        return (windows.find((w) => w.processName.toLowerCase() === processName.toLowerCase()) || null);
    }
    /**
     * 激活窗口（前置）
     */
    activateWindow(handle) {
        try {
            const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$hwnd = [IntPtr]::new(${handle})
if ([WinAPI]::IsIconic($hwnd)) {
  [WinAPI]::ShowWindow($hwnd, 9) | Out-Null
}
[WinAPI]::SetForegroundWindow($hwnd) | Out-Null
`;
            const tmpDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir))
                fs.mkdirSync(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `jiabaixing_activate_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile, psScript, 'utf8');
            (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, {
                encoding: 'utf-8',
                timeout: 5000,
            });
            fs.unlinkSync(tmpFile);
            Logger_1.Logger.info(`🪟 窗口已激活: ${handle}`, 'WindowManager');
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 激活窗口失败', error, 'WindowManager');
            return { success: false, error: error.message };
        }
    }
    /**
     * 激活窗口（按标题）
     */
    activateWindowByTitle(title) {
        const window = this.findWindow(title);
        if (!window) {
            return { success: false, error: `未找到窗口: ${title}` };
        }
        return this.activateWindow(window.handle);
    }
    /**
     * 移动窗口
     */
    moveWindow(handle, x, y, width, height) {
        try {
            const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@
$hwnd = [IntPtr]::new(${handle})
[WinAPI]::MoveWindow($hwnd, ${x}, ${y}, ${width || 800}, ${height || 600}, $true) | Out-Null
`;
            const tmpDir2 = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir2))
                fs.mkdirSync(tmpDir2, { recursive: true });
            const tmpFile2 = path.join(tmpDir2, `jiabaixing_move_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile2, psScript, 'utf8');
            (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile2}"`, {
                encoding: 'utf-8',
                timeout: 5000,
            });
            fs.unlinkSync(tmpFile2);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    /**
     * 最大化窗口
     */
    maximizeWindow(handle) {
        try {
            const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$hwnd = [IntPtr]::new(${handle})
[WinAPI]::ShowWindow($hwnd, 3) | Out-Null
`;
            const tmpDir3 = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir3))
                fs.mkdirSync(tmpDir3, { recursive: true });
            const tmpFile3 = path.join(tmpDir3, `jiabaixing_max_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile3, psScript, 'utf8');
            (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile3}"`, {
                encoding: 'utf-8',
                timeout: 5000,
            });
            fs.unlinkSync(tmpFile3);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    /**
     * 最小化窗口
     */
    minimizeWindow(handle) {
        try {
            const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$hwnd = [IntPtr]::new(${handle})
[WinAPI]::ShowWindow($hwnd, 6) | Out-Null
`;
            const tmpDir4 = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir4))
                fs.mkdirSync(tmpDir4, { recursive: true });
            const tmpFile4 = path.join(tmpDir4, `jiabaixing_min_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile4, psScript, 'utf8');
            (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile4}"`, {
                encoding: 'utf-8',
                timeout: 5000,
            });
            fs.unlinkSync(tmpFile4);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    /**
     * 获取主显示器分辨率
     */
    /**
     * 获取当前前台窗口
     */
    getForegroundWindow() {
        try {
            const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hwnd = [WinAPI]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { return $null }
$sb = New-Object System.Text.StringBuilder 256
[WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
$title = $sb.ToString()
$rect = New-Object WinAPI+RECT
[WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$pid = 0
[WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
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
  isMinimized = [WinAPI]::IsIconic($hwnd)
  isMaximized = [WinAPI]::IsZoomed($hwnd)
} | ConvertTo-Json -Compress
`;
            const tmpDir5 = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir5))
                fs.mkdirSync(tmpDir5, { recursive: true });
            const tmpFile5 = path.join(tmpDir5, `jiabaixing_fg_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile5, psScript, 'utf8');
            const result = (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile5}"`, { encoding: 'utf-8', timeout: 5000 });
            fs.unlinkSync(tmpFile5);
            const window = JSON.parse(result.trim());
            if (!window || !window.handle)
                return null;
            return {
                handle: window._handle,
                title: window._title || '',
                className: '',
                processName: window._processName || '',
                processId: window._processId || 0,
                bounds: {
                    x: window.x || 0,
                    y: window.y || 0,
                    width: window.width || 0,
                    height: window.height || 0,
                },
                isVisible: true,
                isMinimized: window._isMinimized || false,
                isMaximized: window._isMaximized || false,
                zOrder: 0,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取前台窗口失败', error, 'WindowManager');
            return null;
        }
    }
    getScreenSize() {
        try {
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
"$($screen.Bounds.Width),$($screen.Bounds.Height)"
`;
            const tmpDir6 = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir6))
                fs.mkdirSync(tmpDir6, { recursive: true });
            const tmpFile6 = path.join(tmpDir6, `jiabaixing_screen_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile6, psScript, 'utf8');
            const result = (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile6}"`, { encoding: 'utf-8', timeout: 5000 });
            fs.unlinkSync(tmpFile6);
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
exports.default = WindowManager;
