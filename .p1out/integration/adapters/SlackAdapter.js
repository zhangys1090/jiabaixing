"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlackAdapter = void 0;
const Logger_1 = require("../../utils/Logger");
const BaseIntegrationAdapter_1 = require("./BaseIntegrationAdapter");
class SlackAdapter extends BaseIntegrationAdapter_1.BaseIntegrationAdapter {
    constructor() {
        super('slack');
    }
    /**
     * 验证 Slack Webhook URL 可用
     * @param config - 平台配置，需包含 webhookUrl
     * @returns 连接是否成功
     */
    async connect(config) {
        try {
            this.config = config;
            this.updateStatus('connecting');
            this.webhookUrl = process.env.SLACK_WEBHOOK_URL || config.webhookUrl;
            this.botToken = process.env.SLACK_BOT_TOKEN || config.appId;
            if (!this.webhookUrl) {
                throw new Error('缺少 SLACK_WEBHOOK_URL 配置');
            }
            Logger_1.Logger.info('正在连接到 Slack...', 'SlackAdapter');
            // 验证 Webhook URL 有效性（发送一个测试请求）
            const testResponse = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '' }),
            });
            // Slack Webhook 对空消息返回 "missing_text_or_fallback_or_attachments" 是正常的
            const responseText = await testResponse.text();
            if (responseText === 'missing_text_or_fallback_or_attachments' ||
                testResponse.ok) {
                Logger_1.Logger.info('Slack Webhook 已验证', 'SlackAdapter');
            }
            else {
                throw new Error(`Slack Webhook URL 无效: ${responseText}`);
            }
            this.updateStatus('connected');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('连接 Slack 失败', error, 'SlackAdapter');
            this.updateStatus('error', error.message);
            return false;
        }
    }
    /**
     * 断开 Slack 连接，清理状态
     */
    async disconnect() {
        this.webhookUrl = undefined;
        this.botToken = undefined;
        this.updateStatus('disconnected');
        Logger_1.Logger.info('已断开与 Slack 的连接', 'SlackAdapter');
    }
    /**
     * 通过 Slack Webhook 发送消息
     * @param message - 消息文本
     * @param to - 目标频道（Webhook 模式下可选，默认发送到 Webhook 关联的频道）
     * @param imageUrls - 图片 URL 列表（作为附件嵌入）
     * @param mentions - @提及的用户 ID 列表
     * @returns 发送结果
     */
    async sendMessage(message, to, imageUrls, mentions) {
        if (!this.status.connected || !this.webhookUrl) {
            return { success: false, error: '未连接到 Slack' };
        }
        try {
            const payload = {};
            // 构建消息内容，处理 @提及
            let textContent = message;
            if (mentions && mentions.length > 0) {
                const mentionStr = mentions.map((m) => `<@${m}>`).join(' ');
                textContent = `${mentionStr} ${textContent}`;
            }
            payload.text = textContent;
            // 添加图片附件
            if (imageUrls && imageUrls.length > 0) {
                payload.attachments = imageUrls.map((url) => ({
                    image_url: url,
                    fallback: 'Image',
                }));
            }
            // 指定频道（如果提供了 to 参数）
            if (to) {
                payload.channel = to;
            }
            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Slack Webhook 返回错误 (HTTP ${response.status}): ${errorText}`);
            }
            return {
                success: true,
                messageId: `slack_msg_${Date.now()}`,
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            Logger_1.Logger.error('发送 Slack 消息失败', error, 'SlackAdapter');
            return {
                success: false,
                error: error.message,
            };
        }
    }
    /**
     * 处理 Slack 事件回调
     * @param payload - Slack Event Payload
     * @returns 处理结果
     */
    async handleWebhook(payload) {
        try {
            const eventPayload = payload;
            // 处理 URL 验证挑战
            if (eventPayload.type === 'url_verification' && eventPayload.challenge) {
                return {
                    success: true,
                    response: { challenge: eventPayload.challenge },
                };
            }
            // 处理事件回调
            if (eventPayload.type === 'event_callback' && eventPayload.event) {
                const event = eventPayload.event;
                // 忽略机器人自己发送的消息
                if (event.bot_id || event.subtype === 'bot_message') {
                    return { success: true };
                }
                const hasFiles = event.files && event.files.length > 0;
                const incomingMessage = {
                    platform: 'slack',
                    type: hasFiles ? 'image' : 'text',
                    content: event.text || '',
                    from: event.user || '',
                    fromName: event.user || '',
                    timestamp: event.ts
                        ? new Date(Number(event.ts) * 1000).toISOString()
                        : new Date().toISOString(),
                    rawData: payload,
                };
                await this.emitMessage(incomingMessage);
            }
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error('处理 Slack Webhook 失败', error, 'SlackAdapter');
            return { success: false };
        }
    }
    /**
     * 从环境变量加载 Slack 配置
     * @returns 平台配置，如果未启用则返回 null
     */
    static loadConfigFromEnv() {
        const enabled = process.env.SLACK_ENABLED === 'true';
        if (!enabled)
            return null;
        return {
            webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
            appId: process.env.SLACK_BOT_TOKEN || '',
        };
    }
}
exports.SlackAdapter = SlackAdapter;
