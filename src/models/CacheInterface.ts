/**
 * Cache Interface - 通用缓存抽象接口
 * 支持多种缓存实现：内存、Redis、混合等
 */

export interface CacheEntry<T = Record<string, unknown>> {
  value: T;
  createdAt: number;
  expiresAt: number;
  hits: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
}

export interface CacheOptions {
  ttl?: number; // Time to live in milliseconds
  maxSize?: number; // Maximum number of entries
  namespace?: string; // Cache namespace for key prefixing
}

/**
 * 通用缓存接口
 */
export interface ICache<T = Record<string, unknown>> {
  /**
   * 获取缓存值
   */
  get(key: string): T | null;

  /**
   * 设置缓存值
   */
  set(key: string, value: T, options?: CacheOptions): void;

  /**
   * 删除缓存值
   */
  delete(key: string): void;

  /**
   * 清空缓存
   */
  clear(): void;

  /**
   * 检查键是否存在
   */
  has(key: string): boolean;

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats;

  /**
   * 异步获取（支持Redis等异步缓存）
   */
  getAsync(key: string): Promise<T | null>;

  /**
   * 异步设置（支持Redis等异步缓存）
   */
  setAsync(key: string, value: T, options?: CacheOptions): Promise<void>;

  /**
   * 异步删除
   */
  deleteAsync(key: string): Promise<void>;

  /**
   * 异步清空
   */
  clearAsync(): Promise<void>;
}
