/**
 * MCP服务器集成管理器 v2
 * 管理Model Context Protocol服务器的连接和通信
 * 真实子进程启动 + JSON-RPC over stdio 通信
 */

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import { Logger } from '../utils/Logger';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
  enabled?: boolean;
  autoStart?: boolean;
}

export interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPServerProcess {
  process: ChildProcess;
  startTime: number;
  requestId: number;
  pendingRequests: Map<
    string | number,
    {
      resolve: (msg: MCPMessage) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  outputBuffer: string;
  initialized: boolean;
  serverInfo?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

export class MCPServerManager extends EventEmitter {
  private static instance: MCPServerManager | null = null;
  private servers: Map<string, MCPServerConfig> = new Map();
  private serverProcesses: Map<string, MCPServerProcess> = new Map();
  private messageHandlers: Map<string, (message: MCPMessage) => void> =
    new Map();
  private static readonly REQUEST_TIMEOUT_MS = 30000;
  private static readonly MAX_OUTPUT_BUFFER = 512 * 1024;

  private constructor() {
    super();
    this.initializeDefaultServers();
  }

  public static getInstance(): MCPServerManager {
    if (!MCPServerManager.instance) {
      MCPServerManager.instance = new MCPServerManager();
    }
    return MCPServerManager.instance;
  }

  private initializeDefaultServers(): void {
    this.registerServer({
      name: 'filesystem',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', process.cwd()],
      description: '文件系统操作服务器',
      enabled: true,
      autoStart: false,
    });

    this.registerServer({
      name: 'sqlite',
      command: 'npx',
      args: ['@modelcontextprotocol/server-sqlite', '--db-path', './data'],
      description: 'SQLite数据库操作服务器',
      enabled: true,
      autoStart: false,
    });

    this.registerServer({
      name: 'browser',
      command: 'npx',
      args: ['@anthropic-ai/mcp-server-browser'],
      description: '浏览器自动化服务器 (Hermes Browser)',
      enabled: true,
      autoStart: false,
    });

    this.registerServer({
      name: 'cron',
      command: 'npx',
      args: ['@anthropic-ai/mcp-server-cron'],
      description: '定时任务服务器 (Hermes Cron)',
      enabled: true,
      autoStart: false,
    });
  }

  public registerServer(config: MCPServerConfig): void {
    this.servers.set(config.name, {
      ...config,
      enabled: config.enabled !== false,
      autoStart: config.autoStart ?? false,
    });
    Logger.info(`📡 MCP服务器已注册: ${config.name}`, 'MCPServerManager');
  }

  public unregisterServer(name: string): boolean {
    this.stopServer(name);
    this.servers.delete(name);
    return true;
  }

  public async startServer(name: string): Promise<boolean> {
    const config = this.servers.get(name);
    if (!config) {
      Logger.error(
        `MCP服务器不存在: ${name}`,
        new Error('Server not found'),
        'MCPServerManager'
      );
      return false;
    }

    if (!config.enabled) {
      Logger.warn(`MCP服务器已禁用: ${name}`, 'MCPServerManager');
      return false;
    }

    if (this.serverProcesses.has(name)) {
      Logger.warn(`MCP服务器已在运行: ${name}`, 'MCPServerManager');
      return true;
    }

    try {
      Logger.info(`🚀 启动MCP服务器: ${name}`, 'MCPServerManager');

      const childProcess = spawn(config.command, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...config.env },
        windowsHide: true,
      });

      const serverProc: MCPServerProcess = {
        process: childProcess,
        startTime: Date.now(),
        requestId: 0,
        pendingRequests: new Map(),
        outputBuffer: '',
        initialized: false,
      };

      childProcess.stdout!.on('data', (data: Buffer) => {
        this.handleServerOutput(name, serverProc, data.toString());
      });

      childProcess.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          Logger.debug(`MCP[${name}] stderr: ${msg.substring(0, 200)}`, 'MCPServerManager');
        }
      });

      childProcess.on('error', (err) => {
        Logger.error(`MCP服务器进程错误: ${name}`, err, 'MCPServerManager');
        this.cleanupServer(name, serverProc);
      });

      childProcess.on('exit', (code) => {
        Logger.warn(`MCP服务器进程退出: ${name} (code=${code})`, 'MCPServerManager');
        this.cleanupServer(name, serverProc);
      });

      this.serverProcesses.set(name, serverProc);
      this.emit('serverStarted', { name, config });

      Logger.info(
        `✅ MCP服务器启动成功: ${name} (PID: ${childProcess.pid})`,
        'MCPServerManager'
      );

      const initResult = await this.initializeServer(name);
      if (!initResult) {
        Logger.warn(`⚠️ MCP服务器初始化握手失败: ${name}`, 'MCPServerManager');
      }

      return true;
    } catch (error) {
      Logger.error(
        `MCP服务器启动失败: ${name}`,
        error as Error,
        'MCPServerManager'
      );
      return false;
    }
  }

  private async initializeServer(name: string): Promise<boolean> {
    try {
      const response = await this.sendMessage(name, {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'jiabaixing',
            version: '5.0',
          },
        },
      });

      const serverProc = this.serverProcesses.get(name);
      if (serverProc && response.result) {
        const result = response.result as Record<string, unknown>;
        serverProc.initialized = true;
        serverProc.serverInfo = result.serverInfo as Record<string, unknown>;
        serverProc.capabilities = result.capabilities as Record<string, unknown>;
      }

      await this.sendMessage(name, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      Logger.info(`🤝 MCP服务器初始化完成: ${name}`, 'MCPServerManager');
      return true;
    } catch (error) {
      Logger.error(
        `MCP服务器初始化失败: ${name}`,
        error as Error,
        'MCPServerManager'
      );
      return false;
    }
  }

  private handleServerOutput(
    name: string,
    serverProc: MCPServerProcess,
    chunk: string
  ): void {
    serverProc.outputBuffer += chunk;
    if (serverProc.outputBuffer.length > MCPServerManager.MAX_OUTPUT_BUFFER) {
      serverProc.outputBuffer = serverProc.outputBuffer.substring(
        serverProc.outputBuffer.length - MCPServerManager.MAX_OUTPUT_BUFFER / 2
      );
    }

    const lines = serverProc.outputBuffer.split('\n');
    serverProc.outputBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: MCPMessage = JSON.parse(trimmed);

        if (message.id !== undefined) {
          const pending = serverProc.pendingRequests.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            serverProc.pendingRequests.delete(message.id);
            pending.resolve(message);
          }
        }

        if (message.method) {
          const handler = this.messageHandlers.get(name);
          if (handler) {
            handler(message);
          }
          this.emit('message', { serverName: name, message });
        }
      } catch {
        // 非 JSON 行，忽略
      }
    }
  }

  private cleanupServer(name: string, serverProc: MCPServerProcess): void {
    for (const [id, pending] of serverProc.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP服务器 ${name} 已退出`));
      serverProc.pendingRequests.delete(id);
    }
    this.serverProcesses.delete(name);
    this.emit('serverStopped', { name });
  }

  public stopServer(name: string): boolean {
    const serverProc = this.serverProcesses.get(name);
    if (!serverProc) {
      return false;
    }

    try {
      Logger.info(`🛑 停止MCP服务器: ${name}`, 'MCPServerManager');

      serverProc.process.kill();
      this.cleanupServer(name, serverProc);

      Logger.info(`✅ MCP服务器已停止: ${name}`, 'MCPServerManager');
      return true;
    } catch (error) {
      Logger.error(
        `MCP服务器停止失败: ${name}`,
        error as Error,
        'MCPServerManager'
      );
      return false;
    }
  }

  public async startAllServers(): Promise<void> {
    Logger.info('🔄 启动所有MCP服务器...', 'MCPServerManager');

    const startPromises = Array.from(this.servers.entries())
      .filter(([_, config]) => config.enabled)
      .map(([name, _]) => this.startServer(name));

    await Promise.allSettled(startPromises);

    const runningCount = this.serverProcesses.size;
    Logger.info(
      `✅ MCP服务器启动完成: ${runningCount}/${this.servers.size} 个服务器运行中`,
      'MCPServerManager'
    );
  }

  public async startAutoStartServers(): Promise<void> {
    Logger.info('🔄 启动自动启动的MCP服务器...', 'MCPServerManager');

    const startPromises = Array.from(this.servers.entries())
      .filter(([_, config]) => config.enabled && config.autoStart)
      .map(([name, _]) => this.startServer(name));

    await Promise.allSettled(startPromises);

    Logger.info(
      `✅ 自动启动完成: ${this.serverProcesses.size} 个服务器运行中`,
      'MCPServerManager'
    );
  }

  public stopAllServers(): void {
    Logger.info('🔄 停止所有MCP服务器...', 'MCPServerManager');

    Array.from(this.serverProcesses.keys()).forEach((name) => {
      this.stopServer(name);
    });

    Logger.info('✅ 所有MCP服务器已停止', 'MCPServerManager');
  }

  public async sendMessage(
    serverName: string,
    message: MCPMessage
  ): Promise<MCPMessage> {
    const serverProc = this.serverProcesses.get(serverName);
    if (!serverProc) {
      throw new Error(`MCP服务器未运行: ${serverName}`);
    }

    const isNotification = message.method && message.id === undefined;
    if (isNotification) {
      const jsonStr = JSON.stringify(message) + '\n';
      serverProc.process.stdin!.write(jsonStr);
      return { jsonrpc: '2.0', result: null };
    }

    const id = ++serverProc.requestId;
    const msgWithId: MCPMessage = { ...message, id };

    return new Promise<MCPMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        serverProc.pendingRequests.delete(id);
        reject(new Error(`MCP请求超时 (${MCPServerManager.REQUEST_TIMEOUT_MS}ms): ${serverName}/${message.method}`));
      }, MCPServerManager.REQUEST_TIMEOUT_MS);

      serverProc.pendingRequests.set(id, { resolve, reject, timer });

      const jsonStr = JSON.stringify(msgWithId) + '\n';
      try {
        serverProc.process.stdin!.write(jsonStr);
      } catch (err) {
        clearTimeout(timer);
        serverProc.pendingRequests.delete(id);
        reject(new Error(`MCP写入失败: ${(err as Error).message}`));
      }
    });
  }

  public async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    const response = await this.sendMessage(serverName, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    });

    if (response.error) {
      throw new Error(
        `MCP工具调用失败: ${response.error.message} (${response.error.code})`
      );
    }

    return response.result;
  }

  public async listTools(serverName: string): Promise<unknown[]> {
    const response = await this.sendMessage(serverName, {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });

    if (response.error) {
      throw new Error(
        `MCP工具列表获取失败: ${response.error.message}`
      );
    }

    const result = response.result as { tools?: unknown[] } | null;
    return result?.tools || [];
  }

  public registerMessageHandler(
    serverName: string,
    handler: (message: MCPMessage) => void
  ): void {
    this.messageHandlers.set(serverName, handler);
    Logger.info(`📝 注册消息处理器: ${serverName}`, 'MCPServerManager');
  }

  public unregisterMessageHandler(serverName: string): void {
    this.messageHandlers.delete(serverName);
  }

  public getServerStatus(name: string): {
    running: boolean;
    initialized: boolean;
    config?: MCPServerConfig;
    serverInfo?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
  } {
    const serverProc = this.serverProcesses.get(name);
    const config = this.servers.get(name);
    return {
      running: !!serverProc,
      initialized: serverProc?.initialized ?? false,
      config,
      serverInfo: serverProc?.serverInfo,
      capabilities: serverProc?.capabilities,
    };
  }

  public getAllServerStatus(): Record<
    string,
    {
      running: boolean;
      initialized: boolean;
      config?: MCPServerConfig;
      serverInfo?: Record<string, unknown>;
      capabilities?: Record<string, unknown>;
    }
  > {
    const status: Record<string, ReturnType<typeof this.getServerStatus>> = {};

    this.servers.forEach((config, name) => {
      status[name] = this.getServerStatus(name);
    });

    return status;
  }

  public getRunningServers(): string[] {
    return Array.from(this.serverProcesses.keys());
  }

  public getServerCount(): number {
    return this.servers.size;
  }

  public getRunningServerCount(): number {
    return this.serverProcesses.size;
  }
}

export default MCPServerManager;
