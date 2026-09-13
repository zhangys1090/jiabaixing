"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPRECATED_PROXY = exports.DeprecatedModuleProxy = void 0;
exports.createDeprecatedProxy = createDeprecatedProxy;
const Logger_1 = require("../utils/Logger");
class DeprecatedModuleProxy {
    baseUrl;
    fallbackHandlers = new Map();
    enabled;
    constructor(baseUrl = 'http://127.0.0.1:3112', enabled = true) {
        this.baseUrl = baseUrl;
        this.enabled = enabled;
    }
    registerFallback(path, handler) {
        this.fallbackHandlers.set(path, handler);
    }
    setEnabled(enabled) {
        this.enabled = enabled;
    }
    async proxy(request) {
        if (!this.enabled) {
            return this.executeFallback(request);
        }
        try {
            const url = `${this.baseUrl}${request.path}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), request.timeout ?? 30000);
            const fetchOptions = {
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
                Logger_1.Logger.warn(`代理请求失败: ${request.method} ${request.path} → ${response.status}`, 'DeprecatedModuleProxy');
                return this.executeFallback(request);
            }
            const data = (await response.json());
            return { ok: true, data, backend: 'python' };
        }
        catch (err) {
            Logger_1.Logger.warn(`Python 后端不可用，回退本地: ${err.message}`, 'DeprecatedModuleProxy');
            return this.executeFallback(request);
        }
    }
    async executeFallback(request) {
        const handler = this.fallbackHandlers.get(request.path);
        if (handler) {
            try {
                const data = (await handler(request));
                return { ok: true, data, backend: 'local-fallback' };
            }
            catch (err) {
                return {
                    ok: false,
                    error: err.message,
                    backend: 'local-fallback',
                };
            }
        }
        return {
            ok: false,
            error: `无本地回退处理器: ${request.path}`,
            backend: 'local-fallback',
        };
    }
}
exports.DeprecatedModuleProxy = DeprecatedModuleProxy;
exports.DEPRECATED_PROXY = new DeprecatedModuleProxy();
function createDeprecatedProxy(moduleName, endpoints) {
    const proxy = new DeprecatedModuleProxy();
    Logger_1.Logger.info(`废弃模块代理已创建: ${moduleName} (${Object.keys(endpoints).length} 端点)`, 'DeprecatedModuleProxy');
    return proxy;
}
