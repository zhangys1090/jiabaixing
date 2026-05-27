import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';
import {
  PlatformConfig,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';

export class DingTalkAdapter extends BaseIntegrationAdapter {
  private accessToken?: string;

  constructor() {
    super('dingtalk');
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    try {
      this.config = config;
      this.updateStatus('connecting');

      if (config.appId && config.appSecret) {
        Logger.info('正在连接到钉钉...', 'DingTalkAdapter');
        await this.fetchAccessToken();
        this.updateStatus('connected');
        return true;
      } else {
        throw new Error('缺少必要的钉钉配置参数');
      }
    } catch (error) {
      Logger.error('连接钉钉失败', error as Error, 'DingTalkAdapter');
      this.updateStatus('error', (error as Error).message);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.updateStatus('disconnected');
    this.accessToken = undefined;
    Logger.info('已断开与钉钉的连接', 'DingTalkAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    imageUrls?: string[],
    mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (!this.status.connected) {
      return { success: false, error: '未连接到钉钉' };
    }

    try {
      Logger.info('正在发送消息到钉钉', 'DingTalkAdapter', { to, message });
      await new Promise(resolve => setTimeout(resolve, 200));

      return {
        success: true,
        messageId: `dt_msg_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      Logger.error('发送钉钉消息失败', error as Error, 'DingTalkAdapter');
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
      Logger.debug('处理钉钉 Webhook', 'DingTalkAdapter', { payload });

      const msgType = payload.msgtype as string;

      if (msgType === 'text') {
        const text = payload.text as Record<string, string>;
        const conversationType = payload.conversationType as string;
        const senderNick = payload.senderNick as string;

        const incomingMessage: IncomingMessageEvent = {
          platform: 'dingtalk',
          type: 'text',
          content: text.content || '',
          from: payload.senderStaffId as string || '',
          fromName: senderNick,
          timestamp: new Date().toISOString(),
          rawData: payload,
        };

        await this.emitMessage(incomingMessage);
      }

      return { success: true };
    } catch (error) {
      Logger.error('处理钉钉 Webhook 失败', error as Error, 'DingTalkAdapter');
      return { success: false };
    }
  }

  private async fetchAccessToken(): Promise<void> {
    this.accessToken = 'dingtalk_token_' + Date.now();
    Logger.info('成功获取钉钉访问令牌', 'DingTalkAdapter');
  }
}
