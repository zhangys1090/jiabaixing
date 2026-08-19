"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationManager = void 0;
const crypto = __importStar(require("crypto"));
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
const DingTalkAdapter_1 = require("./adapters/DingTalkAdapter");
const DiscordAdapter_1 = require("./adapters/DiscordAdapter");
const FeishuAdapter_1 = require("./adapters/FeishuAdapter");
const QQAdapter_1 = require("./adapters/QQAdapter");
const SlackAdapter_1 = require("./adapters/SlackAdapter");
const TelegramAdapter_1 = require("./adapters/TelegramAdapter");
const WeChatAdapter_1 = require("./adapters/WeChatAdapter");
const WeChatQRAdapter_1 = require("./adapters/WeChatQRAdapter");
const PLATFORM_INFO = {
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
class IntegrationManager {
    constructor() {
        this.adapters = new Map();
        this.webhookEndpoints = new Map();
        this.MAX_WEBHOOK_ENDPOINTS = 100;
        this.core = null;
        this.initializeAdapters();
    }
    /**
     * 获取 IntegrationManager 单例
     * @param skipAutoConnect - 是否跳过自动连接（主进程不需要自动连接平台，由 Gateway Worker 负责）
     */
    static getInstance(skipAutoConnect = false) {
        if (!IntegrationManager.instance) {
            IntegrationManager.skipAutoConnect = skipAutoConnect;
            IntegrationManager.instance = new IntegrationManager();
        }
        return IntegrationManager.instance;
    }
    setCore(core) {
        this.core = core;
        Logger_1.Logger.info('✅ JiabaixingCore 已注入到 IntegrationManager', 'IntegrationManager');
    }
    initializeAdapters() {
        // 默认用官方 API 模式
        this.adapters.set('wechat', new WeChatAdapter_1.WeChatAdapter());
        this.adapters.set('feishu', new FeishuAdapter_1.FeishuAdapter());
        this.adapters.set('dingtalk', new DingTalkAdapter_1.DingTalkAdapter());
        this.adapters.set('qq', new QQAdapter_1.QQAdapter());
        this.adapters.set('telegram', new TelegramAdapter_1.TelegramAdapter());
        this.adapters.set('discord', new DiscordAdapter_1.DiscordAdapter());
        this.adapters.set('slack', new SlackAdapter_1.SlackAdapter());
        // 为每个适配器注册消息处理
        for (const adapter of this.adapters.values()) {
            adapter.onMessage(async (message) => {
                void this.handleIncomingMessage(message);
            });
        }
        Logger_1.Logger.info('集成管理器初始化完成', 'IntegrationManager');
        if (IntegrationManager.skipAutoConnect) {
            Logger_1.Logger.info('跳过平台自动连接 (skipAutoConnect=true)，由 Gateway Worker 负责', 'IntegrationManager');
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
    async autoConnectQQ() {
        const qqConfig = QQAdapter_1.QQAdapter.loadConfigFromEnv();
        if (!qqConfig) {
            Logger_1.Logger.info('QQ 自动连接未启用 (QQ_ENABLED=false)', 'IntegrationManager');
            return;
        }
        Logger_1.Logger.info('检测到 QQ 环境变量配置，正在自动连接...', 'IntegrationManager');
        // 等待 2 秒让系统完全就绪
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const success = await this.connectPlatform('qq', qqConfig);
        if (success) {
            Logger_1.Logger.info('QQ 机器人自动连接成功', 'IntegrationManager');
        }
        else {
            Logger_1.Logger.warn('QQ 机器人自动连接失败，将在后台自动重试', 'IntegrationManager');
        }
    }
    /**
     * 从环境变量自动连接 Telegram
     */
    async autoConnectTelegram() {
        const telegramConfig = TelegramAdapter_1.TelegramAdapter.loadConfigFromEnv();
        if (!telegramConfig) {
            Logger_1.Logger.info('Telegram 自动连接未启用 (TELEGRAM_ENABLED=false)', 'IntegrationManager');
            return;
        }
        Logger_1.Logger.info('检测到 Telegram 环境变量配置，正在自动连接...', 'IntegrationManager');
        // 等待 2 秒让系统完全就绪
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const success = await this.connectPlatform('telegram', telegramConfig);
        if (success) {
            Logger_1.Logger.info('Telegram 机器人自动连接成功', 'IntegrationManager');
        }
        else {
            Logger_1.Logger.warn('Telegram 机器人自动连接失败', 'IntegrationManager');
        }
    }
    /**
     * 从环境变量自动连接飞书
     */
    async autoConnectFeishu() {
        const appId = process.env.FEISHU_APP_ID || '';
        const appSecret = process.env.FEISHU_APP_SECRET || '';
        if (!appId || !appSecret) {
            Logger_1.Logger.info('飞书自动连接未启用 (缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET)', 'IntegrationManager');
            return;
        }
        Logger_1.Logger.info('检测到飞书环境变量配置，正在自动连接...', 'IntegrationManager');
        // 等待 2 秒让系统完全就绪
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const success = await this.connectPlatform('feishu', {
            appId,
            appSecret,
        });
        if (success) {
            Logger_1.Logger.info('飞书自动连接成功', 'IntegrationManager');
        }
        else {
            Logger_1.Logger.warn('飞书自动连接失败，将在后台自动重试', 'IntegrationManager');
        }
    }
    /**
     * 获取所有支持的平台信息
     */
    getPlatforms() {
        const platforms = [];
        for (const [key, info] of Object.entries(PLATFORM_INFO)) {
            const adapter = this.adapters.get(key);
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
    async connectPlatform(platform, config) {
        // 微信 QR 扫码模式：替换为 QR 适配器
        if (platform === 'wechat' && config.mode === 'qr') {
            const qrAdapter = new WeChatQRAdapter_1.WeChatQRAdapter();
            this.adapters.set('wechat', qrAdapter);
            qrAdapter.onMessage(async (message) => {
                void this.handleIncomingMessage(message);
            });
        }
        const adapter = this.adapters.get(platform);
        if (!adapter) {
            Logger_1.Logger.warn(`不支持的平台: ${platform}`, 'IntegrationManager');
            return false;
        }
        try {
            const success = await adapter.connect(config);
            if (success) {
                EventBus_1.EventBus.emit('integration_connected', {
                    platform,
                    timestamp: new Date().toISOString(),
                });
                Logger_1.Logger.info(`成功连接到 ${platform}`, 'IntegrationManager');
            }
            return success;
        }
        catch (error) {
            Logger_1.Logger.error(`连接 ${platform} 失败`, error, 'IntegrationManager');
            return false;
        }
    }
    /**
     * 断开平台连接
     */
    async disconnectPlatform(platform) {
        const adapter = this.adapters.get(platform);
        if (!adapter) {
            return;
        }
        await adapter.disconnect();
        EventBus_1.EventBus.emit('integration_disconnected', {
            platform,
            timestamp: new Date().toISOString(),
        });
        Logger_1.Logger.info(`断开了 ${platform} 的连接`, 'IntegrationManager');
    }
    /**
     * 发送消息到指定平台
     */
    async sendMessage(request) {
        const adapter = this.adapters.get(request.platform);
        if (!adapter) {
            return {
                success: false,
                error: '不支持的平台',
            };
        }
        return await adapter.sendMessage(request.message, request.to, request.imageUrls, request.mentions);
    }
    /**
     * 处理 Webhook
     */
    async handleWebhook(platform, payload) {
        const adapter = this.adapters.get(platform);
        if (!adapter) {
            return { success: false };
        }
        return await adapter.handleWebhook(payload);
    }
    /**
     * 获取平台状态
     */
    getPlatformStatus(platform) {
        return this.adapters.get(platform)?.getStatus();
    }
    /**
     * 获取微信 QR 扫码状态（仅限 QR 模式）
     */
    getWeChatQRState() {
        const adapter = this.adapters.get('wechat');
        if (adapter instanceof WeChatQRAdapter_1.WeChatQRAdapter) {
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
    async handleIncomingMessage(message) {
        Logger_1.Logger.info(`收到来自 ${message.platform} 的消息: ${message.from}`, 'IntegrationManager');
        // 通过 EventBus 广播消息
        EventBus_1.EventBus.emit('integration_message', {
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
                Logger_1.Logger.info(`📨 路由消息到 core.processInput: ${message.platform} <- ${message.from}: ${message.content.substring(0, 50)}...`, 'IntegrationManager');
                const result = await this.core.processInput(message.content, message.from || 'gateway', undefined);
                if (result.response) {
                    await this.sendMessage({
                        platform: message.platform,
                        message: result.response,
                        to: message.from || '',
                    });
                    Logger_1.Logger.info(`📤 回复已发送: ${result.response.substring(0, 50)}...`, 'IntegrationManager');
                }
            }
            catch (error) {
                Logger_1.Logger.error('IntegrationManager 处理消息失败', error, 'IntegrationManager');
            }
        }
    }
    // ====================== Webhook 推送功能 ======================
    /**
     * 注册 Webhook 端点
     * @param endpoint - Webhook 端点配置
     */
    registerWebhook(endpoint) {
        if (this.webhookEndpoints.has(endpoint.id)) {
            Logger_1.Logger.warn(`Webhook 端点已存在，将覆盖: ${endpoint.id}`, 'IntegrationManager');
        }
        else if (this.webhookEndpoints.size >= this.MAX_WEBHOOK_ENDPOINTS) {
            const oldestKey = this.webhookEndpoints.keys().next().value;
            this.webhookEndpoints.delete(oldestKey);
        }
        this.webhookEndpoints.set(endpoint.id, endpoint);
        Logger_1.Logger.info(`Webhook 端点已注册: ${endpoint.id} (${endpoint.name}), 订阅事件: [${endpoint.events.join(', ')}]`, 'IntegrationManager');
    }
    /**
     * 注销 Webhook 端点
     * @param id - Webhook 端点 ID
     */
    unregisterWebhook(id) {
        const removed = this.webhookEndpoints.delete(id);
        if (removed) {
            Logger_1.Logger.info(`Webhook 端点已注销: ${id}`, 'IntegrationManager');
        }
        else {
            Logger_1.Logger.warn(`Webhook 端点不存在: ${id}`, 'IntegrationManager');
        }
    }
    /**
     * 列出所有 Webhook 端点
     * @returns Webhook 端点列表
     */
    listWebhooks() {
        return Array.from(this.webhookEndpoints.values());
    }
    /**
     * 获取指定 Webhook 端点
     * @param id - Webhook 端点 ID
     * @returns Webhook 端点配置，不存在则返回 undefined
     */
    getWebhook(id) {
        return this.webhookEndpoints.get(id);
    }
    /**
     * 向所有订阅了指定事件的 Webhook 端点推送通知
     * @param eventType - 事件类型
     * @param payload - 事件数据
     */
    async pushToWebhooks(eventType, payload) {
        const matchedEndpoints = Array.from(this.webhookEndpoints.values()).filter((ep) => ep.enabled && ep.events.includes(eventType));
        if (matchedEndpoints.length === 0) {
            return;
        }
        Logger_1.Logger.info(`推送事件 ${eventType} 到 ${matchedEndpoints.length} 个 Webhook`, 'IntegrationManager');
        const results = await Promise.allSettled(matchedEndpoints.map((endpoint) => this.deliverWebhook(endpoint, eventType, payload)));
        const failedCount = results.filter((r) => r.status === 'rejected').length;
        if (failedCount > 0) {
            Logger_1.Logger.warn(`事件 ${eventType} 推送完成: ${matchedEndpoints.length - failedCount}/${matchedEndpoints.length} 成功`, 'IntegrationManager');
        }
    }
    /**
     * 单个 Webhook 投递（带重试和 HMAC 签名）
     * @param endpoint - Webhook 端点配置
     * @param eventType - 事件类型
     * @param payload - 事件数据
     * @returns 投递是否成功
     */
    async deliverWebhook(endpoint, eventType, payload) {
        const body = {
            event: eventType,
            data: payload,
            timestamp: Date.now(),
            source: 'jiabaixing',
        };
        const bodyStr = JSON.stringify(body);
        const maxRetries = endpoint.retryCount ?? 3;
        const timeout = endpoint.timeout ?? 5000;
        const headers = {
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
                    Logger_1.Logger.info(`Webhook 投递成功: ${endpoint.id} (${eventType}), 状态码=${response.status}`, 'IntegrationManager');
                    return true;
                }
                Logger_1.Logger.warn(`Webhook 投递失败: ${endpoint.id} (${eventType}), 状态码=${response.status}`, 'IntegrationManager');
            }
            catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                Logger_1.Logger.warn(`Webhook 投递异常: ${endpoint.id} (${eventType}), 尝试 ${attempt + 1}/${maxRetries + 1}, 错误: ${errorMsg}`, 'IntegrationManager');
            }
            // 重试间隔: 1s, 2s, 4s
            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        Logger_1.Logger.error(`Webhook 投递最终失败: ${endpoint.id} (${eventType}), 已重试 ${maxRetries} 次`, new Error('所有重试均失败'), 'IntegrationManager');
        return false;
    }
}
exports.IntegrationManager = IntegrationManager;
IntegrationManager.skipAutoConnect = false;
