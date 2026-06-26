/**
 * CLI 模块共享常量
 */

/** 后端服务端口 */
export const backendPort = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : 3111;

/** 后端服务 URL */
export const backendUrl = `http://localhost:${backendPort}`;

/** IPC 请求超时时间（毫秒） */
export const IPC_TIMEOUT_MS = 60000;

/** ANSI 颜色码 */
export const COLORS = {
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
export function c(color: string, text: string): string {
  return `${color}${text}${COLORS.reset}`;
}

/** 启动横幅 */
export const BANNER = `
${COLORS.cyan}  ╔════════════════(COLORS.reset${COLORS.cyan}══════════════════════════════════╗${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}                                                  ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}   ${COLORS.bold}${COLORS.magenta}✦${COLORS.reset} ${COLORS.bold}Jiabaixing${COLORS.reset} ${COLORS.dim}v5.0${COLORS.reset}  ·  AI Agent Framework     ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}      ${COLORS.dim}REPL Mode  ·  Continuous Interaction${COLORS.reset}       ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ║${COLORS.reset}                                                  ${COLORS.cyan}║${COLORS.reset}
${COLORS.cyan}  ╚════════════════${COLORS.reset}${COLORS.cyan}══════════════════════════════════╝${COLORS.reset}
`;

/** 帮助文本 */
export const HELP_TEXT = `
${COLORS.bold}  可用命令:${COLORS.reset}

  ${COLORS.cyan}/help${COLORS.reset}        显示此帮助信息
  ${COLORS.cyan}/status${COLORS.reset}      查看系统运行状态
  ${COLORS.cyan}/model${COLORS.reset}       查看当前模型
  ${COLORS.cyan}/skills${COLORS.reset}      查看技能列表
  ${COLORS.cyan}/memory${COLORS.reset}      记忆系统 (stats/search/store/profile)
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

/** REPL 命令列表 */
export const COMMANDS = [
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
export const SHELL_COMMANDS = [
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
