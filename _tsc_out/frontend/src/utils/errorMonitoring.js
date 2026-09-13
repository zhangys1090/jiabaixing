"use strict";
/**
 * 错误监控系统
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMonitor = exports.ErrorType = exports.ErrorLevel = void 0;
var ErrorLevel;
(function (ErrorLevel) {
    ErrorLevel["INFO"] = "info";
    ErrorLevel["WARN"] = "warn";
    ErrorLevel["ERROR"] = "error";
    ErrorLevel["CRITICAL"] = "critical";
})(ErrorLevel || (exports.ErrorLevel = ErrorLevel = {}));
var ErrorType;
(function (ErrorType) {
    ErrorType["RUNTIME"] = "runtime";
    ErrorType["RESOURCE"] = "resource";
    ErrorType["NETWORK"] = "network";
    ErrorType["UNKNOWN"] = "unknown";
})(ErrorType || (exports.ErrorType = ErrorType = {}));
class ErrorMonitor {
    isInitialized = false;
    initialize() {
        if (this.isInitialized)
            return;
        window.addEventListener('error', this.handleRuntimeError.bind(this));
        window.addEventListener('unhandledrejection', this.handlePromiseRejection.bind(this));
        window.addEventListener('error', this.handleResourceError.bind(this), true);
        this.isInitialized = true;
        console.log('[ErrorMonitor] 错误监控系统已初始化');
    }
    handleRuntimeError(event) {
        if (event.target instanceof Element || event.target instanceof HTMLElement) {
            return;
        }
        const errorData = {
            message: event.message,
            stack: event.error?.stack,
            level: ErrorLevel.ERROR,
            type: ErrorType.RUNTIME,
            url: event.filename,
            line: event.lineno,
            column: event.colno,
            timestamp: Date.now(),
            userAgent: navigator.userAgent,
            pageUrl: window.location.href,
        };
        void this.reportError(errorData);
    }
    handleResourceError(event) {
        if (event.target instanceof Element || event.target instanceof HTMLElement) {
            const target = event.target;
            const tagName = target.tagName.toLowerCase();
            if (tagName === 'script' ||
                tagName === 'link' ||
                tagName === 'img' ||
                tagName === 'video' ||
                tagName === 'audio') {
                const errorData = {
                    message: `资源加载失败: ${target.src || target.href}`,
                    level: ErrorLevel.WARN,
                    type: ErrorType.RESOURCE,
                    url: target.src || target.href,
                    timestamp: Date.now(),
                    userAgent: navigator.userAgent,
                    pageUrl: window.location.href,
                    additionalData: {
                        tagName,
                    },
                };
                void this.reportError(errorData);
            }
        }
    }
    handlePromiseRejection(event) {
        const errorData = {
            message: event.reason?.message || String(event.reason),
            stack: event.reason?.stack,
            level: ErrorLevel.ERROR,
            type: ErrorType.RUNTIME,
            timestamp: Date.now(),
            userAgent: navigator.userAgent,
            pageUrl: window.location.href,
            additionalData: {
                reason: event.reason,
            },
        };
        void this.reportError(errorData);
    }
    reportNetworkError(url, statusCode, message) {
        const errorData = {
            message: `网络请求失败: ${url} (${statusCode}) - ${message}`,
            level: statusCode >= 500 ? ErrorLevel.ERROR : ErrorLevel.WARN,
            type: ErrorType.NETWORK,
            url,
            statusCode,
            timestamp: Date.now(),
            userAgent: navigator.userAgent,
            pageUrl: window.location.href,
        };
        void this.reportError(errorData);
    }
    reportCustomError(message, level = ErrorLevel.ERROR, additionalData) {
        const errorData = {
            message,
            level,
            type: ErrorType.UNKNOWN,
            timestamp: Date.now(),
            userAgent: navigator.userAgent,
            pageUrl: window.location.href,
            additionalData,
        };
        void this.reportError(errorData);
    }
    async reportError(errorData) {
        try {
            const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || window.location.origin;
            const normalizedBaseUrl = apiBaseUrl.endsWith('/api') ? apiBaseUrl : `${apiBaseUrl}/api`;
            await fetch(`${normalizedBaseUrl}/error/monitoring`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(errorData),
            });
        }
        catch (error) {
            console.error('发送错误报告失败:', error);
        }
    }
}
exports.errorMonitor = new ErrorMonitor();
