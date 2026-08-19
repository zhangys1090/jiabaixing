"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramAdapter = void 0;
const Logger_1 = require("../../utils/Logger");
const BaseIntegrationAdapter_1 = require("./BaseIntegrationAdapter");
const TELEGRAM_API_BASE = 'https://api.telegram.org';
class TelegramAdapter extends BaseIntegrationAdapter_1.BaseIntegrationAdapter {
    constructor() {
        super('telegram');
        this.lastUpdateId = 0;
    }
    /**
     * 使用 BOT_TOKEN 连接到 Telegram API，设置 webhook
     * @param config - 平台配置，需包含 webhookUrl 和通过环境变量读取的 BOT_TOKEN
     * @returns 连接是否成功
     */
    async connect(config) {
        try {
            this.config = config;
            this.updateStatus('connecting');
            this.botToken = process.env.TELEGRAM_BOT_TOKEN || config.webhookSecret;
            this.webhookUrl = config.webhookUrl;
            if (!this.botToken) {
                throw new Error('缺少 TELEGRAM_BOT_TOKEN 配置');
            }
            Logger_1.Logger.info('正在连接到 Telegram...', 'TelegramAdapter');
            // 验证 Bot Token 有效性
            const meResult = await this.callApi('getMe');
            if (!meResult.ok || !meResult.result) {
                throw new Error(`Telegram Bot Token 无效: ${meResult.description || '未知错误'}`);
            }
            Logger_1.Logger.info(`Telegram Bot 已验证: @${meResult.result.username || meResult.result.first_name}`, 'TelegramAdapter');
            // 设置 Webhook（如果配置了 webhookUrl）
            if (this.webhookUrl) {
                const webhookResult = await this.callApi('setWebhook', {
                    url: this.webhookUrl,
                    allowed_updates: ['message', 'callback_query'],
                });
                if (!webhookResult.ok) {
                    Logger_1.Logger.warn(`设置 Telegram Webhook 失败: ${webhookResult.description}`, 'TelegramAdapter');
                }
                else {
                    Logger_1.Logger.info(`Telegram Webhook 已设置: ${this.webhookUrl}`, 'TelegramAdapter');
                }
            }
            this.updateStatus('connected');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('连接 Telegram 失败', error, 'TelegramAdapter');
            this.updateStatus('error', error.message);
            return false;
        }
    }
    /**
     * 断开 Telegram 连接，关闭 webhook
     */
    async disconnect() {
        if (this.botToken) {
            try {
                await this.callApi('deleteWebhook');
                Logger_1.Logger.info('Telegram Webhook 已删除', 'TelegramAdapter');
            }
            catch {
                // 忽略删除 webhook 时的错误
            }
        }
        this.botToken = undefined;
        this.webhookUrl = undefined;
        this.lastUpdateId = 0;
        this.updateStatus('disconnected');
        Logger_1.Logger.info('已断开与 Telegram 的连接', 'TelegramAdapter');
    }
    /**
     * 调用 Telegram sendMessage API 发送消息
     * @param message - 消息文本
     * @param to - 目标 chat_id
     * @param imageUrls - 图片 URL 列表
     * @param mentions - 无需支持（Telegram 使用 @username）
     * @returns 发送结果
     */
    async sendMessage(message, to, imageUrls, _mentions) {
        if (!this.status.connected || !this.botToken) {
            return { success: false, error: '未连接到 Telegram' };
        }
        if (!to) {
            return { success: false, error: '缺少目标 chat_id' };
        }
        try {
            // 发送图片
            if (imageUrls && imageUrls.length > 0) {
                for (const url of imageUrls) {
                    const result = await this.callApi('sendPhoto', {
                        chat_id: to,
                        photo: url,
                        caption: imageUrls.indexOf(url) === imageUrls.length - 1
                            ? message
                            : undefined,
                    });
                    if (!result.ok) {
                        throw new Error(`发送图片失败: ${result.description || '未知错误'}`);
                    }
                }
                // 如果只有图片没有文本（或文本已在最后一张图片的 caption 中），直接返回
                if (!message || (imageUrls.length > 0 && imageUrls.length === 1)) {
                    return {
                        success: true,
                        messageId: `tg_msg_${Date.now()}`,
                        timestamp: new Date().toISOString(),
                    };
                }
            }
            // 发送文本消息
            const result = await this.callApi('sendMessage', {
                chat_id: to,
                text: message,
                parse_mode: 'HTML',
            });
            if (!result.ok) {
                throw new Error(`发送消息失败: ${result.description || '未知错误'}`);
            }
            return {
                success: true,
                messageId: `tg_msg_${result.result?.message_id || Date.now()}`,
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            Logger_1.Logger.error('发送 Telegram 消息失败', error, 'TelegramAdapter');
            return {
                success: false,
                error: error.message,
            };
        }
    }
    /**
     * 处理 Telegram 的 Update 对象（Webhook 回调）
     * @param payload - Telegram Update 对象
     * @returns 处理结果
     */
    async handleWebhook(payload) {
        try {
            const update = payload;
            // 处理回调查询
            if (update.callback_query) {
                const callbackQuery = update.callback_query;
                Logger_1.Logger.debug(`Telegram 回调查询: ${callbackQuery.data}`, 'TelegramAdapter');
                // 应答回调查询
                if (this.botToken) {
                    await this.callApi('answerCallbackQuery', {
                        callback_query_id: callbackQuery.id,
                    });
                }
                return { success: true };
            }
            // 处理消息
            if (update.message) {
                const msg = update.message;
                const fromUser = msg.from;
                const hasPhoto = msg.photo && msg.photo.length > 0;
                const incomingMessage = {
                    platform: 'telegram',
                    type: hasPhoto ? 'image' : 'text',
                    content: msg.text || msg.caption || '',
                    from: String(msg.chat.id),
                    fromName: fromUser
                        ? `${fromUser.first_name}${fromUser.last_name ? ' ' + fromUser.last_name : ''}`
                        : String(msg.chat.id),
                    timestamp: new Date(msg.date * 1000).toISOString(),
                    rawData: payload,
                };
                await this.emitMessage(incomingMessage);
            }
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error('处理 Telegram Webhook 失败', error, 'TelegramAdapter');
            return { success: false };
        }
    }
    /**
     * 调用 Telegram Bot API
     * @param method - API 方法名
     * @param body - 请求体
     * @returns API 响应
     */
    async callApi(method, body) {
        if (!this.botToken) {
            throw new Error('BOT_TOKEN 未配置');
        }
        const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/${method}`;
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const data = (await response.json());
        if (!data.ok && data.description) {
            Logger_1.Logger.warn(`Telegram API ${method} 返回错误: ${data.description}`, 'TelegramAdapter');
        }
        return data;
    }
    /**
     * 从环境变量加载 Telegram 配置
     * @returns 平台配置，如果未启用则返回 null
     */
    static loadConfigFromEnv() {
        const enabled = process.env.TELEGRAM_ENABLED === 'true';
        if (!enabled)
            return null;
        return {
            webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || '',
            webhookSecret: process.env.TELEGRAM_BOT_TOKEN || '',
        };
    }
}
exports.TelegramAdapter = TelegramAdapter;
