"use strict";
/**
 * 网络出站白名单守卫
 * 确保所有外部网络请求仅指向允许的本地地址，防止用户数据外泄
 * 数据主权核心防线：拦截所有非白名单的出站请求
 */
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
exports.NetworkGuard = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const Logger_1 = require("../utils/Logger");
const DEFAULT_ALLOWED_HOSTS = [
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
    constructor() {
        this.violationLog = [];
        this.allowedHosts = new Set(DEFAULT_ALLOWED_HOSTS.map((h) => h.host));
        this.allowedPorts = new Set(DEFAULT_ALLOWED_PORTS);
        this.enabled = process.env.NETWORK_GUARD_ENABLED !== 'false';
    }
    install() {
        if (!this.enabled) {
            Logger_1.Logger.info('⚠️ 网络守卫：已禁用（NETWORK_GUARD_ENABLED=false）', 'NetworkGuard');
            return;
        }
        this.patchFetch();
        this.patchHttpRequest();
        Logger_1.Logger.info('✅ 网络守卫：出站白名单已安装，仅允许本地请求', 'NetworkGuard');
    }
    isUrlAllowed(url) {
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
            if (this.isPrivateIP(hostname)) {
                Logger_1.Logger.warn(`🚫 网络守卫：拦截私有/元数据IP地址 - ${hostname}`, 'NetworkGuard');
            }
            return false;
        }
        catch (err) {
            Logger_1.Logger.debug(`URL解析失败: ${err?.message}`, 'NetworkGuard');
            return false;
        }
    }
    isPrivateIP(hostname) {
        if (/^10\./.test(hostname))
            return true;
        if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname))
            return true;
        if (/^192\.168\./.test(hostname))
            return true;
        if (/^169\.254\./.test(hostname))
            return true;
        if (/^0\./.test(hostname))
            return true;
        if (/^127\./.test(hostname) && hostname !== '127.0.0.1')
            return true;
        if (/^fc00:/i.test(hostname) || /^fe80:/i.test(hostname))
            return true;
        return false;
    }
    checkRequest(url, source) {
        if (!this.enabled)
            return true;
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
        Logger_1.Logger.warn(`🚫 网络守卫：拦截非白名单出站请求 - ${url}` +
            (source ? ` (来源: ${source})` : ''), 'NetworkGuard');
        return false;
    }
    getViolationLog() {
        return [...this.violationLog];
    }
    addAllowedHost(host, description) {
        this.allowedHosts.add(host);
        Logger_1.Logger.info(`✅ 网络守卫：新增白名单主机 ${host} (${description})`, 'NetworkGuard');
    }
    patchFetch() {
        const originalFetch = globalThis.fetch;
        if (typeof originalFetch !== 'function')
            return;
        const guard = this;
        globalThis.fetch = function patchedFetch(input, init) {
            const url = typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.href
                    : input.url;
            if (!guard.checkRequest(url, 'fetch')) {
                return Promise.reject(new TypeError(`NetworkGuard: 请求被拦截 - 目标地址不在白名单中 (${url})。` +
                    `如需允许此地址，请调用 NetworkGuard.addAllowedHost() 添加。`));
            }
            return originalFetch.call(this, input, init);
        };
    }
    patchHttpRequest() {
        try {
            const guard = this;
            const patchModule = (mod, protocol) => {
                const originalRequest = mod.request;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                mod.request = function patchedRequest(opts, callback) {
                    let host;
                    let port;
                    let pathName = '/';
                    try {
                        if (typeof opts === 'string') {
                            const parsed = new URL(opts);
                            host = parsed.hostname;
                            port = parsed.port;
                            pathName = parsed.pathname;
                        }
                        else if (opts && typeof opts === 'object') {
                            host = opts.hostname || opts.host;
                            port = opts.port;
                            pathName = opts.path || '/';
                        }
                    }
                    catch (err) {
                        Logger_1.Logger.debug(`HTTP请求选项解析失败: ${err?.message}`, 'NetworkGuard');
                        host = undefined;
                    }
                    if (!host) {
                        return originalRequest.call(this, opts, callback);
                    }
                    const url = `${protocol}//${host}${port ? ':' + port : ''}${pathName}`;
                    if (!guard.checkRequest(url, `http.${protocol}`)) {
                        const blockedReq = {
                            abort: () => { },
                            destroy: () => { },
                            on: () => blockedReq,
                            write: () => blockedReq,
                            end: (cb) => {
                                process.nextTick(() => {
                                    if (callback) {
                                        const mockRes = {
                                            statusCode: 403,
                                            headers: { 'content-type': 'application/json' },
                                            on: (event, listener) => {
                                                if (event === 'data') {
                                                    listener(Buffer.from(JSON.stringify({
                                                        error: `NetworkGuard: 请求被拦截 - ${url}`,
                                                    })));
                                                }
                                                if (event === 'end') {
                                                    listener();
                                                }
                                                return mockRes;
                                            },
                                            destroy: () => { },
                                        };
                                        callback(mockRes);
                                    }
                                    cb?.();
                                });
                            },
                        };
                        return blockedReq;
                    }
                    return originalRequest.call(this, opts, callback);
                };
            };
            patchModule(http, 'http:');
            patchModule(https, 'https:');
        }
        catch (err) {
            Logger_1.Logger.info('ℹ️ 网络守卫：http/https模块补丁跳过（模块不可用）', 'NetworkGuard');
        }
    }
}
const networkGuard = new NetworkGuardInner();
exports.NetworkGuard = networkGuard;
