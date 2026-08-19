"use strict";
/**
 * ActionDispatcher —— 统一动作调度器（编排层单一入口）
 *
 * 归并 harness 工具 / 桌面 / MCP 三通道为一个调度接口：
 *   编排层 → dispatch({ channel, ... }) → 对应 ActionChannel → ActionResult
 *
 * 同时提供 verifyDesktopAction(...) 便捷封装，供桌面动作在执行后接回
 * Python ActionVerifier（闭环）。各通道后端对象经 use* 方法注入，启动时装配。
 *
 * v2 增强：
 * - 通道级断路器：连续失败自动熔断，恢复期后探测恢复
 * - 批量调度：dispatchBatch 支持并发/顺序批量动作
 * - 调度指标采集：成功率、P50/P95 延迟、通道健康度
 * - 通道健康检查：isChannelHealthy / getChannelHealth
 *
 * v3 增强：
 * - 调度优先级队列：高/中/低优先级，高优先级请求优先调度
 * - 通道自动降级：主通道熔断时自动切换到备用通道
 * - 调度限流：令牌桶算法控制每通道最大并发
 * - 调度事件通知：调度成功/失败/熔断事件回调
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionDispatcher = void 0;
exports.getActionDispatcher = getActionDispatcher;
exports.configureActionDispatcher = configureActionDispatcher;
const ToolChannel_1 = require("./channels/ToolChannel");
const DesktopChannel_1 = require("./channels/DesktopChannel");
const McpChannel_1 = require("./channels/McpChannel");
const VerificationBridge_1 = require("./verify/VerificationBridge");
const DesktopActionExecutor_1 = require("../../desktop/DesktopActionExecutor");
const Logger_1 = require("../../utils/Logger");
const CIRCUIT_BREAKER_DEFAULTS = {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenMaxProbe: 1,
};
class CircuitBreaker {
    constructor(config) {
        this._state = 'closed';
        this._failureCount = 0;
        this._successCount = 0;
        this._lastFailureTime = 0;
        this._halfOpenProbeCount = 0;
        this._config = { ...CIRCUIT_BREAKER_DEFAULTS, ...config };
    }
    get state() { return this._state; }
    get failureCount() { return this._failureCount; }
    allow() {
        if (this._state === 'closed')
            return true;
        if (this._state === 'open') {
            const elapsed = Date.now() - this._lastFailureTime;
            if (elapsed >= this._config.resetTimeoutMs) {
                this._state = 'half-open';
                this._halfOpenProbeCount = 0;
                return true;
            }
            return false;
        }
        if (this._state === 'half-open') {
            return this._halfOpenProbeCount < this._config.halfOpenMaxProbe;
        }
        return false;
    }
    recordSuccess() {
        this._successCount++;
        if (this._state === 'half-open') {
            this._state = 'closed';
            this._failureCount = 0;
        }
    }
    recordFailure() {
        this._failureCount++;
        this._lastFailureTime = Date.now();
        if (this._state === 'half-open') {
            this._state = 'open';
        }
        else if (this._failureCount >= this._config.failureThreshold) {
            this._state = 'open';
        }
    }
    reset() {
        this._state = 'closed';
        this._failureCount = 0;
        this._successCount = 0;
        this._halfOpenProbeCount = 0;
    }
    getStats() {
        return { state: this._state, failureCount: this._failureCount, successCount: this._successCount };
    }
}
class ActionDispatcher {
    constructor() {
        this.channels = new Map();
        this.toolRegistry = null;
        this.desktopExecutor = null;
        this.verifier = (0, VerificationBridge_1.getActionVerificationBridge)();
        this._circuitBreakers = new Map();
        this._dispatchMetrics = { total: 0, success: 0, failed: 0, durations: [] };
        this._priorityQueue = { high: [], medium: [], low: [] };
        this._isDraining = false;
        this._fallbackMap = new Map();
        this._rateLimiters = new Map();
        this._dispatchCallbacks = [];
        this.ensureChannels();
    }
    _getBreaker(channel) {
        if (!this._circuitBreakers.has(channel)) {
            this._circuitBreakers.set(channel, new CircuitBreaker());
        }
        return this._circuitBreakers.get(channel);
    }
    isChannelHealthy(channel) {
        const breaker = this._circuitBreakers.get(channel);
        if (!breaker)
            return true;
        return breaker.state === 'closed' || breaker.state === 'half-open';
    }
    getChannelHealth(channel) {
        const breaker = this._circuitBreakers.get(channel);
        if (!breaker)
            return { healthy: true, state: 'closed', failureCount: 0, successCount: 0 };
        const stats = breaker.getStats();
        return { healthy: stats.state !== 'open', ...stats };
    }
    getAllChannelHealth() {
        const result = {};
        for (const channel of this.channels.keys()) {
            result[channel] = this.getChannelHealth(channel);
        }
        return result;
    }
    getDispatchMetrics() {
        const m = this._dispatchMetrics;
        const sorted = [...m.durations].sort((a, b) => a - b);
        const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
        const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
        return {
            total: m.total,
            success: m.success,
            failed: m.failed,
            successRate: m.total > 0 ? m.success / m.total : 0,
            p50Ms: p50,
            p95Ms: p95,
        };
    }
    resetDispatchMetrics() {
        this._dispatchMetrics = { total: 0, success: 0, failed: 0, durations: [] };
    }
    ensureChannels() {
        if (!this.channels.has('mcp')) {
            this.channels.set('mcp', new McpChannel_1.McpChannel());
        }
        const desktop = this.desktopExecutor ?? DesktopActionExecutor_1.DesktopActionExecutor.getInstance();
        if (!this.channels.has('desktop')) {
            this.channels.set('desktop', new DesktopChannel_1.DesktopChannel(desktop, this.verifier));
        }
    }
    useToolRegistry(registry) {
        this.toolRegistry = registry;
        this.channels.set('tool', new ToolChannel_1.ToolChannel(registry));
        return this;
    }
    useDesktopExecutor(executor) {
        this.desktopExecutor = executor;
        this.channels.set('desktop', new DesktopChannel_1.DesktopChannel(executor, this.verifier));
        return this;
    }
    useVerifier(verifier) {
        this.verifier = verifier;
        const desktop = this.desktopExecutor ?? DesktopActionExecutor_1.DesktopActionExecutor.getInstance();
        this.channels.set('desktop', new DesktopChannel_1.DesktopChannel(desktop, verifier));
        return this;
    }
    registerChannel(channel) {
        this.channels.set(channel.kind, channel);
        return this;
    }
    getChannel(kind) {
        return this.channels.get(kind);
    }
    async dispatch(request) {
        const priority = request.priority || 'medium';
        if (priority === 'low' && this._hasHigherPriorityPending()) {
            this._priorityQueue.low.push(request);
            if (!this._isDraining) {
                this._drainQueue();
            }
            return {
                channel: request.channel,
                success: false,
                output: null,
                error: '低优先级请求已入队，等待高优先级请求完成',
                durationMs: 0,
                queued: true,
                priority,
            };
        }
        if (priority === 'medium' && this._priorityQueue.high.length > 0) {
            this._priorityQueue.medium.push(request);
            if (!this._isDraining) {
                this._drainQueue();
            }
            return {
                channel: request.channel,
                success: false,
                output: null,
                error: '中优先级请求已入队，等待高优先级请求完成',
                durationMs: 0,
                queued: true,
                priority,
            };
        }
        return this._dispatchWithFallback(request);
    }
    _hasHigherPriorityPending() {
        return this._priorityQueue.high.length > 0 || this._priorityQueue.medium.length > 0;
    }
    async _drainQueue() {
        if (this._isDraining) return;
        this._isDraining = true;
        try {
            while (this._priorityQueue.high.length > 0 || this._priorityQueue.medium.length > 0 || this._priorityQueue.low.length > 0) {
                let request = this._priorityQueue.high.shift() || this._priorityQueue.medium.shift() || this._priorityQueue.low.shift();
                if (request) {
                    try {
                        await this._dispatchWithFallback(request);
                    }
                    catch (err) {
                        Logger_1.Logger.warn(`ActionDispatcher 队列调度异常: ${err.message}`, 'ActionDispatcher');
                    }
                }
            }
        }
        finally {
            this._isDraining = false;
        }
    }
    async _dispatchWithFallback(request) {
        let channel = this.channels.get(request.channel);
        if (!channel) {
            Logger_1.Logger.warn(`ActionDispatcher 未注册通道: ${request.channel}`, 'ActionDispatcher');
            return {
                channel: request.channel,
                success: false,
                output: null,
                error: `未注册的动作通道: ${request.channel}`,
                durationMs: 0,
            };
        }
        const breaker = this._getBreaker(request.channel);
        if (!breaker.allow()) {
            const fallback = this._fallbackMap.get(request.channel);
            if (fallback && this.channels.has(fallback)) {
                const fallbackBreaker = this._getBreaker(fallback);
                if (fallbackBreaker.allow()) {
                    Logger_1.Logger.info(`ActionDispatcher 通道 ${request.channel} 熔断，降级到 ${fallback}`, 'ActionDispatcher');
                    this._notifyCallbacks('fallback', { from: request.channel, to: fallback, tool: request.tool });
                    const fallbackReq = { ...request, channel: fallback };
                    return this._dispatchInternal(fallbackReq);
                }
            }
            Logger_1.Logger.warn(`ActionDispatcher 通道 ${request.channel} 断路器开启(熔断)，拒绝调度`, 'ActionDispatcher');
            this._notifyCallbacks('circuit_open', { channel: request.channel, tool: request.tool });
            return {
                channel: request.channel,
                success: false,
                output: null,
                error: `通道 ${request.channel} 已熔断，请稍后重试`,
                durationMs: 0,
                circuitBreakerOpen: true,
            };
        }
        return this._dispatchInternal(request);
    }
    async _dispatchInternal(request) {
        const channel = this.channels.get(request.channel);
        if (!channel) {
            return {
                channel: request.channel,
                success: false,
                output: null,
                error: `未注册的动作通道: ${request.channel}`,
                durationMs: 0,
            };
        }
        const breaker = this._getBreaker(request.channel);
        const rateLimiter = this._getRateLimiter(request.channel);
        if (!rateLimiter.tryConsume()) {
            return {
                channel: request.channel,
                success: false,
                output: null,
                error: `通道 ${request.channel} 限流中，请稍后重试`,
                durationMs: 0,
                rateLimited: true,
            };
        }
        const dispatchTimeout = request.timeoutMs || 30000;
        const startTime = Date.now();
        const maxRetries = request.retries ?? 0;
        const retryDelayBase = 500;
        let lastResult = null;
        let attemptStartTime = startTime;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            attemptStartTime = Date.now();
            let timeoutId;
            try {
                const result = await Promise.race([
                    channel.dispatch(request),
                    new Promise((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error(`动作调度超时: ${request.channel}/${request.tool} (${dispatchTimeout}ms)`)), dispatchTimeout);
                        if (timeoutId.unref)
                            timeoutId.unref();
                    }),
                ]);
                clearTimeout(timeoutId);
                if (result.success) {
                    breaker.recordSuccess();
                    this._dispatchMetrics.total++;
                    this._dispatchMetrics.success++;
                    const durationMs = Date.now() - startTime;
                    this._dispatchMetrics.durations.push(durationMs);
                    if (this._dispatchMetrics.durations.length > 1000) {
                        this._dispatchMetrics.durations = this._dispatchMetrics.durations.slice(-500);
                    }
                    this._notifyCallbacks('success', { channel: request.channel, tool: request.tool, durationMs });
                    return result;
                }
                breaker.recordFailure();
                this._dispatchMetrics.total++;
                this._dispatchMetrics.failed++;
                this._notifyCallbacks('failure', { channel: request.channel, tool: request.tool, error: result.error });
                if (attempt === maxRetries) {
                    const durationMs = Date.now() - startTime;
                    this._dispatchMetrics.durations.push(durationMs);
                    if (this._dispatchMetrics.durations.length > 1000) {
                        this._dispatchMetrics.durations = this._dispatchMetrics.durations.slice(-500);
                    }
                    return result;
                }
                lastResult = result;
                if (attempt < maxRetries) {
                    const delay = Math.min(retryDelayBase * Math.pow(2, attempt), 30000);
                    Logger_1.Logger.warn(`ActionDispatcher 重试 ${attempt + 1}/${maxRetries}: ${request.channel}/${request.tool} — ${result.error} (${delay}ms后)`, 'ActionDispatcher');
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
            catch (err) {
                clearTimeout(timeoutId);
                breaker.recordFailure();
                this._dispatchMetrics.total++;
                this._dispatchMetrics.failed++;
                this._notifyCallbacks('error', { channel: request.channel, tool: request.tool, error: err.message });
                lastResult = {
                    channel: request.channel,
                    success: false,
                    output: null,
                    error: err.message,
                    durationMs: Date.now() - startTime,
                };
                if (attempt < maxRetries) {
                    const delay = Math.min(retryDelayBase * Math.pow(2, attempt), 30000);
                    Logger_1.Logger.warn(`ActionDispatcher 异常重试 ${attempt + 1}/${maxRetries}: ${err.message} (${delay}ms后)`, 'ActionDispatcher');
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
        }
        return lastResult || {
            channel: request.channel,
            success: false,
            output: null,
            error: '所有重试均失败',
            durationMs: Date.now() - startTime,
        };
    }
    async dispatchBatch(requests, options) {
        const concurrency = options?.concurrency ?? 4;
        const continueOnError = options?.continueOnError ?? true;
        const results = [];
        if (concurrency <= 1) {
            for (const req of requests) {
                const result = await this.dispatch(req);
                results.push(result);
                if (!result.success && !continueOnError)
                    break;
            }
        }
        else {
            const executing = new Set();
            let idx = 0;
            const enqueue = async () => {
                while (idx < requests.length) {
                    const currentIdx = idx++;
                    const req = requests[currentIdx];
                    const promise = this.dispatch(req).then((result) => {
                        results[currentIdx] = result;
                        executing.delete(promise);
                        return result;
                    });
                    executing.add(promise);
                    if (executing.size >= concurrency) {
                        await Promise.race(executing);
                    }
                    if (!continueOnError && results.some((r) => r && !r.success)) {
                        break;
                    }
                }
            };
            await Promise.all([enqueue(), ...executing]);
        }
        const successCount = results.filter((r) => r?.success).length;
        return {
            results,
            total: results.length,
            successCount,
            failedCount: results.length - successCount,
            allSucceeded: successCount === results.length,
        };
    }
    async verifyDesktopAction(description, prePath, postPath, opts = {}) {
        return this.verifier.verify({
            description,
            prePath,
            postPath,
            strategy: opts.strategy ?? 'auto',
            question: opts.question ?? '',
        });
    }
    _getRateLimiter(channel) {
        if (!this._rateLimiters.has(channel)) {
            this._rateLimiters.set(channel, new TokenBucketRateLimiter(10, 1000));
        }
        return this._rateLimiters.get(channel);
    }
    setChannelRateLimit(channel, maxTokens, refillIntervalMs) {
        this._rateLimiters.set(channel, new TokenBucketRateLimiter(maxTokens, refillIntervalMs));
        Logger_1.Logger.info(`ActionDispatcher 通道 ${channel} 限流设置: ${maxTokens}次/${refillIntervalMs}ms`, 'ActionDispatcher');
    }
    setChannelFallback(primaryChannel, fallbackChannel) {
        this._fallbackMap.set(primaryChannel, fallbackChannel);
        Logger_1.Logger.info(`ActionDispatcher 通道降级配置: ${primaryChannel} → ${fallbackChannel}`, 'ActionDispatcher');
    }
    onDispatchEvent(callback) {
        this._dispatchCallbacks.push(callback);
        return () => {
            const idx = this._dispatchCallbacks.indexOf(callback);
            if (idx >= 0) this._dispatchCallbacks.splice(idx, 1);
        };
    }
    _notifyCallbacks(eventType, data) {
        for (const cb of this._dispatchCallbacks) {
            try {
                cb(eventType, data);
            }
            catch { }
        }
    }
    getDispatchSummary() {
        const metrics = this.getDispatchMetrics();
        const channelHealth = this.getAllChannelHealth();
        const fallbacks = Object.fromEntries(this._fallbackMap);
        return { metrics, channelHealth, fallbacks };
    }
}
class TokenBucketRateLimiter {
    constructor(maxTokens, refillIntervalMs) {
        this._maxTokens = maxTokens;
        this._tokens = maxTokens;
        this._refillIntervalMs = refillIntervalMs;
        this._lastRefillTime = Date.now();
    }
    tryConsume() {
        this._refill();
        if (this._tokens > 0) {
            this._tokens--;
            return true;
        }
        return false;
    }
    _refill() {
        const now = Date.now();
        const elapsed = now - this._lastRefillTime;
        if (elapsed >= this._refillIntervalMs) {
            const intervals = Math.floor(elapsed / this._refillIntervalMs);
            this._tokens = Math.min(this._maxTokens, this._tokens + intervals);
            this._lastRefillTime = now;
        }
    }
}
exports.ActionDispatcher = ActionDispatcher;
let _dispatcher = null;
function getActionDispatcher() {
    if (!_dispatcher)
        _dispatcher = new ActionDispatcher();
    return _dispatcher;
}
function configureActionDispatcher(opts) {
    const d = getActionDispatcher();
    if (opts.toolRegistry)
        d.useToolRegistry(opts.toolRegistry);
    if (opts.desktopExecutor)
        d.useDesktopExecutor(opts.desktopExecutor);
    if (opts.verifier)
        d.useVerifier(opts.verifier);
    return d;
}
