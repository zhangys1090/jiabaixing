/**
 * CLI 模块主入口
 * 导出所有公共 API，供 src/cli.ts 薄代理使用
 */

// 核心循环
export { mainLoop } from './repl';

// 模式入口
export { pipeMode } from './modes/pipe';
export { subcommandMode, printSubcommandHelp } from './modes/subcommand';
export { standaloneDaemon } from './modes/daemon';

// 常量（供外部使用）
export { backendUrl, backendPort } from './constants';

// IPC（供外部使用）
export { ipcSend, requestWithFallback } from './ipc';

// WebSocket 客户端（实时事件）
export { CLIWebSocketClient, getWSClient, initCLIWebSocket } from './wsClient';

// 工具函数（供外部使用）
export { checkBackendHealth } from './utils';
