"use strict";
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
exports.getCurrentReplState = getCurrentReplState;
exports.printStatusBar = printStatusBar;
exports.formatResponse = formatResponse;
exports.printThinking = printThinking;
exports.clearThinking = clearThinking;
exports.ask = ask;
exports.setupReadlineHistory = setupReadlineHistory;
exports.replLoop = replLoop;
exports.mainLoop = mainLoop;
const readline = __importStar(require("readline"));
const DaemonManager_1 = require("../daemon/DaemonManager");
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
const chat_1 = require("./commands/chat");
const config_1 = require("./commands/config");
const demo_1 = require("./commands/demo");
const evolution_1 = require("./commands/evolution");
const gateway_1 = require("./commands/gateway");
const memory_1 = require("./commands/memory");
const model_1 = require("./commands/model");
const schedule_1 = require("./commands/schedule");
const skills_1 = require("./commands/skills");
const status_1 = require("./commands/status");
const constants_1 = require("./constants");
const types_1 = require("./types");
const utils_1 = require("./utils");
const wsClient_1 = require("./wsClient");
/** 当前 REPL 状态实例 */
let currentReplState = null;
/**
 * 获取当前 REPL 状态
 * @returns 当前 ReplState 实例
 */
function getCurrentReplState() {
    return currentReplState;
}
/**
 * 打印状态栏
 * @param health - 后端健康状态
 */
function printStatusBar(health) {
    const connIcon = health.online ? (0, constants_1.c)(constants_1.COLORS.green, '●') : (0, constants_1.c)(constants_1.COLORS.red, '○');
    const connText = health.online
        ? (0, constants_1.c)(constants_1.COLORS.green, 'connected')
        : (0, constants_1.c)(constants_1.COLORS.red, 'disconnected');
    const uptime = currentReplState?.getUptime() || '0s';
    const { backendUrl } = require('./constants');
    Logger_1.Logger.info(`${constants_1.COLORS.dim}  ──────────────────────────────────────────────────────${constants_1.COLORS.reset}\n` +
        `  ${connIcon} ${connText}  ${constants_1.COLORS.dim}|${constants_1.COLORS.reset}  ${backendUrl}  ${constants_1.COLORS.dim}|${constants_1.COLORS.reset}  uptime: ${uptime}  ${constants_1.COLORS.dim}|${constants_1.COLORS.reset}  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}\n` +
        `${constants_1.COLORS.dim}  ──────────────────────────────────────────────────────${constants_1.COLORS.reset}`, 'CLI');
}
/**
 * 格式化响应文本，添加颜色和缩进
 * @param text - 原始文本
 * @returns 格式化后的文本
 */
function formatResponse(text) {
    let result = text;
    result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
        return `\n  ${constants_1.COLORS.dim}┌─ ${lang || 'code'} ───────────────────────────────────${constants_1.COLORS.reset}\n${code
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n')}\n  ${constants_1.COLORS.dim}└────────────────────────────────────────────┘${constants_1.COLORS.reset}`;
    });
    result = result.replace(/\*\*(.*?)\*\*/g, `${constants_1.COLORS.bold}$1${constants_1.COLORS.reset}`);
    result = result.replace(/`(.*?)`/g, `${constants_1.COLORS.cyan}$1${constants_1.COLORS.reset}`);
    return result
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
}
/** 显示思考中提示 */
function printThinking() {
    process.stdout.write(`\n  ${constants_1.COLORS.dim}${constants_1.COLORS.yellow}◌ 思考中...${constants_1.COLORS.reset}`);
}
/** 清除思考中提示 */
function clearThinking() {
    process.stdout.write(`\r${' '.repeat(40)}\r`);
}
/**
 * 交互式提问
 * @param rl - readline 接口
 * @param question - 问题文本
 * @returns 用户回答
 */
function ask(rl, question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}
/**
 * 设置 readline 历史记录和自动补全
 * @param rl - readline 接口
 * @param state - REPL 状态
 */
function setupReadlineHistory(rl, state) {
    const rli = rl;
    rl.on('line', (line) => {
        state.pushHistory(line.trim());
    });
    rli.input.on('keypress', (_str, key) => {
        if (key.name === 'up' && state.historyIndex > 0) {
            state.historyIndex--;
            readline.moveCursor(process.stdout, -rli.line.length, 0);
            readline.clearLine(process.stdout, 0);
            const prev = state.history[state.historyIndex];
            process.stdout.write(prev);
            rli.line = prev;
            rli.cursor = prev.length;
        }
        else if (key.name === 'down' &&
            state.historyIndex < state.history.length - 1) {
            state.historyIndex++;
            readline.moveCursor(process.stdout, -rli.line.length, 0);
            readline.clearLine(process.stdout, 0);
            const next = state.history[state.historyIndex] || '';
            process.stdout.write(next);
            rli.line = next;
            rli.cursor = next.length;
        }
        else if (key.name === 'tab' && rli.line) {
            const matches = constants_1.COMMANDS.filter((cmd) => cmd.startsWith(rli.line));
            if (matches.length === 1) {
                readline.moveCursor(process.stdout, -rli.line.length, 0);
                readline.clearLine(process.stdout, 0);
                process.stdout.write(matches[0]);
                rli.line = matches[0];
                rli.cursor = matches[0].length;
            }
            else if (matches.length > 1) {
                Logger_1.Logger.info(`\n  ${constants_1.COLORS.dim}${matches.join('  ')}${constants_1.COLORS.reset}`, 'CLI');
                rl.prompt(true);
            }
        }
    });
}
/**
 * Daemon 交互菜单
 * @param rl - readline 接口
 */
async function handleDaemonMenu(rl) {
    const dm = new DaemonManager_1.DaemonManager();
    while (true) {
        const status = await dm.status();
        const statusIcon = status.running ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m';
        const statusText = status.running
            ? `\x1b[32m运行中\x1b[0m (PID: ${status.state.pid}, ${dm.formatUptime(status.uptime)})`
            : '\x1b[31m未运行\x1b[0m';
        Logger_1.Logger.info(`\n  \x1b[1m\x1b[36mDAEMON 后台常驻服务\x1b[0m\n`, 'CLI');
        Logger_1.Logger.info(`  状态: ${statusIcon} ${statusText}`, 'CLI');
        if (status.running && status.memoryUsage) {
            Logger_1.Logger.info(`  内存: ${status.memoryUsage}`, 'CLI');
        }
        if (status.running) {
            const pyIcon = status.pythonReady
                ? '\x1b[32m●\x1b[0m'
                : '\x1b[33m○\x1b[0m';
            const pyText = status.pythonReady
                ? `运行中 (PID: ${status.state.pythonPid}, :${status.state.pythonPort})`
                : '未运行';
            Logger_1.Logger.info(`  Python: ${pyIcon} ${pyText}`, 'CLI');
        }
        Logger_1.Logger.info('', 'CLI');
        Logger_1.Logger.info(`  \x1b[36mstart\x1b[0m    启动后台服务`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36mstop\x1b[0m     停止后台服务`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36mrestart\x1b[0m  重启后台服务`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36mlogs\x1b[0m     查看最近日志`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36mstatus\x1b[0m   刷新状态`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36minstall\x1b[0m  安装为系统服务（开机自启）`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36muninstall\x1b[0m 卸载系统服务`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36mtray\x1b[0m     显示系统托盘`, 'CLI');
        Logger_1.Logger.info(`  \x1b[36mdiagnose\x1b[0m 诊断服务问题`, 'CLI');
        Logger_1.Logger.info(`  \x1b[2m  back  返回\x1b[0m\n`, 'CLI');
        const choice = await ask(rl, `  \x1b[36mdaemon\x1b[0m> `);
        if (choice === 'back')
            return;
        switch (choice) {
            case 'start': {
                Logger_1.Logger.info('  ⏳ 正在启动...', 'CLI');
                const r = await dm.start();
                Logger_1.Logger.info(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`, 'CLI');
                break;
            }
            case 'stop': {
                Logger_1.Logger.info('  ⏳ 正在停止...', 'CLI');
                const r = await dm.stop();
                Logger_1.Logger.info(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`, 'CLI');
                break;
            }
            case 'restart': {
                Logger_1.Logger.info('  ⏳ 正在重启...', 'CLI');
                const r = await dm.restart();
                Logger_1.Logger.info(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`, 'CLI');
                break;
            }
            case 'logs': {
                const lines = await ask(rl, '  行数 [30]: ');
                const n = parseInt(lines, 10) || 30;
                const logText = await dm.logs(n);
                Logger_1.Logger.info(`\n  \x1b[2m──── 最近 ${n} 行日志 ────\x1b[0m`, 'CLI');
                Logger_1.Logger.info(logText
                    .split('\n')
                    .map((l) => `  \x1b[2m${l}\x1b[0m`)
                    .join('\n'), 'CLI');
                Logger_1.Logger.info(`  \x1b[2m──── 日志文件: ${dm.logFilePath()}\x1b[0m\n`, 'CLI');
                break;
            }
            case 'status': {
                continue;
            }
            case 'install': {
                Logger_1.Logger.info('  ⏳ 正在安装系统服务...', 'CLI');
                const r = await dm.installService({
                    autoStart: true,
                    firewall: true,
                });
                Logger_1.Logger.info(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`, 'CLI');
                break;
            }
            case 'uninstall': {
                Logger_1.Logger.info('  ⏳ 正在卸载系统服务...', 'CLI');
                const r = await dm.uninstallService();
                Logger_1.Logger.info(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`, 'CLI');
                break;
            }
            case 'tray': {
                Logger_1.Logger.info('  ⏳ 正在显示系统托盘...', 'CLI');
                const r = await dm.showTray();
                Logger_1.Logger.info(r.success ? `  ✅ ${r.message}` : `  ❌ ${r.message}`, 'CLI');
                break;
            }
            case 'diagnose': {
                Logger_1.Logger.info('  ⏳ 正在运行系统诊断...\n', 'CLI');
                const r = await dm.diagnoseService();
                Logger_1.Logger.info(`  ${r.success ? '✅' : '⚠️'} ${r.message}`, 'CLI');
                if (r.details) {
                    r.details.split('\n').forEach((line) => {
                        Logger_1.Logger.info(`  ${line}`, 'CLI');
                    });
                }
                break;
            }
            default:
                Logger_1.Logger.info('  未知命令', 'CLI');
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
function createLineReader(rl) {
    let pendingResolve = null;
    let pasteBuffer = [];
    let pasteTimer = null;
    const PASTE_THRESHOLD_MS = 60;
    const promptText = `${constants_1.COLORS.bold}${constants_1.COLORS.magenta}✦${constants_1.COLORS.reset} ${constants_1.COLORS.bold}${constants_1.COLORS.cyan}jiabaixing${constants_1.COLORS.reset}${constants_1.COLORS.dim} > ${constants_1.COLORS.reset}`;
    const flushBuffer = () => {
        const merged = pasteBuffer.join('\n');
        pasteBuffer = [];
        if (!merged.trim())
            return;
        if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve(merged);
        }
    };
    rl.on('line', (line) => {
        if (pasteTimer)
            clearTimeout(pasteTimer);
        pasteBuffer.push(line);
        if (pasteBuffer.length === 1) {
            pasteTimer = setTimeout(() => {
                pasteTimer = null;
                flushBuffer();
            }, PASTE_THRESHOLD_MS);
        }
        else {
            pasteTimer = setTimeout(() => {
                pasteTimer = null;
                flushBuffer();
            }, PASTE_THRESHOLD_MS);
        }
    });
    return (_prompt) => {
        return new Promise((resolve) => {
            pendingResolve = resolve;
            rl.prompt(true);
            process.stdout.write(promptText);
        });
    };
}
async function replLoop(rl, state) {
    const readLine = createLineReader(rl);
    while (true) {
        state.aborted = false;
        const input = await readLine('');
        if (!input)
            continue;
        const lines = input.split('\n').filter((l) => l.trim());
        if (lines.length > 1) {
            Logger_1.Logger.info(`${constants_1.COLORS.dim}📋 检测到 ${lines.length} 行粘贴，已合并为一条消息${constants_1.COLORS.reset}`, 'CLI');
        }
        if (input.startsWith('/')) {
            const cmd = input.toLowerCase().split(/\s+/)[0];
            switch (cmd) {
                case '/help':
                    Logger_1.Logger.info(constants_1.HELP_TEXT, 'CLI');
                    continue;
                case '/status':
                    await (0, status_1.handleStatusCommand)();
                    continue;
                case '/model':
                    await (0, model_1.handleModelCommand)();
                    continue;
                case '/skills':
                    await (0, skills_1.handleSkillsCommand)();
                    continue;
                case '/memory':
                    await (0, memory_1.handleMemoryCommand)();
                    continue;
                case '/evolution':
                    await (0, evolution_1.handleEvolutionCommand)();
                    continue;
                case '/env':
                    await (0, config_1.handleConfigMenu)(rl);
                    continue;
                case '/chat':
                    Logger_1.Logger.info(`  ${constants_1.COLORS.dim}已处于聊天模式，直接输入消息即可${constants_1.COLORS.reset}\n`, 'CLI');
                    continue;
                case '/gateway':
                case '/gw':
                    if (input.trim() === '/gateway' || input.trim() === '/gw') {
                        await (0, gateway_1.handleGatewayStatus)();
                    }
                    else {
                        await (0, gateway_1.handleGatewayMenu)(rl);
                    }
                    continue;
                case '/schedule':
                case '/sched':
                    await (0, schedule_1.handleScheduleMenu)(rl);
                    continue;
                case '/daemon':
                    await handleDaemonMenu(rl);
                    continue;
                case '/config':
                case '/cfg':
                    await (0, config_1.handleConfigMenu)(rl);
                    continue;
                case '/web':
                case '/w':
                    Logger_1.Logger.info(`\n  打开浏览器: http://localhost:3100\n`, 'CLI');
                    try {
                        const { execSync } = require('child_process');
                        if (process.platform === 'win32') {
                            execSync('start http://localhost:3100');
                        }
                        else {
                            execSync('open http://localhost:3100');
                        }
                    }
                    catch {
                        Logger_1.Logger.warn('打开浏览器失败', 'WebCommand');
                    }
                    continue;
                case '/demo':
                    await (0, demo_1.handleDemoCommand)(input);
                    continue;
                case '/clear':
                case '/cls':
                    console.clear();
                    Logger_1.Logger.info(constants_1.BANNER, 'CLI');
                    {
                        const h = await (0, utils_1.checkBackendHealth)();
                        printStatusBar(h);
                    }
                    continue;
                case '/quit':
                case '/exit':
                case '/q':
                    Logger_1.Logger.info(`\n  ${constants_1.COLORS.yellow}再见！${constants_1.COLORS.reset}\n`, 'CLI');
                    state.aborted = true;
                    return;
                default:
                    Logger_1.Logger.info(`  ${constants_1.COLORS.red}未知命令: ${cmd}${constants_1.COLORS.reset}`, 'CLI');
                    Logger_1.Logger.info(`  输入 ${constants_1.COLORS.cyan}/help${constants_1.COLORS.reset} 查看可用命令\n`, 'CLI');
                    continue;
            }
        }
        const shellCmd = (0, utils_1.detectShellCommand)(input);
        if (shellCmd) {
            Logger_1.Logger.info(`\n  ${constants_1.COLORS.yellow}💡 这看起来是终端命令，请在系统终端（CMD/PowerShell）中执行，而不是在 jiabaixing CLI 内。${constants_1.COLORS.reset}`, 'CLI');
            Logger_1.Logger.info(`  ${constants_1.COLORS.dim}提示: 输入 ${constants_1.COLORS.cyan}/help${constants_1.COLORS.dim} 查看 jiabaixing CLI 支持的命令${constants_1.COLORS.reset}`, 'CLI');
            if (input.startsWith('npm start') || input.startsWith('npm run')) {
                Logger_1.Logger.info(`  ${constants_1.COLORS.dim}      启动服务: 在系统终端执行 ${constants_1.COLORS.cyan}${input}${constants_1.COLORS.dim}，然后在另一个终端执行 ${constants_1.COLORS.cyan}npm run cli${constants_1.COLORS.dim} 进入 CLI${constants_1.COLORS.reset}`, 'CLI');
            }
            Logger_1.Logger.info('', 'CLI');
            continue;
        }
        try {
            const response = await (0, chat_1.sendChatMessage)(input);
            Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.green}✦ Response${constants_1.COLORS.reset}`, 'CLI');
            Logger_1.Logger.info(formatResponse(response), 'CLI');
            Logger_1.Logger.info('', 'CLI');
        }
        catch (err) {
            if (state.aborted) {
                Logger_1.Logger.info(`\n  ${constants_1.COLORS.yellow}✦ 请求已中断${constants_1.COLORS.reset}\n`, 'CLI');
            }
            else {
                Logger_1.Logger.info(`\n  ${constants_1.COLORS.red}✦ 错误: ${err.message}${constants_1.COLORS.reset}`, 'CLI');
                Logger_1.Logger.info(`  ${constants_1.COLORS.dim}请确认后端服务已运行: npm start${constants_1.COLORS.reset}\n`, 'CLI');
            }
        }
    }
}
/**
 * CLI 主循环入口
 * 初始化 REPL 环境并启动交互循环
 */
async function mainLoop() {
    console.clear();
    Logger_1.Logger.info(constants_1.BANNER, 'CLI');
    const state = new types_1.ReplState();
    currentReplState = state;
    const health = await (0, utils_1.checkBackendHealth)();
    printStatusBar(health);
    // 初始化 WebSocket 实时事件连接
    const wsClient = (0, wsClient_1.initCLIWebSocket)();
    if (health.online) {
        wsClient.connect();
    }
    if (!health.online) {
        Logger_1.Logger.info(`  ${constants_1.COLORS.yellow}⚠ 后端服务未运行，部分功能不可用。输入 /status 查看详情。${constants_1.COLORS.reset}\n`, 'CLI');
    }
    Logger_1.Logger.info(`  ${constants_1.COLORS.dim}输入消息开始对话，输入 /help 查看所有命令${constants_1.COLORS.reset}\n`, 'CLI');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '',
        terminal: true,
        historySize: 500,
    });
    setupReadlineHistory(rl, state);
    EventBus_1.EventBus.on('integration_message', (payload) => {
        const from = payload.fromName || payload.from || '';
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.magenta}📩${constants_1.COLORS.reset} [${payload.platform}] ${from}: ${payload.content}`, 'CLI');
        process.stdout.write(`  ${constants_1.COLORS.bold}${constants_1.COLORS.magenta}✦${constants_1.COLORS.reset} ${constants_1.COLORS.bold}${constants_1.COLORS.cyan}jiabaixing${constants_1.COLORS.reset}${constants_1.COLORS.dim} > ${constants_1.COLORS.reset}`);
    });
    let sigintCount = 0;
    const sigintHandler = () => {
        sigintCount++;
        if (sigintCount >= 2) {
            Logger_1.Logger.info('\n  强制退出...', 'CLI');
            process.exit(1);
        }
        if (currentReplState) {
            currentReplState.aborted = true;
        }
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.yellow}(按 Ctrl+C 再次强制退出，或输入 /quit)${constants_1.COLORS.reset}`, 'CLI');
        setTimeout(() => {
            sigintCount = 0;
        }, 3000);
    };
    process.on('SIGINT', sigintHandler);
    try {
        await replLoop(rl, state);
    }
    finally {
        process.off('SIGINT', sigintHandler);
        wsClient.disconnect();
        rl.close();
    }
}
