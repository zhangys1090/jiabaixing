/**
 * SystemInput - 系统鼠标键盘控制
 * Windows 平台：通过 PowerShell + user32.dll SendInput API 实现
 * v3: 全异步 + 常驻 PowerShell 进程，所有操作走常驻进程避免 200-500ms 启动开销
 */

import { ChildProcess, spawn } from 'child_process';
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
  private psProcess: ChildProcess | null = null;
  private commandId: number = 0;
  private pendingCommands: Map<
    number,
    {
      resolve: (value: string) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  > = new Map();
  private outputBuffer: string = '';
  private usePersistentSession: boolean = true;
  private static readonly MAX_OUTPUT_BUFFER = 1024 * 1024;

  private constructor() {}

  public static create(): SystemInput {
    return new SystemInput();
  }

  public static getInstance(): SystemInput {
    if (!SystemInput.instance) {
      SystemInput.instance = SystemInput.create();
    }
    return SystemInput.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    Logger.info('🖱️ SystemInput 初始化', 'SystemInput');
    try {
      await this.startPersistentSession();
    } catch (err) {
      Logger.warn(
        `⚠️ 常驻PowerShell启动失败，降级为execSync: ${(err as Error).message}`,
        'SystemInput'
      );
      this.usePersistentSession = false;
    }
    this.initialized = true;
  }

  private async startPersistentSession(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.psProcess = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '-'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );

      let initBuffer = '';
      const initTimeout = setTimeout(() => {
        reject(new Error('PowerShell 初始化超时'));
      }, 10000);

      const onReady = (): void => {
        clearTimeout(initTimeout);
        Logger.info('🖱️ 常驻PowerShell进程已启动', 'SystemInput');
        resolve();
      };

      this.psProcess.stdout!.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (!this.initialized) {
          initBuffer += chunk;
          if (initBuffer.includes('__INIT_OK__')) {
            this.psProcess!.stdout!.removeListener('data', onReady);
            onReady();
            return;
          }
        }
        this.handleOutput(chunk);
      });

      this.psProcess.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          Logger.warn(`⚠️ PS stderr: ${msg.substring(0, 100)}`, 'SystemInput');
        }
      });

      this.psProcess.on('error', (err) => {
        Logger.error('❌ PowerShell进程错误', err, 'SystemInput');
        this.usePersistentSession = false;
        clearTimeout(initTimeout);
        reject(err);
      });

      this.psProcess.on('exit', (code) => {
        Logger.warn(`⚠️ PowerShell进程退出: code=${code}`, 'SystemInput');
        this.psProcess = null;
        this.usePersistentSession = false;
        for (const [id, pending] of this.pendingCommands) {
          clearTimeout(pending.timer);
          pending.reject(new Error('PowerShell进程已退出'));
          this.pendingCommands.delete(id);
        }
      });

      this.psProcess.stdin!.write("Write-Output '__INIT_OK__'\n");
    });
  }

  private handleOutput(chunk: string): void {
    this.outputBuffer += chunk;
    if (this.outputBuffer.length > SystemInput.MAX_OUTPUT_BUFFER) {
      this.outputBuffer = this.outputBuffer.substring(
        this.outputBuffer.length - SystemInput.MAX_OUTPUT_BUFFER / 2
      );
      Logger.warn('⚠️ PowerShell输出缓冲区接近上限，已截断', 'SystemInput');
    }
    const markerRegex = /__CMD_END_(\d+)__/g;
    let match: RegExpExecArray | null;
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

  private async executePs(
    psScript: string,
    timeoutMs: number = 5000
  ): Promise<string> {
    if (this.usePersistentSession && this.psProcess && !this.psProcess.killed) {
      return this.executeViaSession(psScript, timeoutMs);
    }
    return this.executeViaExecSyncAsync(psScript, timeoutMs);
  }

  private executeViaSession(
    psScript: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = ++this.commandId;
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`命令超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingCommands.set(id, { resolve, reject, timer });

      const wrappedScript = `${psScript}\nWrite-Output '__CMD_END_${id}__'\n`;
      this.psProcess!.stdin!.write(wrappedScript);
    });
  }

  private executeViaExecSyncAsync(
    psScript: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const { exec } =
        require('child_process') as typeof import('child_process');
      exec(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
        (err: Error | null, stdout: string) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  public async getMousePosition(): Promise<MousePosition> {
    try {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$pos = [System.Windows.Forms.Cursor]::Position
"$($pos.X),$($pos.Y)"
`;
      const result = await this.executePs(psScript);
      const [x, y] = result.trim().split(',').map(Number);
      return { x, y };
    } catch (error) {
      Logger.error('❌ 获取鼠标位置失败', error as Error, 'SystemInput');
      return { x: 0, y: 0 };
    }
  }

  public async moveMouse(x: number, y: number): Promise<InputResult> {
    try {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
`;
      await this.executePs(psScript);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  public async click(x?: number, y?: number): Promise<InputResult> {
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
      await this.executePs(psScript);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  public async rightClick(x?: number, y?: number): Promise<InputResult> {
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
      await this.executePs(psScript);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  public async scroll(delta: number): Promise<InputResult> {
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
      await this.executePs(psScript);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  public async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ): Promise<InputResult> {
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
      await this.executePs(psScript, 10000);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  public async keyPress(keyCode: number): Promise<InputResult> {
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
      await this.executePs(psScript);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  public async keyCombo(...keyCodes: number[]): Promise<InputResult> {
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
      await this.executePs(psScript);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  public async typeText(text: string): Promise<InputResult> {
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
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${escaped}")
`;
      await this.executePs(psScript);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

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
    if (this.psProcess && !this.psProcess.killed) {
      this.psProcess.stdin!.write('exit\n');
      this.psProcess.kill();
      this.psProcess = null;
    }
    this.initialized = false;
    Logger.info('🖱️ SystemInput 已关闭', 'SystemInput');
  }
}

export default SystemInput;
