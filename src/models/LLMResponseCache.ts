/**
 * @deprecated 已迁移到 Python agent/llm/cache.py。
 * 此存根仅保持向后兼容，V6.0 后移除。
 */
export interface LLMResponseCacheConfig {
  ttlMs?: number;
  maxSize?: number;
}

export class LLMResponseCache {
  private _cache = new Map<string, { response: string; timestamp: number }>();
  private _ttlMs: number;
  private _maxSize: number;

  constructor(config?: LLMResponseCacheConfig | number) {
    this._ttlMs =
      typeof config === 'number' ? config : (config?.ttlMs ?? 5 * 60 * 1000);
    this._maxSize = typeof config === 'number' ? 500 : (config?.maxSize ?? 500);
  }

  get(key: string): string | null {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._ttlMs) {
      this._cache.delete(key);
      return null;
    }
    return entry.response;
  }

  set(key: string, response: string): void {
    if (this._cache.size >= this._maxSize) {
      this.evictExpired();
      if (this._cache.size >= this._maxSize) {
        const firstKey = this._cache.keys().next().value;
        if (firstKey !== undefined) this._cache.delete(firstKey);
      }
    }
    this._cache.set(key, { response, timestamp: Date.now() });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (now - entry.timestamp > this._ttlMs) {
        this._cache.delete(key);
      }
    }
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this._cache.clear();
  }

  generateKey(...parts: unknown[]): string {
    return parts.join(':');
  }
}
