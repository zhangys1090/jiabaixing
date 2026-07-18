/**
 * MultiPlatformGateway - 多平台网关统一协调层
 *
 * 统一管理:
 * 1. 即时通讯平台（微信/飞书/钉钉/QQ/Telegram/Discord/Slack）
 * 2. MCP 协议服务器（Agent Tools/Prompts/Resources）
 * 3. Webhook 事件推送
 *
 * 架构：GatewayRouter → (IntegrationManager + GatewayBridge + MCPServerManager)
 *
 * 设计原则:
 * - 单一真相源：所有平台状态统一查询
 * - 自动降级：Worker不可用时回退到内联模式
 * - 事件驱动：通过 EventBus 广播状态变更
 */

import { MCPServerConfig } from '../mcp/types';
import { getActivePythonBridge } from '../ide/bridgeRegistry';
import {
  GatewayOverview,
  GatewayStatus,
  IncomingMessageEvent,
  IntegrationPlatform,
  IntegrationPlatformInfo,
  IntegrationStatus,
  PlatformConfig,
  SendMessageRequest,
  SendMessageResponse,
} from '../shared/contracts';
import { Logger } from '../utils/Logger';
import { GatewayBridge } from './GatewayBridge';
import { IntegrationManager, WebhookEndpoint } from './IntegrationManager';

/** MCP 服务器健康状态（与 MCPServerManager.getServerStatus 返回类型对齐） */
type MCPServerHealth = {
  running: boolean;
  initialized: boolean;
  config?: MCPServerConfig;
  serverInfo?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
};

/**
 * 网关运行模式
 * - worker: 独立进程（GatewayBridge），更健壮但需要 fork
 * - inline: 内联模式（IntegrationManager），简单但与主进程共生死
 * - mcp_only: 仅启用 MCP，不启用 IM 平台
 * - hybrid: 全部启用（默认）
 */
export type GatewayMode = 'worker' | 'inline' | 'mcp_only' | 'hybrid';

/**
 * 网关启动配置
 */
export interface GatewayOptions {
  mode?: GatewayMode;
  autoStartMCP?: boolean;
  /** 消息处理并发数（默认3） */
  concurrency?: number;
  /** 消息队列大小（默认100） */
  queueSize?: number;
}

export class MultiPlatformGateway {
  private static instance: MultiPlatformGateway | null = null;
  private mode: GatewayMode;
  private manager: IntegrationManager;
  private bridge: GatewayBridge;
  private initialized = false;
  private started = false;
  private messageQueue: Array<IncomingMessageEvent> = [];
  private queueSize: number;
  private concurrency: number;
  private activeProcessing = 0;

  private constructor(options?: GatewayOptions) {
    this.mode = options?.mode ?? 'hybrid';
    this.concurrency = options?.concurrency ?? 3;
    this.queueSize = options?.queueSize ?? 100;
    this.manager = IntegrationManager.getInstance();
    this.bridge = GatewayBridge.getInstance();

    // 注册 IM 平台消息处理
    this.bridge.setIncomingMessageHandler(async (msg) => {
      await this.dispatchIncomingMessage(msg);
    });
  }

  public static getInstance(options?: GatewayOptions): MultiPlatformGateway {
    if (!MultiPlatformGateway.instance) {
      MultiPlatformGateway.instance = new MultiPlatformGateway(options);
    }
    return MultiPlatformGateway.instance;
  }

  public static resetInstance(): void {
    MultiPlatformGateway.instance = null;
  }

  /**
   * 获取当前运行模式
   */
  public getMode(): GatewayMode {
    return this.mode;
  }

  /**
   * 设置运行模式
   */
  public setMode(mode: GatewayMode): void {
    this.mode = mode;
    Logger.info(`网关模式切换为: ${mode}`, 'Gateway');
  }

  /**
   * 是否已初始化
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 是否已启动
   */
  public isStarted(): boolean {
    return this.started;
  }

  /**
   * 初始化网关（仅注册组件，不启动连接）
   */
  initialize(): void {
    if (this.initialized) {
      Logger.info('MultiPlatformGateway 已初始化，跳过', 'Gateway');
      return;
    }
    this.initialized = true;
    Logger.info(
      `🟣 MultiPlatformGateway 初始化完成 (mode=${this.mode})`,
      'Gateway'
    );
  }

  /**
   * 启动网关（根据模式启动对应子系统）
   */
  async start(): Promise<boolean> {
    if (!this.initialized) {
      this.initialize();
    }

    Logger.info(`🚀 MultiPlatformGateway 启动中...`, 'Gateway');

    let success = true;

    // 1. 启动 MCP 服务器管理器
    if (this.mode === 'hybrid' || this.mode === 'mcp_only') {
      // MCP 服务器由用户按需通过 API 启动，此处仅确保管理器可用
      Logger.info('📡 MCP 管理器已就绪', 'Gateway');
    }

    // 2. 启动 IM 平台网关（Worker 优先）
    if (
      this.mode === 'hybrid' ||
      this.mode === 'worker' ||
      this.mode === 'inline'
    ) {
      try {
        if (this.mode === 'hybrid' || this.mode === 'worker') {
          await this.bridge.start();
          Logger.info('🟢 Worker 网关启动成功', 'Gateway');
        } else {
          Logger.info('🟡 使用内联模式（IntegrationManager）', 'Gateway');
        }
      } catch (err) {
        Logger.warn(
          `Worker 模式启动失败，回退到内联模式: ${(err as Error).message}`,
          'Gateway'
        );
        // 静默回退到 inline
        this.mode = 'inline';
      }
    }

    this.started = true;
    Logger.info(
      `✅ MultiPlatformGateway 启动完成 (mode=${this.mode})`,
      'Gateway'
    );
    return success;
  }

  /**
   * 停止网关
   */
  async stop(): Promise<void> {
    Logger.info('🛑 停止 MultiPlatformGateway...', 'Gateway');

    try {
      if (this.isWorkerActive()) {
        await this.bridge.stop();
      }
      // 停止所有 MCP 服务器
      const bridge = getActivePythonBridge();
      if (bridge) {
        const mcpHealth = await bridge.getMcpServersStatus();
        for (const [name, status] of Object.entries(mcpHealth)) {
          if ((status as { running?: boolean }).running) {
            await bridge.stopMcpServer(name);
          }
        }
      }
    } catch (err) {
      Logger.error('网关停止时发生错误', err as Error, 'Gateway');
    }

    this.started = false;
    this.messageQueue = [];
    this.activeProcessing = 0;
    Logger.info('MultiPlatformGateway 已停止', 'Gateway');
  }

  /**
   * 获取网关概览（所有平台 + MCP 的统一状态）
   */
  async getOverview(): Promise<GatewayOverview> {
    // 1. IM 平台状态
    const imPlatforms: Record<string, GatewayStatus> = {};
    const imList = this.isWorkerActive()
      ? await this.bridge.getPlatforms()
      : this.manager.getPlatforms();

    for (const p of imList) {
      imPlatforms[p.id] = {
        kind: 'im_platform',
        name: p.id,
        displayName: p.name,
        connected: p.status?.connected ?? false,
        status: p.status?.status ?? 'disconnected',
        enabled: p.enabled,
        lastActive: p.status?.lastConnectedAt ?? null,
        error: p.status?.error ?? null,
      };
    }

    // 2. MCP 服务器状态
    const mcpPlatforms: Record<string, GatewayStatus> = {};
    const bridge = getActivePythonBridge();
    const mcpHealth: Record<string, MCPServerHealth> = bridge
      ? ((await bridge.getMcpServersStatus()) as Record<
          string,
          MCPServerHealth
        >)
      : {};
    for (const [name, health] of Object.entries(mcpHealth)) {
      mcpPlatforms[name] = {
        kind: 'mcp_server',
        name,
        displayName: `MCP: ${name}`,
        connected: health.running,
        status: health.initialized ? 'connected' : 'disconnected',
        enabled: true,
        lastActive: null,
        error: health.running ? null : '未启动',
      };
    }

    // 3. Webhook 状态
    const webhooks = this.manager.listWebhooks();
    const webhookStatus: Record<string, GatewayStatus> = {};
    for (const w of webhooks) {
      webhookStatus[w.id] = {
        kind: 'webhook',
        name: w.id,
        displayName: `Webhook: ${w.name}`,
        connected: w.enabled,
        status: w.enabled ? 'connected' : 'disconnected',
        enabled: w.enabled,
        lastActive: null,
        error: null,
      };
    }

    return {
      mode: this.mode,
      initialized: this.initialized,
      started: this.started,
      workerActive: this.isWorkerActive(),
      imPlatforms,
      mcpPlatforms,
      webhooks: webhookStatus,
      queue: {
        pending: this.messageQueue.length,
        processing: this.activeProcessing,
        capacity: this.queueSize,
      },
      totalPlatforms:
        Object.keys(imPlatforms).length +
        Object.keys(mcpPlatforms).length +
        Object.keys(webhookStatus).length,
      activePlatforms:
        Object.values(imPlatforms).filter((p) => p.connected).length +
        Object.values(mcpPlatforms).filter((p) => p.connected).length,
      generatedAt: new Date().toISOString(),
    };
  }

  // ==================== IM 平台操作 ====================

  /**
   * 连接到 IM 平台
   */
  async connectIMPlatform(
    platform: IntegrationPlatform,
    config: PlatformConfig
  ): Promise<boolean> {
    if (this.isWorkerActive()) {
      return await this.bridge.connectPlatform(platform, config);
    }
    return await this.manager.connectPlatform(platform, config);
  }

  /**
   * 断开 IM 平台连接
   */
  async disconnectIMPlatform(platform: IntegrationPlatform): Promise<void> {
    if (this.isWorkerActive()) {
      await this.bridge.disconnectPlatform(platform);
    } else {
      await this.manager.disconnectPlatform(platform);
    }
  }

  /**
   * 获取 IM 平台状态
   */
  async getIMPlatformStatus(
    platform: IntegrationPlatform
  ): Promise<IntegrationStatus | undefined> {
    if (this.isWorkerActive()) {
      return await this.bridge.getPlatformStatus(platform);
    }
    return this.manager.getPlatformStatus(platform);
  }

  /**
   * 列出所有 IM 平台信息
   */
  async listIMPlatforms(): Promise<IntegrationPlatformInfo[]> {
    if (this.isWorkerActive()) {
      return await this.bridge.getPlatforms();
    }
    return this.manager.getPlatforms();
  }

  /**
   * 发送消息到 IM 平台
   */
  async sendIMMessage(
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    if (this.isWorkerActive()) {
      return await this.bridge.sendMessage(request);
    }
    return await this.manager.sendMessage(request);
  }

  /**
   * 处理 IM 平台 Webhook
   */
  async handleIMWebhook(
    platform: IntegrationPlatform,
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown }> {
    if (this.isWorkerActive()) {
      return await this.bridge.handleWebhook(platform, payload);
    }
    return await this.manager.handleWebhook(platform, payload);
  }

  // ==================== MCP 操作 ====================

  /**
   * 注册 MCP 服务器
   */
  registerMCPServer(config: MCPServerConfig): void {
    if (!this.validateAdapter({ platform: config.name, connect: () => true })) {
      return;
    }
    const bridge = getActivePythonBridge();
    if (!bridge) return;
    void bridge.registerMcpServer(config);
  }

  /**
   * 启动 MCP 服务器
   */
  async startMCPServer(name: string): Promise<boolean> {
    const bridge = getActivePythonBridge();
    return bridge ? await bridge.startMcpServer(name) : false;
  }

  /**
   * 停止 MCP 服务器
   */
  async stopMCPServer(name: string): Promise<boolean> {
    const bridge = getActivePythonBridge();
    return bridge ? await bridge.stopMcpServer(name) : false;
  }

  /**
   * 列出所有 MCP 服务器状态
   */
  async listMCPServers(): Promise<Record<string, MCPServerHealth>> {
    const bridge = getActivePythonBridge();
    return bridge
      ? ((await bridge.getMcpServersStatus()) as Record<
          string,
          MCPServerHealth
        >)
      : {};
  }

  /**
   * 调用 MCP 工具
   */
  async callMCPTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    const bridge = getActivePythonBridge();
    if (!bridge) return null;
    return await bridge.callMcpTool(serverName, toolName, args);
  }

  // ==================== Webhook 操作 ====================

  registerWebhook(endpoint: WebhookEndpoint): void {
    this.manager.registerWebhook(endpoint);
  }

  unregisterWebhook(id: string): void {
    this.manager.unregisterWebhook(id);
  }

  listWebhooks(): WebhookEndpoint[] {
    return this.manager.listWebhooks();
  }

  // ==================== 内部方法 ====================

  /** 验证适配器合法性 */
  private validateAdapter(adapter: {
    platform: string;
    sendMessage?: unknown;
    connect?: unknown;
  }): boolean {
    if (!adapter || !adapter.platform || typeof adapter.platform !== 'string') {
      Logger.warn(
        '适配器注册失败: 缺少有效的platform字段',
        'MultiPlatformGateway'
      );
      return false;
    }
    if (
      typeof adapter.sendMessage !== 'function' &&
      typeof adapter.connect !== 'function'
    ) {
      Logger.warn(
        `适配器注册失败: ${adapter.platform} 缺少sendMessage或connect方法`,
        'MultiPlatformGateway'
      );
      return false;
    }
    return true;
  }

  private isWorkerActive(): boolean {
    try {
      return this.bridge.isWorkerAlive();
    } catch {
      return false;
    }
  }

  /**
   * 调度接收到的消息（带并发控制）
   */
  private async dispatchIncomingMessage(
    message: IncomingMessageEvent
  ): Promise<void> {
    // 队列已满则丢弃最旧的一条
    if (this.messageQueue.length >= this.queueSize) {
      this.messageQueue.shift();
      Logger.warn('消息队列已满，丢弃最旧的消息', 'Gateway');
    }

    this.messageQueue.push(message);
    Logger.info(
      `[GW] 消息入队: ${message.platform} <- ${message.from}`,
      'Gateway'
    );

    // 并发控制
    if (this.activeProcessing < this.concurrency) {
      void this.processNext();
    }
  }

  private async processNext(): Promise<void> {
    if (this.activeProcessing >= this.concurrency) return;
    const message = this.messageQueue.shift();
    if (!message) return;

    this.activeProcessing++;
    try {
      // 通过 IntegrationManager 的内部流程处理（它已连接到 JiabaixingCore）
      await this.manager.sendMessage({
        platform: message.platform,
        message: message.content,
        to: message.from,
      });
      Logger.info(`[GW] 消息处理完成: ${message.platform}`, 'Gateway');
    } catch (err) {
      Logger.error(
        `[GW] 消息处理失败: ${message.platform}`,
        err as Error,
        'Gateway'
      );
    } finally {
      this.activeProcessing--;
      if (this.messageQueue.length > 0) {
        void this.processNext();
      }
    }
  }
}
