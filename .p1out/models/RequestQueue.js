"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestQueue = void 0;
const Logger_1 = require("../utils/Logger");
class RequestQueue {
    constructor(config) {
        this._queue = [];
        this._running = 0;
        this._maxConcurrent =
            typeof config === 'number' ? config : (config?.maxConcurrent ?? 5);
        this._defaultTimeoutMs = typeof config === 'number' ? 0 : (config?.timeoutMs ?? 0);
        this._consecutiveFailures = 0;
        this._circuitOpen = false;
        this._circuitOpenUntil = 0;
        this._circuitThreshold = typeof config === 'number' ? 10 : (config?.circuitThreshold ?? 10);
        this._circuitRecoveryMs = typeof config === 'number' ? 30000 : (config?.circuitRecoveryMs ?? 30000);
    }
    async enqueue(fn, timeoutMs, priority = 0) {
        if (this._circuitOpen) {
            if (Date.now() < this._circuitOpenUntil) {
                throw new Error('RequestQueue 熔断中，请求被拒绝');
            }
            this._circuitOpen = false;
            this._consecutiveFailures = 0;
        }
        if (this._running >= this._maxConcurrent) {
            await new Promise((resolve) => this._queue.push({ resolve, priority }));
            this._queue.sort((a, b) => b.priority - a.priority);
        }
        this._running++;
        try {
            const effectiveTimeout = timeoutMs ?? this._defaultTimeoutMs;
            let result;
            if (effectiveTimeout > 0) {
                let timer;
                result = await Promise.race([
                    fn(),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`RequestQueue task timed out after ${effectiveTimeout}ms`)), effectiveTimeout);
                        if (timer.unref)
                            timer.unref();
                    }),
                ]);
                clearTimeout(timer);
            }
            else {
                result = await fn();
            }
            this._consecutiveFailures = 0;
            return result;
        }
        catch (err) {
            this._consecutiveFailures++;
            if (this._consecutiveFailures >= this._circuitThreshold) {
                this._circuitOpen = true;
                this._circuitOpenUntil = Date.now() + this._circuitRecoveryMs;
                Logger_1.Logger.warn(`🔒 RequestQueue 熔断触发: 连续${this._consecutiveFailures}次失败，${this._circuitRecoveryMs / 1000}秒后恢复`, 'RequestQueue');
            }
            throw err;
        }
        finally {
            this._running--;
            if (this._queue.length > 0) {
                const next = this._queue.shift();
                next.resolve();
            }
        }
    }
    get pending() {
        return this._queue.length;
    }
    get running() {
        return this._running;
    }
    get maxConcurrent() {
        return this._maxConcurrent;
    }
    get circuitOpen() {
        return this._circuitOpen && Date.now() < this._circuitOpenUntil;
    }
    clear() {
        const pending = this._queue.splice(0);
        for (const item of pending) {
            item.resolve();
        }
    }
    resetCircuit() {
        this._circuitOpen = false;
        this._consecutiveFailures = 0;
        this._circuitOpenUntil = 0;
    }
}
exports.RequestQueue = RequestQueue;
