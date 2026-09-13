"use strict";
/**
 * CLI 模块共享常量
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHELL_COMMANDS = exports.COMMANDS = exports.HELP_TEXT = exports.BANNER = exports.COLORS = exports.IPC_TIMEOUT_MS = exports.backendUrl = exports.backendPort = void 0;
exports.c = c;
/** 后端服务端口 */
exports.backendPort = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : 3111;
/** 后端服务 URL */
exports.backendUrl = `http://localhost:${exports.backendPort}`;
/** IPC 请求超时时间（毫秒） */
exports.IPC_TIMEOUT_MS = 60000;
/** ANSI 颜色码 */
exports.COLORS = {
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
/**
 * 为文本添加 ANSI 颜色
 * @param color - ANSI 颜色码
 * @param text - 文本内容
 * @returns 带颜色码的文本
 */
function c(color, text) {
    return `${color}${text}${exports.COLORS.reset}`;
}
/** 启动横幅 */
exports.BANNER = `
${exports.COLORS.cyan}  ╔════════════════(COLORS.reset${exports.COLORS.cyan}══════════════════════════════════╗${exports.COLORS.reset}
${exports.COLORS.cyan}  ║${exports.COLORS.reset}                                                  ${exports.COLORS.cyan}║${exports.COLORS.reset}
${exports.COLORS.cyan}  ║${exports.COLORS.reset}   ${exports.COLORS.bold}${exports.COLORS.magenta}✦${exports.COLORS.reset} ${exports.COLORS.bold}Jiabaixing${exports.COLORS.reset} ${exports.COLORS.dim}v5.0${exports.COLORS.reset}  ·  AI Agent Framework     ${exports.COLORS.cyan}║${exports.COLORS.reset}
${exports.COLORS.cyan}  ║${exports.COLORS.reset}      ${exports.COLORS.dim}REPL Mode  ·  Continuous Interaction${exports.COLORS.reset}       ${exports.COLORS.cyan}║${exports.COLORS.reset}
${exports.COLORS.cyan}  ║${exports.COLORS.reset}                                                  ${exports.COLORS.cyan}║${exports.COLORS.reset}
${exports.COLORS.cyan}  ╚════════════════${exports.COLORS.reset}${exports.COLORS.cyan}══════════════════════════════════╝${exports.COLORS.reset}
`;
/** 帮助文本 */
exports.HELP_TEXT = `
${exports.COLORS.bold}  可用命令:${exports.COLORS.reset}

  ${exports.COLORS.cyan}/help${exports.COLORS.reset}        显示此帮助信息
  ${exports.COLORS.cyan}/status${exports.COLORS.reset}      查看系统运行状态
  ${exports.COLORS.cyan}/model${exports.COLORS.reset}       查看当前模型
  ${exports.COLORS.cyan}/skills${exports.COLORS.reset}      查看技能列表
  ${exports.COLORS.cyan}/memory${exports.COLORS.reset}      记忆系统 (stats/search/store/profile)
  ${exports.COLORS.cyan}/evolution${exports.COLORS.reset}   查看进化数据
  ${exports.COLORS.cyan}/env${exports.COLORS.reset}        查看桌面环境
  ${exports.COLORS.cyan}/chat${exports.COLORS.reset}        进入聊天模式（默认）
  ${exports.COLORS.cyan}/gateway${exports.COLORS.reset}     网关配置（微信/QQ/飞书/钉钉）
  ${exports.COLORS.cyan}/schedule${exports.COLORS.reset}    定时任务与自动化管理
  ${exports.COLORS.cyan}/config${exports.COLORS.reset}      系统配置管理
  ${exports.COLORS.cyan}/daemon${exports.COLORS.reset}      后台常驻服务管理
  ${exports.COLORS.cyan}/web${exports.COLORS.reset}         打开前端界面
  ${exports.COLORS.cyan}/demo${exports.COLORS.reset}        演示命令（研究/分析/自动化）
  ${exports.COLORS.cyan}/clear${exports.COLORS.reset}       清屏
  ${exports.COLORS.cyan}/quit${exports.COLORS.reset}        退出程序

  ${exports.COLORS.dim}直接输入文字即可与 AI 对话${exports.COLORS.reset}
  ${exports.COLORS.dim}Ctrl+C 中断当前请求  ·  Ctrl+D 退出${exports.COLORS.reset}
`;
/** REPL 命令列表 */
exports.COMMANDS = [
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
/** 可识别的 Shell 命令列表 */
exports.SHELL_COMMANDS = [
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
