import * as net from 'net';
import { Logger } from '../utils/Logger';
import { backendUrl, IPC_TIMEOUT_MS } from './constants';

/**
 * 获取 IPC 端点路径
 * Windows 使用 Named Pipe，Linux/macOS 使用 Unix Domain Socket
 * 可通过环境变量 IPC_PATH 覆盖默认路径
 * @returns IPC 端点路径
 */
export function getIpcPath(): string {
  if (process.env.IPC_PATH) {
    return process.env.IPC_PATH;
  }
  const isWindows = process.platform === 'win32';
  return isWindows ? '\\\\.\\pipe\\jiabaixing' : '/tmp/jiabaixing.sock';
}

/**
 * 从响应数据中提取文本内容，兼容多种响应格式
 * 支持嵌套 data.data.response、data.response、data.message、data.text 等
 * @param data - 响应数据（对象或任意类型）
 * @returns 提取的文本内容
 */
export function extractResponse(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  const obj = data as Record<string, unknown>;
  return ((obj.data as Record<string, unknown> | undefined)?.response ??
    obj.response ??
    obj.message ??
    obj.text ??
    obj.output ??
    obj.error ??
    JSON.stringify(data)) as string;
}

/**
 * 通用请求函数：优先尝试 IPC，失败时降级到 HTTP
 * @param ipcMethod - IPC 方法名
 * @param ipcParams - IPC 参数
 * @param httpOptions - HTTP 选项
 * @returns 请求结果
 */
export async function requestWithFallback<T>(
  ipcMethod: string,
  ipcParams: Record<string, unknown> = {},
  httpOptions: {
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: Record<string, unknown>;
    timeout?: number;
  }
): Promise<T> {
  // 优先尝试 IPC
  try {
    const ipcResult = await ipcSend(ipcMethod, ipcParams);
    return ipcResult as T;
  } catch (err) {
    Logger.warn(
      `IPC 请求 "${ipcMethod}" 失败，降级到 HTTP`,
      'RequestWithFallback',
      err
    );
  }

  // HTTP 请求
  const { path, method = 'GET', body, timeout = 60000 } = httpOptions;
  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  return (await res.json()) as T;
}

/**
 * 通过 IPC 发送请求到 jiabaixing 服务端
 * 使用 JSON Lines 协议通信，比 HTTP 更快（无 HTTP 开销）
 * @param method - 要调用的方法名
 * @param params - 方法参数
 * @returns 服务端返回的 result 字段，或抛出错误
 */
export async function ipcSend(
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const ipcPath = getIpcPath();
  let requestId = 0;

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(ipcPath, () => {
      requestId++;
      const request = JSON.stringify({ id: requestId, method, params }) + '\n';
      socket.write(request);
    });

    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('IPC 连接超时'));
    }, IPC_TIMEOUT_MS);

    socket.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        clearTimeout(timer);
        try {
          const response = JSON.parse(trimmed) as {
            id: number;
            result?: unknown;
            error?: { code: number; message: string };
          };

          if (response.error) {
            socket.destroy();
            reject(new Error(response.error.message));
          } else {
            socket.destroy();
            resolve(response.result);
          }
        } catch (err) {
          Logger.debug(
            'IPC 响应部分解析失败，继续等待完整数据',
            'IpcSend',
            err
          );
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      reject(new Error('IPC 连接不可用'));
    });

    socket.on('close', () => {
      clearTimeout(timer);
    });
  });
}

/**
 * 检测 IPC 服务是否可用
 * 通过发送 ping 请求验证连接
 * @returns true 表示 IPC 可用
 */
export async function isIpcAvailable(): Promise<boolean> {
  try {
    await ipcSend('ping');
    return true;
  } catch {
    return false;
  }
}
