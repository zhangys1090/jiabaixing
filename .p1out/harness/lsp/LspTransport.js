"use strict";
/**
 * LSP JSON-RPC 2.0 传输层
 *
 * 通过 child_process 与语言服务器通信
 * 实现 LSP 规范的 Base Protocol（Content-Length 分帧）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LspTransport = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const Logger_1 = require("../../utils/Logger");
class LspTransport extends events_1.EventEmitter {
    constructor(requestTimeout = 30000) {
        super();
        this.process = null;
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.buffer = '';
        this.requestTimeout = requestTimeout;
    }
    async start(command, args = [], env) {
        return new Promise((resolve, reject) => {
            try {
                const spawnEnv = { ...process.env, ...env };
                this.process = (0, child_process_1.spawn)(command, args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: spawnEnv,
                });
                if (!this.process.stdin || !this.process.stdout) {
                    reject(new Error('无法获取进程 stdin/stdout'));
                    return;
                }
                this.process.stdout.on('data', (data) => {
                    this.handleData(data.toString('utf-8'));
                });
                this.process.stderr?.on('data', (data) => {
                    Logger_1.Logger.debug('LspTransport', `stderr: ${data.toString('utf-8').trim()}`);
                });
                this.process.on('error', (err) => {
                    Logger_1.Logger.error('LspTransport', err, '进程错误');
                    this.emit('error', err);
                    reject(err);
                });
                this.process.on('exit', (code) => {
                    Logger_1.Logger.info('LspTransport', `语言服务器退出，代码: ${code}`);
                    this.emit('exit', code);
                    this.cleanup();
                });
                resolve();
            }
            catch (error) {
                reject(error);
            }
        });
    }
    sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin) {
                reject(new Error('传输层未启动'));
                return;
            }
            const id = ++this.messageId;
            const message = {
                jsonrpc: '2.0',
                id,
                method,
                params,
            };
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`请求超时: ${method} (id=${id})`));
            }, this.requestTimeout);
            this.pendingRequests.set(id, { resolve, reject, timer });
            this.sendMessage(message);
        });
    }
    sendNotification(method, params) {
        if (!this.process?.stdin) {
            Logger_1.Logger.warn('LspTransport', '传输层未启动，无法发送通知');
            return;
        }
        const message = {
            jsonrpc: '2.0',
            method,
            params,
        };
        this.sendMessage(message);
    }
    sendMessage(message) {
        const content = JSON.stringify(message);
        const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
        try {
            this.process.stdin.write(header + content);
        }
        catch (error) {
            Logger_1.Logger.error('LspTransport', error, '发送消息失败');
        }
    }
    handleData(data) {
        this.buffer += data;
        while (this.buffer.length > 0) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1)
                break;
            const header = this.buffer.substring(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                this.buffer = this.buffer.substring(headerEnd + 4);
                continue;
            }
            const contentLength = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + contentLength;
            if (this.buffer.length < bodyEnd)
                break;
            const body = this.buffer.substring(bodyStart, bodyEnd);
            this.buffer = this.buffer.substring(bodyEnd);
            try {
                const message = JSON.parse(body);
                this.handleMessage(message);
            }
            catch (error) {
                Logger_1.Logger.error('LspTransport', error, '解析消息失败');
            }
        }
    }
    handleMessage(message) {
        if ('id' in message && ('result' in message || 'error' in message)) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRequests.delete(message.id);
                if (message.error) {
                    pending.reject(new Error(`LSP 错误 ${message.error.code}: ${message.error.message}`));
                }
                else {
                    pending.resolve(message.result);
                }
            }
        }
        else if ('method' in message) {
            this.emit('notification', message);
            this.emit(`notification:${message.method}`, message.params);
        }
    }
    cleanup() {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('连接已关闭'));
        }
        this.pendingRequests.clear();
        this.buffer = '';
    }
    async stop() {
        if (this.process) {
            try {
                this.process.kill();
            }
            catch {
                // 进程可能已退出
            }
            this.process = null;
        }
        this.cleanup();
        this.removeAllListeners();
    }
    isRunning() {
        return this.process !== null && !this.process.killed;
    }
}
exports.LspTransport = LspTransport;
