import {
  IncomingMessageEvent,
  IntegrationPlatform,
  IntegrationStatus,
  PlatformConfig,
  SendMessageResponse,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';

export abstract class BaseIntegrationAdapter {
  protected config: PlatformConfig;
  protected status: IntegrationStatus;
  protected messageHandlers: Array<
    (message: IncomingMessageEvent) => Promise<void>
  > = [];

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
  abstract handleWebhook(
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown; error?: string }>;

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
    Logger.info(
      `注册了新的消息处理器到 ${this.platform}`,
      'IntegrationAdapter'
    );
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
   * 校验 Webhook URL 安全性（防止 SSRF 攻击）
   * @param url - 待校验的 URL
   * @returns 校验结果
   */
  protected validateWebhookUrl(url: string): {
    valid: boolean;
    reason?: string;
  } {
    try {
      const parsed = new URL(url);

      // 仅允许 https 和 http 协议
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { valid: false, reason: '不支持的协议' };
      }

      const hostname = parsed.hostname;

      // 禁止 IP 地址形式（防止访问内网 IP）
      const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
      const isIPv6 = hostname.startsWith('[') && hostname.endsWith(']');

      if (isIPv4 || isIPv6) {
        // 检查是否为私有 IP
        if (this.isPrivateIP(hostname)) {
          return { valid: false, reason: '禁止使用私有 IP 地址' };
        }
      }

      // 禁止 localhost
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1'
      ) {
        return { valid: false, reason: '禁止使用 localhost' };
      }

      return { valid: true };
    } catch {
      return { valid: false, reason: '无效的 URL' };
    }
  }

  /**
   * 检查是否为私有 IP 地址
   */
  private isPrivateIP(ip: string): boolean {
    // 移除 IPv6 方括号
    const cleanIp = ip.replace(/^\[|\]$/g, '');

    const parts = cleanIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return false;
    }

    const [a, b] = parts;

    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;

    return false;
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
        status === 'connected'
          ? new Date().toISOString()
          : this.status.lastConnectedAt,
      error,
    };
    Logger.debug(
      `${this.platform} 状态更新`,
      'IntegrationAdapter',
      this.status
    );
  }
}
