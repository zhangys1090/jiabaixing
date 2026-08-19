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
exports.GatewayBridge = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
const DEFAULT_OPTIONS = {
    maxRestartAttempts: 5,
    restartDelayMs: 3000,
    requestTimeoutMs: 15000,
    healthCheckIntervalMs: 30000,
};
class GatewayBridge {
    constructor(options) {
        this.worker = null;
        this.pendingRequests = new Map();
        this.MAX_PENDING_REQUESTS = 1000;
        this.messageHandler = null;
        this.restartAttempts = 0;
        this.restartTimer = null;
        this.healthCheckTimer = null;
        this.isShuttingDown = false;
        this.workerReady = false;
        this.onIncomingMessage = null;
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }
    static getInstance(options) {
        if (!GatewayBridge.instance) {
            GatewayBridge.instance = new GatewayBridge(options);
        }
        return GatewayBridge.instance;
    }
    setIncomingMessageHandler(handler) {
        this.onIncomingMessage = handler;
    }
    async start() {
        if (this.worker) {
            Logger_1.Logger.warn('Gateway Worker 已在运行', 'GatewayBridge');
            return;
        }
        this.isShuttingDown = false;
        await this.spawnWorker();
        this.startHealthCheck();
        Logger_1.Logger.info('🟢 GatewayBridge 已启动，网关运行在独立进程', 'GatewayBridge');
    }
    async stop() {
        this.isShuttingDown = true;
        this.stopHealthCheck();
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        for (const [, pending] of this.pendingRequests) {
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
            await new Promise((resolve) => {
                if (this.worker) {
                    this.worker.on('exit', () => {
                        clearTimeout(forceKillTimer);
                        resolve();
                    });
                }
                else {
                    resolve();
                }
            });
            this.worker = null;
            this.workerReady = false;
        }
        Logger_1.Logger.info('GatewayBridge 已停止', 'GatewayBridge');
    }
    isWorkerAlive() {
        return this.worker !== null && this.workerReady;
    }
    async connectPlatform(platform, config) {
        const result = await this.sendRequest('connect', { platform, config });
        return result;
    }
    async disconnectPlatform(platform) {
        await this.sendRequest('disconnect', { platform });
    }
    async sendMessage(request) {
        return (await this.sendRequest('sendMessage', request));
    }
    async getPlatforms() {
        if (!this.isWorkerAlive()) {
            return this.getOfflinePlatforms();
        }
        const syncResult = await this.sendSyncRequest('getPlatforms');
        return (syncResult?.data
            ?.platforms ?? this.getOfflinePlatforms());
    }
    async getPlatformStatus(platform) {
        if (!this.isWorkerAlive()) {
            return {
                platform,
                connected: false,
                status: 'disconnected',
                error: 'Gateway Worker 未运行',
            };
        }
        const syncResult = await this.sendSyncRequest('getStatus', { platform });
        return syncResult?.data;
    }
    async getWeChatQRState() {
        if (!this.isWorkerAlive())
            return null;
        const syncResult = await this.sendSyncRequest('getWeChatQRState');
        return syncResult?.data;
    }
    async handleWebhook(platform, payload) {
        return (await this.sendRequest('handleWebhook', {
            platform,
            payload,
        }));
    }
    async spawnWorker() {
        const jsPath = path.join(__dirname, 'gatewayWorker.js');
        const tsPath = path.join(__dirname, 'gatewayWorker.ts');
        let workerPath;
        let execArgv;
        if (fs.existsSync(jsPath)) {
            workerPath = jsPath;
            execArgv = [];
            Logger_1.Logger.info(`使用编译后的 Worker: ${jsPath}`, 'GatewayBridge');
        }
        else if (fs.existsSync(tsPath)) {
            workerPath = tsPath;
            execArgv = ['-r', 'ts-node/register'];
            Logger_1.Logger.info(`使用源码 Worker: ${tsPath}`, 'GatewayBridge');
        }
        else {
            throw new Error(`找不到 gatewayWorker 文件 (尝试: ${jsPath}, ${tsPath})`);
        }
        try {
            this.worker = (0, child_process_1.fork)(workerPath, [], {
                execArgv,
                env: {
                    ...process.env,
                    TS_NODE_TRANSPILE_ONLY: 'true',
                },
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            });
            this.worker.stdout?.on('data', (data) => {
                const output = data.toString().trim();
                if (output) {
                    Logger_1.Logger.debug(`[GW] ${output}`, 'GatewayBridge');
                }
            });
            this.worker.stderr?.on('data', (data) => {
                const output = data.toString().trim();
                if (output) {
                    Logger_1.Logger.warn(`[GW ERR] ${output}`, 'GatewayBridge');
                }
            });
            this.messageHandler = (msg) => {
                this.handleWorkerMessage(msg);
            };
            this.worker.on('message', this.messageHandler);
            this.worker.on('exit', (code, signal) => {
                Logger_1.Logger.warn(`Gateway Worker 退出 (code=${code}, signal=${signal})`, 'GatewayBridge');
                this.worker = null;
                this.workerReady = false;
                if (!this.isShuttingDown) {
                    this.scheduleRestart();
                }
            });
            this.worker.on('error', (err) => {
                Logger_1.Logger.error('Gateway Worker 进程错误', err, 'GatewayBridge');
                this.worker = null;
                this.workerReady = false;
                if (!this.isShuttingDown) {
                    this.scheduleRestart();
                }
            });
            await new Promise((resolve, reject) => {
                const readyTimeout = setTimeout(() => {
                    this.cleanupWorker();
                    reject(new Error('Gateway Worker 启动超时 (10s)'));
                }, 10000);
                const originalHandler = this.messageHandler;
                this.messageHandler = (msg) => {
                    const ipcMsg = msg;
                    if (ipcMsg.id === 'worker_ready' && ipcMsg.data?.type === 'ready') {
                        clearTimeout(readyTimeout);
                        this.workerReady = true;
                        this.restartAttempts = 0;
                        Logger_1.Logger.info('✅ Gateway Worker 已就绪', 'GatewayBridge');
                        resolve();
                        this.worker?.on('message', originalHandler);
                        this.messageHandler = originalHandler;
                        return;
                    }
                    this.handleWorkerMessage(msg);
                };
                if (this.worker) {
                    this.worker.off('message', originalHandler);
                    this.worker.on('message', this.messageHandler);
                }
            });
        }
        catch (error) {
            Logger_1.Logger.error('Gateway Worker 启动失败，回退到内联模式', error, 'GatewayBridge');
            this.cleanupWorker();
            throw error;
        }
    }
    cleanupWorker() {
        if (this.worker) {
            this.worker.kill('SIGTERM');
            this.worker = null;
        }
        this.workerReady = false;
    }
    handleWorkerMessage(msg) {
        const ipcMsg = msg;
        if (!ipcMsg.id)
            return;
        const pending = this.pendingRequests.get(ipcMsg.id);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(ipcMsg.id);
            if (ipcMsg.success) {
                pending.resolve(ipcMsg.data);
            }
            else {
                pending.reject(new Error(ipcMsg.error || 'Gateway Worker 返回错误'));
            }
            return;
        }
        if (ipcMsg.data &&
            typeof ipcMsg.data === 'object' &&
            ipcMsg.data.type === 'incoming_message') {
            const payload = ipcMsg.data
                .payload;
            if (this.onIncomingMessage && payload) {
                this.onIncomingMessage(payload).catch((err) => {
                    Logger_1.Logger.error('处理网关消息失败', err, 'GatewayBridge');
                });
            }
            return;
        }
        if (ipcMsg.id?.startsWith('err_')) {
            Logger_1.Logger.error(`Gateway Worker 错误: ${ipcMsg.error}`, undefined, 'GatewayBridge');
        }
    }
    sendRequest(type, payload) {
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
            if (this.pendingRequests.size > this.MAX_PENDING_REQUESTS) {
                const oldestKey = this.pendingRequests.keys().next().value;
                const oldest = this.pendingRequests.get(oldestKey);
                if (oldest?.timer) clearTimeout(oldest.timer);
                this.pendingRequests.delete(oldestKey);
            }
            try {
                this.worker.send({ id, type, payload });
            }
            catch (err) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(new Error(`发送请求失败 (${type}): ${err.message}`));
            }
        });
    }
    async sendSyncRequest(type, payload) {
        if (!this.worker || !this.workerReady)
            return null;
        const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.worker?.off('message', tempHandler);
                resolve(null);
            }, 5000);
            const tempHandler = (msg) => {
                const ipcMsg = msg;
                if (ipcMsg.id === id) {
                    clearTimeout(timer);
                    this.worker?.off('message', tempHandler);
                    resolve({ data: ipcMsg.data });
                }
            };
            this.worker.on('message', tempHandler);
            this.worker.send({ id, type, payload });
        });
    }
    scheduleRestart() {
        if (this.isShuttingDown)
            return;
        if (this.restartAttempts >= this.options.maxRestartAttempts) {
            Logger_1.Logger.error(`Gateway Worker 重启已达最大次数 (${this.options.maxRestartAttempts})，停止重启`, undefined, 'GatewayBridge');
            EventBus_1.EventBus.emit('system_status', 'gateway_down', '网关进程崩溃且重启失败');
            return;
        }
        this.restartAttempts++;
        const delay = Math.min(this.options.restartDelayMs * Math.pow(1.5, this.restartAttempts - 1), 60000);
        Logger_1.Logger.info(`Gateway Worker 将在 ${Math.round(delay / 1000)}s 后重启 (第 ${this.restartAttempts} 次)`, 'GatewayBridge');
        this.restartTimer = setTimeout(async () => {
            try {
                await this.spawnWorker();
                Logger_1.Logger.info('✅ Gateway Worker 重启成功', 'GatewayBridge');
            }
            catch (err) {
                Logger_1.Logger.warn(`Gateway Worker 重启失败: ${err.message}，将再次尝试`, 'GatewayBridge');
                this.scheduleRestart();
            }
        }, delay);
        if (this.restartTimer.unref)
            this.restartTimer.unref();
    }
    startHealthCheck() {
        this.healthCheckTimer = setInterval(async () => {
            if (!this.worker || !this.workerReady)
                return;
            try {
                await this.sendRequest('ping');
            }
            catch (err) {
                Logger_1.Logger.warn(`Gateway Worker 健康检查失败: ${err?.message}`, 'GatewayBridge');
            }
        }, this.options.healthCheckIntervalMs);
        if (this.healthCheckTimer.unref)
            this.healthCheckTimer.unref();
    }
    stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
    getOfflinePlatforms() {
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
                description: '通过 Bot API 连接 Telegram',
                enabled: true,
            },
            discord: {
                id: 'discord',
                name: 'Discord',
                icon: '🎮',
                description: '通过 Webhook 连接 Discord',
                enabled: true,
            },
            slack: {
                id: 'slack',
                name: 'Slack',
                icon: '📱',
                description: '通过 Webhook 连接 Slack',
                enabled: true,
            },
            signal: {
                id: 'signal',
                name: 'Signal',
                icon: '🔒',
                description: '连接到 Signal',
                enabled: true,
            },
        };
        return Object.entries(PLATFORM_INFO).map(([key, info]) => ({
            ...info,
            available: false,
            status: {
                platform: key,
                connected: false,
                status: 'disconnected',
                error: 'Gateway Worker 未运行',
            },
        }));
    }
}
exports.GatewayBridge = GatewayBridge;
GatewayBridge.instance = null;
