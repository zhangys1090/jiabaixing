"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeChatAdapter = void 0;
const Logger_1 = require("../../utils/Logger");
const BaseIntegrationAdapter_1 = require("./BaseIntegrationAdapter");
const WECHAT_API_BASE = 'https://api.weixin.qq.com/cgi-bin';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
class WeChatAdapter extends BaseIntegrationAdapter_1.BaseIntegrationAdapter {
    constructor() {
        super('wechat');
        this.tokenExpiresAt = 0;
        this.tokenRefreshTimer = null;
        this.appId = '';
        this.appSecret = '';
        this.client = fetch;
    }
    async connect(config) {
        try {
            this.config = config;
            this.appId = config.appId || '';
            this.appSecret = config.appSecret || '';
            if (!this.appId || !this.appSecret) {
                throw new Error('缺少微信配置: 需要 appId 和 appSecret');
            }
            this.updateStatus('connecting');
            Logger_1.Logger.info('正在连接到微信...', 'WeChatAdapter');
            await this.refreshToken();
            this.startTokenRefresh();
            this.updateStatus('connected');
            Logger_1.Logger.info('微信连接成功', 'WeChatAdapter');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('连接微信失败', error, 'WeChatAdapter');
            this.updateStatus('error', error.message);
            return false;
        }
    }
    async disconnect() {
        this.stopTokenRefresh();
        this.accessToken = undefined;
        this.tokenExpiresAt = 0;
        this.updateStatus('disconnected');
        Logger_1.Logger.info('已断开与微信的连接', 'WeChatAdapter');
    }
    async sendMessage(message, to, _imageUrls, _mentions) {
        if (!this.status.connected || !this.accessToken) {
            return { success: false, error: '未连接到微信' };
        }
        if (!to) {
            return { success: false, error: '缺少接收者 (openid)' };
        }
        try {
            await this.ensureToken();
            Logger_1.Logger.info('正在发送消息到微信', 'WeChatAdapter', {
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
            const data = (await response.json());
            if (data.errcode === 0) {
                return {
                    success: true,
                    messageId: data.msgid?.toString() || `wx_msg_${Date.now()}`,
                    timestamp: new Date().toISOString(),
                };
            }
            if (data.errcode === 40001 || data.errcode === 42001) {
                Logger_1.Logger.warn('微信 token 过期，尝试刷新', 'WeChatAdapter');
                await this.refreshToken();
                return this.sendMessage(message, to, _imageUrls, _mentions);
            }
            return {
                success: false,
                error: `微信 API 错误: ${data.errcode} - ${data.errmsg}`,
            };
        }
        catch (error) {
            Logger_1.Logger.error('发送微信消息失败', error, 'WeChatAdapter');
            return {
                success: false,
                error: error.message,
            };
        }
    }
    async handleWebhook(payload) {
        try {
            Logger_1.Logger.debug('处理微信 Webhook', 'WeChatAdapter', { payload });
            const msgType = payload.msgtype;
            if (msgType === 'text') {
                const content = payload.content;
                const from = payload.fromusername;
                const message = {
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
                Logger_1.Logger.info('新用户关注微信公众号', 'WeChatAdapter', {
                    from: payload.FromUserName,
                });
            }
            return {
                success: true,
                response: 'success',
            };
        }
        catch (error) {
            Logger_1.Logger.error('处理微信 Webhook 失败', error, 'WeChatAdapter');
            return { success: false };
        }
    }
    async refreshToken() {
        try {
            const url = `${WECHAT_API_BASE}/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`;
            const response = await this.client(url, { method: 'GET' });
            const data = (await response.json());
            if (data.errcode) {
                throw new Error(`获取微信 token 失败: ${data.errcode} - ${data.errmsg}`);
            }
            this.accessToken = data.access_token;
            const expiresIn = (data.expires_in || 7200) * 1000;
            this.tokenExpiresAt = Date.now() + expiresIn;
            Logger_1.Logger.info(`微信 token 获取成功，有效期 ${Math.round(expiresIn / 1000 / 60)} 分钟`, 'WeChatAdapter');
        }
        catch (error) {
            Logger_1.Logger.error('获取微信 token 失败', error, 'WeChatAdapter');
            throw error;
        }
    }
    async ensureToken() {
        if (!this.accessToken ||
            Date.now() + TOKEN_REFRESH_MARGIN_MS >= this.tokenExpiresAt) {
            await this.refreshToken();
        }
    }
    startTokenRefresh() {
        this.stopTokenRefresh();
        this.tokenRefreshTimer = setInterval(async () => {
            try {
                await this.ensureToken();
            }
            catch {
                Logger_1.Logger.warn('微信 token 定时刷新失败', 'WeChatAdapter');
            }
        }, 5 * 60 * 1000);
        if (this.tokenRefreshTimer.unref)
            this.tokenRefreshTimer.unref();
    }
    stopTokenRefresh() {
        if (this.tokenRefreshTimer) {
            clearInterval(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
    }
    static loadConfigFromEnv() {
        const enabled = process.env.WECHAT_ENABLED === 'true';
        if (!enabled)
            return null;
        return {
            appId: process.env.WECHAT_APP_ID || '',
            appSecret: process.env.WECHAT_APP_SECRET || '',
        };
    }
}
exports.WeChatAdapter = WeChatAdapter;
