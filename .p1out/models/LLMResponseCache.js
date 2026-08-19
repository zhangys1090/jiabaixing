"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMResponseCache = void 0;
const node_crypto_1 = require("crypto");
class LLMResponseCache {
    constructor(config) {
        this._cache = new Map();
        this._stats = { hits: 0, misses: 0, evictions: 0 };
        this._ttlMs =
            typeof config === 'number' ? config : (config?.ttlMs ?? 5 * 60 * 1000);
        this._maxSize =
            typeof config === 'number' ? 500 : (config?.maxSize ?? 500);
    }
    get(key) {
        const entry = this._cache.get(key);
        if (!entry) {
            this._stats.misses++;
            return null;
        }
        if (Date.now() - entry.timestamp > this._ttlMs) {
            this._cache.delete(key);
            this._stats.evictions++;
            this._stats.misses++;
            return null;
        }
        this._stats.hits++;
        return entry.response;
    }
    set(key, response) {
        if (this._cache.size >= this._maxSize) {
            const oldestKey = this._cache.keys().next().value;
            this._cache.delete(oldestKey);
            this._stats.evictions++;
        }
        this._cache.set(key, { response, timestamp: Date.now() });
    }
    has(key) {
        const entry = this._cache.get(key);
        if (!entry) return false;
        if (Date.now() - entry.timestamp > this._ttlMs) {
            this._cache.delete(key);
            this._stats.evictions++;
            return false;
        }
        return true;
    }
    clear() {
        this._cache.clear();
    }
    generateKey(...parts) {
        const joined = parts
            .map((p) => String(p || ''))
            .join('\x00');
        return (0, node_crypto_1.createHash)('sha256').update(joined).digest('hex').slice(0, 32);
    }
    getStats() {
        const total = this._stats.hits + this._stats.misses;
        return {
            ...this._stats,
            size: this._cache.size,
            hitRate: total > 0 ? this._stats.hits / total : 0,
        };
    }
    invalidateByPrefix(prefix) {
        let count = 0;
        for (const key of this._cache.keys()) {
            if (key.startsWith(prefix)) {
                this._cache.delete(key);
                count++;
            }
        }
        this._stats.evictions += count;
        return count;
    }
}
exports.LLMResponseCache = LLMResponseCache;
