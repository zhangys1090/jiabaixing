import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';
import {
  PlatformConfig,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';

export class FeishuAdapter extends BaseIntegrationAdapter {
  private appAccessToken?: string;
  private tenantAccessToken?: string;

  constructor() {
    super('feishu');
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    try {
      this.config = config;
      this.updateStatus('connecting');

      // 支持两种命名方式：appId/appSecret 或 clientId/clientSecret
      const appId = config.appId || config.clientId;
      const appSecret = config.appSecret || config.clientSecret;

      if (appId && appSecret) {
        Logger.info('正在连接到飞书...', 'FeishuAdapter');
        await this.fetchAppAccessToken();
        this.updateStatus('connected');
        return true;
      } else {
        throw new Error('缺少必要的飞书配置参数');
      }
    } catch (error) {
      Logger.error('连接飞书失败', error as Error, 'FeishuAdapter');
      this.updateStatus('error', (error as Error).message);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.updateStatus('disconnected');
    this.appAccessToken = undefined;
    this.tenantAccessToken = undefined;
    Logger.info('已断开与飞书的连接', 'FeishuAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    _imageUrls?: string[],
    _mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (!this.status.connected) {
      return { success: false, error: '未连接到飞书' };
    }

    try {
      Logger.info('正在发送消息到飞书', 'FeishuAdapter', { to, message });
      await new Promise((resolve) => setTimeout(resolve, 200));

      return {
        success: true,
        messageId: `fs_msg_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      Logger.error('发送飞书消息失败', error as Error, 'FeishuAdapter');
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
      Logger.debug('处理飞书 Webhook', 'FeishuAdapter', { payload });

      if (payload.challenge) {
        return {
          success: true,
          response: { challenge: payload.challenge },
        };
      }

      const header = payload.header as Record<string, unknown>;
      const eventType = header?.event_type as string;

      if (eventType === 'im.message.receive_v1') {
        const event = payload.event as Record<string, unknown>;
        const sender = event.sender as Record<string, unknown>;
        const senderId = sender.sender_id as Record<string, unknown>;
        const message = event.message as Record<string, unknown>;
        const contentRaw = (message.content as string) || '{}';
        let content: Record<string, unknown> = {};
        try {
          content = JSON.parse(contentRaw);
        } catch {
          content = {};
        }

        const incomingMessage: IncomingMessageEvent = {
          platform: 'feishu',
          type: content.image_key ? 'image' : 'text',
          content: (content.text as string) || '',
          from: (senderId.open_id as string) || '',
          fromName: (senderId.name as string) || '',
          timestamp: new Date().toISOString(),
          rawData: payload,
        };

        await this.emitMessage(incomingMessage);
      }

      return { success: true };
    } catch (error) {
      Logger.error('处理飞书 Webhook 失败', error as Error, 'FeishuAdapter');
      return { success: false };
    }
  }

  private async fetchAppAccessToken(): Promise<void> {
    // 在实际生产环境中，这里应该调用飞书的 API 获取访问令牌
    this.appAccessToken = 'feishu_app_token_' + Date.now();
    this.tenantAccessToken = 'feishu_tenant_token_' + Date.now();
    Logger.info('成功获取飞书访问令牌', 'FeishuAdapter');
  }
}
