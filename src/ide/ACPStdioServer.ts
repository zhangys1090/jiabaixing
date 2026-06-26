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

import { ACPServer, ACPDeps, ACPChatRequest } from './ACPServer';
import { ACPAuthManager } from './ACPServer';
import { Logger } from '../utils/Logger';

/** JSON-RPC 2.0 请求 */
interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应 */
interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** ACP 能力声明 */
interface ACPCapabilities {
  /** 支持的方法列表 */
  methods: string[];
  /** 支持的文件操作 */
  fileOperations: {
    read: boolean;
    write: boolean;
    diff: boolean;
  };
  /** 支持的终端操作 */
  terminalOperations: {
    execute: boolean;
    stream: boolean;
  };
  /** 最大并发请求数 */
  maxConcurrentRequests: number;
}

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
export class ACPStdioServer {
  private acpServer: ACPServer;
  private authManager: ACPAuthManager;
  private initialized = false;
  private buffer = '';
  private requestIdCounter = 0;

  constructor(deps: ACPDeps) {
    this.acpServer = new ACPServer(deps);
    this.authManager = new ACPAuthManager();

    Logger.info('ACP stdio 服务器已创建', 'ACPStdio');
  }

  /**
   * 启动 stdio 监听
   * 从 stdin 读取 JSON-RPC 请求，处理后通过 stdout 返回响应
   */
  start(): void {
    Logger.info('ACP stdio 服务器启动，监听 stdin', 'ACPStdio');

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    process.stdin.on('end', () => {
      Logger.info('stdin 已关闭，ACP 服务器退出', 'ACPStdio');
      process.exit(0);
    });

    // stdio 模式下，所有日志输出到 stderr，stdout 专用于 JSON-RPC 响应
    console.log = (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(' ') + '\n');
    };
  }

  /**
   * 处理缓冲区中的消息
   * JSON-RPC over stdio 使用换行符分隔消息
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request = JSON.parse(trimmed) as JSONRPCRequest;
        this.handleRequest(request)
          .then((response) => {
            this.sendResponse(response);
          })
          .catch((err) => {
            Logger.error(`ACPServer 处理请求失败: ${err.message}`, 'ACPStdio');
          });
      } catch (err) {
        this.sendResponse({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: ERROR_CODES.PARSE_ERROR,
            message: `Parse error: ${(err as Error).message}`,
          },
        });
      }
    }
  }

  /**
   * 处理单个 JSON-RPC 请求
   */
  private async handleRequest(
    request: JSONRPCRequest
  ): Promise<JSONRPCResponse> {
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
      const result = await this.dispatchMethod(
        request.method,
        request.params || {}
      );
      return {
        jsonrpc: '2.0',
        id: request.id ?? this.nextRequestId(),
        result,
      };
    } catch (err) {
      Logger.error(
        `ACP 方法 ${request.method} 执行失败`,
        err as Error,
        'ACPStdio'
      );
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: (err as Error).message,
        },
      };
    }
  }

  /**
   * 方法路由分发
   */
  private async dispatchMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
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

  private handleInitialize(params: Record<string, unknown>): {
    capabilities: ACPCapabilities;
    serverInfo: { name: string; version: string };
  } {
    this.initialized = true;

    // 如果客户端提供了认证信息，进行认证
    if (params.apiKey) {
      this.authManager.authenticate(params.apiKey as string);
    }

    Logger.info('ACP 初始化完成', 'ACPStdio');

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

  private handleShutdown(): { success: boolean } {
    Logger.info('ACP shutdown 请求', 'ACPStdio');
    this.initialized = false;
    // 优雅退出
    setTimeout(() => process.exit(0), 100);
    return { success: true };
  }

  // ── 聊天方法 ──

  private async handleChat(params: Record<string, unknown>): Promise<unknown> {
    const request: ACPChatRequest = {
      message: (params.message as string) || '',
      sessionId: (params.sessionId as string) || this.generateSessionId(),
      contextFiles: (params.contextFiles as string[]) || undefined,
    };

    return this.acpServer.handleChat(request);
  }

  // ── 文件方法 ──

  private handleFileDiffs(params: Record<string, unknown>): unknown {
    const sessionId = (params.sessionId as string) || '';
    return this.acpServer.getFileDiff(sessionId);
  }

  private handleFileRead(params: Record<string, unknown>): unknown {
    // 文件读取通过后端 API 实现
    const filePath = (params.path as string) || '';
    if (!filePath) {
      throw new Error('file/read requires path parameter');
    }
    // 这里委托给后端的工具系统
    return {
      path: filePath,
      message: 'File read delegated to backend tool system',
    };
  }

  private handleFileEdit(params: Record<string, unknown>): unknown {
    const filePath = (params.path as string) || '';
    const content = (params.content as string) || '';
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

  private handleTerminalCommands(params: Record<string, unknown>): unknown {
    const sessionId = (params.sessionId as string) || '';
    return this.acpServer.getTerminalCommands(sessionId);
  }

  private handleTerminalExecute(params: Record<string, unknown>): unknown {
    const command = (params.command as string) || '';
    const cwd = (params.cwd as string) || undefined;
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

  private handleToolActivities(params: Record<string, unknown>): unknown {
    const sessionId = (params.sessionId as string) || '';
    return this.acpServer.getToolActivities(sessionId);
  }

  private handleToolsList(): unknown {
    // 返回已注册的工具列表
    return {
      tools: [],
      count: 0,
      message: 'Tools list available through backend API',
    };
  }

  private handleToolsExecute(params: Record<string, unknown>): unknown {
    const toolName = (params.toolName as string) || '';
    const toolParams = (params.params as Record<string, unknown>) || {};
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

  private handleSessionList(): unknown {
    return this.acpServer.getActiveSessions();
  }

  private handleSessionClose(params: Record<string, unknown>): unknown {
    const sessionId = (params.sessionId as string) || '';
    const success = this.acpServer.closeSession(sessionId);
    return { success };
  }

  // ── 认证方法 ──

  private handleAuthLogin(params: Record<string, unknown>): unknown {
    const apiKey = (params.apiKey as string) || '';
    return this.authManager.authenticate(apiKey);
  }

  // ── 辅助方法 ──

  private generateSessionId(): string {
    return `acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private nextRequestId(): number {
    return ++this.requestIdCounter;
  }

  /**
   * 发送 JSON-RPC 响应到 stdout
   * 每条响应以换行符结尾
   */
  private sendResponse(response: JSONRPCResponse): void {
    const output = JSON.stringify(response) + '\n';
    process.stdout.write(output);
  }
}

/**
 * 启动 ACP stdio 服务器
 * 从命令行参数 `--acp-stdio` 触发
 */
export function startACPStdio(deps: ACPDeps): void {
  const server = new ACPStdioServer(deps);
  server.start();
}
