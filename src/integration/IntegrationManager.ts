import {
  IntegrationPlatform,
  PlatformConfig,
  IntegrationPlatformInfo,
  IntegrationStatus,
  SendMessageRequest,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../shared/contracts';
import { Logger } from '../utils/Logger';
import { BaseIntegrationAdapter } from './adapters/BaseIntegrationAdapter';
import { WeChatAdapter } from './adapters/WeChatAdapter';
import { WeChatQRAdapter } from './adapters/WeChatQRAdapter';
import { FeishuAdapter } from './adapters/FeishuAdapter';
import { DingTalkAdapter } from './adapters/DingTalkAdapter';
import { QQAdapter } from './adapters/QQAdapter';
import { EventBus } from '../shared/EventBus';
import type { JiabaixingCore } from '../core/JiabaixingCore';

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
};

export class IntegrationManager {
  private adapters: Map<IntegrationPlatform, BaseIntegrationAdapter> =
    new Map();
  private static instance: IntegrationManager;
  private core: JiabaixingCore | null = null;

  private constructor() {
    this.initializeAdapters();
  }

  static getInstance(): IntegrationManager {
    if (!IntegrationManager.instance) {
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

    // 为每个适配器注册消息处理
    for (const adapter of this.adapters.values()) {
      adapter.onMessage(async (message: IncomingMessageEvent) => {
        void this.handleIncomingMessage(message);
      });
    }

    Logger.info('集成管理器初始化完成', 'IntegrationManager');

    // 如果环境变量配置了 QQ，自动连接
    void this.autoConnectQQ();
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
  ): Promise<{ success: boolean; response?: unknown }> {
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
}
