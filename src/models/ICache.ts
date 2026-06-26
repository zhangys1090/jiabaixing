/**
 * ICache — 统一的缓存接口
 *
 * 所有缓存实现（Redis/SQLite/内存）共享此接口。
 * 上层代码通过此接口编程，底层可无缝切换。
 */

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  /** 实现特定的扩展统计 */
  extras?: Record<string, unknown>;
}

export interface ICache<V> {
  /** 读：返回缓存值，不存在或过期返回 undefined */
  get(key: string): V | undefined;

  /** 写：存储值，带 TTL（毫秒），未提供时使用实现默认值 */
  set(key: string, value: V, ttlMs?: number): void;

  /** 删除单个 key */
  delete(key: string): boolean;

  /** 清空全部，返回清除的条目数 */
  clear(): number;

  /** 统计 */
  getStats(): CacheStats;

  /** 资源释放 */
  close(): void;
}

/**
 * 内存缓存实现
 * 默认 InMemoryCache，进程重启后丢失
 */
export class InMemoryCache<V> implements ICache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();
  private hits = 0;
  private misses = 0;
  /** 默认 TTL：1 分钟 */
  private static readonly DEFAULT_TTL_MS = 60_000;

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? InMemoryCache.DEFAULT_TTL_MS;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): number {
    const count = this.store.size;
    this.store.clear();
    return count;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      size: this.store.size,
      extras: { type: 'memory' },
    };
  }

  close(): void {
    this.store.clear();
  }
}
