/**
 * SystemInput - 系统鼠标键盘控制
 * Windows 平台：通过 PowerShell + user32.dll SendInput API 实现
 * 支持鼠标移动、点击、滚轮，键盘按键、输入文字
 */

import { execSync } from 'child_process';
import { Logger } from '../utils/Logger';

export interface MousePosition {
  x: number;
  y: number;
}

export interface InputResult {
  success: boolean;
  error?: string;
}

export class SystemInput {
  private static instance: SystemInput | null = null;
  private initialized: boolean = false;

  private constructor() {}

  public static getInstance(): SystemInput {
    if (!SystemInput.instance) {
      SystemInput.instance = new SystemInput();
    }
    return SystemInput.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    Logger.info('🖱️ SystemInput 初始化', 'SystemInput');
    this.initialized = true;
  }

  /**
   * 获取当前鼠标位置
   */
  public getMousePosition(): MousePosition {
    try {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$pos = [System.Windows.Forms.Cursor]::Position
"$($pos.X),$($pos.Y)"
`;
      const result = execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      const [x, y] = result.trim().split(',').map(Number);
      return { x, y };
    } catch (error) {
      Logger.error('❌ 获取鼠标位置失败', error as Error, 'SystemInput');
      return { x: 0, y: 0 };
    }
  }

  /**
   * 移动鼠标到指定位置
   */
  public moveMouse(x: number, y: number): InputResult {
    try {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
`;
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 鼠标左键单击
   */
  public click(x?: number, y?: number): InputResult {
    try {
      let psScript = '';
      if (x !== undefined && y !== undefined) {
        psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 50
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClick {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint LEFTDOWN = 0x02;
  public const uint LEFTUP = 0x04;
}
"@
[MouseClick]::mouse_event([MouseClick]::LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::LEFTUP, 0, 0, 0, 0)
`;
      } else {
        psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClick {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint LEFTDOWN = 0x02;
  public const uint LEFTUP = 0x04;
}
"@
[MouseClick]::mouse_event([MouseClick]::LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::LEFTUP, 0, 0, 0, 0)
`;
      }
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 鼠标右键单击
   */
  public rightClick(x?: number, y?: number): InputResult {
    try {
      let psScript = '';
      if (x !== undefined && y !== undefined) {
        psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 50
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClick {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint RIGHTDOWN = 0x08;
  public const uint RIGHTUP = 0x10;
}
"@
[MouseClick]::mouse_event([MouseClick]::RIGHTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::RIGHTUP, 0, 0, 0, 0)
`;
      } else {
        psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClick {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint RIGHTDOWN = 0x08;
  public const uint RIGHTUP = 0x10;
}
"@
[MouseClick]::mouse_event([MouseClick]::RIGHTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event([MouseClick]::RIGHTUP, 0, 0, 0, 0)
`;
      }
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 鼠标滚轮滚动
   */
  public scroll(delta: number): InputResult {
    try {
      const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseScroll {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint WHEEL = 0x800;
}
"@
[MouseScroll]::mouse_event([MouseScroll]::WHEEL, 0, 0, ${delta}, 0)
`;
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 拖拽操作
   */
  public drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ): InputResult {
    try {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseDrag {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint LEFTDOWN = 0x02;
  public const uint LEFTUP = 0x04;
}
"@
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${fromX}, ${fromY})
Start-Sleep -Milliseconds 100
[MouseDrag]::mouse_event([MouseDrag]::LEFTDOWN, 0, 0, 0, 0)
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
[MouseDrag]::mouse_event([MouseDrag]::LEFTUP, 0, 0, 0, 0)
`;
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 15000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 键盘按键（单键）
   */
  public keyPress(keyCode: number): InputResult {
    try {
      const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyPress {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
  public const uint KEYDOWN = 0x00;
  public const uint KEYUP = 0x02;
}
"@
[KeyPress]::keybd_event(${keyCode}, 0, [KeyPress]::KEYDOWN, 0)
Start-Sleep -Milliseconds 50
[KeyPress]::keybd_event(${keyCode}, 0, [KeyPress]::KEYUP, 0)
`;
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 键盘组合键
   */
  public keyCombo(...keyCodes: number[]): InputResult {
    try {
      const downScript = keyCodes
        .map(
          (k) =>
            `[KeyPress]::keybd_event(${k}, 0, [KeyPress]::KEYDOWN, 0)\nStart-Sleep -Milliseconds 50`
        )
        .join('\n');
      const upScript = [...keyCodes]
        .reverse()
        .map(
          (k) =>
            `[KeyPress]::keybd_event(${k}, 0, [KeyPress]::KEYUP, 0)\nStart-Sleep -Milliseconds 50`
        )
        .join('\n');

      const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyPress {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
  public const uint KEYDOWN = 0x00;
  public const uint KEYUP = 0x02;
}
"@
${downScript}
${upScript}
`;
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 10000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 输入文字（模拟键盘输入）
   */
  public typeText(text: string): InputResult {
    try {
      const escaped = text.replace(/"/g, '`"').replace(/\\/g, '\\\\');
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${escaped}")
`;
      execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\"')}"`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 常用按键码
   */
  public static readonly Keys = {
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
    C: 0x43,
    V: 0x56,
    X: 0x58,
    Z: 0x5a,
    F5: 0x74,
    F11: 0x7a,
  };

  public async shutdown(): Promise<void> {
    this.initialized = false;
    Logger.info('🖱️ SystemInput 已关闭', 'SystemInput');
  }
}

export default SystemInput;
