"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscordAdapter = void 0;
const Logger_1 = require("../../utils/Logger");
const BaseIntegrationAdapter_1 = require("./BaseIntegrationAdapter");
class DiscordAdapter extends BaseIntegrationAdapter_1.BaseIntegrationAdapter {
    constructor() {
        super('discord');
    }
    /**
     * 验证 Discord Webhook URL 可用
     * @param config - 平台配置，需包含 webhookUrl
     * @returns 连接是否成功
     */
    async connect(config) {
        try {
            this.config = config;
            this.updateStatus('connecting');
            this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || config.webhookUrl;
            if (!this.webhookUrl) {
                throw new Error('缺少 DISCORD_WEBHOOK_URL 配置');
            }
            Logger_1.Logger.info('正在连接到 Discord...', 'DiscordAdapter');
            // 解析 Webhook URL: https://discord.com/api/webhooks/{id}/{token}
            const webhookMatch = this.webhookUrl.match(/discord\.com\/api\/webhooks\/(\d+)\/([\w-]+)/);
            if (webhookMatch) {
                this.webhookId = webhookMatch[1];
                this.webhookToken = webhookMatch[2];
            }
            // 验证 Webhook URL 有效性
            const response = await fetch(this.webhookUrl, { method: 'GET' });
            if (!response.ok) {
                throw new Error(`Discord Webhook URL 无效 (HTTP ${response.status})`);
            }
            const webhookInfo = (await response.json());
            Logger_1.Logger.info(`Discord Webhook 已验证: ${webhookInfo.name || '未命名'}`, 'DiscordAdapter');
            this.updateStatus('connected');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('连接 Discord 失败', error, 'DiscordAdapter');
            this.updateStatus('error', error.message);
            return false;
        }
    }
    /**
     * 断开 Discord 连接，清理状态
     */
    async disconnect() {
        this.webhookUrl = undefined;
        this.webhookId = undefined;
        this.webhookToken = undefined;
        this.updateStatus('disconnected');
        Logger_1.Logger.info('已断开与 Discord 的连接', 'DiscordAdapter');
    }
    /**
     * 通过 Discord Webhook 发送消息
     * @param message - 消息文本
     * @param to - 目标（Webhook 模式下忽略，消息发送到 Webhook 关联的频道）
     * @param imageUrls - 图片 URL 列表（嵌入到消息中）
     * @param mentions - 无需支持
     * @returns 发送结果
     */
    async sendMessage(message, _to, imageUrls, _mentions) {
        if (!this.status.connected || !this.webhookUrl) {
            return { success: false, error: '未连接到 Discord' };
        }
        try {
            const payload = {};
            // 构建消息内容
            if (message) {
                payload.content = message;
            }
            // 添加图片嵌入
            if (imageUrls && imageUrls.length > 0) {
                payload.embeds = imageUrls.map((url) => ({
                    image: { url },
                }));
            }
            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Discord Webhook 返回错误 (HTTP ${response.status}): ${errorText}`);
            }
            // Discord Webhook 成功返回 204 No Content 或 200 OK
            const messageId = response.status === 204
                ? `discord_msg_${Date.now()}`
                : (await response.json())
                    .id || `discord_msg_${Date.now()}`;
            return {
                success: true,
                messageId: `discord_msg_${messageId}`,
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            Logger_1.Logger.error('发送 Discord 消息失败', error, 'DiscordAdapter');
            return {
                success: false,
                error: error.message,
            };
        }
    }
    /**
     * 处理 Discord 交互回调
     * @param payload - Discord Interaction Payload
     * @returns 处理结果
     */
    async handleWebhook(payload) {
        try {
            const interaction = payload;
            // Discord Interaction Type 1: PING
            if (interaction.type === 1) {
                return {
                    success: true,
                    response: { type: 1 }, // PONG
                };
            }
            // Discord Interaction Type 2: APPLICATION_COMMAND
            if (interaction.type === 2) {
                const userName = interaction.member?.user?.global_name ||
                    interaction.member?.user?.username ||
                    'Unknown';
                const commandName = interaction.data?.name || '';
                const incomingMessage = {
                    platform: 'discord',
                    type: 'text',
                    content: `/${commandName}`,
                    from: interaction.member?.user?.id || '',
                    fromName: userName,
                    timestamp: new Date().toISOString(),
                    rawData: payload,
                };
                await this.emitMessage(incomingMessage);
                // 返回一个 Deferred Channel Message 回应
                return {
                    success: true,
                    response: { type: 5 }, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
                };
            }
            // Discord Interaction Type 3: MESSAGE_COMPONENT
            if (interaction.type === 3) {
                const userName = interaction.member?.user?.global_name ||
                    interaction.member?.user?.username ||
                    'Unknown';
                const customId = interaction.data?.custom_id || '';
                const incomingMessage = {
                    platform: 'discord',
                    type: 'event',
                    content: customId,
                    from: interaction.member?.user?.id || '',
                    fromName: userName,
                    timestamp: new Date().toISOString(),
                    rawData: payload,
                };
                await this.emitMessage(incomingMessage);
                return {
                    success: true,
                    response: { type: 6 }, // DEFERRED_UPDATE_MESSAGE
                };
            }
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error('处理 Discord Webhook 失败', error, 'DiscordAdapter');
            return { success: false };
        }
    }
    /**
     * 从环境变量加载 Discord 配置
     * @returns 平台配置，如果未启用则返回 null
     */
    static loadConfigFromEnv() {
        const enabled = process.env.DISCORD_ENABLED === 'true';
        if (!enabled)
            return null;
        return {
            webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
        };
    }
}
exports.DiscordAdapter = DiscordAdapter;
