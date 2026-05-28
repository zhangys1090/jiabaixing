import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';
import {
  PlatformConfig,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';

export class WeChatAdapter extends BaseIntegrationAdapter {
  private accessToken?: string;
  private accessTokenExpiry?: number;

  constructor() {
    super('wechat');
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    try {
      this.config = config;
      this.updateStatus('connecting');

      // 在实际生产中应验证和获取访问令牌
      if (config.appId && config.appSecret) {
        // 模拟验证和连接过程
        Logger.info('正在连接到微信...', 'WeChatAdapter');
        await this.fetchAccessToken();

        this.updateStatus('connected');
        return true;
      } else {
        throw new Error('缺少必要的配置参数');
      }
    } catch (error) {
      Logger.error('连接微信失败', error as Error, 'WeChatAdapter');
      this.updateStatus('error', (error as Error).message);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.updateStatus('disconnected');
    this.accessToken = undefined;
    this.accessTokenExpiry = undefined;
    Logger.info('已断开与微信的连接', 'WeChatAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    _imageUrls?: string[],
    _mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (!this.status.connected) {
      return { success: false, error: '未连接到微信' };
    }

    try {
      // 在实际生产中，这里应该调用微信的 API
      Logger.info('正在发送消息到微信', 'WeChatAdapter', { to, message });

      // 模拟 API 调用
      await new Promise((resolve) => setTimeout(resolve, 200));

      return {
        success: true,
        messageId: `wx_msg_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      Logger.error('发送微信消息失败', error as Error, 'WeChatAdapter');
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async handleWebhook(
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown }> {
    try {
      // 验证签名
      const signature = payload.signature as string;
      const timestamp = payload.timestamp as string;
      const nonce = payload.nonce as string;

      // 在实际生产中验证请求签名
      Logger.debug('处理微信 Webhook', 'WeChatAdapter', {
        signature,
        timestamp,
        nonce,
      });

      // 验证通过，处理消息
      if (payload.msgtype === 'text') {
        const content = payload.content as string;
        const from = payload.fromusername as string;

        // 创建消息对象
        const message: IncomingMessageEvent = {
          platform: 'wechat',
          type: 'text',
          content,
          from,
          timestamp: new Date().toISOString(),
          rawData: payload,
        };

        // 处理并转发消息
        await this.emitMessage(message);
      }

      // 返回验证响应
      return {
        success: true,
        response: {
          success: true,
        },
      };
    } catch (error) {
      Logger.error('处理微信 Webhook 失败', error as Error, 'WeChatAdapter');
      return { success: false };
    }
  }

  private async fetchAccessToken(): Promise<void> {
    // 在实际生产环境中，这里应该调用微信的 API 获取访问令牌
    this.accessToken = 'wechat_demo_token_' + Date.now();
    this.accessTokenExpiry = Date.now() + 7200 * 1000;
    Logger.info('成功获取微信访问令牌', 'WeChatAdapter');
  }
}
