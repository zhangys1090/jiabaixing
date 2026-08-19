import { Logger } from '../utils/Logger';

interface ProxyRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  timeout?: number;
}

interface ProxyResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  backend: 'python' | 'local-fallback';
}

export class DeprecatedModuleProxy {
  private baseUrl: string;
  private fallbackHandlers: Map<string, (req: ProxyRequest) => Promise<unknown>> = new Map();
  private enabled: boolean;

  constructor(baseUrl: string = 'http://127.0.0.1:3112', enabled: boolean = true) {
    this.baseUrl = baseUrl;
    this.enabled = enabled;
  }

  registerFallback(path: string, handler: (req: ProxyRequest) => Promise<unknown>): void {
    this.fallbackHandlers.set(path, handler);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async proxy<T = unknown>(request: ProxyRequest): Promise<ProxyResponse<T>> {
    if (!this.enabled) {
      return this.executeFallback<T>(request);
    }

    try {
      const url = `${this.baseUrl}${request.path}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), request.timeout ?? 30000);

      const fetchOptions: RequestInit = {
        method: request.method,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      };

      if (request.body && request.method !== 'GET') {
        fetchOptions.body = JSON.stringify(request.body);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      if (!response.ok) {
        Logger.warn(`代理请求失败: ${request.method} ${request.path} → ${response.status}`, 'DeprecatedModuleProxy');
        return this.executeFallback<T>(request);
      }

      const data = await response.json() as T;
      return { ok: true, data, backend: 'python' };
    } catch (err) {
      Logger.warn(`Python 后端不可用，回退本地: ${(err as Error).message}`, 'DeprecatedModuleProxy');
      return this.executeFallback<T>(request);
    }
  }

  private async executeFallback<T>(request: ProxyRequest): Promise<ProxyResponse<T>> {
    const handler = this.fallbackHandlers.get(request.path);
    if (handler) {
      try {
        const data = await handler(request) as T;
        return { ok: true, data, backend: 'local-fallback' };
      } catch (err) {
        return { ok: false, error: (err as Error).message, backend: 'local-fallback' };
      }
    }
    return { ok: false, error: `无本地回退处理器: ${request.path}`, backend: 'local-fallback' };
  }
}

export const DEPRECATED_PROXY = new DeprecatedModuleProxy();

export function createDeprecatedProxy(moduleName: string, endpoints: Record<string, string>): DeprecatedModuleProxy {
  const proxy = new DeprecatedModuleProxy();
  Logger.info(`废弃模块代理已创建: ${moduleName} (${Object.keys(endpoints).length} 端点)`, 'DeprecatedModuleProxy');
  return proxy;
}
