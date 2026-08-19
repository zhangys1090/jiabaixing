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
exports.WeChatQRAdapter = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../../utils/Logger");
const BaseIntegrationAdapter_1 = require("./BaseIntegrationAdapter");
class WeChatQRAdapter extends BaseIntegrationAdapter_1.BaseIntegrationAdapter {
    constructor() {
        super('wechat');
        this.loginState = {
            qrCodePath: null,
            qrCodeBase64: null,
            status: 'waiting_scan',
            botWxid: null,
            botNickname: null,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.browser = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.page = null;
        this.loginCheckTimer = null;
        this.messagePollTimer = null;
        this.contacts = new Map();
        this.MAX_CONTACTS = 50000;
    }
    getQRState() {
        return { ...this.loginState };
    }
    async connect(config) {
        try {
            this.config = config;
            this.updateStatus('connecting');
            this.loginState = {
                qrCodePath: null,
                qrCodeBase64: null,
                status: 'waiting_scan',
                botWxid: null,
                botNickname: null,
            };
            Logger_1.Logger.info('正在启动微信扫码登录...', 'WeChatQRAdapter');
            // 使用 Playwright 打开 Web 微信
            const { chromium } = await Promise.resolve().then(() => __importStar(require('playwright')));
            this.browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });
            const context = await this.browser.newContext({
                viewport: { width: 800, height: 600 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            });
            this.page = await context.newPage();
            // 打开微信网页版
            await this.page.goto('https://wx.qq.com/', {
                waitUntil: 'networkidle',
                timeout: 30000,
            });
            Logger_1.Logger.info('微信网页版已加载，等待二维码...', 'WeChatQRAdapter');
            // 等待二维码出现
            await this.page.waitForSelector('img[src*="qrcode"]', { timeout: 15000 });
            // 截取二维码
            await this.captureQRCode();
            // 开始监控扫码状态
            this.startLoginMonitor();
            // 开始消息轮询（登录后自动启用）
            this.startMessagePolling();
            this.updateStatus('connecting');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('启动微信扫码登录失败', error, 'WeChatQRAdapter');
            this.loginState.status = 'error';
            this.loginState.error = error.message;
            this.updateStatus('error', error.message);
            await this.cleanup();
            return false;
        }
    }
    async disconnect() {
        this.loginState.status = 'waiting_scan';
        this.loginState.qrCodeBase64 = null;
        this.loginState.qrCodePath = null;
        this.loginState.botWxid = null;
        this.loginState.botNickname = null;
        await this.cleanup();
        this.updateStatus('disconnected');
        Logger_1.Logger.info('已断开微信连接', 'WeChatQRAdapter');
    }
    async sendMessage(message, to, _imageUrls, _mentions) {
        if (this.loginState.status !== 'logged_in' || !this.page) {
            return { success: false, error: '微信未登录' };
        }
        try {
            // 通过页面控制台执行消息发送
            // 在 Web 微信中，需要找到对应的聊天窗口并发送消息
            if (to) {
                // 查找联系人
                await this.page.evaluate((payload) => {
                    const win = window;
                    const msgSend = win.msgSend;
                    if (msgSend) {
                        msgSend(payload.wxid, payload.msg);
                    }
                }, { wxid: to, msg: message });
            }
            return {
                success: true,
                messageId: `wx_${Date.now()}`,
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            Logger_1.Logger.error('发送微信消息失败', error, 'WeChatQRAdapter');
            return {
                success: false,
                error: error.message,
            };
        }
    }
    async handleWebhook(_payload) {
        return { success: true, response: { handled: false } };
    }
    async captureQRCode() {
        try {
            if (!this.page)
                return;
            // 获取二维码图片
            const qrImg = await this.page.$('img[src*="qrcode"]');
            if (!qrImg) {
                throw new Error('未找到二维码图片');
            }
            // 截图保存
            const uploadsDir = path.join(process.cwd(), 'uploads');
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }
            const qrPath = path.join(uploadsDir, 'wechat-qr.png');
            await qrImg.screenshot({ path: qrPath });
            // 读取为 base64
            const imageBuffer = fs.readFileSync(qrPath);
            const base64 = imageBuffer.toString('base64');
            this.loginState.qrCodePath = qrPath;
            this.loginState.qrCodeBase64 = `data:image/png;base64,${base64}`;
            Logger_1.Logger.info('微信二维码已捕获', 'WeChatQRAdapter');
        }
        catch (error) {
            Logger_1.Logger.error('捕获二维码失败', error, 'WeChatQRAdapter');
            throw error;
        }
    }
    async refreshQRCode() {
        try {
            await this.captureQRCode();
            this.loginState.status = 'waiting_scan';
        }
        catch (err) {
            Logger_1.Logger.warn(`二维码刷新失败: ${err.message}`, 'WeChatQRAdapter');
        }
    }
    startLoginMonitor() {
        this.loginCheckTimer = setInterval(async () => {
            if (!this.page)
                return;
            try {
                // 检查是否已登录
                const isLoggedIn = await this.page.evaluate(() => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const win = window;
                    return (typeof win.login !== 'undefined' ||
                        document.querySelector('.chat') !== null ||
                        document.querySelector('#chatArea') !== null);
                });
                if (isLoggedIn) {
                    this.loginState.status = 'logged_in';
                    // 获取用户信息
                    const userInfo = await this.page.evaluate(() => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const win = window;
                        return {
                            wxid: win.__wxUser?.uin || win.uin || 'unknown',
                            nickname: win.__wxUser?.nickName ||
                                document.querySelector('.avatar_text')?.textContent ||
                                'WeChat User',
                        };
                    });
                    this.loginState.botWxid = userInfo.wxid;
                    this.loginState.botNickname = userInfo.nickname;
                    this.updateStatus('connected');
                    Logger_1.Logger.info(`微信已登录: ${userInfo.nickname}`, 'WeChatQRAdapter');
                    if (this.loginCheckTimer) {
                        clearInterval(this.loginCheckTimer);
                        this.loginCheckTimer = null;
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`登录状态检查失败: ${err.message}`, 'WeChatQRAdapter');
            }
        }, 2000);
        if (this.loginCheckTimer.unref)
            this.loginCheckTimer.unref();
        setTimeout(() => {
            if (this.loginState.status === 'waiting_scan') {
                void this.refreshQRCode();
            }
        }, 5 * 60 * 1000);
    }
    startMessagePolling() {
        this.messagePollTimer = setInterval(async () => {
            if (this.loginState.status !== 'logged_in' || !this.page)
                return;
            try {
                const messages = await this.page.evaluate(() => {
                    const win = window;
                    const newMsgs = win.__newMessages;
                    if (newMsgs && newMsgs.length > 0) {
                        win.__newMessages = [];
                        return newMsgs;
                    }
                    return [];
                });
                if (Array.isArray(messages)) {
                    for (const msg of messages) {
                        const incoming = {
                            platform: 'wechat',
                            type: msg.type === 'image' ? 'image' : 'text',
                            content: msg.content || '',
                            from: msg.from || msg.from_wxid,
                            fromName: msg.from_name || msg.from_nickname,
                            timestamp: new Date().toISOString(),
                            rawData: msg,
                        };
                        await this.emitMessage(incoming);
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`消息轮询失败: ${err.message}`, 'WeChatQRAdapter');
            }
        }, 1500);
        if (this.messagePollTimer.unref)
            this.messagePollTimer.unref();
    }
    async cleanup() {
        if (this.loginCheckTimer) {
            clearInterval(this.loginCheckTimer);
            this.loginCheckTimer = null;
        }
        if (this.messagePollTimer) {
            clearInterval(this.messagePollTimer);
            this.messagePollTimer = null;
        }
        if (this.page) {
            try {
                await this.page.close();
            }
            catch (err) {
                Logger_1.Logger.debug(`微信QR页面关闭失败: ${err?.message}`, 'WeChatQRAdapter');
            }
            this.page = null;
        }
        if (this.browser) {
            try {
                await this.browser.close();
            }
            catch (err) {
                Logger_1.Logger.debug(`微信QR浏览器关闭失败: ${err?.message}`, 'WeChatQRAdapter');
            }
            this.browser = null;
        }
    }
}
exports.WeChatQRAdapter = WeChatQRAdapter;
