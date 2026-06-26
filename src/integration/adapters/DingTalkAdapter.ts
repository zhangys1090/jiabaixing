import {
  IncomingMessageEvent,
  PlatformConfig,
  SendMessageResponse,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';
import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';

const DINGTALK_OAPI_BASE = 'https://oapi.dingtalk.com';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface DingTalkTokenResponse {
  errcode: number;
  errmsg: string;
  access_token: string;
  expires_in: number;
}

interface DingTalkSendResponse {
  errcode: number;
  errmsg: string;
  task_id?: number;
  message_id?: string;
}

export class DingTalkAdapter extends BaseIntegrationAdapter {
  private client: typeof fetch;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private appKey = '';
  private appSecret = '';

  constructor() {
    super('dingtalk');
    this.client = fetch;
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    try {
      this.config = config;
      this.appKey = config.appId || config.clientId || '';
      this.appSecret = config.appSecret || config.clientSecret || '';

      if (!this.appKey || !this.appSecret) {
        throw new Error(
          '缺少钉钉配置: 需要 appKey/appSecret (或 clientId/clientSecret)'
        );
      }

      this.updateStatus('connecting');
      Logger.info('正在连接到钉钉...', 'DingTalkAdapter');

      await this.refreshToken();
      this.startTokenRefresh();

      this.updateStatus('connected');
      Logger.info('钉钉连接成功', 'DingTalkAdapter');
      return true;
    } catch (error) {
      Logger.error('连接钉钉失败', error as Error, 'DingTalkAdapter');
      this.updateStatus('error', (error as Error).message);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopTokenRefresh();
    this.accessToken = undefined;
    this.tokenExpiresAt = 0;
    this.updateStatus('disconnected');
    Logger.info('已断开与钉钉的连接', 'DingTalkAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    imageUrls?: string[],
    _mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (!this.status.connected || !this.accessToken) {
      return { success: false, error: '未连接到钉钉' };
    }

    if (!to) {
      return { success: false, error: '缺少接收者 (to)' };
    }

    try {
      await this.ensureToken();

      Logger.info('正在发送消息到钉钉', 'DingTalkAdapter', {
        to,
        message: message.substring(0, 50),
      });

      const isGroup = to.startsWith('cid') || to.startsWith('group_');
      const actualTo = to.replace(/^group_/, '');

      const msgKey = isGroup ? 'sampleText' : 'sampleText';
      const msgParam = JSON.stringify({ content: message });

      const endpoint = isGroup
        ? `${DINGTALK_OAPI_BASE}/topapi/message/corpconversation/asyncsend_v2`
        : `${DINGTALK_OAPI_BASE}/v1.0/robot/oToMessages/batchSend`;

      const body = isGroup
        ? {
            access_token: this.accessToken,
            agent_id: this.config.agentId || '',
            userid_list: actualTo,
            msg: {
              msgtype: 'text',
              text: { content: message },
            },
          }
        : {
            msgKey,
            msgParam,
            userIds: [actualTo],
            robotCode: this.appKey,
          };

      const response = await this.client(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': this.accessToken,
        },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as DingTalkSendResponse;

      if (data.errcode === 0 || response.ok) {
        return {
          success: true,
          messageId:
            data.task_id?.toString() ||
            data.message_id ||
            `dt_msg_${Date.now()}`,
          timestamp: new Date().toISOString(),
        };
      }

      if (data.errcode === 40001 || data.errcode === 40014) {
        Logger.warn('钉钉 token 过期，尝试刷新', 'DingTalkAdapter');
        await this.refreshToken();
        return this.sendMessage(message, to, imageUrls, _mentions);
      }

      return {
        success: false,
        error: `钉钉 API 错误: ${data.errcode} - ${data.errmsg}`,
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
  ): Promise<{ success: boolean; response?: unknown; error?: string }> {
    try {
      Logger.debug('处理钉钉 Webhook', 'DingTalkAdapter', { payload });

      const msgType = payload.msgtype as string;

      if (msgType === 'text') {
        const text = payload.text as Record<string, string>;
        const senderNick = payload.senderNick as string;

        const incomingMessage: IncomingMessageEvent = {
          platform: 'dingtalk',
          type: 'text',
          content: text.content || '',
          from: (payload.senderStaffId as string) || '',
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

  private async refreshToken(): Promise<void> {
    try {
      const url = `${DINGTALK_OAPI_BASE}/gettoken?appkey=${this.appKey}&appsecret=${this.appSecret}`;
      const response = await this.client(url, { method: 'GET' });
      const data = (await response.json()) as DingTalkTokenResponse;

      if (data.errcode !== 0) {
        throw new Error(
          `获取钉钉 token 失败: ${data.errcode} - ${data.errmsg}`
        );
      }

      this.accessToken = data.access_token;
      const expiresIn = (data.expires_in || 7200) * 1000;
      this.tokenExpiresAt = Date.now() + expiresIn;
      Logger.info(
        `钉钉 token 获取成功，有效期 ${Math.round(expiresIn / 1000 / 60)} 分钟`,
        'DingTalkAdapter'
      );
    } catch (error) {
      Logger.error('获取钉钉 token 失败', error as Error, 'DingTalkAdapter');
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
          Logger.warn('钉钉 token 定时刷新失败', 'DingTalkAdapter');
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
    const enabled = process.env.DINGTALK_ENABLED === 'true';
    if (!enabled) return null;

    return {
      appId: process.env.DINGTALK_APP_KEY || '',
      appSecret: process.env.DINGTALK_APP_SECRET || '',
      agentId: process.env.DINGTALK_AGENT_ID || '',
    };
  }
}
