import * as path from 'path';
import * as fs from 'fs';
import { IntegrationManager } from '../integration/IntegrationManager';
import { GatewayBridge } from '../integration/GatewayBridge';
import { Logger } from '../utils/Logger';
import { backendUrl, COLORS, SHELL_COMMANDS } from './constants';
import { ipcSend } from './ipc';

/**
 * 检测输入是否为 Shell 命令
 * @param input - 用户输入
 * @returns 识别到的 Shell 命令名，或 null
 */
export function detectShellCommand(input: string): string | null {
  const firstWord = input.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return null;
  if (SHELL_COMMANDS.includes(firstWord)) return firstWord;
  if (/^[a-zA-Z]:\\/.test(firstWord)) return 'path';
  if (
    firstWord.endsWith('.exe') ||
    firstWord.endsWith('.cmd') ||
    firstWord.endsWith('.bat')
  )
    return firstWord;
  return null;
}

/**
 * 获取集成管理器实例（GatewayBridge 优先）
 * @returns IntegrationManager 或 GatewayBridge 实例
 */
export function getIM(): IntegrationManager | GatewayBridge {
  const bridge = GatewayBridge.getInstance();
  if (bridge.isWorkerAlive()) return bridge;
  return IntegrationManager.getInstance();
}

/**
 * 检查后端服务健康状态
 * 优先通过 IPC 获取，降级到 HTTP
 * @returns 健康状态信息
 */
export async function checkBackendHealth(): Promise<{
  online: boolean;
  status?: string;
  uptime?: number;
  model?: string;
  llm?: { available: boolean; message?: string };
  services?: Record<string, unknown>;
}> {
  // 优先尝试 IPC 获取状态
  try {
    const ipcResult = await ipcSend('status');
    const data = ipcResult as Record<string, unknown>;
    if (data && data.initialized) {
      return {
        online: true,
        status: 'healthy',
        uptime: data.uptime as number,
        model: process.env.LLM_MODEL || 'deepseek-chat',
        llm: data.llm as { available: boolean; message?: string } | undefined,
      };
    }
  } catch {
    Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
  }

  try {
    const res = await fetch(`${backendUrl}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as Record<string, unknown>;
    const status = data.status as string;
    const online = status === 'healthy' || status === 'degraded';
    return {
      online,
      status,
      uptime: data.uptime as number,
      model: data.model as string,
      llm: data.llm as { available: boolean; message?: string } | undefined,
      services: data.services as Record<string, unknown>,
    };
  } catch {
    return { online: false };
  }
}

/**
 * 从参数列表中解析 --json / --quiet 等全局选项
 * @param args - 原始参数列表
 * @returns 分离后的 { positional, options }
 */
export function parseGlobalOptions(args: string[]): {
  positional: string[];
  options: import('./types').SubcommandOptions;
} {
  const positional: string[] = [];
  const options: import('./types').SubcommandOptions = {
    json: false,
    quiet: false,
  };
  for (const arg of args) {
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

/**
 * 去除文本中的 ANSI 颜色码，用于管道模式纯文本输出
 * @param text - 含 ANSI 码的文本
 * @returns 纯文本
 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 获取项目目录下的 .env 文件路径 */
export function getEnvFilePath(): string {
  return path.join(process.cwd(), '.env');
}

/** 读取 .env 文件内容，隐藏敏感字段 */
export function readEnvFileSafe(envFile: string): string[] {
  if (!fs.existsSync(envFile)) return [];
  const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    if (
      trimmed.includes('KEY=') ||
      trimmed.includes('SECRET=') ||
      trimmed.includes('VERIFY_KEY=')
    ) {
      const [key] = trimmed.split('=');
      return `${key}=****`;
    }
    return trimmed;
  });
}

/** 获取 Git 状态信息 */
export function getGitStatus(dirs: string[]): string[] {
  const results: string[] = [];
  for (const dir of dirs) {
    try {
      const gitDir = path.join(dir, '.git');
      if (!fs.existsSync(gitDir)) continue;
      const { execSync } = require('child_process') as {
        execSync: (cmd: string, opts?: Record<string, unknown>) => Buffer;
      };
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: dir,
        timeout: 3000,
        encoding: 'utf-8',
      })
        .toString()
        .trim();
      const status = execSync('git status --porcelain', {
        cwd: dir,
        timeout: 3000,
        encoding: 'utf-8',
      })
        .toString()
        .trim();
      const uncommitted = status
        ? status.split('\n').filter((l: string) => l).length
        : 0;
      const lastMsg = execSync('git log -1 --format=%s', {
        cwd: dir,
        timeout: 3000,
        encoding: 'utf-8',
      })
        .toString()
        .trim();
      const name = path.basename(dir);
      results.push(JSON.stringify({ name, branch, uncommitted, lastMsg, dir }));
    } catch {
      /* 跳过非git目录 */
    }
  }
  return results;
}

/**
 * 获取前台窗口信息（仅 Windows）
 * @returns 进程名和窗口标题，或 null
 */
export function getForegroundWindowInfo(): {
  proc: string;
  title: string;
} | null {
  try {
    const { execSync } = require('child_process') as {
      execSync: (cmd: string, opts?: Record<string, unknown>) => Buffer;
    };
    const psCmd = `powershell -Command "Add-Type @\\\"using System;using System.Runtime.InteropServices;using System.Text;public class W { [DllImport(\\\"user32.dll\\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\\"user32.dll\\\")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder lpString,int nMaxCount);[DllImport(\\\"user32.dll\\\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint lpdwProcessId);} \\\";$h=[W]::GetForegroundWindow();$s=New-Object Text.StringBuilder 256;[W]::GetWindowText($h,$s,256)|Out-Null;$p=0;[W]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;$t=$s.ToString();$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;Write-Output \\\"$n|$t\\\""`;
    const result = execSync(psCmd, { timeout: 5000, encoding: 'utf-8' })
      .toString()
      .trim();
    const parts = result.split('|');
    if (parts.length >= 2 && parts[0]) {
      return {
        proc: parts[0],
        title: parts.slice(1).join('|'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 根据窗口标题和进程名判断环境类型
 * @param title - 窗口标题
 * @param proc - 进程名
 * @returns 环境类型描述
 */
export function detectEnvironmentType(title: string, proc: string): string {
  const t = title.toLowerCase();
  const p = proc.toLowerCase();
  if (
    t.includes('code') ||
    t.includes('vscode') ||
    p.includes('code') ||
    t.includes('terminal') ||
    p.includes('terminal') ||
    p.includes('cmd') ||
    p.includes('powershell') ||
    p.includes('bash') ||
    t.includes('cursor')
  ) {
    return `${COLORS.green}💻 编程${COLORS.reset}`;
  }
  if (
    p.includes('chrome') ||
    p.includes('edge') ||
    p.includes('firefox') ||
    p.includes('explorer')
  ) {
    return `${COLORS.yellow}🌐 浏览${COLORS.reset}`;
  }
  return `${COLORS.dim}其他${COLORS.reset}`;
}
