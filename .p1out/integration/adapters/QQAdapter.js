"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QQAdapter = void 0;
const Logger_1 = require("../../utils/Logger");
const BaseIntegrationAdapter_1 = require("./BaseIntegrationAdapter");
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1500;
class QQAdapter extends BaseIntegrationAdapter_1.BaseIntegrationAdapter {
    constructor() {
        super('qq');
        this.httpBaseUrl = 'http://localhost:8080';
        this.reconnectAttempts = 0;
        this.shouldAutoReconnect = true;
    }
    async connect(config) {
        try {
            this.config = config;
            this.updateStatus('connecting');
            this.reconnectAttempts = 0;
            this.shouldAutoReconnect = true;
            this.httpBaseUrl = `http://${config.miraiHttpHost || 'localhost'}:${config.miraiHttpPort || '8080'}`;
            this.qqAccount = config.qqAccount;
            this.miraiVerifyKey = config.miraiVerifyKey;
            Logger_1.Logger.info('正在通过 Mirai 连接到 QQ...', 'QQAdapter');
            const session = await this.verifySession(this.miraiVerifyKey || '');
            if (session.code !== 0) {
                const errorMap = {
                    1: 'verifyKey 错误',
                    2: 'Session 错误或过期',
                    3: '未绑定 QQ 账号',
                    4: ' mirai-api-http 版本不兼容',
                };
                throw new Error(errorMap[session.code] || `连接失败 (code: ${session.code})`);
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
            Logger_1.Logger.info(`QQ 机器人已连接 (Session: ${this.sessionKey?.slice(0, 8)}...)`, 'QQAdapter');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('连接 QQ 失败', error, 'QQAdapter');
            this.updateStatus('error', error.message);
            void this.scheduleReconnect();
            return false;
        }
    }
    async disconnect() {
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
            }
            catch {
                // 忽略释放 session 时的错误
            }
        }
        this.sessionKey = undefined;
        this.updateStatus('disconnected');
        Logger_1.Logger.info('已断开 QQ 连接', 'QQAdapter');
    }
    async sendMessage(message, to, imageUrls, mentions) {
        if (!this.status.connected || !this.sessionKey) {
            return { success: false, error: '未连接到 QQ' };
        }
        try {
            const messageChain = [];
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
            let endpoint;
            let body;
            if (isGroup) {
                endpoint = `${this.httpBaseUrl}/sendGroupMessage`;
                body = {
                    sessionKey: this.sessionKey,
                    target: actualTarget,
                    messageChain,
                };
            }
            else {
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
        }
        catch (error) {
            Logger_1.Logger.error('发送 QQ 消息失败', error, 'QQAdapter');
            return {
                success: false,
                error: error.message,
            };
        }
    }
    async handleWebhook(_payload) {
        return { success: true, response: { handled: false } };
    }
    async verifySession(verifyKey) {
        Logger_1.Logger.info('正在验证 Mirai Session...', 'QQAdapter');
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
    async bindQQ(qq) {
        if (!this.sessionKey)
            return false;
        Logger_1.Logger.info(`正在绑定 QQ ${qq}...`, 'QQAdapter');
        const response = await fetch(`${this.httpBaseUrl}/bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionKey: this.sessionKey,
                qq: Number(qq),
            }),
        });
        if (!response.ok)
            return false;
        const result = await response.json();
        return result.code === 0;
    }
    async fetchNewMessages() {
        if (!this.sessionKey || !this.status.connected)
            return;
        try {
            const response = await fetch(`${this.httpBaseUrl}/fetchMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionKey: this.sessionKey, count: 10 }),
            });
            if (!response.ok) {
                if (response.status === 500) {
                    Logger_1.Logger.warn('Mirai Session 可能已过期，准备重连', 'QQAdapter');
                    this.updateStatus('error', 'Session 过期');
                    void this.scheduleReconnect();
                }
                return;
            }
            const data = await response.json();
            const messages = data.data || [];
            for (const msg of messages) {
                const textContent = msg.messageChain
                    .filter((c) => c.type === 'Plain')
                    .map((c) => c.text || '')
                    .join('');
                const hasImage = msg.messageChain.some((c) => c.type === 'Image');
                const incoming = {
                    platform: 'qq',
                    type: hasImage ? 'image' : 'text',
                    content: textContent,
                    from: String(msg.sender.id),
                    fromName: msg.sender.nickname || msg.sender.remark || String(msg.sender.id),
                    timestamp: new Date().toISOString(),
                    rawData: msg,
                };
                await this.emitMessage(incoming);
            }
        }
        catch {
            // 轮询失败，可能网络问题，下次轮询继续
        }
    }
    startPolling() {
        this.stopPolling();
        this.pollingTimer = setInterval(() => {
            void this.fetchNewMessages();
        }, POLL_INTERVAL_MS);
        if (this.pollingTimer.unref)
            this.pollingTimer.unref();
        Logger_1.Logger.info('QQ 消息轮询已启动', 'QQAdapter');
    }
    stopPolling() {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
    }
    cancelReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }
    async scheduleReconnect() {
        if (!this.shouldAutoReconnect)
            return;
        this.reconnectAttempts++;
        if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            Logger_1.Logger.error(`QQ 重连已达最大次数 (${MAX_RECONNECT_ATTEMPTS})，停止重连`, undefined, 'QQAdapter');
            return;
        }
        const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts - 1), 60000);
        Logger_1.Logger.info(`QQ 将在 ${Math.round(delay / 1000)} 秒后重连 (第 ${this.reconnectAttempts} 次)`, 'QQAdapter');
        this.reconnectTimer = setTimeout(async () => {
            Logger_1.Logger.info('正在重连 QQ...', 'QQAdapter');
            await this.connect({
                miraiHttpHost: this.config.miraiHttpHost,
                miraiHttpPort: this.config.miraiHttpPort,
                miraiVerifyKey: this.miraiVerifyKey,
                qqAccount: this.qqAccount,
            });
        }, delay);
        if (this.reconnectTimer.unref)
            this.reconnectTimer.unref();
    }
    /**
     * 从环境变量加载 QQ 配置
     */
    static loadConfigFromEnv() {
        const enabled = process.env.QQ_ENABLED === 'true';
        if (!enabled)
            return null;
        return {
            miraiHttpHost: process.env.MIRAI_HTTP_HOST || 'localhost',
            miraiHttpPort: process.env.MIRAI_HTTP_PORT || '8080',
            miraiVerifyKey: process.env.MIRAI_VERIFY_KEY || '',
            qqAccount: process.env.QQ_ACCOUNT || '',
        };
    }
}
exports.QQAdapter = QQAdapter;
