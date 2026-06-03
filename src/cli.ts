import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { IntegrationManager } from './integration/IntegrationManager';
import { GatewayBridge } from './integration/GatewayBridge';
import { EventBus } from './shared/EventBus';
import { DaemonManager } from './daemon/DaemonManager';
import { Logger } from './utils/Logger';

const backendPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3111;
const backendUrl = `http://localhost:${backendPort}`;

/**
 * 获取 IPC 端点路径
 * Windows 使用 Named Pipe，Linux/macOS 使用 Unix Domain Socket
 * 可通过环境变量 IPC_PATH 覆盖默认路径
 * @returns IPC 端点路径
 */
function getIpcPath(): string {
  if (process.env.IPC_PATH) {
    return process.env.IPC_PATH;
  }
  const isWindows = process.platform === 'win32';
  return isWindows ? '\\\\.\\pipe\\jiabaixing' : '/tmp/jiabaixing.sock';
}

/** IPC 请求超时时间（毫秒） */
const IPC_TIMEOUT_MS = 5000;

/**
 * 通用请求函数：优先尝试 IPC，失败时降级到 HTTP
 * @param ipcMethod - IPC 方法名
 * @param ipcParams - IPC 参数
 * @param httpOptions - HTTP 选项
 * @returns 请求结果
 */
async function requestWithFallback<T>(
  ipcMethod: string,
  ipcParams: Record<string, unknown> = {},
  httpOptions: {
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: Record<string, unknown>;
    timeout?: number;
  }
): Promise<T> {
  // 优先尝试 IPC
  try {
    const ipcResult = await ipcSend(ipcMethod, ipcParams);
    return ipcResult as T;
  } catch {
    // IPC 不可用，降级到 HTTP
  }

  // HTTP 请求
  const { path, method = 'GET', body, timeout = 60000 } = httpOptions;
  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  return (await res.json()) as T;
}

/**
 * 通过 IPC 发送请求到 jiabaixing 服务端
 * 使用 JSON Lines 协议通信，比 HTTP 更快（无 HTTP 开销）
 * @param method - 要调用的方法名
 * @param params - 方法参数
 * @returns 服务端返回的 result 字段，或抛出错误
 */
async function ipcSend(
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const ipcPath = getIpcPath();
  let requestId = 0;

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(ipcPath, () => {
      requestId++;
      const request = JSON.stringify({ id: requestId, method, params }) + '\n';
      socket.write(request);
    });

    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('IPC 连接超时'));
    }, IPC_TIMEOUT_MS);

    socket.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const response = JSON.parse(trimmed) as {
            id: number;
            result?: unknown;
            error?: { code: number; message: string };
          };

          clearTimeout(timer);

          if (response.error) {
            socket.destroy();
            reject(new Error(response.error.message));
          } else {
            socket.destroy();
            resolve(response.result);
          }
        } catch {
          // 解析失败，继续等待完整数据
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      reject(new Error('IPC 连接不可用'));
    });

    socket.on('close', () => {
      clearTimeout(timer);
    });
  });
}

/**
 * 检测 IPC 服务是否可用
 * 通过发送 ping 请求验证连接
 * @returns true 表示 IPC 可用
 */
async function isIpcAvailable(): Promise<boolean> {
  try {
    await ipcSend('ping');
    return true;
  } catch {
    return false;
  }
}

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function c(color: string, text: string): string {
  return `${color}${text}${COLORS.reset}`;
}

const BANNER = `
${COLORS.cyan}  ╔════════════════(COLORS.reset${COLORS.cyan}══════════════════════════════════╗${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}                                                  ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}   ${COLORS.bold}${COLORS.magenta}✦${COLORS.reset} ${COLORS.bold}Jiabaixing${COLORS.reset} ${COLORS.dim}v5.0${COLORS.reset}  ·  AI Agent Framework     ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}      ${COLORS.dim}REPL Mode  ·  Continuous Interaction${COLORS.reset}       ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}                                                  ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ╚════════════════${COLORS.reset}${COLORS.cyan}══════════════════════════════════╝${COLORS.reset}
`;

const HELP_TEXT = `
${COLORS.bold}  可用命令:${COLORS.reset}

  ${COLORS.cyan}/help${COLORS.reset}        显示此帮助信息
  ${COLORS.cyan}/status${COLORS.reset}      查看系统运行状态
  ${COLORS.cyan}/model${COLORS.reset}       查看当前模型
  ${COLORS.cyan}/skills${COLORS.reset}      查看技能列表
  ${COLORS.cyan}/memory${COLORS.reset}      查看记忆统计
  ${COLORS.cyan}/evolution${COLORS.reset}   查看进化数据
  ${COLORS.cyan}/env${COLORS.reset}        查看桌面环境
  ${COLORS.cyan}/chat${COLORS.reset}        进入聊天模式（默认）
  ${COLORS.cyan}/gateway${COLORS.reset}     网关配置（微信/QQ/飞书/钉钉）
  ${COLORS.cyan}/schedule${COLORS.reset}    定时任务与自动化管理
  ${COLORS.cyan}/config${COLORS.reset}      系统配置管理
  ${COLORS.cyan}/daemon${COLORS.reset}      后台常驻服务管理
  ${COLORS.cyan}/web${COLORS.reset}         打开前端界面
  ${COLORS.cyan}/demo${COLORS.reset}        演示命令（研究/分析/自动化）
  ${COLORS.cyan}/clear${COLORS.reset}       清屏
  ${COLORS.cyan}/quit${COLORS.reset}        退出程序

  ${COLORS.dim}直接输入文字即可与 AI 对话${COLORS.reset}
  ${COLORS.dim}Ctrl+C 中断当前请求  ·  Ctrl+D 退出${COLORS.reset}
`;

const COMMANDS = [
  '/daemon',
  '/help',
  '/status',
  '/model',
  '/skills',
  '/memory',
  '/evolution',
  '/env',
  '/chat',
  '/gateway',
  '/schedule',
  '/config',
  '/web',
  '/demo',
  '/clear',
  '/quit',
  '/exit',
];

const SHELL_COMMANDS = [
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'node',
  'ts-node',
  'tsx',
  'deno',
  'cd',
  'dir',
  'ls',
  'pwd',
  'mkdir',
  'rmdir',
  'rm',
  'cp',
  'mv',
  'cat',
  'type',
  'echo',
  'head',
  'tail',
  'less',
  'more',
  'git',
  'docker',
  'kubectl',
  'python',
  'python3',
  'pip',
  'pip3',
  'java',
  'javac',
  'mvn',
  'gradle',
  'go',
  'cargo',
  'rustc',
  'ping',
  'curl',
  'wget',
  'ssh',
  'scp',
  'taskkill',
  'netstat',
  'ipconfig',
  'ifconfig',
  'cls',
  'clear',
  'exit',
  'code',
  'vim',
  'nano',
  'notepad',
  'start',
];

function detectShellCommand(input: string): string | null {
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

class ReplState {
  history: string[] = [];
  historyIndex: number = -1;
  inputBuffer: string = '';
  startTime: number = Date.now();
  aborted: boolean = false;

  pushHistory(line: string): void {
    if (line && line !== this.history[this.history.length - 1]) {
      this.history.push(line);
      if (this.history.length > 500) this.history.shift();
    }
    this.historyIndex = this.history.length;
  }

  getUptime(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
}

let currentReplState: ReplState | null = null;

function getIM(): IntegrationManager | GatewayBridge {
  const bridge = GatewayBridge.getInstance();
  if (bridge.isWorkerAlive()) return bridge;
  return IntegrationManager.getInstance();
}

async function checkBackendHealth(): Promise<{
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
    // IPC 不可用，降级到 HTTP
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

function printStatusBar(health: { online: boolean; status?: string }): void {
  const connIcon = health.online ? c(COLORS.green, '●') : c(COLORS.red, '○');
  const connText = health.online
    ? c(COLORS.green, 'connected')
    : c(COLORS.red, 'disconnected');
  const uptime = currentReplState?.getUptime() || '0s';
  console.log(
    `${COLORS.dim}  ──────────────────────────────────────────────────────${COLORS.reset}\n` +
      `  ${connIcon} ${connText}  ${COLORS.dim}|${COLORS.reset}  ${backendUrl}  ${COLORS.dim}|${COLORS.reset}  uptime: ${uptime}  ${COLORS.dim}|${COLORS.reset}  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}\n` +
      `${COLORS.dim}  ──────────────────────────────────────────────────────${COLORS.reset}`
  );
}

function formatResponse(text: string): string {
  let result = text;
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    return `\n  ${COLORS.dim}┌─ ${lang || 'code'} ───────────────────────────────────${COLORS.reset}\n${code
      .split('\n')
      .map((l: string) => `  ${l}`)
      .join(
        '\n'
      )}\n  ${COLORS.dim}└────────────────────────────────────────────┘${COLORS.reset}`;
  });
  result = result.replace(/\*\*(.*?)\*\*/g, `${COLORS.bold}$1${COLORS.reset}`);
  result = result.replace(/`(.*?)`/g, `${COLORS.cyan}$1${COLORS.reset}`);
  return result
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function printThinking(): void {
  process.stdout.write(
    `\n  ${COLORS.dim}${COLORS.yellow}◌ 思考中...${COLORS.reset}`
  );
}

function clearThinking(): void {
  process.stdout.write(`\r${' '.repeat(40)}\r`);
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function sendChatMessage(input: string): Promise<string> {
  printThinking();
  try {
    // 优先尝试 IPC 通信（更快，无 HTTP 开销）
    try {
      const ipcResult = await ipcSend('process', { input });
      clearThinking();
      if (typeof ipcResult === 'string') {
        return ipcResult;
      }
      const data = ipcResult as Record<string, unknown>;
      return (data.response ||
        data.message ||
        data.text ||
        JSON.stringify(data)) as string;
    } catch {
      // IPC 不可用，降级到 HTTP
    }

    const res = await fetch(`${backendUrl}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(60000),
    });
    clearThinking();
    const data = (await res.json()) as Record<string, unknown>;
    return (data.response ||
      data.message ||
      data.text ||
      JSON.stringify(data)) as string;
  } catch (err) {
    clearThinking();
    if ((err as Error).name === 'AbortError') throw new Error('请求超时');
    throw err;
  }
}

async function handleStatusCommand(): Promise<void> {
  const health = await checkBackendHealth();
  console.log(`\n  ${COLORS.bold}系统状态${COLORS.reset}\n`);
  console.log(
    `  后端服务: ${health.online ? c(COLORS.green, '🟢 在线') : c(COLORS.red, '🔴 离线')}`
  );
  console.log(`  健康状态: ${health.status || 'unknown'}`);
  if (health.uptime) {
    console.log(`  运行时间: ${Math.round(health.uptime / 60)} 分钟`);
  }
  if (health.services) {
    console.log(`\n  ${COLORS.dim}服务组件:${COLORS.reset}`);
    for (const [name, svc] of Object.entries(health.services)) {
      const info = svc as { status?: string; message?: string };
      const mark =
        info.status === 'ok' ? c(COLORS.green, '🟢') : c(COLORS.red, '🔴');
      console.log(`    ${mark} ${name}: ${info.message || info.status || '-'}`);
    }
  }

  const im = getIM();
  const platforms = im.getPlatforms();
  if (platforms.length > 0) {
    console.log(`\n  ${COLORS.dim}平台连接:${COLORS.reset}`);
    for (const p of platforms) {
      const s = (p.status?.status as string) || 'disconnected';
      const mark =
        s === 'connected'
          ? '🟢'
          : s === 'connecting'
            ? '🟡'
            : s === 'error'
              ? '🔴'
              : '⚪';
      console.log(`    ${mark} ${p.icon} ${p.name}: ${s}`);
    }
  }
  console.log();
}

async function handleModelCommand(): Promise<void> {
  const health = await checkBackendHealth();
  console.log(`\n  ${COLORS.bold}当前模型${COLORS.reset}\n`);
  console.log(`  模型: ${health.model || 'deepseek-chat'}`);
  console.log(
    `  LLM: ${health.llm?.available ? c(COLORS.green, '✅ 可用') : c(COLORS.red, '❌ 不可用')}`
  );
  if (health.llm?.message) console.log(`  信息: ${health.llm.message}`);
  console.log();
}

async function handleSkillsCommand(): Promise<void> {
  try {
    let data: {
      skills?: Array<{ name: string; description: string; category: string }>;
      count?: number;
    };

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('skill.list');
      data = ipcResult as {
        skills?: Array<{ name: string; description: string; category: string }>;
        count?: number;
      };
    } catch {
      // IPC 不可用，降级到 HTTP
      const resp = await fetch(`${backendUrl}/api/skills/list`);
      data = (await resp.json()) as {
        skills?: Array<{ name: string; description: string; category: string }>;
        count?: number;
      };
    }

    console.log(
      `\n  ${COLORS.bold}技能列表 (${data.count || 0})${COLORS.reset}\n`
    );
    if (data.skills) {
      for (const skill of data.skills) {
        console.log(
          `  ${COLORS.cyan}■${COLORS.reset} ${COLORS.bold}${skill.name}${COLORS.reset}`
        );
        console.log(
          `    ${COLORS.dim}${skill.description.substring(0, 80)}${skill.description.length > 80 ? '...' : ''}${COLORS.reset}`
        );
        console.log(
          `    ${COLORS.yellow}分类: ${skill.category}${COLORS.reset}\n`
        );
      }
    }
  } catch {
    console.log(`  ${c(COLORS.red, '❌ 获取技能列表失败')}`);
  }
  console.log();
}

async function handleMemoryCommand(): Promise<void> {
  try {
    let data: {
      data?: {
        totalMemories?: number;
        shortTermSize?: number;
        dbPath?: string;
      };
    };

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('memory.stats');
      data = ipcResult as typeof data;
    } catch {
      // IPC 不可用，降级到 HTTP
      const resp = await fetch(`${backendUrl}/api/memory/stats`);
      data = (await resp.json()) as typeof data;
    }

    console.log(`\n  ${COLORS.bold}记忆统计${COLORS.reset}\n`);
    if (data.data) {
      console.log(`  记忆条数: ${data.data.totalMemories || 0}`);
      console.log(`  短期记忆: ${data.data.shortTermSize || 0} 字节`);
      if (data.data.dbPath) console.log(`  数据库: ${data.data.dbPath}`);
    } else {
      console.log(`  ${COLORS.dim}无记忆数据${COLORS.reset}`);
    }
  } catch {
    console.log(`  ${c(COLORS.red, '❌ 获取记忆统计失败')}`);
  }
  console.log();
}

async function handleEvolutionCommand(): Promise<void> {
  try {
    let data: {
      orchestrator?: {
        totalInteractions?: number;
        totalOptimizations?: number;
        averageQualityScore?: number;
        qualityTrend?: string;
        failureRate?: number;
        cyclesToday?: number;
        totalCycles?: number;
        userProfileConfidence?: number;
        lastCycleTime?: number;
      };
      enginesActive?: string[];
    };

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('evolution.status');
      data = ipcResult as typeof data;
    } catch {
      // IPC 不可用，降级到 HTTP
      const resp = await fetch(`${backendUrl}/api/evolution/status`);
      data = (await resp.json()) as typeof data;
    }

    console.log(`\n  ${COLORS.bold}进化数据${COLORS.reset}\n`);
    if (data.orchestrator) {
      const o = data.orchestrator;
      console.log(`  交互: ${o.totalInteractions || 0} 次`);
      console.log(`  优化: ${o.totalOptimizations || 0} 次`);
      console.log(`  平均质量: ${(o.averageQualityScore || 0).toFixed(3)}`);
      console.log(`  趋势: ${o.qualityTrend || 'stable'}`);
      console.log(`  失败率: ${((o.failureRate || 0) * 100).toFixed(1)}%`);
      console.log(`  今日周期: ${o.cyclesToday || 0}`);
      console.log(`  总周期: ${o.totalCycles || 0}`);
      if (o.lastCycleTime) {
        const ago = Math.round((Date.now() - o.lastCycleTime) / 60000);
        console.log(`  上次优化: ${ago} 分钟前`);
      }
      if (o.userProfileConfidence) {
        console.log(
          `  画像置信度: ${(o.userProfileConfidence * 100).toFixed(0)}%`
        );
      }
    } else {
      console.log(`  ${COLORS.dim}进化引擎未启动${COLORS.reset}`);
    }
    if (data.enginesActive?.length) {
      console.log(`  活跃引擎: ${data.enginesActive.join(', ')}`);
    }

    // 额外获取优化结果详情
    try {
      const metricsResp = await fetch(`${backendUrl}/api/evolution/metrics`);
      const metricsData = (await metricsResp.json()) as {
        data?: {
          optimizationHistory?: Array<{
            id: string;
            reason: string;
            toneAdjustments: Array<unknown>;
            skillAdjustments: Array<unknown>;
            promptExamples: Array<unknown>;
          }>;
        };
      };
      const history = metricsData.data?.optimizationHistory;
      if (history && history.length > 0) {
        console.log(`\n  ${COLORS.dim}最近优化:${COLORS.reset}`);
        for (const h of history.slice(-3)) {
          const tone = h.toneAdjustments?.length || 0;
          const skill = h.skillAdjustments?.length || 0;
          const prompt = h.promptExamples?.length || 0;
          console.log(
            `    ${COLORS.cyan}●${COLORS.reset} ${h.reason.substring(0, 40)} → 语气${tone} 技能${skill} 示例${prompt}`
          );
        }
      }
    } catch {
      /* ignore */
    }
  } catch {
    console.log(`  ${c(COLORS.red, '❌ 获取进化数据失败')}`);
  }
  console.log();
}

async function handleGatewayStatus(): Promise<void> {
  const im = getIM();
  const platforms = im.getPlatforms();
  console.log(`\n  ${COLORS.bold}网关状态${COLORS.reset}\n`);
  if (platforms.length === 0) {
    console.log(`  ${COLORS.dim}未配置任何平台连接${COLORS.reset}`);
  } else {
    console.log(`  已配置 ${platforms.length} 个平台:\n`);
    for (const p of platforms) {
      const s = (p.status?.status as string) || 'disconnected';
      const mark =
        s === 'connected'
          ? '🟢'
          : s === 'connecting'
            ? '🟡'
            : s === 'error'
              ? '🔴'
              : '⚪';
      const statusText =
        s === 'connected'
          ? c(COLORS.green, '已连接')
          : s === 'connecting'
            ? c(COLORS.yellow, '连接中')
            : s === 'error'
              ? c(COLORS.red, '错误')
              : c(COLORS.dim, '未连接');
      console.log(`    ${mark} ${p.icon} ${p.name}: ${statusText}`);
    }
  }
  console.log(
    `\n  输入 ${COLORS.cyan}/gateway menu${COLORS.reset} 进入配置菜单`
  );
  console.log();
}

async function handleEnvCommand(): Promise<void> {
  try {
    let health: Record<string, unknown>;

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('status');
      health = ipcResult as Record<string, unknown>;
    } catch {
      // IPC 不可用，降级到 HTTP
      const resp = await fetch(`${backendUrl}/api/health`);
      health = await resp.json();
    }

    console.log(`\n  ${COLORS.bold}桌面环境${COLORS.reset}\n`);
    console.log(`  后端: ${health.status}`);
    console.log(`  模型: ${health.model}`);
    console.log(`  运行: ${Math.round((health.uptime as number) / 60)} 分钟\n`);

    // 尝试获取前台窗口信息（通过 PowerShell）
    try {
      const { execSync } = require('child_process');
      const psCmd = `powershell -Command "Add-Type @\\\"using System;using System.Runtime.InteropServices;using System.Text;public class W { [DllImport(\\\"user32.dll\\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\\"user32.dll\\\")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder lpString,int nMaxCount);[DllImport(\\\"user32.dll\\\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint lpdwProcessId);} \\\";$h=[W]::GetForegroundWindow();$s=New-Object Text.StringBuilder 256;[W]::GetWindowText($h,$s,256)|Out-Null;$p=0;[W]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;$t=$s.ToString();$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;Write-Output \\\"$n|$t\\\""`;
      const result = execSync(psCmd, { timeout: 5000, encoding: 'utf-8' })
        .toString()
        .trim();
      const parts = result.split('|');
      if (parts.length >= 2 && parts[0]) {
        const proc = parts[0];
        const title = parts.slice(1).join('|');
        console.log(`  前台窗口:`);
        console.log(`    ${COLORS.cyan}进程:${COLORS.reset} ${proc}`);
        console.log(
          `    ${COLORS.cyan}标题:${COLORS.reset} ${title.substring(0, 80)}`
        );

        const envType = (() => {
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
            return c(COLORS.green, '💻 编程');
          }
          if (
            p.includes('chrome') ||
            p.includes('edge') ||
            p.includes('firefox') ||
            p.includes('explorer')
          ) {
            return c(COLORS.yellow, '🌐 浏览');
          }
          return c(COLORS.dim, '其他');
        })();
        console.log(`  环境: ${envType}`);
      } else {
        console.log(`  ${COLORS.dim}未检测到前台窗口${COLORS.reset}`);
      }
    } catch {
      console.log(`  ${COLORS.dim}环境检测不可用${COLORS.reset}`);
    }

    // Git状态
    console.log(`\n  ${COLORS.dim}项目Git状态:${COLORS.reset}`);
    const dirs = [
      process.cwd(),
      path.resolve(process.cwd(), '..', 'hermes-agent-main'),
    ];
    for (const dir of dirs) {
      try {
        const gitDir = path.join(dir, '.git');
        if (!fs.existsSync(gitDir)) continue;
        const { execSync } = require('child_process');
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
        const marker =
          uncommitted > 0
            ? c(COLORS.yellow, ` ⚡${uncommitted}个未提交`)
            : c(COLORS.green, ' ✅ 干净');
        console.log(
          `    ${COLORS.cyan}${name}${COLORS.reset} [${branch}]${marker}`
        );
        console.log(
          `    ${COLORS.dim}${lastMsg.substring(0, 60)}${COLORS.reset}`
        );
      } catch {
        /* 跳过非git目录 */
      }
    }
  } catch {
    console.log(`  ${c(COLORS.red, '❌ 获取环境状态失败')}`);
  }
  console.log();
}

async function handleGatewayMenu(rl: readline.Interface): Promise<void> {
  while (true) {
    console.log(
      `\n  ${COLORS.bold}${COLORS.cyan}GATEWAY 网关配置${COLORS.reset}\n`
    );
    console.log(`  ${COLORS.cyan}1.${COLORS.reset} 微信 (扫码登录) 🟢`);
    console.log(`  ${COLORS.cyan}2.${COLORS.reset} 微信 (企业号/公众号 API)`);
    console.log(`  ${COLORS.cyan}3.${COLORS.reset} QQ (Mirai) 🐧`);
    console.log(`  ${COLORS.cyan}4.${COLORS.reset} 飞书 ✈️`);
    console.log(`  ${COLORS.cyan}5.${COLORS.reset} 钉钉 📌`);
    console.log(
      `  ${COLORS.dim}  list  查看连接状态  |  back  返回${COLORS.reset}\n`
    );

    const choice = await ask(rl, `  ${COLORS.cyan}gateway${COLORS.reset}> `);
    if (choice === 'back') return;

    const im = getIM();
    switch (choice) {
      case '1': {
        console.log(
          '\n  📱 微信扫码登录\n  Playwright 将打开 wx.qq.com 获取二维码'
        );
        try {
          const ok = await im.connectPlatform('wechat', { mode: 'qr' });
          console.log(ok ? '  ✅ 微信扫码模式已启动' : '  ❌ 启动失败');
        } catch (e) {
          console.log(`  ❌ 错误: ${(e as Error).message}`);
        }
        break;
      }
      case '2': {
        const appId = await ask(rl, '  AppID: ');
        const appSecret = await ask(rl, '  AppSecret: ');
        const token = await ask(rl, '  Token: ');
        const encodingAESKey = await ask(rl, '  EncodingAESKey (可选): ');
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('wechat', {
          mode: 'official',
          appId,
          appSecret,
          token,
          encodingAESKey: encodingAESKey || undefined,
        });
        console.log(ok ? '  ✅ 连接成功' : '  ❌ 连接失败');
        break;
      }
      case '3': {
        console.log('\n  🐧 QQ 机器人 (Mirai)\n');
        const host =
          (await ask(rl, '  Mirai HTTP 地址 [localhost]: ')) || 'localhost';
        const port = (await ask(rl, '  Mirai HTTP 端口 [8080]: ')) || '8080';
        const vk = await ask(rl, '  verifyKey: ');
        const qq = await ask(rl, '  QQ 账号: ');
        const qqPassword = await ask(rl, '  QQ 密码 (可选): ');
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('qq', {
          miraiHttpHost: host,
          miraiHttpPort: port,
          miraiVerifyKey: vk,
          qqAccount: qq,
          qqPassword: qqPassword || undefined,
        });
        console.log(ok ? '  ✅ QQ 已连接' : '  ❌ 连接失败');
        break;
      }
      case '4': {
        const appId = await ask(rl, '  App ID: ');
        const appSecret = await ask(rl, '  App Secret: ');
        const verificationToken = await ask(rl, '  Verification Token (可选): ');
        const encryptKey = await ask(rl, '  Encrypt Key (可选): ');
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('feishu', { 
          appId, 
          appSecret,
          verificationToken: verificationToken || undefined,
          encryptKey: encryptKey || undefined,
        });
        console.log(ok ? '  ✅ 连接成功' : '  ❌ 连接失败');
        break;
      }
      case '5': {
        const clientId = await ask(rl, '  Client ID: ');
        const clientSecret = await ask(rl, '  Client Secret: ');
        const signatureSecret = await ask(rl, '  签名密钥 (可选): ');
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('dingtalk', {
          appId: clientId,
          appSecret: clientSecret,
          signatureSecret: signatureSecret || undefined,
        });
        console.log(ok ? '  ✅ 连接成功' : '  ❌ 连接失败');
        break;
      }
      case 'list': {
        const im2 = getIM();
        const platforms = im2.getPlatforms();
        console.log('\n  平台连接状态:\n');
        for (const p of platforms) {
          const s = (p.status?.status as string) || 'disconnected';
          const mark =
            s === 'connected'
              ? '🟢'
              : s === 'connecting'
                ? '🟡'
                : s === 'error'
                  ? '🔴'
                  : '⚪';
          console.log(`  ${mark} ${p.icon} ${p.name.padEnd(12)} ${s}`);
        }
        console.log();
        break;
      }
      default:
        console.log('  未知选项');
    }
  }
}

async function handleScheduleMenu(rl: readline.Interface): Promise<void> {
  while (true) {
    console.log(
      `\n  ${COLORS.bold}${COLORS.cyan}SCHEDULE 定时任务 & 自动化${COLORS.reset}\n`
    );
    console.log(
      `  内置任务: 早安简报(8:00) · 情绪检查(30min) · 任务提醒(15min) · 行为分析(2:00)\n`
    );
    console.log(`  ${COLORS.cyan}list${COLORS.reset}    查看所有任务`);
    console.log(`  ${COLORS.cyan}add${COLORS.reset}     添加新任务`);
    console.log(`  ${COLORS.cyan}toggle${COLORS.reset}  启用/禁用`);
    console.log(`  ${COLORS.cyan}run${COLORS.reset}     手动执行`);
    console.log(`  ${COLORS.cyan}triggers${COLORS.reset} 触发器队列`);
    console.log(`  ${COLORS.cyan}patterns${COLORS.reset} 行为模式`);
    console.log(`  ${COLORS.dim}  back  返回${COLORS.reset}\n`);

    const choice = await ask(rl, `  ${COLORS.cyan}schedule${COLORS.reset}> `);
    if (choice === 'back') return;

    switch (choice) {
      case 'list': {
        try {
          let tasks: Array<Record<string, unknown>>;

          // 优先尝试 IPC
          try {
            const ipcResult = await ipcSend('automation.tasks.list');
            // 处理可能的包装结构
            const result = ipcResult as { data?: Array<Record<string, unknown>>; success?: boolean };
            tasks = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : [];
          } catch {
            // IPC 不可用，降级到 HTTP
            const result = (await fetch(`${backendUrl}/api/automation/tasks`).then(
              (r) => r.json()
            )) as { data?: Array<Record<string, unknown>>; success?: boolean };
            tasks = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : [];
          }

          console.log('\n  定时任务:\n');
          if (Array.isArray(tasks) && tasks.length > 0) {
            for (const t of tasks) {
              const enabled = t.enabled as boolean;
              const status = enabled ? '🟢 启用' : '⚪ 禁用';
              console.log(`  ${status} ${t.name || t.id}`);
              console.log(
                `     cron: ${t.schedule || t.cronExpression || '-'}  |  执行 ${t.executionCount || 0} 次\n`
              );
            }
          } else {
            console.log('  (暂无任务数据，请先启动后端服务)\n');
          }
        } catch {
          console.log('  ⚠️ 后端服务未启动\n');
        }
        break;
      }
      case 'add': {
        const name = await ask(rl, '  任务名称: ');
        const cron = await ask(rl, '  Cron 表达式 (例: 0 8 * * *): ');
        const desc = await ask(rl, '  描述: ');
        try {
          let res: Record<string, unknown>;

          // 优先尝试 IPC
          try {
            const ipcResult = await ipcSend('automation.tasks.add', { name, schedule: cron, description: desc, enabled: true });
            res = ipcResult as Record<string, unknown>;
          } catch {
            // IPC 不可用，降级到 HTTP
            res = (await fetch(`${backendUrl}/api/automation/tasks`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                schedule: cron,
                description: desc,
                enabled: true,
              }),
            }).then((r) => r.json())) as Record<string, unknown>;
          }

          console.log(
            res.success ? `  ✅ 任务 "${name}" 已创建` : `  ❌ 创建失败`
          );
        } catch {
          console.log('  ⚠️ 后端服务未启动');
        }
        break;
      }
      case 'toggle': {
        const id = await ask(rl, '  任务ID: ');
        try {
          let res: Record<string, unknown>;

          // 优先尝试 IPC
          try {
            const ipcResult = await ipcSend('automation.tasks.toggle', { id });
            res = ipcResult as Record<string, unknown>;
          } catch {
            // IPC 不可用，降级到 HTTP
            res = (await fetch(
              `${backendUrl}/api/automation/tasks/${id}/toggle`,
              { method: 'PATCH' }
            ).then((r) => r.json())) as Record<string, unknown>;
          }

          console.log(res.success ? '  ✅ 已切换' : '  ❌ 失败');
        } catch {
          console.log('  ⚠️ 后端服务未启动');
        }
        break;
      }
      case 'run': {
        const id = await ask(rl, '  任务ID: ');
        try {
          let res: Record<string, unknown>;

          // 优先尝试 IPC
          try {
            const ipcResult = await ipcSend('automation.tasks.execute', { id });
            res = ipcResult as Record<string, unknown>;
          } catch {
            // IPC 不可用，降级到 HTTP
            res = (await fetch(
              `${backendUrl}/api/automation/tasks/${id}/execute`,
              { method: 'POST' }
            ).then((r) => r.json())) as Record<string, unknown>;
          }

          console.log(
            res.success ? '  ✅ 已执行' : `  ❌ 失败: ${res.error || ''}`
          );
        } catch {
          console.log('  ⚠️ 后端服务未启动');
        }
        break;
      }
      case 'triggers': {
        try {
          let triggers: Array<Record<string, unknown>>;

          // 优先尝试 IPC
          try {
            const ipcResult = await ipcSend('automation.triggers.list');
            triggers = Array.isArray(ipcResult) ? ipcResult : [];
          } catch {
            // IPC 不可用，降级到 HTTP
            triggers = (await fetch(
              `${backendUrl}/api/automation/triggers`
            ).then((r) => r.json())) as Array<Record<string, unknown>>;
          }

          console.log('\n  触发器队列:\n');
          if (Array.isArray(triggers) && triggers.length > 0) {
            for (const t of triggers) {
              console.log(
                `  🔔 [${t.type}] ${t.reason} (优先级: ${t.priority})`
              );
            }
          } else {
            console.log('  (队列为空)\n');
          }
        } catch {
          console.log('  ⚠️ 后端服务未启动');
        }
        break;
      }
      case 'patterns': {
        try {
          let patterns: Record<string, unknown>;

          // 优先尝试 IPC
          try {
            const ipcResult = await ipcSend('automation.patterns');
            patterns = ipcResult as Record<string, unknown>;
          } catch {
            // IPC 不可用，降级到 HTTP
            patterns = (await fetch(
              `${backendUrl}/api/automation/patterns`
            ).then((r) => r.json())) as Record<string, unknown>;
          }

          console.log('\n  用户行为模式:\n');
          if (patterns.activeHours) {
            console.log(
              `  活跃时段: ${(patterns.activeHours as string[]).join(', ')}`
            );
            console.log(
              `  常用话题: ${((patterns.frequentTopics as string[]) || []).join(', ')}`
            );
            console.log(
              `  任务完成率: ${Math.round(((patterns.taskCompletionRate as number) || 0) * 100)}%`
            );
          } else {
            console.log('  (暂无足够数据)\n');
          }
        } catch {
          console.log('  ⚠️ 后端服务未启动');
        }
        break;
      }
      default:
        console.log('  未知命令');
    }
  }
}

async function handleConfigMenu(rl: readline.Interface): Promise<void> {
  while (true) {
    console.log(
      `\n  ${COLORS.bold}${COLORS.cyan}CONFIG 系统配置${COLORS.reset}\n`
    );
    console.log(`  ${COLORS.cyan}show${COLORS.reset}   显示当前配置`);
    console.log(`  ${COLORS.cyan}env${COLORS.reset}    编辑 .env 文件`);
    console.log(`  ${COLORS.cyan}model${COLORS.reset}  模型配置`);
    console.log(`  ${COLORS.dim}  back  返回${COLORS.reset}\n`);

    const choice = await ask(rl, `  ${COLORS.cyan}config${COLORS.reset}> `);
    if (choice === 'back') return;

    switch (choice) {
      case 'show': {
        const envFile = path.join(process.cwd(), '.env');
        console.log('\n  .env 配置:\n');
        if (fs.existsSync(envFile)) {
          const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            if (
              trimmed.includes('KEY=') ||
              trimmed.includes('SECRET=') ||
              trimmed.includes('VERIFY_KEY=')
            ) {
              const [key] = trimmed.split('=');
              console.log(`  ${key}=****`);
            } else {
              console.log(`  ${trimmed}`);
            }
          }
        }
        console.log();
        break;
      }
      case 'env': {
        const envFile = path.join(process.cwd(), '.env');
        try {
          const { execSync } = require('child_process') as {
            execSync: (cmd: string, opts?: Record<string, unknown>) => Buffer;
          };
          if (process.platform === 'win32') {
            execSync(`notepad "${envFile}"`);
          } else {
            execSync(`vi "${envFile}"`, { stdio: 'inherit' });
          }
        } catch {
          console.log(`  .env 路径: ${envFile}\n`);
        }
        break;
      }
      case 'model': {
        // 使用 ProviderManager 显示当前配置并提供交互式管理
        const { getProviderManager, runSetupCLI } = require('../config/setup');
        console.log();
        const manager = getProviderManager();
        const providers = manager.getAll();
        const primary = manager.getPrimary();

        if (providers.length === 0) {
          console.log('  ⚠️ 未配置任何 LLM Provider\n');
          console.log('  是否添加第一个 Provider?');
          const ans = await ask(rl, '  (y/n): ');
          if (ans.toLowerCase() === 'y') {
            await runSetupCLI(['--add']);
          }
        } else {
          console.log(
            `  ${COLORS.bold}已配置 ${providers.length} 个 Provider:${COLORS.reset}\n`
          );
          for (const p of providers) {
            const mark =
              primary?.name === p.name
                ? ` ${COLORS.green}(主)${COLORS.reset}`
                : '';
            const status =
              p.healthy === undefined
                ? '?'
                : p.healthy
                  ? `${COLORS.green}✓${COLORS.reset}`
                  : `${COLORS.red}✗${COLORS.reset}`;
            console.log(
              `  ${status} ${p.displayName} ${COLORS.dim}(${p.model})${COLORS.reset}${mark}`
            );
          }
          console.log(
            `\n  路由: ${manager.getRouting().enabled ? `${COLORS.green}启用${COLORS.reset}` : '禁用'}`
          );
          console.log(
            `\n  输入 ${COLORS.cyan}setup${COLORS.reset} 打开配置向导`
          );
          console.log(
            `  输入 ${COLORS.cyan}add${COLORS.reset} 添加新的 Provider`
          );
          console.log(`  输入 ${COLORS.cyan}switch${COLORS.reset} 切换主模型`);

          const sub = await ask(
            rl,
            `  ${COLORS.cyan}config model${COLORS.reset}> `
          );
          if (sub === 'setup') {
            await runSetupCLI([]);
          } else if (sub === 'add') {
            await runSetupCLI(['--add']);
          } else if (sub === 'switch') {
            console.log();
            providers.forEach(
              (p: { name: string; displayName: string }, _i: number) => {
                const mark = primary?.name === p.name ? ' ★' : '';
                console.log(`  ${_i + 1}. ${p.displayName}${mark}`);
              }
            );
            const idx = parseInt(await ask(rl, '  选择主模型 (1)')) - 1;
            if (idx >= 0 && idx < providers.length) {
              manager.setPrimary(providers[idx].name);
              console.log(
                `  ${COLORS.green}✅ 主模型已切换为 ${providers[idx].displayName}${COLORS.reset}\n`
              );
            }
          }
        }
        break;
      }
      default:
        console.log('  未知命令');
    }
  }
}

type ReadlineInternal = readline.Interface & {
  input: NodeJS.ReadStream;
  line: string;
  cursor: number;
};

interface KeypressResult {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

function setupReadlineHistory(rl: readline.Interface, state: ReplState): void {
  const rli = rl as ReadlineInternal;

  rl.on('line', (line: string) => {
    state.pushHistory(line.trim());
  });

  rli.input.on('keypress', (_str: string, key: KeypressResult) => {
    if (key.name === 'up' && state.historyIndex > 0) {
      state.historyIndex--;
      readline.moveCursor(process.stdout, -rli.line.length, 0);
      readline.clearLine(process.stdout, 0);
      const prev = state.history[state.historyIndex];
      process.stdout.write(prev);
      rli.line = prev;
      rli.cursor = prev.length;
    } else if (
      key.name === 'down' &&
      state.historyIndex < state.history.length - 1
    ) {
      state.historyIndex++;
      readline.moveCursor(process.stdout, -rli.line.length, 0);
      readline.clearLine(process.stdout, 0);
      const next = state.history[state.historyIndex] || '';
      process.stdout.write(next);
      rli.line = next;
      rli.cursor = next.length;
    } else if (key.name === 'tab' && rli.line) {
      const matches = COMMANDS.filter((cmd) => cmd.startsWith(rli.line));
      if (matches.length === 1) {
        readline.moveCursor(process.stdout, -rli.line.length, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(matches[0]);
        rli.line = matches[0];
        rli.cursor = matches[0].length;
      } else if (matches.length > 1) {
        console.log(`\n  ${COLORS.dim}${matches.join('  ')}${COLORS.reset}`);
        rl.prompt(true);
      }
    }
  });
}

async function replLoop(
  rl: readline.Interface,
  state: ReplState
): Promise<void> {
  async function handleDaemonMenu(rl: readline.Interface): Promise<void> {
    const dm = new DaemonManager();

    while (true) {
      const status = await dm.status();
      const statusIcon = status.running
        ? '\x1b[32m●\x1b[0m'
        : '\x1b[31m○\x1b[0m';
      const statusText = status.running
        ? `\x1b[32m运行中\x1b[0m (PID: ${status.state!.pid}, ${dm.formatUptime(status.uptime!)})`
        : '\x1b[31m未运行\x1b[0m';

      console.log(`\n  \x1b[1m\x1b[36mDAEMON 后台常驻服务\x1b[0m\n`);
      console.log(`  状态: ${statusIcon} ${statusText}`);
      if (status.running && status.memoryUsage) {
        console.log(`  内存: ${status.memoryUsage}`);
      }
      console.log();
      console.log(`  \x1b[36mstart\x1b[0m    启动后台服务`);
      console.log(`  \x1b[36mstop\x1b[0m     停止后台服务`);
      console.log(`  \x1b[36mrestart\x1b[0m  重启后台服务`);
      console.log(`  \x1b[36mlogs\x1b[0m     查看最近日志`);
      console.log(`  \x1b[36mstatus\x1b[0m   刷新状态`);
      console.log(`  \x1b[2m  back  返回\x1b[0m\n`);

      const choice = await ask(rl, `  \x1b[36mdaemon\x1b[0m> `);
      if (choice === 'back') return;

      switch (choice) {
        case 'start': {
          console.log('  ⏳ 正在启动...');
          const r = await dm.start();
          console.log(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`);
          break;
        }
        case 'stop': {
          console.log('  ⏳ 正在停止...');
          const r = await dm.stop();
          console.log(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`);
          break;
        }
        case 'restart': {
          console.log('  ⏳ 正在重启...');
          const r = await dm.restart();
          console.log(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`);
          break;
        }
        case 'logs': {
          const lines = await ask(rl, '  行数 [30]: ');
          const n = parseInt(lines, 10) || 30;
          const logText = await dm.logs(n);
          console.log(`\n  \x1b[2m──── 最近 ${n} 行日志 ────\x1b[0m`);
          console.log(
            logText
              .split('\n')
              .map((l: string) => `  \x1b[2m${l}\x1b[0m`)
              .join('\n')
          );
          console.log(`  \x1b[2m──── 日志文件: ${dm.logFilePath()}\x1b[0m\n`);
          break;
        }
        case 'status': {
          continue; // 重新循环刷新
        }
        default:
          console.log('  未知命令');
      }
    }
  }
  const promptText = `${COLORS.bold}${COLORS.magenta}✦${COLORS.reset} ${COLORS.bold}${COLORS.cyan}jiabaixing${COLORS.reset}${COLORS.dim} > ${COLORS.reset}`;

  while (true) {
    state.aborted = false;
    const input = await ask(rl, promptText);

    if (!input) continue;

    if (input.startsWith('/')) {
      const cmd = input.toLowerCase().split(/\s+/)[0];

      switch (cmd) {
        case '/help':
          console.log(HELP_TEXT);
          continue;
        case '/status':
          await handleStatusCommand();
          continue;
        case '/model':
          await handleModelCommand();
          continue;
        case '/skills':
          await handleSkillsCommand();
          continue;
        case '/memory':
          await handleMemoryCommand();
          continue;
        case '/evolution':
          await handleEvolutionCommand();
          continue;
        case '/env':
          await handleEnvCommand();
          continue;
        case '/chat':
          console.log(
            `  ${COLORS.dim}已处于聊天模式，直接输入消息即可${COLORS.reset}\n`
          );
          continue;
        case '/gateway':
        case '/gw':
          if (input.trim() === '/gateway' || input.trim() === '/gw') {
            // 无参数：显示快速状态
            await handleGatewayStatus();
          } else {
            // 有参数：进入子菜单
            await handleGatewayMenu(rl);
          }
          continue;
        case '/schedule':
        case '/sched':
          await handleScheduleMenu(rl);
          continue;
        case '/daemon':
          await handleDaemonMenu(rl);
          continue;
        case '/config':
        case '/cfg':
          await handleConfigMenu(rl);
          continue;
        case '/web':
        case '/w':
          console.log(`\n  打开浏览器: http://localhost:3100\n`);
          try {
            const { execSync } = require('child_process') as {
              execSync: (cmd: string) => Buffer;
            };
            if (process.platform === 'win32') {
              execSync('start http://localhost:3100');
            } else {
              execSync('open http://localhost:3100');
            }
          } catch {}
          continue;
        case '/demo':
          await handleDemoCommand(input);
          continue;
        case '/clear':
        case '/cls':
          console.clear();
          console.log(BANNER);
          {
            const h = await checkBackendHealth();
            printStatusBar(h);
          }
          continue;
        case '/quit':
        case '/exit':
        case '/q':
          console.log(`\n  ${COLORS.yellow}👋 再见！${COLORS.reset}\n`);
          rl.close();
          process.exit(0);
          break;
        default:
          console.log(`  ${COLORS.red}未知命令: ${cmd}${COLORS.reset}`);
          console.log(
            `  输入 ${COLORS.cyan}/help${COLORS.reset} 查看可用命令\n`
          );
          continue;
      }
    }

    const shellCmd = detectShellCommand(input);
    if (shellCmd) {
      console.log(
        `\n  ${COLORS.yellow}💡 这看起来是终端命令，请在系统终端（CMD/PowerShell）中执行，而不是在 jiabaixing CLI 内。${COLORS.reset}`
      );
      console.log(
        `  ${COLORS.dim}提示: 输入 ${COLORS.cyan}/help${COLORS.dim} 查看 jiabaixing CLI 支持的命令${COLORS.reset}`
      );
      if (input.startsWith('npm start') || input.startsWith('npm run')) {
        console.log(
          `  ${COLORS.dim}      启动服务: 在系统终端执行 ${COLORS.cyan}${input}${COLORS.dim}，然后在另一个终端执行 ${COLORS.cyan}npm run cli${COLORS.dim} 进入 CLI${COLORS.reset}`
        );
      }
      console.log();
      continue;
    }

    try {
      const response = await sendChatMessage(input);
      console.log(`\n  ${COLORS.bold}${COLORS.green}✦ Response${COLORS.reset}`);
      console.log(formatResponse(response));
      console.log();
    } catch (err) {
      if (state.aborted) {
        console.log(`\n  ${COLORS.yellow}✦ 请求已中断${COLORS.reset}\n`);
      } else {
        console.log(
          `\n  ${COLORS.red}✦ 错误: ${(err as Error).message}${COLORS.reset}`
        );
        console.log(
          `  ${COLORS.dim}请确认后端服务已运行: npm start${COLORS.reset}\n`
        );
      }
    }
  }
}

/**
 * /demo 命令 — 从 Hermes Agent 学习的穿透式演示
 * 用法: /demo <场景>
 * 场景: research, a-share, daily-brief, code-review
 */
async function handleDemoCommand(input: string): Promise<void> {
  const args = input.trim().split(/\s+/).slice(1);
  const scenario = args[0] || 'help';

  const DEMO_SCENARIOS: Record<
    string,
    { name: string; prompt: string; description: string }
  > = {
    research: {
      name: '深度研究',
      prompt:
        '帮我研究{topic}的最新发展趋势，搜索3个不同角度的信息，总结5个要点，格式化输出',
      description: '多角度搜索 → 分析 → 总结报告',
    },
    'a-share': {
      name: 'A股情绪日报',
      prompt:
        '帮我看看今天A股大盘情绪怎么样，搜索今日A股行情、涨跌比、板块热度，做个简短的情绪分析日报',
      description: '搜索行情 → 情绪分析 → 日报输出',
    },
    'daily-brief': {
      name: '每日简报',
      prompt:
        '帮我整理今日科技新闻要点，搜索AI、科技、互联网领域的最新动态，总结3-5条重要新闻',
      description: '搜索新闻 → 筛选 → 简报',
    },
    'code-review': {
      name: '代码审查',
      prompt:
        '帮我审查当前项目的代码质量，分析最近修改的文件，找出潜在的bug和改进建议',
      description: '读取代码 → 分析 → 审查报告',
    },
    help: {
      name: '帮助',
      prompt: '',
      description: '',
    },
  };

  if (scenario === 'help' || !DEMO_SCENARIOS[scenario]) {
    console.log(
      `\n  ${COLORS.bold}${COLORS.cyan}✦ /demo 演示命令${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}从 Hermes Agent 学习的穿透式工作流演示${COLORS.reset}\n`
    );
    console.log(`  ${COLORS.bold}可用场景:${COLORS.reset}\n`);
    for (const [key, s] of Object.entries(DEMO_SCENARIOS)) {
      if (key === 'help') continue;
      console.log(
        `    ${COLORS.cyan}/demo ${key}${COLORS.reset}  ${s.name} — ${s.description}`
      );
    }
    console.log(
      `\n  ${COLORS.dim}用法: /demo <场景> [自定义参数]${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}示例: /demo research 智慧养老AI${COLORS.reset}\n`
    );
    return;
  }

  const demo = DEMO_SCENARIOS[scenario];
  let prompt = demo.prompt;

  // 支持自定义参数替换 {topic}
  const topic = args.slice(1).join(' ');
  if (topic) {
    prompt = prompt.replace(/\{topic\}/g, topic);
  }

  console.log(
    `\n  ${COLORS.bold}${COLORS.cyan}✦ Demo: ${demo.name}${COLORS.reset}`
  );
  console.log(`  ${COLORS.dim}${demo.description}${COLORS.reset}\n`);
  console.log(
    `  ${COLORS.yellow}▸ 指令: ${prompt.substring(0, 80)}...${COLORS.reset}\n`
  );

  // 发送到后端处理
  try {
    const startTime = Date.now();
    let data: {
      success: boolean;
      response: string;
      trace_id?: string;
    };

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input: prompt });
      // 处理 IPC 返回的可能格式
      if (typeof ipcResult === 'string') {
        data = { success: true, response: ipcResult };
      } else {
        const result = ipcResult as Record<string, unknown>;
        data = {
          success: true,
          response: (result.response || result.message || result.text || JSON.stringify(result)) as string,
        };
      }
    } catch {
      // IPC 不可用，降级到 HTTP
      const resp = await fetch(`${backendUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt }),
      });

      if (!resp.ok) {
        console.log(
          `  ${COLORS.red}✗ 请求失败: HTTP ${resp.status}${COLORS.reset}\n`
        );
        return;
      }

      data = (await resp.json()) as {
        success: boolean;
        response: string;
        trace_id?: string;
      };
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`  ${COLORS.green}✓ 完成 (${duration}s)${COLORS.reset}\n`);

    if (data.response) {
      // 格式化输出
      const lines = data.response.split('\n');
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      console.log();
    }

    if (data.trace_id) {
      console.log(`  ${COLORS.dim}轨迹: ${data.trace_id}${COLORS.reset}\n`);
    }
  } catch (err) {
    console.log(
      `  ${COLORS.red}✗ 错误: ${(err as Error).message}${COLORS.reset}\n`
    );
    console.log(
      `  ${COLORS.dim}请确认后端服务已运行: npm start${COLORS.reset}\n`
    );
  }
}

async function mainLoop(): Promise<void> {
  console.clear();
  console.log(BANNER);

  const state = new ReplState();
  currentReplState = state;

  const health = await checkBackendHealth();
  printStatusBar(health);

  if (!health.online) {
    console.log(
      `  ${COLORS.yellow}⚠ 后端服务未运行，部分功能不可用。输入 /status 查看详情。${COLORS.reset}\n`
    );
  }

  console.log(
    `  ${COLORS.dim}输入消息开始对话，输入 /help 查看所有命令${COLORS.reset}\n`
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
    terminal: true,
    historySize: 500,
  });

  setupReadlineHistory(rl, state);

  EventBus.on(
    'integration_message',
    (payload: {
      platform: string;
      fromName?: string;
      from?: string;
      content: string;
    }) => {
      const from = payload.fromName || payload.from || '';
      console.log(
        `\n  ${COLORS.bold}${COLORS.magenta}📩${COLORS.reset} [${payload.platform}] ${from}: ${payload.content}`
      );
      process.stdout.write(
        `  ${COLORS.bold}${COLORS.magenta}✦${COLORS.reset} ${COLORS.bold}${COLORS.cyan}jiabaixing${COLORS.reset}${COLORS.dim} > ${COLORS.reset}`
      );
    }
  );

  const sigintHandler = (): void => {
    if (currentReplState) {
      currentReplState.aborted = true;
    }
    console.log(
      `\n  ${COLORS.yellow}(按 Ctrl+C 再次或输入 /quit 退出)${COLORS.reset}`
    );
  };

  process.on('SIGINT', sigintHandler);

  try {
    await replLoop(rl, state);
  } finally {
    process.off('SIGINT', sigintHandler);
    rl.close();
  }
}

async function standaloneDaemon(args: string[]): Promise<void> {
  const dm = new DaemonManager();
  const cmd = args[0] || 'status';

  switch (cmd) {
    case 'start': {
      const r = await dm.start();
      console.log(r.success ? `✅ ${r.message}` : `❌ ${r.message}`);
      process.exit(r.success ? 0 : 1);
      break;
    }
    case 'stop': {
      const r = await dm.stop();
      console.log(r.success ? `✅ ${r.message}` : `❌ ${r.message}`);
      process.exit(r.success ? 0 : 1);
      break;
    }
    case 'restart': {
      const r = await dm.restart();
      console.log(r.success ? `✅ ${r.message}` : `❌ ${r.message}`);
      process.exit(r.success ? 0 : 1);
      break;
    }
    case 'status': {
      const status = await dm.status();
      if (status.running) {
        const uptime = dm.formatUptime(status.uptime!);
        console.log(
          `🟢 运行中  PID: ${status.state!.pid}  端口: ${status.state!.port}  运行: ${uptime}${status.memoryUsage ? `  内存: ${status.memoryUsage}` : ''}`
        );
      } else {
        console.log('🔴 未运行');
      }
      process.exit(status.running ? 0 : 1);
      break;
    }
    case 'logs': {
      const n = parseInt(args[1], 10) || 30;
      const logText = await dm.logs(n);
      console.log(logText);
      process.exit(0);
      break;
    }
    default:
      console.log(`用法: npm run cli daemon <start|stop|restart|status|logs>`);
      process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// 管道模式 & 子命令模式
// ─────────────────────────────────────────────────────────────

/** 子命令选项 */
interface SubcommandOptions {
  json: boolean;
  quiet: boolean;
}

/**
 * 从参数列表中解析 --json / --quiet 等全局选项
 * @param args - 原始参数列表
 * @returns 分离后的 { positional, options }
 */
function parseGlobalOptions(args: string[]): {
  positional: string[];
  options: SubcommandOptions;
} {
  const positional: string[] = [];
  const options: SubcommandOptions = { json: false, quiet: false };
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
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 管道模式：从 stdin 读取全部内容，发送给后端 API，输出结果后退出
 * 支持 --json 参数输出 JSON 格式，--quiet 只输出结果
 * @param args - 命令行参数
 */
async function pipeMode(args: string[]): Promise<void> {
  const { options } = parseGlobalOptions(args);

  let input = '';
  try {
    input = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on('end', () =>
        resolve(Buffer.concat(chunks).toString('utf-8'))
      );
      process.stdin.on('error', reject);
    });
  } catch (err) {
    Logger.error('读取 stdin 失败', err as Error, 'PipeMode');
    process.stderr.write(`读取输入失败: ${(err as Error).message}\n`);
    process.exit(1);
  }

  input = input.trim();
  if (!input) {
    process.stderr.write('错误: stdin 为空\n');
    process.exit(1);
  }

  Logger.info(`管道模式: 接收输入 ${input.length} 字符`, 'PipeMode');

  try {
    let data: Record<string, unknown>;

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input });
      if (typeof ipcResult === 'string') {
        data = { response: ipcResult };
      } else {
        data = ipcResult as Record<string, unknown>;
      }
    } catch {
      // IPC 不可用，降级到 HTTP
      const res = await fetch(`${backendUrl}/api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(120000),
      });
      data = (await res.json()) as Record<string, unknown>;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const responseText =
        ((data.data as Record<string, unknown>)?.response as string) ||
        (data.response as string) ||
        (data.message as string) ||
        (data.text as string) ||
        JSON.stringify(data);
      // 管道模式输出纯文本，不含 ANSI 颜色码
      process.stdout.write(stripAnsi(responseText) + '\n');
    }

    process.exit(0);
  } catch (err) {
    Logger.error('管道模式请求失败', err as Error, 'PipeMode');
    process.stderr.write(`请求失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * 子命令模式：解析子命令参数，调用对应后端 API，输出结果后退出
 * @param args - 命令行参数（不含 node 和脚本路径）
 */
async function subcommandMode(args: string[]): Promise<void> {
  const { positional, options } = parseGlobalOptions(args);
  const command = positional[0];

  if (!command) {
    process.stderr.write('错误: 缺少子命令\n');
    printSubcommandHelp();
    process.exit(1);
  }

  try {
    switch (command) {
      case 'ask':
        await handleAskCommand(positional.slice(1).join(' '), options);
        break;
      case 'skill':
        await handleSkillCommand(positional.slice(1), options);
        break;
      case 'schedule':
        await handleScheduleCommand(positional.slice(1), options);
        break;
      case 'status':
        await handleStatusCommandCLI(options);
        break;
      case 'memory':
        await handleMemoryCommandCLI(positional.slice(1), options);
        break;
      case 'evolution':
        await handleEvolutionCommandCLI(positional.slice(1), options);
        break;
      case 'gateway':
        await handleGatewayCommandCLI(positional.slice(1), options);
        break;
      case 'context':
        await handleContextCommandCLI(positional.slice(1), options);
        break;
      case 'search':
        await handleSearchCommand(positional.slice(1).join(' '), options);
        break;
      case 'help':
      case '--help':
      case '-h':
        printSubcommandHelp();
        break;
      default:
        process.stderr.write(`未知子命令: ${command}\n`);
        printSubcommandHelp();
        process.exit(1);
    }
  } catch (err) {
    Logger.error(`子命令 ${command} 执行失败`, err as Error, 'SubcommandMode');
    process.stderr.write(`错误: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * 打印子命令帮助信息
 */
function printSubcommandHelp(): void {
  process.stdout.write(`Jiabaixing CLI 子命令

用法:
  npx tsx src/cli.ts <子命令> [参数] [选项]

子命令:
  ask <问题>              单次问答，输出结果后退出
  skill list              列出技能
  skill execute <名称> [参数]  执行技能
  schedule list           列出定时任务
  schedule add <名称> <cron> <描述>  添加定时任务
  status                  查看系统状态
  memory stats            查看记忆统计
  evolution status        查看进化状态
  gateway list            列出网关状态
  gateway connect <平台>  连接平台
  context list            列出已加载的上下文文件
  context refresh         刷新上下文文件缓存
  context create [文件名] 创建上下文文件模板（默认 JIABAIXING.md）
  context read <文件名>   读取指定上下文文件内容
  search <查询>           网页搜索

全局选项:
  --json                  以 JSON 格式输出
  --quiet, -q             只输出结果，不输出额外信息

管道模式:
  echo "你好" | npx tsx src/cli.ts
  cat question.txt | npx tsx src/cli.ts --json

示例:
  npx tsx src/cli.ts ask "今天天气怎么样"
  npx tsx src/cli.ts skill list --json
  npx tsx src/cli.ts status
  npx tsx src/cli.ts context list
  npx tsx src/cli.ts context create JIABAIXING.md
  npx tsx src/cli.ts context read JIABAIXING.md
  echo "帮我写一段代码" | npx tsx src/cli.ts
`);
}

/**
 * 处理 ask 子命令 — 单次问答
 * @param query - 用户提问内容
 * @param options - 子命令选项
 */
async function handleAskCommand(
  query: string,
  options: SubcommandOptions
): Promise<void> {
  if (!query) {
    process.stderr.write('错误: ask 命令需要提供问题内容\n');
    process.exit(1);
  }

  Logger.info(`ask 命令: ${query.substring(0, 50)}`, 'AskCommand');

  try {
    let data: Record<string, unknown>;

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input: query });
      if (typeof ipcResult === 'string') {
        data = { response: ipcResult };
      } else {
        data = ipcResult as Record<string, unknown>;
      }
    } catch {
      // IPC 不可用，降级到 HTTP
      const res = await fetch(`${backendUrl}/api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: query }),
        signal: AbortSignal.timeout(120000),
      });
      data = (await res.json()) as Record<string, unknown>;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const responseText =
        ((data.data as Record<string, unknown>)?.response as string) ||
        (data.response as string) ||
        (data.message as string) ||
        (data.text as string) ||
        JSON.stringify(data);
      process.stdout.write(stripAnsi(responseText) + '\n');
    }
  } catch (err) {
    Logger.error('ask 命令请求失败', err as Error, 'AskCommand');
    process.stderr.write(`请求失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * 处理 skill 子命令 — 技能管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleSkillCommand(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        let data: {
          skills?: Array<{
            name: string;
            description: string;
            category: string;
          }>;
          count?: number;
        };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('skill.list');
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/skills/list`);
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const skills = data.skills || [];
          if (!options.quiet) {
            process.stdout.write(
              `技能列表 (${data.count || skills.length})\n\n`
            );
          }
          for (const skill of skills) {
            process.stdout.write(
              `  ${skill.name}  ${skill.description.substring(0, 60)}  [${skill.category}]\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取技能列表失败', err as Error, 'SkillCommand');
        process.stderr.write(`获取技能列表失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'execute': {
      const skillName = subArgs[1];
      if (!skillName) {
        process.stderr.write('错误: skill execute 需要提供技能名称\n');
        process.exit(1);
      }
      // 解析额外参数为 JSON 对象
      let params: Record<string, unknown> = {};
      if (subArgs[2]) {
        try {
          params = JSON.parse(subArgs[2]) as Record<string, unknown>;
        } catch {
          // 如果不是 JSON，作为 query 参数
          params = { query: subArgs.slice(2).join(' ') };
        }
      }

      Logger.info(`执行技能: ${skillName}`, 'SkillCommand');

      try {
        let data: Record<string, unknown>;

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('skill.execute', { skillName, params });
          data = ipcResult as Record<string, unknown>;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/skills/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skillName, params }),
            signal: AbortSignal.timeout(120000),
          });
          data = (await resp.json()) as Record<string, unknown>;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const output =
            (data.output as string) ||
            (data.error as string) ||
            JSON.stringify(data);
          process.stdout.write(stripAnsi(output) + '\n');
        }
      } catch (err) {
        Logger.error('技能执行失败', err as Error, 'SkillCommand');
        process.stderr.write(`技能执行失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 skill 子命令: ${action}\n`);
      process.stderr.write('用法: skill list | skill execute <名称> [参数]\n');
      process.exit(1);
  }
}

/**
 * 处理 schedule 子命令 — 定时任务管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleScheduleCommand(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        let data: {
          data?: Array<Record<string, unknown>>;
          success?: boolean;
        };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('automation.tasks.list');
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/automation/tasks`);
          data = (await resp.json()) as typeof data;
        }

        const tasks = Array.isArray(data.data)
          ? data.data
          : Array.isArray(data)
            ? (data as Array<Record<string, unknown>>)
            : [];

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`定时任务 (${tasks.length})\n\n`);
          }
          for (const t of tasks) {
            const enabled = t.enabled as boolean;
            const status = enabled ? '🟢 启用' : '⚪ 禁用';
            process.stdout.write(
              `  ${status} ${t.name || t.id}  cron: ${t.schedule || t.cronExpression || '-'}  执行 ${t.executionCount || 0} 次\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取定时任务失败', err as Error, 'ScheduleCommand');
        process.stderr.write(`获取定时任务失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'add': {
      const name = subArgs[1];
      const cron = subArgs[2];
      const desc = subArgs.slice(3).join(' ') || '';

      if (!name || !cron) {
        process.stderr.write(
          '错误: schedule add 需要提供任务名称和 cron 表达式\n'
        );
        process.stderr.write('用法: schedule add <名称> <cron> [描述]\n');
        process.exit(1);
      }

      Logger.info(`添加定时任务: ${name}`, 'ScheduleCommand');

      try {
        let data: Record<string, unknown>;

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('automation.tasks.add', { name, schedule: cron, description: desc, enabled: true });
          data = ipcResult as Record<string, unknown>;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/automation/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              schedule: cron,
              description: desc,
              enabled: true,
            }),
          });
          data = (await resp.json()) as Record<string, unknown>;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const success = data.success as boolean;
          process.stdout.write(
            success ? `✅ 任务 "${name}" 已创建\n` : `❌ 创建失败\n`
          );
        }
      } catch (err) {
        Logger.error('添加定时任务失败', err as Error, 'ScheduleCommand');
        process.stderr.write(`添加定时任务失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 schedule 子命令: ${action}\n`);
      process.stderr.write(
        '用法: schedule list | schedule add <名称> <cron> [描述]\n'
      );
      process.exit(1);
  }
}

/**
 * 处理 status 子命令 — 查看系统状态
 * @param options - 子命令选项
 */
async function handleStatusCommandCLI(
  options: SubcommandOptions
): Promise<void> {
  Logger.info('查看系统状态', 'StatusCommand');

  try {
    const health = await checkBackendHealth();

    if (options.json) {
      process.stdout.write(JSON.stringify(health, null, 2) + '\n');
    } else {
      process.stdout.write(`系统状态\n\n`);
      process.stdout.write(`  后端服务: ${health.online ? '在线' : '离线'}\n`);
      process.stdout.write(`  健康状态: ${health.status || 'unknown'}\n`);
      if (health.uptime) {
        process.stdout.write(
          `  运行时间: ${Math.round(health.uptime / 60)} 分钟\n`
        );
      }
      if (health.model) {
        process.stdout.write(`  模型: ${health.model}\n`);
      }
      if (health.services) {
        process.stdout.write(`\n  服务组件:\n`);
        for (const [name, svc] of Object.entries(health.services)) {
          const info = svc as { status?: string; message?: string };
          process.stdout.write(
            `    ${info.status === 'ok' ? '🟢' : '🔴'} ${name}: ${info.message || info.status || '-'}\n`
          );
        }
      }
    }
  } catch (err) {
    Logger.error('获取系统状态失败', err as Error, 'StatusCommand');
    process.stderr.write(`获取系统状态失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * 处理 memory 子命令 — 查看记忆统计
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleMemoryCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'stats';

  switch (action) {
    case 'stats': {
      try {
        let data: {
          data?: {
            totalMemories?: number;
            shortTermSize?: number;
            dbPath?: string;
          };
        };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('memory.stats');
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/memory/stats`);
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`记忆统计\n\n`);
          }
          if (data.data) {
            process.stdout.write(
              `  记忆条数: ${data.data.totalMemories || 0}\n`
            );
            process.stdout.write(
              `  短期记忆: ${data.data.shortTermSize || 0} 字节\n`
            );
            if (data.data.dbPath) {
              process.stdout.write(`  数据库: ${data.data.dbPath}\n`);
            }
          } else {
            process.stdout.write(`  无记忆数据\n`);
          }
        }
      } catch (err) {
        Logger.error('获取记忆统计失败', err as Error, 'MemoryCommand');
        process.stderr.write(`获取记忆统计失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 memory 子命令: ${action}\n`);
      process.stderr.write('用法: memory stats\n');
      process.exit(1);
  }
}

/**
 * 处理 evolution 子命令 — 查看进化状态
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleEvolutionCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'status';

  switch (action) {
    case 'status': {
      try {
        let data: {
          orchestrator?: {
            totalInteractions?: number;
            totalOptimizations?: number;
            averageQualityScore?: number;
            qualityTrend?: string;
            failureRate?: number;
            cyclesToday?: number;
            totalCycles?: number;
            userProfileConfidence?: number;
            lastCycleTime?: number;
          };
          enginesActive?: string[];
        };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('evolution.status');
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/evolution/status`);
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`进化数据\n\n`);
          }
          if (data.orchestrator) {
            const o = data.orchestrator;
            process.stdout.write(`  交互: ${o.totalInteractions || 0} 次\n`);
            process.stdout.write(`  优化: ${o.totalOptimizations || 0} 次\n`);
            process.stdout.write(
              `  平均质量: ${(o.averageQualityScore || 0).toFixed(3)}\n`
            );
            process.stdout.write(`  趋势: ${o.qualityTrend || 'stable'}\n`);
            process.stdout.write(
              `  失败率: ${((o.failureRate || 0) * 100).toFixed(1)}%\n`
            );
            process.stdout.write(`  今日周期: ${o.cyclesToday || 0}\n`);
            process.stdout.write(`  总周期: ${o.totalCycles || 0}\n`);
            if (o.lastCycleTime) {
              const ago = Math.round((Date.now() - o.lastCycleTime) / 60000);
              process.stdout.write(`  上次优化: ${ago} 分钟前\n`);
            }
            if (o.userProfileConfidence) {
              process.stdout.write(
                `  画像置信度: ${(o.userProfileConfidence * 100).toFixed(0)}%\n`
              );
            }
          } else {
            process.stdout.write(`  进化引擎未启动\n`);
          }
          if (data.enginesActive?.length) {
            process.stdout.write(
              `  活跃引擎: ${data.enginesActive.join(', ')}\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取进化状态失败', err as Error, 'EvolutionCommand');
        process.stderr.write(`获取进化状态失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 evolution 子命令: ${action}\n`);
      process.stderr.write('用法: evolution status\n');
      process.exit(1);
  }
}

/**
 * 处理 gateway 子命令 — 网关管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleGatewayCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        const im = getIM();
        const platforms = im.getPlatforms();

        if (options.json) {
          process.stdout.write(JSON.stringify(platforms, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`网关状态 (${platforms.length} 个平台)\n\n`);
          }
          if (platforms.length === 0) {
            process.stdout.write(`  未配置任何平台连接\n`);
          } else {
            for (const p of platforms) {
              const s = (p.status?.status as string) || 'disconnected';
              const mark =
                s === 'connected'
                  ? '🟢'
                  : s === 'connecting'
                    ? '🟡'
                    : s === 'error'
                      ? '🔴'
                      : '⚪';
              process.stdout.write(`  ${mark} ${p.icon} ${p.name}: ${s}\n`);
            }
          }
        }
      } catch (err) {
        Logger.error('获取网关状态失败', err as Error, 'GatewayCommand');
        process.stderr.write(`获取网关状态失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'connect': {
      const platform = subArgs[1];
      if (!platform) {
        process.stderr.write('错误: gateway connect 需要提供平台名称\n');
        process.stderr.write('可用平台: wechat, qq, feishu, dingtalk\n');
        process.exit(1);
      }

      Logger.info(`连接平台: ${platform}`, 'GatewayCommand');

      try {
        const im = getIM();
        const ok = await im.connectPlatform(
          platform as 'wechat' | 'qq' | 'feishu' | 'dingtalk',
          {}
        );

        if (options.json) {
          process.stdout.write(
            JSON.stringify({ success: ok, platform }, null, 2) + '\n'
          );
        } else {
          process.stdout.write(
            ok ? `✅ ${platform} 已连接\n` : `❌ ${platform} 连接失败\n`
          );
        }
      } catch (err) {
        Logger.error('连接平台失败', err as Error, 'GatewayCommand');
        process.stderr.write(`连接平台失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 gateway 子命令: ${action}\n`);
      process.stderr.write('用法: gateway list | gateway connect <平台>\n');
      process.exit(1);
  }
}

/**
 * 处理 context 子命令 — 项目上下文管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleContextCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      Logger.info('列出已加载的上下文文件', 'ContextCommand');

      try {
        let data: {
          files: Array<{ fileName: string; size: number; loadedAt: number }>;
          count: number;
        };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('context.list');
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/context/list`);
          const result = (await resp.json()) as {
            data?: typeof data;
          };
          if (!result.data) {
            throw new Error('响应格式错误');
          }
          data = result.data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`已加载的上下文文件 (${data.count} 个)\n\n`);
          }
          if (data.files.length === 0) {
            process.stdout.write(
              `  未加载任何上下文文件。可用文件: JIABAIXING.md, CONTEXT.md, .jiabaixing/context.md, CLAUDE.md\n`
            );
            process.stdout.write(
              `  使用 context create [文件名] 创建模板文件。\n`
            );
          } else {
            for (const file of data.files) {
              const sizeStr = file.size < 1024
                ? `${file.size}B`
                : `${(file.size / 1024).toFixed(1)}KB`;
              const timeStr = new Date(file.loadedAt).toLocaleString();
              process.stdout.write(
                `  ${file.fileName} (${sizeStr}, 加载于 ${timeStr})\n`
              );
            }
          }
        }
      } catch (err) {
        Logger.error('列出上下文文件失败', err as Error, 'ContextCommand');
        process.stderr.write(`列出上下文文件失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'refresh': {
      Logger.info('刷新上下文文件缓存', 'ContextCommand');

      try {
        let data: { count: number; message: string };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('context.refresh');
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/context/refresh`, {
            method: 'POST',
          });
          const result = (await resp.json()) as {
            data?: typeof data;
          };
          if (!result.data) {
            throw new Error('响应格式错误');
          }
          data = result.data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`  ${data.message}\n`);
        }
      } catch (err) {
        Logger.error('刷新上下文文件失败', err as Error, 'ContextCommand');
        process.stderr.write(`刷新上下文文件失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'create': {
      const fileName = subArgs[1] || 'JIABAIXING.md';
      Logger.info(`创建上下文文件模板: ${fileName}`, 'ContextCommand');

      try {
        let data: { fileName: string; message: string };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('context.create', { fileName });
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/context/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName }),
          });
          const result = (await resp.json()) as {
            data?: typeof data;
            error?: string;
          };
          if (!result.data) {
            throw new Error(result.error || '响应格式错误');
          }
          data = result.data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`  ${data.message}\n`);
        }
      } catch (err) {
        Logger.error('创建上下文文件失败', err as Error, 'ContextCommand');
        process.stderr.write(`创建上下文文件失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'read': {
      const fileName = subArgs[1];
      if (!fileName) {
        process.stderr.write('错误: context read 需要提供文件名\n');
        process.stderr.write('可用文件: JIABAIXING.md, CONTEXT.md, .jiabaixing/context.md, CLAUDE.md\n');
        process.exit(1);
      }

      Logger.info(`读取上下文文件: ${fileName}`, 'ContextCommand');

      try {
        let data: { fileName: string; content: string; size: number };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('context.read', { fileName });
          data = ipcResult as typeof data;
        } catch {
          // IPC 不可用，降级到 HTTP
          const resp = await fetch(`${backendUrl}/api/context/read/${encodeURIComponent(fileName)}`);
          const result = (await resp.json()) as {
            data?: typeof data;
            error?: string;
          };
          if (!result.data) {
            throw new Error(result.error || '响应格式错误');
          }
          data = result.data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`${data.fileName}\n\n`);
          }
          process.stdout.write(data.content + '\n');
        }
      } catch (err) {
        Logger.error('读取上下文文件失败', err as Error, 'ContextCommand');
        process.stderr.write(`读取上下文文件失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    default:
      process.stderr.write(`未知 context 子命令: ${action}\n`);
      process.stderr.write('用法: context list | context refresh | context create [文件名] | context read <文件名>\n');
      process.exit(1);
  }
}

/**
 * 处理 search 子命令 — 网页搜索
 * @param query - 搜索查询
 * @param options - 子命令选项
 */
async function handleSearchCommand(
  query: string,
  options: SubcommandOptions
): Promise<void> {
  if (!query) {
    process.stderr.write('错误: search 命令需要提供搜索内容\n');
    process.exit(1);
  }

  Logger.info(`搜索: ${query.substring(0, 50)}`, 'SearchCommand');

  try {
    let data: Record<string, unknown>;

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input: `搜索: ${query}` });
      if (typeof ipcResult === 'string') {
        data = { response: ipcResult };
      } else {
        data = ipcResult as Record<string, unknown>;
      }
    } catch {
      // IPC 不可用，降级到 HTTP
      const res = await fetch(`${backendUrl}/api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: `搜索: ${query}` }),
        signal: AbortSignal.timeout(120000),
      });
      data = (await res.json()) as Record<string, unknown>;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const responseText =
        ((data.data as Record<string, unknown>)?.response as string) ||
        (data.response as string) ||
        (data.message as string) ||
        (data.text as string) ||
        JSON.stringify(data);
      process.stdout.write(stripAnsi(responseText) + '\n');
    }
  } catch (err) {
    Logger.error('搜索请求失败', err as Error, 'SearchCommand');
    process.stderr.write(`搜索失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);

  // 0. 优先检查帮助命令
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    printSubcommandHelp();
    process.exit(0);
  }

  // 1. daemon 子命令
  if (args[0] === 'daemon') {
    void standaloneDaemon(args.slice(1));
  }
  // 2. 其他子命令模式
  else if (args.length > 0) {
    void subcommandMode(args);
  }
  // 3. 管道模式：有 stdin 输入（不是 TTY 且尝试读取输入）
  else if (!process.stdin.isTTY) {
    void pipeMode(args);
  }
  // 4. 交互式 REPL
  else {
    mainLoop().catch((err: Error) => {
      console.error('CLI 启动失败:', err.message);
      process.exit(1);
    });
  }
}

export { mainLoop as startCLI };
