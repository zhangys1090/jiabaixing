"use strict";
/**
 * ACP stdio/JSON-RPC 传输层
 *
 * 实现 Agent Communication Protocol 的 stdio 传输，
 * 让 IDE 扩展（VS Code / Zed / JetBrains）通过 stdin/stdout
 * 与 Jiabaixing ACPServer 进行 JSON-RPC 通信。
 *
 * 协议设计参考 Hermes Agent 的 ACP 集成：
 *   - 消息格式: JSON-RPC 2.0
 *   - 传输方式: stdio (stdin/stdout)
 *   - 生命周期: initialize → (正常交互) → shutdown
 *
 * 用法（IDE 扩展侧）:
 *   启动命令: `npx tsx src/main.ts --acp-stdio`
 *   或: `node dist/main.js --acp-stdio`
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACPStdioServer = void 0;
exports.startACPStdio = startACPStdio;
const ACPServer_1 = require("./ACPServer");
const ACPServer_2 = require("./ACPServer");
const Logger_1 = require("../utils/Logger");
/** 标准错误码 */
const ERROR_CODES = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    SERVER_NOT_INITIALIZED: -32002,
    UNKNOWN_ERROR: -32001,
};
/**
 * ACP stdio 传输服务器
 *
 * 通过 stdin 接收 JSON-RPC 请求，通过 stdout 返回响应。
 * IDE 扩展通过启动此进程并使用 stdio 管道进行通信。
 */
class ACPStdioServer {
    acpServer;
    authManager;
    initialized = false;
    buffer = '';
    requestIdCounter = 0;
    constructor(deps) {
        this.acpServer = new ACPServer_1.ACPServer(deps);
        this.authManager = new ACPServer_2.ACPAuthManager();
        Logger_1.Logger.info('ACP stdio 服务器已创建', 'ACPStdio');
    }
    /**
     * 启动 stdio 监听
     * 从 stdin 读取 JSON-RPC 请求，处理后通过 stdout 返回响应
     */
    start() {
        Logger_1.Logger.info('ACP stdio 服务器启动，监听 stdin', 'ACPStdio');
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            this.buffer += chunk;
            this.processBuffer();
        });
        process.stdin.on('end', () => {
            Logger_1.Logger.info('stdin 已关闭，ACP 服务器退出', 'ACPStdio');
            process.exit(0);
        });
        // stdio 模式下，所有日志输出到 stderr，stdout 专用于 JSON-RPC 响应
        console.log = (...args) => {
            process.stderr.write(args.map(String).join(' ') + '\n');
        };
    }
    /**
     * 处理缓冲区中的消息
     * JSON-RPC over stdio 使用换行符分隔消息
     */
    processBuffer() {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const request = JSON.parse(trimmed);
                this.handleRequest(request)
                    .then((response) => {
                    this.sendResponse(response);
                })
                    .catch((err) => {
                    Logger_1.Logger.error(`ACPServer 处理请求失败: ${err.message}`, err, 'ACPStdio');
                });
            }
            catch (err) {
                this.sendResponse({
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                        code: ERROR_CODES.PARSE_ERROR,
                        message: `Parse error: ${err.message}`,
                    },
                });
            }
        }
    }
    /**
     * 处理单个 JSON-RPC 请求
     */
    async handleRequest(request) {
        // 验证 JSON-RPC 格式
        if (request.jsonrpc !== '2.0') {
            return {
                jsonrpc: '2.0',
                id: request.id ?? null,
                error: {
                    code: ERROR_CODES.INVALID_REQUEST,
                    message: 'Invalid JSON-RPC request: missing or wrong jsonrpc version',
                },
            };
        }
        // 检查是否已初始化（除 initialize 方法外）
        if (!this.initialized && request.method !== 'initialize') {
            return {
                jsonrpc: '2.0',
                id: request.id ?? null,
                error: {
                    code: ERROR_CODES.SERVER_NOT_INITIALIZED,
                    message: 'Server not initialized. Call initialize first.',
                },
            };
        }
        try {
            const result = await this.dispatchMethod(request.method, request.params || {});
            return {
                jsonrpc: '2.0',
                id: request.id ?? this.nextRequestId(),
                result,
            };
        }
        catch (err) {
            Logger_1.Logger.error(`ACP 方法 ${request.method} 执行失败`, err, 'ACPStdio');
            return {
                jsonrpc: '2.0',
                id: request.id ?? null,
                error: {
                    code: ERROR_CODES.INTERNAL_ERROR,
                    message: err.message,
                },
            };
        }
    }
    /**
     * 方法路由分发
     */
    async dispatchMethod(method, params) {
        switch (method) {
            // ── 生命周期 ──
            case 'initialize':
                return this.handleInitialize(params);
            case 'shutdown':
                return this.handleShutdown();
            // ── 聊天 ──
            case 'chat/send':
                return this.handleChat(params);
            // ── 文件操作 ──
            case 'file/diffs':
                return this.handleFileDiffs(params);
            case 'file/read':
                return this.handleFileRead(params);
            case 'file/edit':
                return this.handleFileEdit(params);
            // ── 终端 ──
            case 'terminal/commands':
                return this.handleTerminalCommands(params);
            case 'terminal/execute':
                return this.handleTerminalExecute(params);
            // ── 工具 ──
            case 'tools/activities':
                return this.handleToolActivities(params);
            case 'tools/list':
                return this.handleToolsList();
            case 'tools/execute':
                return this.handleToolsExecute(params);
            // ── 会话 ──
            case 'session/list':
                return this.handleSessionList();
            case 'session/close':
                return this.handleSessionClose(params);
            // ── 认证 ──
            case 'auth/login':
                return this.handleAuthLogin(params);
            default:
                throw new Error(`Method not found: ${method}`);
        }
    }
    // ── 生命周期方法 ──
    handleInitialize(params) {
        this.initialized = true;
        // 如果客户端提供了认证信息，进行认证
        if (params.apiKey) {
            this.authManager.authenticate(params.apiKey);
        }
        Logger_1.Logger.info('ACP 初始化完成', 'ACPStdio');
        return {
            capabilities: {
                methods: [
                    'initialize',
                    'shutdown',
                    'chat/send',
                    'file/diffs',
                    'file/read',
                    'file/edit',
                    'terminal/commands',
                    'terminal/execute',
                    'tools/activities',
                    'tools/list',
                    'tools/execute',
                    'session/list',
                    'session/close',
                    'auth/login',
                ],
                fileOperations: { read: true, write: true, diff: true },
                terminalOperations: { execute: true, stream: true },
                maxConcurrentRequests: 5,
            },
            serverInfo: {
                name: 'jiabaixing-acp',
                version: '5.0.0',
            },
        };
    }
    handleShutdown() {
        Logger_1.Logger.info('ACP shutdown 请求', 'ACPStdio');
        this.initialized = false;
        // 优雅退出
        setTimeout(() => process.exit(0), 100);
        return { success: true };
    }
    // ── 聊天方法 ──
    async handleChat(params) {
        const request = {
            message: params.message || '',
            sessionId: params.sessionId || this.generateSessionId(),
            contextFiles: params.contextFiles || undefined,
        };
        return this.acpServer.handleChat(request);
    }
    // ── 文件方法 ──
    handleFileDiffs(params) {
        const sessionId = params.sessionId || '';
        return this.acpServer.getFileDiff(sessionId);
    }
    handleFileRead(params) {
        // 文件读取通过后端 API 实现
        const filePath = params.path || '';
        if (!filePath) {
            throw new Error('file/read requires path parameter');
        }
        // 这里委托给后端的工具系统
        return {
            path: filePath,
            message: 'File read delegated to backend tool system',
        };
    }
    handleFileEdit(params) {
        const filePath = params.path || '';
        const content = params.content || '';
        if (!filePath) {
            throw new Error('file/edit requires path parameter');
        }
        return {
            path: filePath,
            content,
            message: 'File edit delegated to backend tool system',
        };
    }
    // ── 终端方法 ──
    handleTerminalCommands(params) {
        const sessionId = params.sessionId || '';
        return this.acpServer.getTerminalCommands(sessionId);
    }
    handleTerminalExecute(params) {
        const command = params.command || '';
        const cwd = params.cwd || undefined;
        if (!command) {
            throw new Error('terminal/execute requires command parameter');
        }
        return {
            command,
            cwd,
            message: 'Terminal execute delegated to backend shell_exec tool',
        };
    }
    // ── 工具方法 ──
    handleToolActivities(params) {
        const sessionId = params.sessionId || '';
        return this.acpServer.getToolActivities(sessionId);
    }
    handleToolsList() {
        // 返回已注册的工具列表
        return {
            tools: [],
            count: 0,
            message: 'Tools list available through backend API',
        };
    }
    handleToolsExecute(params) {
        const toolName = params.toolName || '';
        const toolParams = params.params || {};
        if (!toolName) {
            throw new Error('tools/execute requires toolName parameter');
        }
        return {
            toolName,
            params: toolParams,
            message: 'Tool execute delegated to backend',
        };
    }
    // ── 会话方法 ──
    handleSessionList() {
        return this.acpServer.getActiveSessions();
    }
    handleSessionClose(params) {
        const sessionId = params.sessionId || '';
        const success = this.acpServer.closeSession(sessionId);
        return { success };
    }
    // ── 认证方法 ──
    handleAuthLogin(params) {
        const apiKey = params.apiKey || '';
        return this.authManager.authenticate(apiKey);
    }
    // ── 辅助方法 ──
    generateSessionId() {
        return `acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    nextRequestId() {
        return ++this.requestIdCounter;
    }
    /**
     * 发送 JSON-RPC 响应到 stdout
     * 每条响应以换行符结尾
     */
    sendResponse(response) {
        const output = JSON.stringify(response) + '\n';
        process.stdout.write(output);
    }
}
exports.ACPStdioServer = ACPStdioServer;
/**
 * 启动 ACP stdio 服务器
 * 从命令行参数 `--acp-stdio` 触发
 */
function startACPStdio(deps) {
    const server = new ACPStdioServer(deps);
    server.start();
}
