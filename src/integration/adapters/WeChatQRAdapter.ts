import * as fs from 'fs';
import * as path from 'path';
import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';
import {
  PlatformConfig,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../../shared/contracts';
import { Logger } from '../../utils/Logger';

interface QRLoginState {
  qrCodePath: string | null;
  qrCodeBase64: string | null;
  status: 'waiting_scan' | 'scanned' | 'logged_in' | 'expired' | 'error';
  botWxid: string | null;
  botNickname: string | null;
  error?: string;
}

export class WeChatQRAdapter extends BaseIntegrationAdapter {
  private loginState: QRLoginState = {
    qrCodePath: null,
    qrCodeBase64: null,
    status: 'waiting_scan',
    botWxid: null,
    botNickname: null,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private browser: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;
  private loginCheckTimer: NodeJS.Timeout | null = null;
  private messagePollTimer: NodeJS.Timeout | null = null;
  private contacts: Map<string, string> = new Map();

  constructor() {
    super('wechat');
  }

  getQRState(): QRLoginState {
    return { ...this.loginState };
  }

  async connect(config: PlatformConfig): Promise<boolean> {
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

      Logger.info('正在启动微信扫码登录...', 'WeChatQRAdapter');

      // 使用 Playwright 打开 Web 微信
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const context = await this.browser.newContext({
        viewport: { width: 800, height: 600 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      this.page = await context.newPage();

      // 打开微信网页版
      await this.page.goto('https://wx.qq.com/', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      Logger.info('微信网页版已加载，等待二维码...', 'WeChatQRAdapter');

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
    } catch (error) {
      Logger.error('启动微信扫码登录失败', error as Error, 'WeChatQRAdapter');
      this.loginState.status = 'error';
      this.loginState.error = (error as Error).message;
      this.updateStatus('error', (error as Error).message);
      await this.cleanup();
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.loginState.status = 'waiting_scan';
    this.loginState.qrCodeBase64 = null;
    this.loginState.qrCodePath = null;
    this.loginState.botWxid = null;
    this.loginState.botNickname = null;
    await this.cleanup();
    this.updateStatus('disconnected');
    Logger.info('已断开微信连接', 'WeChatQRAdapter');
  }

  async sendMessage(
    message: string,
    to?: string,
    _imageUrls?: string[],
    _mentions?: string[]
  ): Promise<SendMessageResponse> {
    if (this.loginState.status !== 'logged_in' || !this.page) {
      return { success: false, error: '微信未登录' };
    }

    try {
      // 通过页面控制台执行消息发送
      // 在 Web 微信中，需要找到对应的聊天窗口并发送消息
      if (to) {
        // 查找联系人
        await this.page.evaluate(
          (payload: { wxid: string; msg: string }) => {
            const win = window as unknown as Record<string, unknown>;
            const msgSend = win.msgSend as
              | ((wxid: string, msg: string) => void)
              | undefined;
            if (msgSend) {
              msgSend(payload.wxid, payload.msg);
            }
          },
          { wxid: to, msg: message }
        );
      }

      return {
        success: true,
        messageId: `wx_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      Logger.error('发送微信消息失败', error as Error, 'WeChatQRAdapter');
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async handleWebhook(
    _payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown }> {
    return { success: true, response: { handled: false } };
  }

  private async captureQRCode(): Promise<void> {
    try {
      if (!this.page) return;

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

      Logger.info('微信二维码已捕获', 'WeChatQRAdapter');
    } catch (error) {
      Logger.error('捕获二维码失败', error as Error, 'WeChatQRAdapter');
      throw error;
    }
  }

  private async refreshQRCode(): Promise<void> {
    try {
      await this.captureQRCode();
      this.loginState.status = 'waiting_scan';
    } catch {
      // 二维码刷新失败，继续等待
    }
  }

  private startLoginMonitor(): void {
    this.loginCheckTimer = setInterval(async () => {
      if (!this.page) return;

      try {
        // 检查是否已登录
        const isLoggedIn = await this.page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const win = window as any;
          return (
            typeof win.login !== 'undefined' ||
            document.querySelector('.chat') !== null ||
            document.querySelector('#chatArea') !== null
          );
        });

        if (isLoggedIn) {
          this.loginState.status = 'logged_in';

          // 获取用户信息
          const userInfo = await this.page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const win = window as any;
            return {
              wxid: win.__wxUser?.uin || win.uin || 'unknown',
              nickname:
                win.__wxUser?.nickName ||
                document.querySelector('.avatar_text')?.textContent ||
                'WeChat User',
            };
          });

          this.loginState.botWxid = userInfo.wxid;
          this.loginState.botNickname = userInfo.nickname;

          this.updateStatus('connected');
          Logger.info(`微信已登录: ${userInfo.nickname}`, 'WeChatQRAdapter');

          if (this.loginCheckTimer) {
            clearInterval(this.loginCheckTimer);
            this.loginCheckTimer = null;
          }
        }
      } catch {
        // 检查失败，继续
      }
    }, 2000);

    // 二维码每 5 分钟刷新一次
    setTimeout(
      () => {
        if (this.loginState.status === 'waiting_scan') {
          void this.refreshQRCode();
        }
      },
      5 * 60 * 1000
    );
  }

  private startMessagePolling(): void {
    this.messagePollTimer = setInterval(async () => {
      if (this.loginState.status !== 'logged_in' || !this.page) return;

      try {
        const messages = await this.page.evaluate(() => {
          const win = window as unknown as Record<string, unknown>;
          const newMsgs = win.__newMessages as
            | Array<Record<string, unknown>>
            | undefined;
          if (newMsgs && newMsgs.length > 0) {
            win.__newMessages = [];
            return newMsgs;
          }
          return [];
        });

        if (Array.isArray(messages)) {
          for (const msg of messages) {
            const incoming: IncomingMessageEvent = {
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
      } catch {
        // 轮询失败，继续
      }
    }, 1500);
  }

  private async cleanup(): Promise<void> {
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
      } catch {}
      this.page = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
  }
}
