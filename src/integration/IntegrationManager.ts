import * as crypto from 'crypto';
import type { JiabaixingCore } from '../core/JiabaixingCore';
import {
  IncomingMessageEvent,
  IntegrationPlatform,
  IntegrationPlatformInfo,
  IntegrationStatus,
  PlatformConfig,
  SendMessageRequest,
  SendMessageResponse,
} from '../shared/contracts';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { BaseIntegrationAdapter } from './adapters/BaseIntegrationAdapter';
import { DingTalkAdapter } from './adapters/DingTalkAdapter';
import { DiscordAdapter } from './adapters/DiscordAdapter';
import { FeishuAdapter } from './adapters/FeishuAdapter';
import { QQAdapter } from './adapters/QQAdapter';
import { SlackAdapter } from './adapters/SlackAdapter';
import { TelegramAdapter } from './adapters/TelegramAdapter';
import { WeChatAdapter } from './adapters/WeChatAdapter';
import { WeChatQRAdapter } from './adapters/WeChatQRAdapter';

/**
 * Webhook 端点配置
 */
export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
  headers?: Record<string, string>;
  retryCount?: number;
  timeout?: number;
}

/**
 * Webhook 投递请求体
 */
interface WebhookPayload {
  event: string;
  data: unknown;
  timestamp: number;
  source: string;
}

const PLATFORM_INFO: Record<
  IntegrationPlatform,
  Omit<IntegrationPlatformInfo, 'status' | 'available'>
> = {
  wechat: {
    id: 'wechat',
    name: '微信',
    icon: '💬',
    description: '扫码登录个人微信 / 企业号/公众号',
    enabled: true,
  },
  feishu: {
    id: 'feishu',
    name: '飞书',
    icon: '✈️',
    description: '连接到飞书平台',
    enabled: true,
  },
  dingtalk: {
    id: 'dingtalk',
    name: '钉钉',
    icon: '📌',
    description: '连接到钉钉平台',
    enabled: true,
  },
  qq: {
    id: 'qq',
    name: 'QQ',
    icon: '🐧',
    description: '通过 Mirai 连接 QQ 机器人',
    enabled: true,
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    icon: '✈️',
    description: '通过 Bot API 连接 Telegram 机器人',
    enabled: true,
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    icon: '🎮',
    description: '通过 Webhook 连接 Discord 频道',
    enabled: true,
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    icon: '📱',
    description: '通过 Webhook 连接 Slack 工作区',
    enabled: true,
  },
  signal: {
    id: 'signal',
    name: 'Signal',
    icon: '🔒',
    description: '连接到 Signal 平台（预留）',
    enabled: false,
  },
};

export class IntegrationManager {
  private adapters: Map<IntegrationPlatform, BaseIntegrationAdapter> =
    new Map();
  private webhookEndpoints: Map<string, WebhookEndpoint> = new Map();
  private static instance: IntegrationManager;
  private static skipAutoConnect = false;
  private core: JiabaixingCore | null = null;

  private constructor() {
    this.initializeAdapters();
  }

  /**
   * 获取 IntegrationManager 单例
   * @param skipAutoConnect - 是否跳过自动连接（主进程不需要自动连接平台，由 Gateway Worker 负责）
   */
  static getInstance(skipAutoConnect = false): IntegrationManager {
    if (!IntegrationManager.instance) {
      IntegrationManager.skipAutoConnect = skipAutoConnect;
      IntegrationManager.instance = new IntegrationManager();
    }
    return IntegrationManager.instance;
  }

  setCore(core: JiabaixingCore): void {
    this.core = core;
    Logger.info(
      '✅ JiabaixingCore 已注入到 IntegrationManager',
      'IntegrationManager'
    );
  }

  private initializeAdapters(): void {
    // 默认用官方 API 模式
    this.adapters.set('wechat', new WeChatAdapter());
    this.adapters.set('feishu', new FeishuAdapter());
    this.adapters.set('dingtalk', new DingTalkAdapter());
    this.adapters.set('qq', new QQAdapter());
    this.adapters.set('telegram', new TelegramAdapter());
    this.adapters.set('discord', new DiscordAdapter());
    this.adapters.set('slack', new SlackAdapter());

    // 为每个适配器注册消息处理
    for (const adapter of this.adapters.values()) {
      adapter.onMessage(async (message: IncomingMessageEvent) => {
        void this.handleIncomingMessage(message);
      });
    }

    Logger.info('集成管理器初始化完成', 'IntegrationManager');

    if (IntegrationManager.skipAutoConnect) {
      Logger.info(
        '跳过平台自动连接 (skipAutoConnect=true)，由 Gateway Worker 负责',
        'IntegrationManager'
      );
      return;
    }

    // 如果环境变量配置了 QQ，自动连接
    void this.autoConnectQQ();
    // 如果环境变量配置了 Telegram，自动连接
    void this.autoConnectTelegram();
    // 如果环境变量配置了飞书，自动连接
    void this.autoConnectFeishu();
  }

  /**
   * 从环境变量自动连接 QQ
   */
  private async autoConnectQQ(): Promise<void> {
    const qqConfig = QQAdapter.loadConfigFromEnv();
    if (!qqConfig) {
      Logger.info('QQ 自动连接未启用 (QQ_ENABLED=false)', 'IntegrationManager');
      return;
    }

    Logger.info(
      '检测到 QQ 环境变量配置，正在自动连接...',
      'IntegrationManager'
    );

    // 等待 2 秒让系统完全就绪
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const success = await this.connectPlatform('qq', qqConfig);
    if (success) {
      Logger.info('QQ 机器人自动连接成功', 'IntegrationManager');
    } else {
      Logger.warn(
        'QQ 机器人自动连接失败，将在后台自动重试',
        'IntegrationManager'
      );
    }
  }

  /**
   * 从环境变量自动连接 Telegram
   */
  private async autoConnectTelegram(): Promise<void> {
    const telegramConfig = TelegramAdapter.loadConfigFromEnv();
    if (!telegramConfig) {
      Logger.info(
        'Telegram 自动连接未启用 (TELEGRAM_ENABLED=false)',
        'IntegrationManager'
      );
      return;
    }

    Logger.info(
      '检测到 Telegram 环境变量配置，正在自动连接...',
      'IntegrationManager'
    );

    // 等待 2 秒让系统完全就绪
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const success = await this.connectPlatform('telegram', telegramConfig);
    if (success) {
      Logger.info('Telegram 机器人自动连接成功', 'IntegrationManager');
    } else {
      Logger.warn('Telegram 机器人自动连接失败', 'IntegrationManager');
    }
  }

  /**
   * 从环境变量自动连接飞书
   */
  private async autoConnectFeishu(): Promise<void> {
    const appId = process.env.FEISHU_APP_ID || '';
    const appSecret = process.env.FEISHU_APP_SECRET || '';

    if (!appId || !appSecret) {
      Logger.info(
        '飞书自动连接未启用 (缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET)',
        'IntegrationManager'
      );
      return;
    }

    Logger.info(
      '检测到飞书环境变量配置，正在自动连接...',
      'IntegrationManager'
    );

    // 等待 2 秒让系统完全就绪
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const success = await this.connectPlatform('feishu', {
      appId,
      appSecret,
    });
    if (success) {
      Logger.info('飞书自动连接成功', 'IntegrationManager');
    } else {
      Logger.warn('飞书自动连接失败，将在后台自动重试', 'IntegrationManager');
    }
  }

  /**
   * 获取所有支持的平台信息
   */
  getPlatforms(): IntegrationPlatformInfo[] {
    const platforms: IntegrationPlatformInfo[] = [];
    for (const [key, info] of Object.entries(PLATFORM_INFO)) {
      const adapter = this.adapters.get(key as IntegrationPlatform);
      platforms.push({
        ...info,
        available: true,
        status: adapter?.getStatus(),
      });
    }
    return platforms;
  }

  /**
   * 连接到指定平台
   */
  async connectPlatform(
    platform: IntegrationPlatform,
    config: PlatformConfig
  ): Promise<boolean> {
    // 微信 QR 扫码模式：替换为 QR 适配器
    if (platform === 'wechat' && config.mode === 'qr') {
      const qrAdapter = new WeChatQRAdapter();
      this.adapters.set('wechat', qrAdapter);
      qrAdapter.onMessage(async (message: IncomingMessageEvent) => {
        void this.handleIncomingMessage(message);
      });
    }

    const adapter = this.adapters.get(platform);
    if (!adapter) {
      Logger.warn(`不支持的平台: ${platform}`, 'IntegrationManager');
      return false;
    }

    try {
      const success = await adapter.connect(config);
      if (success) {
        EventBus.emit('integration_connected', {
          platform,
          timestamp: new Date().toISOString(),
        });
        Logger.info(`成功连接到 ${platform}`, 'IntegrationManager');
      }
      return success;
    } catch (error) {
      Logger.error(
        `连接 ${platform} 失败`,
        error as Error,
        'IntegrationManager'
      );
      return false;
    }
  }

  /**
   * 断开平台连接
   */
  async disconnectPlatform(platform: IntegrationPlatform): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return;
    }
    await adapter.disconnect();
    EventBus.emit('integration_disconnected', {
      platform,
      timestamp: new Date().toISOString(),
    });
    Logger.info(`断开了 ${platform} 的连接`, 'IntegrationManager');
  }

  /**
   * 发送消息到指定平台
   */
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResponse> {
    const adapter = this.adapters.get(request.platform);
    if (!adapter) {
      return {
        success: false,
        error: '不支持的平台',
      };
    }
    return await adapter.sendMessage(
      request.message,
      request.to,
      request.imageUrls,
      request.mentions
    );
  }

  /**
   * 处理 Webhook
   */
  async handleWebhook(
    platform: IntegrationPlatform,
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown; error?: string }> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return { success: false };
    }
    return await adapter.handleWebhook(payload);
  }

  /**
   * 获取平台状态
   */
  getPlatformStatus(
    platform: IntegrationPlatform
  ): IntegrationStatus | undefined {
    return this.adapters.get(platform)?.getStatus();
  }

  /**
   * 获取微信 QR 扫码状态（仅限 QR 模式）
   */
  getWeChatQRState(): {
    qrCodeBase64: string | null;
    status: string;
    botNickname: string | null;
  } | null {
    const adapter = this.adapters.get('wechat');
    if (adapter instanceof WeChatQRAdapter) {
      const state = adapter.getQRState();
      return {
        qrCodeBase64: state.qrCodeBase64,
        status: state.status,
        botNickname: state.botNickname,
      };
    }
    return null;
  }

  /**
   * 处理收到的消息
   */
  private async handleIncomingMessage(
    message: IncomingMessageEvent
  ): Promise<void> {
    Logger.info(
      `收到来自 ${message.platform} 的消息: ${message.from}`,
      'IntegrationManager'
    );

    // 通过 EventBus 广播消息
    EventBus.emit('integration_message', {
      platform: message.platform,
      type: message.type,
      content: message.content,
      from: message.from,
      fromName: message.fromName,
      timestamp: message.timestamp || new Date().toISOString(),
      rawData: message.rawData,
    });

    // 如果 core 已注入，直接调用 core.processInput 并自动回复
    if (this.core) {
      try {
        Logger.info(
          `📨 路由消息到 core.processInput: ${message.platform} <- ${message.from}: ${message.content.substring(0, 50)}...`,
          'IntegrationManager'
        );

        const result = await this.core.processInput(
          message.content,
          message.from || 'gateway',
          undefined
        );

        if (result.response) {
          await this.sendMessage({
            platform: message.platform,
            message: result.response,
            to: message.from || '',
          });
          Logger.info(
            `📤 回复已发送: ${result.response.substring(0, 50)}...`,
            'IntegrationManager'
          );
        }
      } catch (error) {
        Logger.error(
          'IntegrationManager 处理消息失败',
          error as Error,
          'IntegrationManager'
        );
      }
    }
  }

  // ====================== Webhook 推送功能 ======================

  /**
   * 注册 Webhook 端点
   * @param endpoint - Webhook 端点配置
   */
  registerWebhook(endpoint: WebhookEndpoint): void {
    if (this.webhookEndpoints.has(endpoint.id)) {
      Logger.warn(
        `Webhook 端点已存在，将覆盖: ${endpoint.id}`,
        'IntegrationManager'
      );
    }
    this.webhookEndpoints.set(endpoint.id, endpoint);
    Logger.info(
      `Webhook 端点已注册: ${endpoint.id} (${endpoint.name}), 订阅事件: [${endpoint.events.join(', ')}]`,
      'IntegrationManager'
    );
  }

  /**
   * 注销 Webhook 端点
   * @param id - Webhook 端点 ID
   */
  unregisterWebhook(id: string): void {
    const removed = this.webhookEndpoints.delete(id);
    if (removed) {
      Logger.info(`Webhook 端点已注销: ${id}`, 'IntegrationManager');
    } else {
      Logger.warn(`Webhook 端点不存在: ${id}`, 'IntegrationManager');
    }
  }

  /**
   * 列出所有 Webhook 端点
   * @returns Webhook 端点列表
   */
  listWebhooks(): WebhookEndpoint[] {
    return Array.from(this.webhookEndpoints.values());
  }

  /**
   * 获取指定 Webhook 端点
   * @param id - Webhook 端点 ID
   * @returns Webhook 端点配置，不存在则返回 undefined
   */
  getWebhook(id: string): WebhookEndpoint | undefined {
    return this.webhookEndpoints.get(id);
  }

  /**
   * 向所有订阅了指定事件的 Webhook 端点推送通知
   * @param eventType - 事件类型
   * @param payload - 事件数据
   */
  async pushToWebhooks(eventType: string, payload: unknown): Promise<void> {
    const matchedEndpoints = Array.from(this.webhookEndpoints.values()).filter(
      (ep) => ep.enabled && ep.events.includes(eventType)
    );

    if (matchedEndpoints.length === 0) {
      return;
    }

    Logger.info(
      `推送事件 ${eventType} 到 ${matchedEndpoints.length} 个 Webhook`,
      'IntegrationManager'
    );

    const results = await Promise.allSettled(
      matchedEndpoints.map((endpoint) =>
        this.deliverWebhook(endpoint, eventType, payload)
      )
    );

    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount > 0) {
      Logger.warn(
        `事件 ${eventType} 推送完成: ${matchedEndpoints.length - failedCount}/${matchedEndpoints.length} 成功`,
        'IntegrationManager'
      );
    }
  }

  /**
   * 单个 Webhook 投递（带重试和 HMAC 签名）
   * @param endpoint - Webhook 端点配置
   * @param eventType - 事件类型
   * @param payload - 事件数据
   * @returns 投递是否成功
   */
  async deliverWebhook(
    endpoint: WebhookEndpoint,
    eventType: string,
    payload: unknown
  ): Promise<boolean> {
    const body: WebhookPayload = {
      event: eventType,
      data: payload,
      timestamp: Date.now(),
      source: 'jiabaixing',
    };

    const bodyStr = JSON.stringify(body);
    const maxRetries = endpoint.retryCount ?? 3;
    const timeout = endpoint.timeout ?? 5000;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...endpoint.headers,
    };

    // HMAC-SHA256 签名
    if (endpoint.secret) {
      const signature = crypto
        .createHmac('sha256', endpoint.secret)
        .update(bodyStr)
        .digest('hex');
      headers['X-Jiabaixing-Signature'] = `sha256=${signature}`;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers,
          body: bodyStr,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          Logger.info(
            `Webhook 投递成功: ${endpoint.id} (${eventType}), 状态码=${response.status}`,
            'IntegrationManager'
          );
          return true;
        }

        Logger.warn(
          `Webhook 投递失败: ${endpoint.id} (${eventType}), 状态码=${response.status}`,
          'IntegrationManager'
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.warn(
          `Webhook 投递异常: ${endpoint.id} (${eventType}), 尝试 ${attempt + 1}/${maxRetries + 1}, 错误: ${errorMsg}`,
          'IntegrationManager'
        );
      }

      // 重试间隔: 1s, 2s, 4s
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    Logger.error(
      `Webhook 投递最终失败: ${endpoint.id} (${eventType}), 已重试 ${maxRetries} 次`,
      new Error('所有重试均失败'),
      'IntegrationManager'
    );
    return false;
  }
}
