import {
  IncomingMessageEvent,
  PlatformConfig,
  SendMessageResponse,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';
import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';

const WECHAT_API_BASE = 'https://api.weixin.qq.com/cgi-bin';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface WeChatTokenResponse {
  access_token: string;
  expires_in: number;
  errcode?: number;
  errmsg?: string;
}

interface WeChatSendResponse {
  errcode: number;
  errmsg: string;
  msgid?: number;
}

export class WeChatAdapter extends BaseIntegrationAdapter {
  private client: typeof fetch;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private appId = '';
  private appSecret = '';

  constructor() {
    super('wechat');
    this.client = fetch;
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    try {
      this.config = config;
      this.appId = config.appId || '';
      this.appSecret = config.appSecret || '';

      if (!this.appId || !this.appSecret) {
        throw new Error('缺少微信配置: 需要 appId 和 appSecret');
      }

      this.updateStatus('connecting');
      Logger.info('正在连接到微信...', 'WeChatAdapter');

      await this.refreshToken();
      this.startTokenRefresh();

      this.updateStatus('connected');
      Logger.info('微信连接成功', 'WeChatAdapter');
      return true;
    } catch (error) {
      Logger.error('连接微信失败', error as Error, 'WeChatAdapter');
      this.updateStatus('error', (error as Error).message);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopTokenRefresh();
    this.accessToken = undefined;
    this.tokenExpiresAt = 0;
    this.updateStatus('disconnected');
    Logger.info('已断开与微信的连接', 'WeChatAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    _imageUrls?: string[],
    _mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (!this.status.connected || !this.accessToken) {
      return { success: false, error: '未连接到微信' };
    }

    if (!to) {
      return { success: false, error: '缺少接收者 (openid)' };
    }

    try {
      await this.ensureToken();

      Logger.info('正在发送消息到微信', 'WeChatAdapter', {
        to,
        message: message.substring(0, 50),
      });

      const url = `${WECHAT_API_BASE}/message/custom/send?access_token=${this.accessToken}`;
      const body = {
        touser: to,
        msgtype: 'text',
        text: { content: message },
      };

      const response = await this.client(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as WeChatSendResponse;

      if (data.errcode === 0) {
        return {
          success: true,
          messageId: data.msgid?.toString() || `wx_msg_${Date.now()}`,
          timestamp: new Date().toISOString(),
        };
      }

      if (data.errcode === 40001 || data.errcode === 42001) {
        Logger.warn('微信 token 过期，尝试刷新', 'WeChatAdapter');
        await this.refreshToken();
        return this.sendMessage(message, to, _imageUrls, _mentions);
      }

      return {
        success: false,
        error: `微信 API 错误: ${data.errcode} - ${data.errmsg}`,
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
  ): Promise<{ success: boolean; response?: unknown; error?: string }> {
    try {
      Logger.debug('处理微信 Webhook', 'WeChatAdapter', { payload });

      const msgType = payload.msgtype as string;

      if (msgType === 'text') {
        const content = payload.content as string;
        const from = payload.fromusername as string;

        const message: IncomingMessageEvent = {
          platform: 'wechat',
          type: 'text',
          content,
          from,
          timestamp: new Date().toISOString(),
          rawData: payload,
        };

        await this.emitMessage(message);
      }

      if (payload.MsgType === 'event' && payload.Event === 'subscribe') {
        Logger.info('新用户关注微信公众号', 'WeChatAdapter', {
          from: payload.FromUserName,
        });
      }

      return {
        success: true,
        response: 'success',
      };
    } catch (error) {
      Logger.error('处理微信 Webhook 失败', error as Error, 'WeChatAdapter');
      return { success: false };
    }
  }

  private async refreshToken(): Promise<void> {
    try {
      const url = `${WECHAT_API_BASE}/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`;
      const response = await this.client(url, { method: 'GET' });
      const data = (await response.json()) as WeChatTokenResponse;

      if (data.errcode) {
        throw new Error(
          `获取微信 token 失败: ${data.errcode} - ${data.errmsg}`
        );
      }

      this.accessToken = data.access_token;
      const expiresIn = (data.expires_in || 7200) * 1000;
      this.tokenExpiresAt = Date.now() + expiresIn;
      Logger.info(
        `微信 token 获取成功，有效期 ${Math.round(expiresIn / 1000 / 60)} 分钟`,
        'WeChatAdapter'
      );
    } catch (error) {
      Logger.error('获取微信 token 失败', error as Error, 'WeChatAdapter');
      throw error;
    }
  }

  private async ensureToken(): Promise<void> {
    if (
      !this.accessToken ||
      Date.now() + TOKEN_REFRESH_MARGIN_MS >= this.tokenExpiresAt
    ) {
      await this.refreshToken();
    }
  }

  private startTokenRefresh(): void {
    this.stopTokenRefresh();
    this.tokenRefreshTimer = setInterval(
      async () => {
        try {
          await this.ensureToken();
        } catch {
          Logger.warn('微信 token 定时刷新失败', 'WeChatAdapter');
        }
      },
      5 * 60 * 1000
    );
  }

  private stopTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  static loadConfigFromEnv(): PlatformConfig | null {
    const enabled = process.env.WECHAT_ENABLED === 'true';
    if (!enabled) return null;

    return {
      appId: process.env.WECHAT_APP_ID || '',
      appSecret: process.env.WECHAT_APP_SECRET || '',
    };
  }
}
