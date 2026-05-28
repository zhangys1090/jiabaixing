import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';
import {
  PlatformConfig,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';

interface MiraiSession {
  sessionKey: string;
  code: number;
}

interface MiraiMessage {
  type: string;
  sender: {
    id: number;
    nickname: string;
    remark?: string;
  };
  messageChain: Array<{
    type: string;
    text?: string;
    imageId?: string;
    url?: string;
  }>;
}

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1500;

export class QQAdapter extends BaseIntegrationAdapter {
  private sessionKey?: string;
  private httpBaseUrl: string = 'http://localhost:8080';
  private pollingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts: number = 0;
  private shouldAutoReconnect: boolean = true;
  private qqAccount?: string;
  private miraiVerifyKey?: string;

  constructor() {
    super('qq');
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    try {
      this.config = config;
      this.updateStatus('connecting');
      this.reconnectAttempts = 0;
      this.shouldAutoReconnect = true;

      this.httpBaseUrl = `http://${config.miraiHttpHost || 'localhost'}:${config.miraiHttpPort || '8080'}`;
      this.qqAccount = config.qqAccount;
      this.miraiVerifyKey = config.miraiVerifyKey;

      Logger.info('正在通过 Mirai 连接到 QQ...', 'QQAdapter');

      const session = await this.verifySession(this.miraiVerifyKey || '');
      if (session.code !== 0) {
        const errorMap: Record<number, string> = {
          1: 'verifyKey 错误',
          2: 'Session 错误或过期',
          3: '未绑定 QQ 账号',
          4: ' mirai-api-http 版本不兼容',
        };
        throw new Error(
          errorMap[session.code] || `连接失败 (code: ${session.code})`
        );
      }

      this.sessionKey = session.sessionKey;

      if (this.qqAccount) {
        const bindResult = await this.bindQQ(this.qqAccount);
        if (!bindResult) {
          throw new Error(`绑定 QQ ${this.qqAccount} 失败`);
        }
      }

      this.updateStatus('connected');
      this.startPolling();
      this.reconnectAttempts = 0;

      Logger.info(
        `QQ 机器人已连接 (Session: ${this.sessionKey?.slice(0, 8)}...)`,
        'QQAdapter'
      );
      return true;
    } catch (error) {
      Logger.error('连接 QQ 失败', error as Error, 'QQAdapter');
      this.updateStatus('error', (error as Error).message);
      void this.scheduleReconnect();
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.shouldAutoReconnect = false;
    this.stopPolling();
    this.cancelReconnect();

    if (this.sessionKey && this.qqAccount) {
      try {
        await fetch(`${this.httpBaseUrl}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionKey: this.sessionKey,
            qq: Number(this.qqAccount),
          }),
        });
      } catch {
        // 忽略释放 session 时的错误
      }
    }

    this.sessionKey = undefined;
    this.updateStatus('disconnected');
    Logger.info('已断开 QQ 连接', 'QQAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    imageUrls?: string[],
    mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (!this.status.connected || !this.sessionKey) {
      return { success: false, error: '未连接到 QQ' };
    }

    try {
      const messageChain: Array<Record<string, unknown>> = [];

      if (mentions && mentions.length > 0) {
        for (const target of mentions) {
          messageChain.push({ type: 'At', target: Number(target) });
        }
      }

      if (imageUrls && imageUrls.length > 0) {
        for (const url of imageUrls) {
          messageChain.push({ type: 'Image', url });
        }
      }

      messageChain.push({ type: 'Plain', text: message });

      const targetId = to ? Number(to) : 0;
      if (!targetId) {
        return { success: false, error: '缺少接收人' };
      }

      const isGroup = to?.startsWith('g') || to?.startsWith('group_');
      const actualTarget = isGroup
        ? Number(to?.replace(/^(g|group_)/, ''))
        : targetId;

      let endpoint: string;
      let body: Record<string, unknown>;

      if (isGroup) {
        endpoint = `${this.httpBaseUrl}/sendGroupMessage`;
        body = {
          sessionKey: this.sessionKey,
          target: actualTarget,
          messageChain,
        };
      } else {
        endpoint = `${this.httpBaseUrl}/sendFriendMessage`;
        body = {
          sessionKey: this.sessionKey,
          target: actualTarget,
          messageChain,
        };
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Mirai API 返回状态码: ${response.status}`);
      }

      const result = await response.json();
      if (result.code !== 0) {
        throw new Error(`Mirai 发送失败 (code: ${result.code})`);
      }

      return {
        success: true,
        messageId: `qq_msg_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      Logger.error('发送 QQ 消息失败', error as Error, 'QQAdapter');
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async handleWebhook(
    _payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown }> {
    return { success: true, response: { handled: false } };
  }

  private async verifySession(verifyKey: string): Promise<MiraiSession> {
    Logger.info('正在验证 Mirai Session...', 'QQAdapter');

    const response = await fetch(`${this.httpBaseUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verifyKey }),
    });

    if (!response.ok) {
      throw new Error(`Mirai 服务未启动 (${response.status})`);
    }

    return response.json();
  }

  private async bindQQ(qq: string): Promise<boolean> {
    if (!this.sessionKey) return false;

    Logger.info(`正在绑定 QQ ${qq}...`, 'QQAdapter');

    const response = await fetch(`${this.httpBaseUrl}/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKey: this.sessionKey,
        qq: Number(qq),
      }),
    });

    if (!response.ok) return false;

    const result = await response.json();
    return result.code === 0;
  }

  private async fetchNewMessages(): Promise<void> {
    if (!this.sessionKey || !this.status.connected) return;

    try {
      const response = await fetch(`${this.httpBaseUrl}/fetchMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: this.sessionKey, count: 10 }),
      });

      if (!response.ok) {
        if (response.status === 500) {
          Logger.warn('Mirai Session 可能已过期，准备重连', 'QQAdapter');
          this.updateStatus('error', 'Session 过期');
          void this.scheduleReconnect();
        }
        return;
      }

      const data = await response.json();
      const messages: MiraiMessage[] = data.data || [];

      for (const msg of messages) {
        const textContent = msg.messageChain
          .filter((c) => c.type === 'Plain')
          .map((c) => c.text || '')
          .join('');

        const hasImage = msg.messageChain.some((c) => c.type === 'Image');

        const incoming: IncomingMessageEvent = {
          platform: 'qq',
          type: hasImage ? 'image' : 'text',
          content: textContent,
          from: String(msg.sender.id),
          fromName:
            msg.sender.nickname || msg.sender.remark || String(msg.sender.id),
          timestamp: new Date().toISOString(),
          rawData: msg as unknown as Record<string, unknown>,
        };

        await this.emitMessage(incoming);
      }
    } catch {
      // 轮询失败，可能网络问题，下次轮询继续
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollingTimer = setInterval(() => {
      void this.fetchNewMessages();
    }, POLL_INTERVAL_MS);
    Logger.info('QQ 消息轮询已启动', 'QQAdapter');
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (!this.shouldAutoReconnect) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      Logger.error(
        `QQ 重连已达最大次数 (${MAX_RECONNECT_ATTEMPTS})，停止重连`,
        undefined,
        'QQAdapter'
      );
      return;
    }

    const delay = Math.min(
      RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts - 1),
      60000
    );

    Logger.info(
      `QQ 将在 ${Math.round(delay / 1000)} 秒后重连 (第 ${this.reconnectAttempts} 次)`,
      'QQAdapter'
    );

    this.reconnectTimer = setTimeout(async () => {
      Logger.info('正在重连 QQ...', 'QQAdapter');
      await this.connect({
        miraiHttpHost: this.config.miraiHttpHost,
        miraiHttpPort: this.config.miraiHttpPort,
        miraiVerifyKey: this.miraiVerifyKey,
        qqAccount: this.qqAccount,
      });
    }, delay);
  }

  /**
   * 从环境变量加载 QQ 配置
   */
  static loadConfigFromEnv(): PlatformConfig | null {
    const enabled = process.env.QQ_ENABLED === 'true';
    if (!enabled) return null;

    return {
      miraiHttpHost: process.env.MIRAI_HTTP_HOST || 'localhost',
      miraiHttpPort: process.env.MIRAI_HTTP_PORT || '8080',
      miraiVerifyKey: process.env.MIRAI_VERIFY_KEY || '',
      qqAccount: process.env.QQ_ACCOUNT || '',
    };
  }
}
