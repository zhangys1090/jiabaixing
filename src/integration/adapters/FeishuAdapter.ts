import * as lark from '@larksuiteoapi/node-sdk';
import axios, { AxiosInstance } from 'axios';
import {
  IncomingMessageEvent,
  PlatformConfig,
  SendMessageResponse,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';
import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

/**
 * 飞书平台适配器（WebSocket 模式）
 *
 * 使用 @larksuiteoapi/node-sdk 官方 SDK 的 WebSocket 订阅，
 * 无需配置 Webhook URL，配好 App ID + Secret 自动连接收消息。
 */
export class FeishuAdapter extends BaseIntegrationAdapter {
  private client: AxiosInstance;
  private larkClient: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private appId = '';
  private appSecret = '';

  constructor() {
    super('feishu');
    this.client = axios.create({
      baseURL: FEISHU_BASE_URL,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    this.config = config;
    this.appId = config.appId || config.clientId || '';
    this.appSecret = config.appSecret || config.clientSecret || '';

    if (!this.appId || !this.appSecret) {
      Logger.error(
        '缺少飞书配置: 需要 appId 和 appSecret',
        undefined,
        'FeishuAdapter'
      );
      this.updateStatus('error', '缺少 appId 或 appSecret');
      return false;
    }

    this.updateStatus('connecting');
    Logger.info('正在连接到飞书（WebSocket 模式）...', 'FeishuAdapter');

    // 创建 Lark Client（用于后续发消息）
    this.larkClient = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: 'https://open.feishu.cn',
    });

    // 注册事件处理器
    const eventHandler = new lark.EventDispatcher({
      encryptKey: '',
      verificationToken: '',
    }).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        await this.handleMessageEvent(data);
      },
    });

    // 重试连接：SDK WSClient 只能 start() 一次，每次重试需新建实例
    const MAX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // 每次尝试新建 WSClient（SDK 限制，start() 后不能再用同一实例）
      if (this.wsClient) {
        try {
          await (
            this.wsClient as unknown as { stop: () => Promise<void> }
          ).stop();
        } catch {
          /* ignore */
        }
        this.wsClient = null;
      }
      const wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: 'https://open.feishu.cn', // 完整 base URL，SDK 拼接 /callback/ws/endpoint
        autoReconnect: true,
        loggerLevel: lark.LoggerLevel.warn,
      });
      this.wsClient = wsClient;

      try {
        await wsClient.start({ eventDispatcher: eventHandler });
        this.updateStatus('connected');
        Logger.info('✅ 飞书 WebSocket 连接成功', 'FeishuAdapter');
        return true;
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        Logger.warn(
          `飞书 WS 连接尝试 #${attempt} 失败: ${errMsg}`,
          'FeishuAdapter'
        );

        if (attempt < MAX_RETRIES) {
          Logger.info('等待 3 秒后重试飞书连接...', 'FeishuAdapter');
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          Logger.error(
            `飞书 WebSocket 连接失败（已重试 ${MAX_RETRIES} 次）`,
            error as Error,
            'FeishuAdapter'
          );
          this.updateStatus('error', errMsg);
          return false;
        }
      }
    }

    return false;
  }

  async disconnect(): Promise<void> {
    try {
      if (this.wsClient) {
        await (
          this.wsClient as unknown as { stop: () => Promise<void> }
        ).stop();
        this.wsClient = null;
      }
    } catch (e) {
      Logger.warn(`飞书断开连接时出错: ${e}`, 'FeishuAdapter');
    }
    this.larkClient = null;
    this.updateStatus('disconnected');
    Logger.info('已断开与飞书的连接', 'FeishuAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    _imageUrls?: string[],
    _mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (!this.status.connected || !this.larkClient) {
      return { success: false, error: '未连接到飞书' };
    }

    if (!to) {
      return { success: false, error: '缺少接收者 (to)' };
    }

    try {
      const receiveIdType = to.startsWith('ou_')
        ? 'open_id'
        : to.startsWith('oc_')
          ? 'chat_id'
          : to.startsWith('om_')
            ? 'union_id'
            : 'open_id';

      const content = JSON.stringify({ text: message });

      const resp = await this.larkClient.im.message.create({
        params: {
          receive_id_type: receiveIdType as 'open_id' | 'chat_id' | 'user_id',
        },
        data: {
          receive_id: to,
          msg_type: 'text',
          content,
        },
      });

      return {
        success: true,
        messageId:
          (resp as { data?: { message_id?: string } })?.data?.message_id ||
          `fs_msg_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      Logger.error('发送飞书消息失败', error as Error, 'FeishuAdapter');
      return { success: false, error: (error as Error).message };
    }
  }

  async handleWebhook(
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown; error?: string }> {
    // WebSocket 模式不需要 Webhook，保留仅用于 URL Challenge
    if (payload.challenge) {
      return { success: true, response: { challenge: payload.challenge } };
    }
    return { success: false, error: 'WebSocket 模式不支持 HTTP Webhook' };
  }

  // ==================== 事件处理 ====================

  /**
   * 处理收到的飞书消息
   */
  private async handleMessageEvent(
    data: Record<string, unknown>
  ): Promise<void> {
    try {
      const event = (data?.event || data) as Record<string, unknown>;
      const message = (event?.message || {}) as Record<string, unknown>;
      const sender = (event?.sender || {}) as Record<string, unknown>;

      const senderId = (sender?.sender_id || {}) as Record<string, string>;
      const contentRaw = message?.content || '{}';
      const messageType = message?.message_type || 'text';

      let content: Record<string, unknown> = {};
      try {
        content =
          typeof contentRaw === 'string' ? JSON.parse(contentRaw) : contentRaw;
      } catch {
        content = {};
      }

      let textContent = '';
      if (messageType === 'text') {
        textContent =
          ((content as Record<string, unknown>)?.text as string) || '';
      } else if (messageType === 'post') {
        textContent = this.extractPostText(content);
      } else if (messageType === 'image') {
        textContent = '[图片消息]';
      } else if (messageType === 'file') {
        textContent = `[文件: ${(content as Record<string, unknown>)?.file_name || '未知'}]`;
      } else if (messageType === 'audio') {
        textContent = '[语音消息]';
      } else {
        textContent = `[${messageType || '未知'}消息]`;
      }

      const incomingMessage: IncomingMessageEvent = {
        platform: 'feishu',
        type: messageType === 'image' ? 'image' : 'text',
        content: textContent,
        from:
          (senderId as Record<string, string>)?.open_id ||
          (senderId as Record<string, string>)?.user_id ||
          (sender as Record<string, string>)?.open_id ||
          '',
        fromName: (sender as Record<string, string>)?.name || '',
        timestamp: new Date().toISOString(),
        rawData: data,
      };

      Logger.info(
        `📩 飞书消息 | from=${incomingMessage.from} | type=${messageType} | text=${textContent.substring(0, 50)}`,
        'FeishuAdapter'
      );

      await this.emitMessage(incomingMessage);
    } catch (error) {
      Logger.error('处理飞书消息失败', error as Error, 'FeishuAdapter');
    }
  }

  private extractPostText(content: Record<string, unknown>): string {
    const lines: string[] = [];
    const zhCn = (content.zh_cn || content) as Record<string, unknown>;
    const contentArr = zhCn.content as Array<Array<Record<string, unknown>>>;
    if (Array.isArray(contentArr)) {
      for (const paragraph of contentArr) {
        if (Array.isArray(paragraph)) {
          const textParts = paragraph
            .filter((item: Record<string, unknown>) => item.tag === 'text')
            .map(
              (item: Record<string, unknown>) => (item.text as string) || ''
            );
          if (textParts.length > 0) lines.push(textParts.join(''));
        }
      }
    }
    return lines.join('\n') || '[富文本消息]';
  }
}
