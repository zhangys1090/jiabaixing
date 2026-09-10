/**
 * LSP JSON-RPC 2.0 传输层
 *
 * 通过 child_process 与语言服务器通信
 * 实现 LSP 规范的 Base Protocol（Content-Length 分帧）
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { Logger } from '../../utils/Logger';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class LspTransport extends EventEmitter {
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = '';
  private readonly requestTimeout: number;
  private static readonly MAX_BUFFER_SIZE = 10 * 1024 * 1024;

  constructor(requestTimeout = 30000) {
    super();
    this.requestTimeout = requestTimeout;
  }

  async start(
    command: string,
    args: string[] = [],
    env?: Record<string, string>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const spawnEnv = { ...process.env, ...env };

        this.process = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: spawnEnv,
        });

        if (!this.process.stdin || !this.process.stdout) {
          reject(new Error('无法获取进程 stdin/stdout'));
          return;
        }

        this.process.stdout.on('data', (data: Buffer) => {
          this.handleData(data.toString('utf-8'));
        });

        this.process.stderr?.on('data', (data: Buffer) => {
          Logger.debug(
            'LspTransport',
            `stderr: ${data.toString('utf-8').trim()}`
          );
        });

        this.process.on('error', (err) => {
          Logger.error('LspTransport', err, '进程错误');
          this.emit('error', err);
          reject(err);
        });

        this.process.on('exit', (code) => {
          Logger.info('LspTransport', `语言服务器退出，代码: ${code}`);
          this.emit('exit', code);
          this.cleanup();
        });

        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('传输层未启动'));
        return;
      }

      const id = ++this.messageId;
      const message: JsonRpcRequest = {
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

  sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin) {
      Logger.warn('LspTransport', '传输层未启动，无法发送通知');
      return;
    }

    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.sendMessage(message);
  }

  private sendMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

    try {
      this.process!.stdin!.write(header + content);
    } catch (error) {
      Logger.error('LspTransport', error as Error, '发送消息失败');
    }
  }

  private handleData(data: string): void {
    this.buffer += data;

    if (this.buffer.length > LspTransport.MAX_BUFFER_SIZE) {
      Logger.warn(
        'LspTransport',
        `缓冲区超过 ${LspTransport.MAX_BUFFER_SIZE} 字节，截断`
      );
      this.buffer = this.buffer.substring(
        this.buffer.length - Math.floor(LspTransport.MAX_BUFFER_SIZE / 2)
      );
    }

    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.substring(bodyStart, bodyEnd);
      this.buffer = this.buffer.substring(bodyEnd);

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch (error) {
        Logger.error('LspTransport', error as Error, '解析消息失败');
      }
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(
            new Error(
              `LSP 错误 ${message.error.code}: ${message.error.message}`
            )
          );
        } else {
          pending.resolve(message.result);
        }
      }
    } else if ('method' in message) {
      this.emit('notification', message);
      this.emit(`notification:${message.method}`, message.params);
    }
  }

  private cleanup(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('连接已关闭'));
    }
    this.pendingRequests.clear();
    this.buffer = '';
  }

  async stop(): Promise<void> {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // 进程可能已退出
      }
      this.process = null;
    }
    this.cleanup();
    this.removeAllListeners();
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
