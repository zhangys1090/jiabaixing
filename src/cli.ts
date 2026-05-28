import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { IntegrationManager } from './integration/IntegrationManager';
import { GatewayBridge } from './integration/GatewayBridge';
import { EventBus } from './shared/EventBus';
import { DaemonManager } from './daemon/DaemonManager';

const backendPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3111;
const backendUrl = `http://localhost:${backendPort}`;

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
  ${COLORS.cyan}/chat${COLORS.reset}        进入聊天模式（默认）
  ${COLORS.cyan}/gateway${COLORS.reset}     网关配置（微信/QQ/飞书/钉钉）
  ${COLORS.cyan}/schedule${COLORS.reset}    定时任务与自动化管理
  ${COLORS.cyan}/config${COLORS.reset}      系统配置管理
  ${COLORS.cyan}/daemon${COLORS.reset}      后台常驻服务管理
  ${COLORS.cyan}/web${COLORS.reset}         打开前端界面
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
  '/chat',
  '/gateway',
  '/schedule',
  '/config',
  '/web',
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
  console.log(`  LLM: ${health.llm?.available ? c(COLORS.green, '✅ 可用') : c(COLORS.red, '❌ 不可用')}`);
  if (health.llm?.message) console.log(`  信息: ${health.llm.message}`);
  console.log();
}

async function handleSkillsCommand(): Promise<void> {
  try {
    const resp = await fetch(`${backendUrl}/api/skills/list`);
    const data = await resp.json() as { skills?: Array<{ name: string; description: string; category: string }>; count?: number };
    console.log(`\n  ${COLORS.bold}技能列表 (${data.count || 0})${COLORS.reset}\n`);
    if (data.skills) {
      for (const skill of data.skills) {
        console.log(`  ${COLORS.cyan}■${COLORS.reset} ${COLORS.bold}${skill.name}${COLORS.reset}`);
        console.log(`    ${COLORS.dim}${skill.description.substring(0, 80)}${skill.description.length > 80 ? '...' : ''}${COLORS.reset}`);
        console.log(`    ${COLORS.yellow}分类: ${skill.category}${COLORS.reset}\n`);
      }
    }
  } catch {
    console.log(`  ${c(COLORS.red, '❌ 获取技能列表失败')}`);
  }
  console.log();
}

async function handleMemoryCommand(): Promise<void> {
  try {
    const resp = await fetch(`${backendUrl}/api/memory/stats`);
    const data = await resp.json() as { data?: { totalMemories?: number; shortTermSize?: number; dbPath?: string } };
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
    const resp = await fetch(`${backendUrl}/api/evolution/status`);
    const data = await resp.json() as { orchestrator?: { totalInteractions?: number; totalOptimizations?: number; averageQualityScore?: number; qualityTrend?: string; failureRate?: number; cyclesToday?: number; totalCycles?: number }; enginesActive?: string[] };
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
    } else {
      console.log(`  ${COLORS.dim}进化引擎未启动${COLORS.reset}`);
    }
    if (data.enginesActive?.length) {
      console.log(`  活跃引擎: ${data.enginesActive.join(', ')}`);
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
      const mark = s === 'connected' ? '🟢' : s === 'connecting' ? '🟡' : s === 'error' ? '🔴' : '⚪';
      const statusText = s === 'connected' ? c(COLORS.green, '已连接') : s === 'connecting' ? c(COLORS.yellow, '连接中') : s === 'error' ? c(COLORS.red, '错误') : c(COLORS.dim, '未连接');
      console.log(`    ${mark} ${p.icon} ${p.name}: ${statusText}`);
    }
  }
  console.log(`\n  输入 ${COLORS.cyan}/gateway menu${COLORS.reset} 进入配置菜单`);
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
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('wechat', {
          mode: 'official',
          appId,
          appSecret,
          token,
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
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('qq', {
          miraiHttpHost: host,
          miraiHttpPort: port,
          miraiVerifyKey: vk,
          qqAccount: qq,
        });
        console.log(ok ? '  ✅ QQ 已连接' : '  ❌ 连接失败');
        break;
      }
      case '4': {
        const appId = await ask(rl, '  App ID: ');
        const appSecret = await ask(rl, '  App Secret: ');
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('feishu', { appId, appSecret });
        console.log(ok ? '  ✅ 连接成功' : '  ❌ 连接失败');
        break;
      }
      case '5': {
        const clientId = await ask(rl, '  Client ID: ');
        const clientSecret = await ask(rl, '  Client Secret: ');
        console.log('  ⏳ 连接中...');
        const ok = await im.connectPlatform('dingtalk', {
          appId: clientId,
          appSecret: clientSecret,
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
          const tasks = (await fetch(`${backendUrl}/api/automation/tasks`).then(
            (r) => r.json()
          )) as Array<Record<string, unknown>>;
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
          const res = (await fetch(`${backendUrl}/api/automation/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              schedule: cron,
              description: desc,
              enabled: true,
            }),
          }).then((r) => r.json())) as Record<string, unknown>;
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
          const res = (await fetch(
            `${backendUrl}/api/automation/tasks/${id}/toggle`,
            { method: 'PATCH' }
          ).then((r) => r.json())) as Record<string, unknown>;
          console.log(res.success ? '  ✅ 已切换' : '  ❌ 失败');
        } catch {
          console.log('  ⚠️ 后端服务未启动');
        }
        break;
      }
      case 'run': {
        const id = await ask(rl, '  任务ID: ');
        try {
          const res = (await fetch(
            `${backendUrl}/api/automation/tasks/${id}/execute`,
            { method: 'POST' }
          ).then((r) => r.json())) as Record<string, unknown>;
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
          const triggers = (await fetch(
            `${backendUrl}/api/automation/triggers`
          ).then((r) => r.json())) as Array<Record<string, unknown>>;
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
          const patterns = (await fetch(
            `${backendUrl}/api/automation/patterns`
          ).then((r) => r.json())) as Record<string, unknown>;
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
        try {
          const res = (await fetch(`${backendUrl}/api/llm/status`).then((r) =>
            r.json()
          )) as Record<string, unknown>;
          console.log('\n  LLM 模型状态:\n');
          console.log(`  当前模型: ${res.currentModel || 'default'}`);
          if (res.availableModels) {
            for (const m of res.availableModels as Array<
              Record<string, string>
            >) {
              console.log(`  🟢 ${m.name} (${m.id})`);
            }
          }
        } catch {
          console.log('  ⚠️ 后端服务未启动\n');
        }
        console.log();
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

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'daemon') {
    void standaloneDaemon(args.slice(1));
  } else {
    mainLoop().catch((err: Error) => {
      console.error('CLI 启动失败:', err.message);
      process.exit(1);
    });
  }
}

export { mainLoop as startCLI };
