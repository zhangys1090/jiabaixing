"use strict";
/**
 * CLI 模块主入口
 * 导出所有公共 API，供 src/cli.ts 薄代理使用
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBackendHealth = exports.initCLIWebSocket = exports.getWSClient = exports.CLIWebSocketClient = exports.requestWithFallback = exports.ipcSend = exports.backendPort = exports.backendUrl = exports.standaloneDaemon = exports.printSubcommandHelp = exports.subcommandMode = exports.pipeMode = exports.mainLoop = void 0;
// 核心循环
var repl_1 = require("./repl");
Object.defineProperty(exports, "mainLoop", { enumerable: true, get: function () { return repl_1.mainLoop; } });
// 模式入口
var pipe_1 = require("./modes/pipe");
Object.defineProperty(exports, "pipeMode", { enumerable: true, get: function () { return pipe_1.pipeMode; } });
var subcommand_1 = require("./modes/subcommand");
Object.defineProperty(exports, "subcommandMode", { enumerable: true, get: function () { return subcommand_1.subcommandMode; } });
Object.defineProperty(exports, "printSubcommandHelp", { enumerable: true, get: function () { return subcommand_1.printSubcommandHelp; } });
var daemon_1 = require("./modes/daemon");
Object.defineProperty(exports, "standaloneDaemon", { enumerable: true, get: function () { return daemon_1.standaloneDaemon; } });
// 常量（供外部使用）
var constants_1 = require("./constants");
Object.defineProperty(exports, "backendUrl", { enumerable: true, get: function () { return constants_1.backendUrl; } });
Object.defineProperty(exports, "backendPort", { enumerable: true, get: function () { return constants_1.backendPort; } });
// IPC（供外部使用）
var ipc_1 = require("./ipc");
Object.defineProperty(exports, "ipcSend", { enumerable: true, get: function () { return ipc_1.ipcSend; } });
Object.defineProperty(exports, "requestWithFallback", { enumerable: true, get: function () { return ipc_1.requestWithFallback; } });
// WebSocket 客户端（实时事件）
var wsClient_1 = require("./wsClient");
Object.defineProperty(exports, "CLIWebSocketClient", { enumerable: true, get: function () { return wsClient_1.CLIWebSocketClient; } });
Object.defineProperty(exports, "getWSClient", { enumerable: true, get: function () { return wsClient_1.getWSClient; } });
Object.defineProperty(exports, "initCLIWebSocket", { enumerable: true, get: function () { return wsClient_1.initCLIWebSocket; } });
// 工具函数（供外部使用）
var utils_1 = require("./utils");
Object.defineProperty(exports, "checkBackendHealth", { enumerable: true, get: function () { return utils_1.checkBackendHealth; } });
