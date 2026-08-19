import * as readline from 'readline';
import { DaemonManager } from '../daemon/DaemonManager';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { sendChatMessage } from './commands/chat';
import { handleConfigMenu } from './commands/config';
import { handleDemoCommand } from './commands/demo';
import { handleEvolutionCommand } from './commands/evolution';
import { handleGatewayMenu, handleGatewayStatus } from './commands/gateway';
import { handleMemoryCommand } from './commands/memory';
import { handleModelCommand } from './commands/model';
import { handleScheduleMenu } from './commands/schedule';
import { handleSkillsCommand } from './commands/skills';
import { handleStatusCommand } from './commands/status';
import { BANNER, COLORS, COMMANDS, HELP_TEXT, c } from './constants';
import { KeypressResult, ReadlineInternal, ReplState } from './types';
import { checkBackendHealth, detectShellCommand } from './utils';
import { initCLIWebSocket } from './wsClient';

/** 当前 REPL 状态实例 */
let currentReplState: ReplState | null = null;

/**
 * 获取当前 REPL 状态
 * @returns 当前 ReplState 实例
 */
export function getCurrentReplState(): ReplState | null {
  return currentReplState;
}

/**
 * 打印状态栏
 * @param health - 后端健康状态
 */
export function printStatusBar(health: {
  online: boolean;
  status?: string;
}): void {
  const connIcon = health.online ? c(COLORS.green, '●') : c(COLORS.red, '○');
  const connText = health.online
    ? c(COLORS.green, 'connected')
    : c(COLORS.red, 'disconnected');
  const uptime = currentReplState?.getUptime() || '0s';
  const { backendUrl } = require('./constants') as { backendUrl: string };
  Logger.info(
    `${COLORS.dim}  ──────────────────────────────────────────────────────${COLORS.reset}\n` +
      `  ${connIcon} ${connText}  ${COLORS.dim}|${COLORS.reset}  ${backendUrl}  ${COLORS.dim}|${COLORS.reset}  uptime: ${uptime}  ${COLORS.dim}|${COLORS.reset}  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}\n` +
      `${COLORS.dim}  ──────────────────────────────────────────────────────${COLORS.reset}`,
    'CLI'
  );
}

/**
 * 格式化响应文本，添加颜色和缩进
 * @param text - 原始文本
 * @returns 格式化后的文本
 */
export function formatResponse(text: string): string {
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

/** 显示思考中提示 */
export function printThinking(): void {
  process.stdout.write(
    `\n  ${COLORS.dim}${COLORS.yellow}◌ 思考中...${COLORS.reset}`
  );
}

/** 清除思考中提示 */
export function clearThinking(): void {
  process.stdout.write(`\r${' '.repeat(40)}\r`);
}

/**
 * 交互式提问
 * @param rl - readline 接口
 * @param question - 问题文本
 * @returns 用户回答
 */
export function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * 设置 readline 历史记录和自动补全
 * @param rl - readline 接口
 * @param state - REPL 状态
 */
export function setupReadlineHistory(
  rl: readline.Interface,
  state: ReplState
): void {
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
        Logger.info(
          `\n  ${COLORS.dim}${matches.join('  ')}${COLORS.reset}`,
          'CLI'
        );
        rl.prompt(true);
      }
    }
  });
}

/**
 * Daemon 交互菜单
 * @param rl - readline 接口
 */
async function handleDaemonMenu(rl: readline.Interface): Promise<void> {
  const dm = new DaemonManager();

  while (true) {
    const status = await dm.status();
    const statusIcon = status.running ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m';
    const statusText = status.running
      ? `\x1b[32m运行中\x1b[0m (PID: ${status.state!.pid}, ${dm.formatUptime(status.uptime!)})`
      : '\x1b[31m未运行\x1b[0m';

    Logger.info(`\n  \x1b[1m\x1b[36mDAEMON 后台常驻服务\x1b[0m\n`, 'CLI');
    Logger.info(`  状态: ${statusIcon} ${statusText}`, 'CLI');
    if (status.running && status.memoryUsage) {
      Logger.info(`  内存: ${status.memoryUsage}`, 'CLI');
    }
    if (status.running) {
      const pyIcon = status.pythonReady
        ? '\x1b[32m●\x1b[0m'
        : '\x1b[33m○\x1b[0m';
      const pyText = status.pythonReady
        ? `运行中 (PID: ${status.state!.pythonPid}, :${status.state!.pythonPort})`
        : '未运行';
      Logger.info(`  Python: ${pyIcon} ${pyText}`, 'CLI');
    }
    Logger.info('', 'CLI');
    Logger.info(`  \x1b[36mstart\x1b[0m    启动后台服务`, 'CLI');
    Logger.info(`  \x1b[36mstop\x1b[0m     停止后台服务`, 'CLI');
    Logger.info(`  \x1b[36mrestart\x1b[0m  重启后台服务`, 'CLI');
    Logger.info(`  \x1b[36mlogs\x1b[0m     查看最近日志`, 'CLI');
    Logger.info(`  \x1b[36mstatus\x1b[0m   刷新状态`, 'CLI');
    Logger.info(`  \x1b[36minstall\x1b[0m  安装为系统服务（开机自启）`, 'CLI');
    Logger.info(`  \x1b[36muninstall\x1b[0m 卸载系统服务`, 'CLI');
    Logger.info(`  \x1b[36mtray\x1b[0m     显示系统托盘`, 'CLI');
    Logger.info(`  \x1b[36mdiagnose\x1b[0m 诊断服务问题`, 'CLI');
    Logger.info(`  \x1b[2m  back  返回\x1b[0m\n`, 'CLI');

    const choice = await ask(rl, `  \x1b[36mdaemon\x1b[0m> `);
    if (choice === 'back') return;

    switch (choice) {
      case 'start': {
        Logger.info('  ⏳ 正在启动...', 'CLI');
        const r = await dm.start();
        Logger.info(
          r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`,
          'CLI'
        );
        break;
      }
      case 'stop': {
        Logger.info('  ⏳ 正在停止...', 'CLI');
        const r = await dm.stop();
        Logger.info(
          r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`,
          'CLI'
        );
        break;
      }
      case 'restart': {
        Logger.info('  ⏳ 正在重启...', 'CLI');
        const r = await dm.restart();
        Logger.info(
          r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`,
          'CLI'
        );
        break;
      }
      case 'logs': {
        const lines = await ask(rl, '  行数 [30]: ');
        const n = parseInt(lines, 10) || 30;
        const logText = await dm.logs(n);
        Logger.info(`\n  \x1b[2m──── 最近 ${n} 行日志 ────\x1b[0m`, 'CLI');
        Logger.info(
          logText
            .split('\n')
            .map((l: string) => `  \x1b[2m${l}\x1b[0m`)
            .join('\n'),
          'CLI'
        );
        Logger.info(
          `  \x1b[2m──── 日志文件: ${dm.logFilePath()}\x1b[0m\n`,
          'CLI'
        );
        break;
      }
      case 'status': {
        continue;
      }
      case 'install': {
        Logger.info('  ⏳ 正在安装系统服务...', 'CLI');
        const r = await dm.installService({
          autoStart: true,
          firewall: true,
        });
        Logger.info(
          r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`,
          'CLI'
        );
        break;
      }
      case 'uninstall': {
        Logger.info('  ⏳ 正在卸载系统服务...', 'CLI');
        const r = await dm.uninstallService();
        Logger.info(
          r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`,
          'CLI'
        );
        break;
      }
      case 'tray': {
        Logger.info('  ⏳ 正在显示系统托盘...', 'CLI');
        const r = await dm.showTray();
        Logger.info(
          r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`,
          'CLI'
        );
        break;
      }
      case 'diagnose': {
        Logger.info('  ⏳ 正在运行系统诊断...\n', 'CLI');
        const r = await dm.diagnoseService();
        Logger.info(`  ${r.success ? '✅' : '⚠️'} ${r.message}`, 'CLI');
        if (r.details) {
          r.details.split('\n').forEach((line: string) => {
            Logger.info(`  ${line}`, 'CLI');
          });
        }
        break;
      }
      default:
        Logger.info('  未知命令', 'CLI');
    }
  }
}

/**
 * REPL 主循环
 * @param rl - readline 接口
 * @param state - REPL 状态
 */
/**
 * 粘贴检测 — 多行输入缓冲
 * 检测到连续快速输入行时自动合并为一条消息。
 */
function createLineReader(
  rl: readline.Interface
): (prompt: string) => Promise<string> {
  let pendingResolve: ((value: string) => void) | null = null;
  let pasteBuffer: string[] = [];
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;
  const PASTE_THRESHOLD_MS = 60;

  const promptText = `${COLORS.bold}${COLORS.magenta}✦${COLORS.reset} ${COLORS.bold}${COLORS.cyan}jiabaixing${COLORS.reset}${COLORS.dim} > ${COLORS.reset}`;

  const flushBuffer = (): void => {
    const merged = pasteBuffer.join('\n');
    pasteBuffer = [];
    if (!merged.trim()) return;

    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(merged);
    }
  };

  rl.on('line', (line: string) => {
    if (pasteTimer) clearTimeout(pasteTimer);

    pasteBuffer.push(line);

    if (pasteBuffer.length === 1) {
      pasteTimer = setTimeout(() => {
        pasteTimer = null;
        flushBuffer();
      }, PASTE_THRESHOLD_MS);
    } else {
      pasteTimer = setTimeout(() => {
        pasteTimer = null;
        flushBuffer();
      }, PASTE_THRESHOLD_MS);
    }
  });

  return (_prompt: string): Promise<string> => {
    return new Promise<string>((resolve) => {
      pendingResolve = resolve;
      rl.prompt(true);
      process.stdout.write(promptText);
    });
  };
}

export async function replLoop(
  rl: readline.Interface,
  state: ReplState
): Promise<void> {
  const readLine = createLineReader(rl);

  while (true) {
    state.aborted = false;

    const input = await readLine('');

    if (!input) continue;

    const lines = input.split('\n').filter((l) => l.trim());
    if (lines.length > 1) {
      Logger.info(
        `${COLORS.dim}📋 检测到 ${lines.length} 行粘贴，已合并为一条消息${COLORS.reset}`,
        'CLI'
      );
    }

    if (input.startsWith('/')) {
      const cmd = input.toLowerCase().split(/\s+/)[0];

      switch (cmd) {
        case '/help':
          Logger.info(HELP_TEXT, 'CLI');
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
          await handleConfigMenu(rl);
          continue;
        case '/chat':
          Logger.info(
            `  ${COLORS.dim}已处于聊天模式，直接输入消息即可${COLORS.reset}\n`,
            'CLI'
          );
          continue;
        case '/gateway':
        case '/gw':
          if (input.trim() === '/gateway' || input.trim() === '/gw') {
            await handleGatewayStatus();
          } else {
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
          Logger.info(`\n  打开浏览器: http://localhost:3100\n`, 'CLI');
          try {
            const { execSync } = require('child_process') as {
              execSync: (cmd: string) => Buffer;
            };
            if (process.platform === 'win32') {
              execSync('start http://localhost:3100');
            } else {
              execSync('open http://localhost:3100');
            }
          } catch {
            Logger.warn('打开浏览器失败', 'WebCommand');
          }
          continue;
        case '/demo':
          await handleDemoCommand(input);
          continue;
        case '/clear':
        case '/cls':
          console.clear();
          Logger.info(BANNER, 'CLI');
          {
            const h = await checkBackendHealth();
            printStatusBar(h);
          }
          continue;
        case '/quit':
        case '/exit':
        case '/q':
          Logger.info(`\n  ${COLORS.yellow}再见！${COLORS.reset}\n`, 'CLI');
          state.aborted = true;
          return;
        default:
          Logger.info(`  ${COLORS.red}未知命令: ${cmd}${COLORS.reset}`, 'CLI');
          Logger.info(
            `  输入 ${COLORS.cyan}/help${COLORS.reset} 查看可用命令\n`,
            'CLI'
          );
          continue;
      }
    }

    const shellCmd = detectShellCommand(input);
    if (shellCmd) {
      Logger.info(
        `\n  ${COLORS.yellow}💡 这看起来是终端命令，请在系统终端（CMD/PowerShell）中执行，而不是在 jiabaixing CLI 内。${COLORS.reset}`,
        'CLI'
      );
      Logger.info(
        `  ${COLORS.dim}提示: 输入 ${COLORS.cyan}/help${COLORS.dim} 查看 jiabaixing CLI 支持的命令${COLORS.reset}`,
        'CLI'
      );
      if (input.startsWith('npm start') || input.startsWith('npm run')) {
        Logger.info(
          `  ${COLORS.dim}      启动服务: 在系统终端执行 ${COLORS.cyan}${input}${COLORS.dim}，然后在另一个终端执行 ${COLORS.cyan}npm run cli${COLORS.dim} 进入 CLI${COLORS.reset}`,
          'CLI'
        );
      }
      Logger.info('', 'CLI');
      continue;
    }

    try {
      const response = await sendChatMessage(input);
      Logger.info(
        `\n  ${COLORS.bold}${COLORS.green}✦ Response${COLORS.reset}`,
        'CLI'
      );
      Logger.info(formatResponse(response), 'CLI');
      Logger.info('', 'CLI');
    } catch (err) {
      if (state.aborted) {
        Logger.info(`\n  ${COLORS.yellow}✦ 请求已中断${COLORS.reset}\n`, 'CLI');
      } else {
        Logger.info(
          `\n  ${COLORS.red}✦ 错误: ${(err as Error).message}${COLORS.reset}`,
          'CLI'
        );
        Logger.info(
          `  ${COLORS.dim}请确认后端服务已运行: npm start${COLORS.reset}\n`,
          'CLI'
        );
      }
    }
  }
}

/**
 * CLI 主循环入口
 * 初始化 REPL 环境并启动交互循环
 */
export async function mainLoop(): Promise<void> {
  console.clear();
  Logger.info(BANNER, 'CLI');

  const state = new ReplState();
  currentReplState = state;

  const health = await checkBackendHealth();
  printStatusBar(health);

  // 初始化 WebSocket 实时事件连接
  const wsClient = initCLIWebSocket();
  if (health.online) {
    wsClient.connect();
  }

  if (!health.online) {
    Logger.info(
      `  ${COLORS.yellow}⚠ 后端服务未运行，部分功能不可用。输入 /status 查看详情。${COLORS.reset}\n`,
      'CLI'
    );
  }

  Logger.info(
    `  ${COLORS.dim}输入消息开始对话，输入 /help 查看所有命令${COLORS.reset}\n`,
    'CLI'
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
      Logger.info(
        `\n  ${COLORS.bold}${COLORS.magenta}📩${COLORS.reset} [${payload.platform}] ${from}: ${payload.content}`,
        'CLI'
      );
      process.stdout.write(
        `  ${COLORS.bold}${COLORS.magenta}✦${COLORS.reset} ${COLORS.bold}${COLORS.cyan}jiabaixing${COLORS.reset}${COLORS.dim} > ${COLORS.reset}`
      );
    }
  );

  let sigintCount = 0;
  const sigintHandler = (): void => {
    sigintCount++;
    if (sigintCount >= 2) {
      Logger.info('\n  强制退出...', 'CLI');
      process.exit(1);
    }
    if (currentReplState) {
      currentReplState.aborted = true;
    }
    Logger.info(
      `\n  ${COLORS.yellow}(按 Ctrl+C 再次强制退出，或输入 /quit)${COLORS.reset}`,
      'CLI'
    );
    setTimeout(() => { sigintCount = 0; }, 3000);
  };

  process.on('SIGINT', sigintHandler);

  try {
    await replLoop(rl, state);
  } finally {
    process.off('SIGINT', sigintHandler);
    wsClient.disconnect();
    rl.close();
  }
}
