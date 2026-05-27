import { ChildProcess, fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';
import type {
  IntegrationPlatform,
  PlatformConfig,
  IntegrationPlatformInfo,
  IntegrationStatus,
  SendMessageRequest,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../shared/contracts';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface GatewayBridgeOptions {
  maxRestartAttempts?: number;
  restartDelayMs?: number;
  requestTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

const DEFAULT_OPTIONS: Required<GatewayBridgeOptions> = {
  maxRestartAttempts: 5,
  restartDelayMs: 3000,
  requestTimeoutMs: 15000,
  healthCheckIntervalMs: 30000,
};

export class GatewayBridge {
  private worker: ChildProcess | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private messageHandler: ((msg: unknown) => void) | null = null;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private workerReady = false;
  private readonly options: Required<GatewayBridgeOptions>;
  private onIncomingMessage:
    | ((message: IncomingMessageEvent) => Promise<void>)
    | null = null;
  private static instance: GatewayBridge | null = null;

  private constructor(options?: GatewayBridgeOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  static getInstance(options?: GatewayBridgeOptions): GatewayBridge {
    if (!GatewayBridge.instance) {
      GatewayBridge.instance = new GatewayBridge(options);
    }
    return GatewayBridge.instance;
  }

  setIncomingMessageHandler(
    handler: (message: IncomingMessageEvent) => Promise<void>
  ): void {
    this.onIncomingMessage = handler;
  }

  async start(): Promise<void> {
    if (this.worker) {
      Logger.warn('Gateway Worker 已在运行', 'GatewayBridge');
      return;
    }

    this.isShuttingDown = false;
    await this.spawnWorker();
    this.startHealthCheck();
    Logger.info('🟢 GatewayBridge 已启动，网关运行在独立进程', 'GatewayBridge');
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHealthCheck();

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('GatewayBridge 正在关闭'));
    }
    this.pendingRequests.clear();

    if (this.worker) {
      this.worker.kill('SIGTERM');
      const forceKillTimer = setTimeout(() => {
        if (this.worker) {
          this.worker.kill('SIGKILL');
        }
      }, 5000);

      await new Promise<void>((resolve) => {
        if (this.worker) {
          this.worker.on('exit', () => {
            clearTimeout(forceKillTimer);
            resolve();
          });
        } else {
          resolve();
        }
      });

      this.worker = null;
      this.workerReady = false;
    }

    Logger.info('GatewayBridge 已停止', 'GatewayBridge');
  }

  isWorkerAlive(): boolean {
    return this.worker !== null && this.workerReady;
  }

  async connectPlatform(
    platform: IntegrationPlatform,
    config: PlatformConfig
  ): Promise<boolean> {
    const result = await this.sendRequest('connect', { platform, config });
    return result as boolean;
  }

  async disconnectPlatform(
    platform: IntegrationPlatform
  ): Promise<void> {
    await this.sendRequest('disconnect', { platform });
  }

  async sendMessage(
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return (await this.sendRequest('sendMessage', request)) as SendMessageResponse;
  }

  getPlatforms(): IntegrationPlatformInfo[] {
    if (!this.isWorkerAlive()) {
      return this.getOfflinePlatforms();
    }

    const syncResult = this.sendSyncRequest('getPlatforms');
    return (syncResult?.data as { platforms: IntegrationPlatformInfo[] })
      ?.platforms ?? this.getOfflinePlatforms();
  }

  getPlatformStatus(
    platform: IntegrationPlatform
  ): IntegrationStatus | undefined {
    if (!this.isWorkerAlive()) {
      return {
        platform,
        connected: false,
        status: 'disconnected',
        error: 'Gateway Worker 未运行',
      };
    }

    const syncResult = this.sendSyncRequest('getStatus', { platform });
    return syncResult?.data as IntegrationStatus | undefined;
  }

  getWeChatQRState(): {
    qrCodeBase64: string | null;
    status: string;
    botNickname: string | null;
  } | null {
    if (!this.isWorkerAlive()) return null;

    const syncResult = this.sendSyncRequest('getWeChatQRState');
    return syncResult?.data as {
      qrCodeBase64: string | null;
      status: string;
      botNickname: string | null;
    } | null;
  }

  async handleWebhook(
    platform: IntegrationPlatform,
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; response?: unknown }> {
    return (await this.sendRequest('handleWebhook', {
      platform,
      payload,
    })) as { success: boolean; response?: unknown };
  }

  private async spawnWorker(): Promise<void> {
    const jsPath = path.join(__dirname, 'gatewayWorker.js');
    const tsPath = path.join(__dirname, 'gatewayWorker.ts');

    let workerPath: string;
    let execArgv: string[];

    if (fs.existsSync(jsPath)) {
      workerPath = jsPath;
      execArgv = [];
      Logger.info(`使用编译后的 Worker: ${jsPath}`, 'GatewayBridge');
    } else if (fs.existsSync(tsPath)) {
      workerPath = tsPath;
      execArgv = ['-r', 'ts-node/register'];
      Logger.info(`使用源码 Worker: ${tsPath}`, 'GatewayBridge');
    } else {
      throw new Error(`找不到 gatewayWorker 文件 (尝试: ${jsPath}, ${tsPath})`);
    }

    try {
      this.worker = fork(workerPath, [], {
        execArgv,
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      this.worker.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          Logger.debug(`[GW] ${output}`, 'GatewayBridge');
        }
      });

      this.worker.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          Logger.warn(`[GW ERR] ${output}`, 'GatewayBridge');
        }
      });

      this.messageHandler = (msg: unknown) => {
        this.handleWorkerMessage(msg);
      };
      this.worker.on('message', this.messageHandler);

      this.worker.on('exit', (code, signal) => {
        Logger.warn(
          `Gateway Worker 退出 (code=${code}, signal=${signal})`,
          'GatewayBridge'
        );
        this.worker = null;
        this.workerReady = false;

        if (!this.isShuttingDown) {
          this.scheduleRestart();
        }
      });

      this.worker.on('error', (err: Error) => {
        Logger.error('Gateway Worker 进程错误', err, 'GatewayBridge');
        this.worker = null;
        this.workerReady = false;

        if (!this.isShuttingDown) {
          this.scheduleRestart();
        }
      });

      await new Promise<void>((resolve, reject) => {
        const readyTimeout = setTimeout(() => {
          this.cleanupWorker();
          reject(new Error('Gateway Worker 启动超时 (10s)'));
        }, 10000);

        const originalHandler = this.messageHandler;
        this.messageHandler = (msg: unknown) => {
          const ipcMsg = msg as { id?: string; data?: { type?: string } };
          if (ipcMsg.id === 'worker_ready' && ipcMsg.data?.type === 'ready') {
            clearTimeout(readyTimeout);
            this.workerReady = true;
            this.restartAttempts = 0;
            Logger.info('✅ Gateway Worker 已就绪', 'GatewayBridge');
            resolve();

            this.worker?.on('message', originalHandler!);
            this.messageHandler = originalHandler;
            return;
          }
          this.handleWorkerMessage(msg);
        };

        if (this.worker) {
          this.worker.off('message', originalHandler!);
          this.worker.on('message', this.messageHandler);
        }
      });
    } catch (error) {
      Logger.error(
        'Gateway Worker 启动失败，回退到内联模式',
        error as Error,
        'GatewayBridge'
      );
      this.cleanupWorker();
      throw error;
    }
  }

  private cleanupWorker(): void {
    if (this.worker) {
      this.worker.kill('SIGTERM');
      this.worker = null;
    }
    this.workerReady = false;
  }

  private handleWorkerMessage(msg: unknown): void {
    const ipcMsg = msg as {
      id: string;
      success: boolean;
      data?: unknown;
      error?: string;
    };

    if (!ipcMsg.id) return;

    const pending = this.pendingRequests.get(ipcMsg.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(ipcMsg.id);

      if (ipcMsg.success) {
        pending.resolve(ipcMsg.data);
      } else {
        pending.reject(new Error(ipcMsg.error || 'Gateway Worker 返回错误'));
      }
      return;
    }

    if (
      ipcMsg.data &&
      typeof ipcMsg.data === 'object' &&
      (ipcMsg.data as { type?: string }).type === 'incoming_message'
    ) {
      const payload = (ipcMsg.data as { payload: IncomingMessageEvent })
        .payload;
      if (this.onIncomingMessage && payload) {
        this.onIncomingMessage(payload).catch((err: Error) => {
          Logger.error('处理网关消息失败', err, 'GatewayBridge');
        });
      }

      EventBus.emit('integration_message', {
        platform: payload.platform,
        type: payload.type,
        content: payload.content,
        from: payload.from,
        fromName: payload.fromName,
        timestamp: payload.timestamp || new Date().toISOString(),
        rawData: payload.rawData,
      });
      return;
    }

    if (ipcMsg.id?.startsWith('err_')) {
      Logger.error(
        `Gateway Worker 错误: ${ipcMsg.error}`,
        undefined,
        'GatewayBridge'
      );
    }
  }

  private sendRequest(type: string, payload?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.workerReady) {
        reject(new Error('Gateway Worker 未就绪'));
        return;
      }

      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`请求超时: ${type}`));
      }, this.options.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.worker.send!({ id, type, payload });
    });
  }

  private sendSyncRequest(
    type: string,
    payload?: unknown
  ): { data?: unknown } | null {
    if (!this.worker || !this.workerReady) return null;

    let result: { data?: unknown } | null = null;
    const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const tempHandler = (msg: unknown) => {
      const ipcMsg = msg as { id?: string; data?: unknown };
      if (ipcMsg.id === id) {
        result = { data: ipcMsg.data };
      }
    };

    this.worker.on('message', tempHandler);
    this.worker.send!({ id, type, payload });

    const deadline = Date.now() + 5000;
    while (!result && Date.now() < deadline) {
      continue;
    }

    this.worker.off('message', tempHandler);
    return result;
  }

  private scheduleRestart(): void {
    if (this.isShuttingDown) return;

    if (this.restartAttempts >= this.options.maxRestartAttempts) {
      Logger.error(
        `Gateway Worker 重启已达最大次数 (${this.options.maxRestartAttempts})，停止重启`,
        undefined,
        'GatewayBridge'
      );

      EventBus.emit('system_status', 'gateway_down', '网关进程崩溃且重启失败');
      return;
    }

    this.restartAttempts++;
    const delay = Math.min(
      this.options.restartDelayMs *
        Math.pow(1.5, this.restartAttempts - 1),
      60000
    );

    Logger.info(
      `Gateway Worker 将在 ${Math.round(delay / 1000)}s 后重启 (第 ${this.restartAttempts} 次)`,
      'GatewayBridge'
    );

    this.restartTimer = setTimeout(async () => {
      try {
        await this.spawnWorker();
        Logger.info('✅ Gateway Worker 重启成功', 'GatewayBridge');
      } catch {
        Logger.warn('Gateway Worker 重启失败，将再次尝试', 'GatewayBridge');
        this.scheduleRestart();
      }
    }, delay);
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      if (!this.worker || !this.workerReady) return;

      try {
        await this.sendRequest('ping');
      } catch {
        Logger.warn('Gateway Worker 健康检查失败', 'GatewayBridge');
      }
    }, this.options.healthCheckIntervalMs);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private getOfflinePlatforms(): IntegrationPlatformInfo[] {
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

    return Object.entries(PLATFORM_INFO).map(([key, info]) => ({
      ...info,
      available: false,
      status: {
        platform: key as IntegrationPlatform,
        connected: false,
        status: 'disconnected' as const,
        error: 'Gateway Worker 未运行',
      },
    }));
  }
}
