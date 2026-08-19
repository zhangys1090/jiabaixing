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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeishuAdapter = void 0;
const lark = __importStar(require("@larksuiteoapi/node-sdk"));
const axios_1 = __importDefault(require("axios"));
const Logger_1 = require("../../utils/Logger");
const BaseIntegrationAdapter_1 = require("./BaseIntegrationAdapter");
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';
/**
 * 飞书平台适配器（WebSocket 模式）
 *
 * 使用 @larksuiteoapi/node-sdk 官方 SDK 的 WebSocket 订阅，
 * 无需配置 Webhook URL，配好 App ID + Secret 自动连接收消息。
 */
class FeishuAdapter extends BaseIntegrationAdapter_1.BaseIntegrationAdapter {
    constructor() {
        super('feishu');
        this.larkClient = null;
        this.wsClient = null;
        this.appId = '';
        this.appSecret = '';
        this.client = axios_1.default.create({
            baseURL: FEISHU_BASE_URL,
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    async connect(config) {
        this.config = config;
        this.appId = config.appId || config.clientId || '';
        this.appSecret = config.appSecret || config.clientSecret || '';
        if (!this.appId || !this.appSecret) {
            Logger_1.Logger.error('缺少飞书配置: 需要 appId 和 appSecret', undefined, 'FeishuAdapter');
            this.updateStatus('error', '缺少 appId 或 appSecret');
            return false;
        }
        this.updateStatus('connecting');
        Logger_1.Logger.info('正在连接到飞书（WebSocket 模式）...', 'FeishuAdapter');
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
            'im.message.receive_v1': async (data) => {
                await this.handleMessageEvent(data);
            },
        });
        // 重试连接：SDK WSClient 只能 start() 一次，每次重试需新建实例
        const MAX_RETRIES = 2;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            // 每次尝试新建 WSClient（SDK 限制，start() 后不能再用同一实例）
            if (this.wsClient) {
                try {
                    await this.wsClient.stop();
                }
                catch {
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
                Logger_1.Logger.info('✅ 飞书 WebSocket 连接成功', 'FeishuAdapter');
                return true;
            }
            catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                Logger_1.Logger.warn(`飞书 WS 连接尝试 #${attempt} 失败: ${errMsg}`, 'FeishuAdapter');
                if (attempt < MAX_RETRIES) {
                    Logger_1.Logger.info('等待 3 秒后重试飞书连接...', 'FeishuAdapter');
                    await new Promise((r) => setTimeout(r, 3000));
                }
                else {
                    Logger_1.Logger.error(`飞书 WebSocket 连接失败（已重试 ${MAX_RETRIES} 次）`, error, 'FeishuAdapter');
                    this.updateStatus('error', errMsg);
                    return false;
                }
            }
        }
        return false;
    }
    async disconnect() {
        try {
            if (this.wsClient) {
                await this.wsClient.stop();
                this.wsClient = null;
            }
        }
        catch (e) {
            Logger_1.Logger.warn(`飞书断开连接时出错: ${e}`, 'FeishuAdapter');
        }
        this.larkClient = null;
        this.updateStatus('disconnected');
        Logger_1.Logger.info('已断开与飞书的连接', 'FeishuAdapter');
    }
    async sendMessage(message, to, _imageUrls, _mentions) {
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
                    receive_id_type: receiveIdType,
                },
                data: {
                    receive_id: to,
                    msg_type: 'text',
                    content,
                },
            });
            return {
                success: true,
                messageId: resp?.data?.message_id ||
                    `fs_msg_${Date.now()}`,
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            Logger_1.Logger.error('发送飞书消息失败', error, 'FeishuAdapter');
            return { success: false, error: error.message };
        }
    }
    async handleWebhook(payload) {
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
    async handleMessageEvent(data) {
        try {
            const event = (data?.event || data);
            const message = (event?.message || {});
            const sender = (event?.sender || {});
            const senderId = (sender?.sender_id || {});
            const contentRaw = message?.content || '{}';
            const messageType = message?.message_type || 'text';
            let content = {};
            try {
                content =
                    typeof contentRaw === 'string' ? JSON.parse(contentRaw) : contentRaw;
            }
            catch {
                content = {};
            }
            let textContent = '';
            if (messageType === 'text') {
                textContent =
                    content?.text || '';
            }
            else if (messageType === 'post') {
                textContent = this.extractPostText(content);
            }
            else if (messageType === 'image') {
                textContent = '[图片消息]';
            }
            else if (messageType === 'file') {
                textContent = `[文件: ${content?.file_name || '未知'}]`;
            }
            else if (messageType === 'audio') {
                textContent = '[语音消息]';
            }
            else {
                textContent = `[${messageType || '未知'}消息]`;
            }
            const incomingMessage = {
                platform: 'feishu',
                type: messageType === 'image' ? 'image' : 'text',
                content: textContent,
                from: senderId?.open_id ||
                    senderId?.user_id ||
                    sender?.open_id ||
                    '',
                fromName: sender?.name || '',
                timestamp: new Date().toISOString(),
                rawData: data,
            };
            Logger_1.Logger.info(`📩 飞书消息 | from=${incomingMessage.from} | type=${messageType} | text=${textContent.substring(0, 50)}`, 'FeishuAdapter');
            await this.emitMessage(incomingMessage);
        }
        catch (error) {
            Logger_1.Logger.error('处理飞书消息失败', error, 'FeishuAdapter');
        }
    }
    extractPostText(content) {
        const lines = [];
        const zhCn = (content.zh_cn || content);
        const contentArr = zhCn.content;
        if (Array.isArray(contentArr)) {
            for (const paragraph of contentArr) {
                if (Array.isArray(paragraph)) {
                    const textParts = paragraph
                        .filter((item) => item.tag === 'text')
                        .map((item) => item.text || '');
                    if (textParts.length > 0)
                        lines.push(textParts.join(''));
                }
            }
        }
        return lines.join('\n') || '[富文本消息]';
    }
}
exports.FeishuAdapter = FeishuAdapter;
