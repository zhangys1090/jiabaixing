/**
 * MCP服务器集成管理器
 * 管理Model Context Protocol服务器的连接和通信
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';

interface MockServerProcess {
  pid: number;
  status: string;
  startTime: number;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  description?: string;
  enabled?: boolean;
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

export class MCPServerManager extends EventEmitter {
  private static instance: MCPServerManager | null = null;
  private servers: Map<string, MCPServerConfig> = new Map();
  private serverProcesses: Map<string, MockServerProcess> = new Map();
  private messageHandlers: Map<string, (message: MCPMessage) => void> =
    new Map();

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
    // 文件系统服务器
    this.registerServer({
      name: 'filesystem',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', process.cwd()],
      description: '文件系统操作服务器',
      enabled: true,
    });

    // SQLite数据库服务器
    this.registerServer({
      name: 'sqlite',
      command: 'npx',
      args: ['@modelcontextprotocol/server-sqlite', '--db-path', './data'],
      description: 'SQLite数据库操作服务器',
      enabled: true,
    });
  }

  public registerServer(config: MCPServerConfig): void {
    this.servers.set(config.name, {
      ...config,
      enabled: config.enabled !== false,
    });
    Logger.info(`📡 MCP服务器已注册: ${config.name}`, 'MCPServerManager');
  }

  public unregisterServer(name: string): boolean {
    const stopped = this.stopServer(name);
    this.servers.delete(name);
    return stopped;
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

      // 这里应该实际启动子进程
      // 简化实现，使用模拟进程
      const mockProcess = {
        pid: Math.floor(Math.random() * 10000),
        status: 'running',
        startTime: Date.now(),
      };

      this.serverProcesses.set(name, mockProcess);
      this.emit('serverStarted', { name, config });

      Logger.info(
        `✅ MCP服务器启动成功: ${name} (PID: ${mockProcess.pid})`,
        'MCPServerManager'
      );
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

  public stopServer(name: string): boolean {
    const process = this.serverProcesses.get(name);
    if (!process) {
      return false;
    }

    try {
      Logger.info(`🛑 停止MCP服务器: ${name}`, 'MCPServerManager');

      // 这里应该实际终止子进程
      this.serverProcesses.delete(name);
      this.emit('serverStopped', { name });

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

    await Promise.all(startPromises);

    const runningCount = this.serverProcesses.size;
    Logger.info(
      `✅ MCP服务器启动完成: ${runningCount}/${this.servers.size} 个服务器运行中`,
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
    const process = this.serverProcesses.get(serverName);
    if (!process) {
      throw new Error(`MCP服务器未运行: ${serverName}`);
    }

    try {
      Logger.debug(
        `📤 发送消息到 ${serverName}: ${message.method}`,
        'MCPServerManager'
      );

      // 这里应该实际发送消息到MCP服务器
      // 简化实现，返回模拟响应
      const response: MCPMessage = {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          status: 'success',
          data: `模拟响应 from ${serverName}`,
        },
      };

      Logger.debug(`📥 从 ${serverName} 收到响应`, 'MCPServerManager');
      return response;
    } catch (error) {
      Logger.error(
        `发送消息到 ${serverName} 失败`,
        error as Error,
        'MCPServerManager'
      );
      throw error;
    }
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
    config?: MCPServerConfig;
  } {
    const running = this.serverProcesses.has(name);
    const config = this.servers.get(name);
    return { running, config };
  }

  public getAllServerStatus(): Record<
    string,
    { running: boolean; config?: MCPServerConfig }
  > {
    const status: Record<
      string,
      { running: boolean; config?: MCPServerConfig }
    > = {};

    this.servers.forEach((config, name) => {
      status[name] = {
        running: this.serverProcesses.has(name),
        config,
      };
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
