import {
  IntegrationPlatform,
  PlatformConfig,
  IntegrationStatus,
  IncomingMessageEvent,
  SendMessageResponse,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';

export abstract class BaseIntegrationAdapter {
  protected config: PlatformConfig;
  protected status: IntegrationStatus;
  protected messageHandlers: Array<(message: IncomingMessageEvent) => Promise<void>> = [];

  constructor(public readonly platform: IntegrationPlatform) {
    this.config = {};
    this.status = {
      platform,
      connected: false,
      status: 'disconnected',
    };
  }

  /**
   * 连接到平台
   */
  abstract connect(config: PlatformConfig): Promise<boolean>;

  /**
   * 断开平台连接
   */
  abstract disconnect(): Promise<void>;

  /**
   * 发送消息
   */
  abstract sendMessage(
    message: string,
    to?: string,
    imageUrls?: string[],
    mentions?: string[]
  ): Promise<SendMessageResponse>;

  /**
   * 处理 Webhook 请求
   */
  abstract handleWebhook(payload: Record<string, unknown>): Promise<{ success: boolean; response?: unknown }>;

  /**
   * 获取当前状态
   */
  getStatus(): IntegrationStatus {
    return { ...this.status };
  }

  /**
   * 注册消息处理器
   */
  onMessage(handler: (message: IncomingMessageEvent) => Promise<void>): void {
    this.messageHandlers.push(handler);
    Logger.info(`注册了新的消息处理器到 ${this.platform}`, 'IntegrationAdapter');
  }

  /**
   * 触发消息处理
   */
  protected async emitMessage(message: IncomingMessageEvent): Promise<void> {
    Logger.info(`接收到 ${this.platform} 消息`, 'IntegrationAdapter', {
      from: message.from,
      type: message.type,
    });
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        Logger.error('消息处理器失败', error as Error, 'IntegrationAdapter');
      }
    }
  }

  /**
   * 更新状态
   */
  protected updateStatus(
    status: IntegrationStatus['status'],
    error?: string
  ): void {
    this.status = {
      ...this.status,
      status,
      connected: status === 'connected',
      lastConnectedAt:
        status === 'connected' ? new Date().toISOString() : this.status.lastConnectedAt,
      error,
    };
    Logger.debug(`${this.platform} 状态更新`, 'IntegrationAdapter', this.status);
  }
}
