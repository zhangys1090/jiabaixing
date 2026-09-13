"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMResponseCache = void 0;
class LLMResponseCache {
    _cache = new Map();
    _ttlMs;
    _maxSize;
    constructor(config) {
        this._ttlMs =
            typeof config === 'number' ? config : (config?.ttlMs ?? 5 * 60 * 1000);
        this._maxSize = typeof config === 'number' ? 500 : (config?.maxSize ?? 500);
    }
    get(key) {
        const entry = this._cache.get(key);
        if (!entry)
            return null;
        if (Date.now() - entry.timestamp > this._ttlMs) {
            this._cache.delete(key);
            return null;
        }
        return entry.response;
    }
    set(key, response) {
        if (this._cache.size >= this._maxSize) {
            this.evictExpired();
            if (this._cache.size >= this._maxSize) {
                const firstKey = this._cache.keys().next().value;
                if (firstKey !== undefined)
                    this._cache.delete(firstKey);
            }
        }
        this._cache.set(key, { response, timestamp: Date.now() });
    }
    evictExpired() {
        const now = Date.now();
        for (const [key, entry] of this._cache) {
            if (now - entry.timestamp > this._ttlMs) {
                this._cache.delete(key);
            }
        }
    }
    has(key) {
        return this.get(key) !== null;
    }
    clear() {
        this._cache.clear();
    }
    generateKey(...parts) {
        return parts.join(':');
    }
}
exports.LLMResponseCache = LLMResponseCache;
