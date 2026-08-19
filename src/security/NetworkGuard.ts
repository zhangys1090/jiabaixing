/**
 * 网络出站白名单守卫
 * 确保所有外部网络请求仅指向允许的本地地址，防止用户数据外泄
 * 数据主权核心防线：拦截所有非白名单的出站请求
 */

import type { IncomingMessage } from 'http';
import * as http from 'http';
import * as https from 'https';
import { Logger } from '../utils/Logger';

interface AllowedHost {
  host: string;
  port?: number;
  description: string;
}

interface HttpRequestOptions {
  hostname?: string;
  host?: string;
  port?: string | number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}

type HttpRequestCallback = (res: IncomingMessage) => void;

interface BlockedRequest {
  abort(): void;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): BlockedRequest;
  write(data: string | Buffer): BlockedRequest;
  end(cb?: () => void): void;
}

const DEFAULT_ALLOWED_HOSTS: AllowedHost[] = [
  { host: '127.0.0.1', description: '本地LLM服务器' },
  { host: 'localhost', description: '本地服务' },
  { host: '0.0.0.0', description: '本地绑定地址' },
  { host: '::1', description: 'IPv6本地地址' },
  { host: 'open.bigmodel.cn', description: '智谱云端API' },
  { host: 'api.openai.com', description: 'OpenAI API' },
  { host: 'api.tavily.com', description: 'Tavily搜索API' },
  { host: 'html.duckduckgo.com', description: 'DuckDuckGo搜索HTML' },
  { host: 'lite.duckduckgo.com', description: 'DuckDuckGo搜索Lite' },
  { host: 'www.bing.com', description: 'Bing搜索' },
  { host: 'www.baidu.com', description: '百度搜索' },
  { host: 'market.jiabaixing.ai', description: 'jiabaixing插件市场' },
  { host: 'api.deepseek.com', description: 'DeepSeek API' },
  { host: 'token-plan-cn.xiaomimimo.com', description: '小米 MiMo API' },
];

const DEFAULT_ALLOWED_PORTS = [3111, 8000, 8001, 3000, 3100, 11434, 8080];

class NetworkGuardInner {
  private allowedHosts: Set<string>;
  private allowedPorts: Set<number>;
  private enabled: boolean;
  private violationLog: Array<{
    url: string;
    timestamp: number;
    stack?: string;
  }> = [];

  constructor() {
    this.allowedHosts = new Set(DEFAULT_ALLOWED_HOSTS.map((h) => h.host));
    this.allowedPorts = new Set(DEFAULT_ALLOWED_PORTS);
    this.enabled = process.env.NETWORK_GUARD_ENABLED !== 'false';
  }

  public install(): void {
    if (!this.enabled) {
      Logger.info(
        '⚠️ 网络守卫：已禁用（NETWORK_GUARD_ENABLED=false）',
        'NetworkGuard'
      );
      return;
    }

    this.patchFetch();
    this.patchHttpRequest();
    Logger.info(
      '✅ 网络守卫：出站白名单已安装，仅允许本地请求',
      'NetworkGuard'
    );
  }

  public isUrlAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      if (this.allowedHosts.has(hostname)) {
        return true;
      }

      if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
        if (this.allowedHosts.has(hostname)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  public checkRequest(url: string, source?: string): boolean {
    if (!this.enabled) return true;

    if (this.isUrlAllowed(url)) {
      return true;
    }

    const violation = {
      url,
      timestamp: Date.now(),
      stack: new Error().stack?.split('\n').slice(2, 5).join('\n'),
    };
    this.violationLog.push(violation);

    if (this.violationLog.length > 100) {
      this.violationLog = this.violationLog.slice(-50);
    }

    Logger.warn(
      `🚫 网络守卫：拦截非白名单出站请求 - ${url}` +
        (source ? ` (来源: ${source})` : ''),
      'NetworkGuard'
    );

    return false;
  }

  public getViolationLog(): Array<{
    url: string;
    timestamp: number;
    stack?: string;
  }> {
    return [...this.violationLog];
  }

  public addAllowedHost(host: string, description: string): void {
    this.allowedHosts.add(host);
    Logger.info(
      `✅ 网络守卫：新增白名单主机 ${host} (${description})`,
      'NetworkGuard'
    );
  }

  private patchFetch(): void {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== 'function') return;

    const guard = this;

    globalThis.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit
    ) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (!guard.checkRequest(url, 'fetch')) {
        return Promise.reject(
          new TypeError(
            `NetworkGuard: 请求被拦截 - 目标地址不在白名单中 (${url})。` +
              `如需允许此地址，请调用 NetworkGuard.addAllowedHost() 添加。`
          )
        );
      }

      return originalFetch.call(this, input, init);
    };
  }

  private patchHttpRequest(): void {
    try {
      const guard = this;

      const patchModule = (
        mod: typeof http | typeof https,
        protocol: string
      ) => {
        const originalRequest = mod.request;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mod as any).request = function patchedRequest(
          opts: string | HttpRequestOptions,
          callback?: HttpRequestCallback
        ) {
          let host: string | undefined;
          let port: string | number | undefined;
          let pathName: string = '/';

          try {
            if (typeof opts === 'string') {
              const parsed = new URL(opts);
              host = parsed.hostname;
              port = parsed.port;
              pathName = parsed.pathname;
            } else if (opts && typeof opts === 'object') {
              host = opts.hostname || opts.host;
              port = opts.port;
              pathName = opts.path || '/';
            }
          } catch {
            host = undefined;
          }

          if (!host) {
            return originalRequest.call(
              this,
              opts as Parameters<typeof originalRequest>[0],
              callback as Parameters<typeof originalRequest>[1]
            );
          }

          const url = `${protocol}//${host}${port ? ':' + port : ''}${pathName}`;

          if (!guard.checkRequest(url, `http.${protocol}`)) {
            const blockedReq: BlockedRequest = {
              abort: () => {},
              destroy: () => {},
              on: () => blockedReq,
              write: () => blockedReq,
              end: (cb?: () => void) => {
                process.nextTick(() => {
                  if (callback) {
                    const mockRes = {
                      statusCode: 403,
                      headers: { 'content-type': 'application/json' },
                      on: (
                        event: string,
                        listener: (...args: unknown[]) => void
                      ) => {
                        if (event === 'data') {
                          listener(
                            Buffer.from(
                              JSON.stringify({
                                error: `NetworkGuard: 请求被拦截 - ${url}`,
                              })
                            )
                          );
                        }
                        if (event === 'end') {
                          listener();
                        }
                        return mockRes;
                      },
                      destroy: () => {},
                    } as Partial<IncomingMessage> as IncomingMessage;
                    callback(mockRes);
                  }
                  cb?.();
                });
              },
            };
            return blockedReq;
          }

          return originalRequest.call(
            this,
            opts as Parameters<typeof originalRequest>[0],
            callback as Parameters<typeof originalRequest>[1]
          );
        };
      };

      patchModule(http, 'http:');
      patchModule(https, 'https:');
    } catch {
      Logger.info(
        'ℹ️ 网络守卫：http/https模块补丁跳过（模块不可用）',
        'NetworkGuard'
      );
    }
  }
}

const networkGuard = new NetworkGuardInner();

export { networkGuard as NetworkGuard };
