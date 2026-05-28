/**
 * Redis Cache Adapter - Redis缓存适配器
 * 支持分布式缓存，可选回退到内存缓存
 */

import { ICache, CacheOptions, CacheEntry, CacheStats } from './CacheInterface';
import { Logger } from '../utils/Logger';

export interface AdaptiveTTLConfig {
  enabled: boolean;
  minTTL: number;
  maxTTL: number;
  adjustIntervalMs: number;
  highHitRateThreshold: number;
  lowHitRateThreshold: number;
  upscaleFactor: number;
  downscaleFactor: number;
}

export interface RedisCacheConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  ttl?: number;
  maxSize?: number;
  namespace?: string;
  fallbackToMemory?: boolean;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  adaptiveTTL?: Partial<AdaptiveTTLConfig>;
}

/**
 * Redis缓存适配器（支持降级到内存缓存）
 * 注意：项目当前没有安装Redis依赖，此为架构预留
 * 默认回退到内存缓存模式
 */
export class RedisCache<T = Record<string, unknown>> implements ICache<T> {
  private config: RedisCacheConfig;
  private memoryFallback: Map<string, CacheEntry<T>>;
  private hits: number = 0;
  private misses: number = 0;
  private maxSize: number;
  private ttl: number;
  private baseTTL: number;
  private namespace: string;
  private redisAvailable: boolean = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private adaptiveTTLConfig: AdaptiveTTLConfig;
  private adaptiveTTLTimer: NodeJS.Timeout | null = null;
  private ttlAdjustmentLog: Array<{
    timestamp: number;
    oldTTL: number;
    newTTL: number;
    hitRate: number;
  }> = [];

  private static readonly DEFAULT_ADAPTIVE_TTL: AdaptiveTTLConfig = {
    enabled: true,
    minTTL: 30000,
    maxTTL: 600000,
    adjustIntervalMs: 120000,
    highHitRateThreshold: 0.8,
    lowHitRateThreshold: 0.3,
    upscaleFactor: 1.5,
    downscaleFactor: 0.7,
  };

  constructor(config?: RedisCacheConfig) {
    this.config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0', 10),
      ttl: config?.ttl || parseInt(process.env.CACHE_TTL || '120000', 10),
      maxSize: config?.maxSize || 100,
      namespace: config?.namespace || 'llm_cache',
      fallbackToMemory: config?.fallbackToMemory !== false,
      reconnectAttempts: config?.reconnectAttempts || 3,
      reconnectDelay: config?.reconnectDelay || 1000,
    };

    this.memoryFallback = new Map();
    this.maxSize = this.config.maxSize ?? 100;
    this.ttl = this.config.ttl ?? 120000;
    this.baseTTL = this.config.ttl ?? 120000;
    this.namespace = this.config.namespace ?? 'llm_cache';

    this.adaptiveTTLConfig = {
      ...RedisCache.DEFAULT_ADAPTIVE_TTL,
      ...config?.adaptiveTTL,
    };

    void this.initializeRedis();
    this.startCleanup();

    if (this.adaptiveTTLConfig.enabled) {
      this.startAdaptiveTTL();
    }

    Logger.info(
      `🚀 缓存系统初始化完成 (Redis: ${this.redisAvailable ? '启用' : '未启用，使用内存缓存'}, 自适应TTL: ${this.adaptiveTTLConfig.enabled ? '启用' : '禁用'})`,
      'RedisCache'
    );
  }

  /**
   * 初始化Redis连接
   */
  private async initializeRedis(): Promise<void> {
    try {
      // 检查是否有Redis依赖
      // 实际项目中可以在这里导入ioredis或redis
      // 为了保持向后兼容，这里默认使用内存缓存

      // 尝试检测Redis是否可用（简单的连接测试）
      if (process.env.REDIS_ENABLED === 'true') {
        Logger.info(
          '🔌 Redis缓存已启用，但需要安装redis/ioredis依赖',
          'RedisCache'
        );
        Logger.info('📦 运行: npm install ioredis', 'RedisCache');
      }

      this.redisAvailable = false;
      Logger.info(
        '💾 使用内存缓存模式（可通过REDIS_ENABLED=true启用Redis）',
        'RedisCache'
      );
    } catch (error) {
      Logger.warn(
        `⚠️ Redis初始化失败，使用内存缓存: ${(error as Error).message}`,
        'RedisCache'
      );
      this.redisAvailable = false;
    }
  }

  /**
   * 生成带命名空间的键
   */
  private getNamespacedKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  /**
   * 从内存缓存获取
   */
  private getFromMemory(key: string): T | null {
    const entry = this.memoryFallback.get(key);
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.memoryFallback.delete(key);
        this.misses++;
        return null;
      }
      entry.hits++;
      this.hits++;
      return entry.value;
    }
    this.misses++;
    return null;
  }

  /**
   * 存储到内存缓存
   */
  private setToMemory(key: string, value: T, options?: CacheOptions): void {
    const ttl = options?.ttl || this.ttl;

    // LRU淘汰
    if (this.memoryFallback.size >= this.maxSize) {
      const oldestKey = this.memoryFallback.keys().next().value;
      if (oldestKey) {
        this.memoryFallback.delete(oldestKey);
      }
    }

    this.memoryFallback.set(key, {
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
      hits: 0,
    });
  }

  /**
   * 同步获取（内存优先）
   */
  get(key: string): T | null {
    return this.getFromMemory(key);
  }

  /**
   * 同步设置（内存优先）
   */
  set(key: string, value: T, options?: CacheOptions): void {
    this.setToMemory(key, value, options);
  }

  /**
   * 异步获取（支持Redis）
   */
  async getAsync(key: string): Promise<T | null> {
    // 先尝试内存
    const memoryValue = this.getFromMemory(key);
    if (memoryValue !== null) {
      return memoryValue;
    }

    // 尝试Redis
    if (this.redisAvailable) {
      try {
        // Redis获取逻辑（预留）
        Logger.debug('🔄 Redis获取预留位置', 'RedisCache');
      } catch (error) {
        Logger.warn(
          `⚠️ Redis获取失败: ${(error as Error).message}`,
          'RedisCache'
        );
      }
    }

    return null;
  }

  /**
   * 异步设置（支持Redis）
   */
  async setAsync(key: string, value: T, options?: CacheOptions): Promise<void> {
    // 存储到内存
    this.setToMemory(key, value, options);

    // 异步存储到Redis
    if (this.redisAvailable) {
      try {
        // Redis设置逻辑（预留）
        Logger.debug('🔄 Redis设置预留位置', 'RedisCache');
      } catch (error) {
        Logger.warn(
          `⚠️ Redis设置失败: ${(error as Error).message}`,
          'RedisCache'
        );
      }
    }
  }

  /**
   * 删除缓存
   */
  delete(key: string): void {
    this.memoryFallback.delete(key);
  }

  /**
   * 异步删除
   */
  async deleteAsync(key: string): Promise<void> {
    this.memoryFallback.delete(key);

    if (this.redisAvailable) {
      try {
        // Redis删除逻辑（预留）
      } catch (error) {
        Logger.warn(
          `⚠️ Redis删除失败: ${(error as Error).message}`,
          'RedisCache'
        );
      }
    }
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.memoryFallback.clear();
  }

  /**
   * 异步清空
   */
  async clearAsync(): Promise<void> {
    this.memoryFallback.clear();

    if (this.redisAvailable) {
      try {
        // Redis清空逻辑（预留）
      } catch (error) {
        Logger.warn(
          `⚠️ Redis清空失败: ${(error as Error).message}`,
          'RedisCache'
        );
      }
    }
  }

  /**
   * 检查键是否存在
   */
  has(key: string): boolean {
    return this.memoryFallback.has(key);
  }

  /**
   * 获取统计信息
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.memoryFallback.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * 启动定期清理
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000); // 每分钟清理一次
  }

  /**
   * 清理过期条目
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [key, entry] of this.memoryFallback.entries()) {
      if (now > entry.expiresAt) {
        this.memoryFallback.delete(key);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      Logger.debug(`🧹 清理了 ${expiredCount} 个过期缓存条目`, 'RedisCache');
    }
  }

  /**
   * 关闭缓存连接
   */
  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.adaptiveTTLTimer) {
      clearInterval(this.adaptiveTTLTimer);
      this.adaptiveTTLTimer = null;
    }
    Logger.info('🔌 缓存系统已关闭', 'RedisCache');
  }

  /**
   * 获取当前TTL值
   */
  getCurrentTTL(): number {
    return this.ttl;
  }

  /**
   * 获取自适应TTL调整日志
   */
  getTTLAdjustmentLog(): Array<{
    timestamp: number;
    oldTTL: number;
    newTTL: number;
    hitRate: number;
  }> {
    return [...this.ttlAdjustmentLog];
  }

  /**
   * 启动自适应TTL调整
   */
  private startAdaptiveTTL(): void {
    this.adaptiveTTLTimer = setInterval(() => {
      this.adjustTTL();
    }, this.adaptiveTTLConfig.adjustIntervalMs);
    Logger.info(
      `🔄 自适应TTL已启动 (间隔: ${this.adaptiveTTLConfig.adjustIntervalMs / 1000}s)`,
      'RedisCache'
    );
  }

  /**
   * 根据命中率动态调整TTL
   */
  private adjustTTL(): void {
    const stats = this.getStats();
    const hitRate = stats.hitRate;
    const oldTTL = this.ttl;
    let newTTL = this.ttl;

    if (hitRate >= this.adaptiveTTLConfig.highHitRateThreshold) {
      newTTL = Math.min(
        Math.round(this.ttl * this.adaptiveTTLConfig.upscaleFactor),
        this.adaptiveTTLConfig.maxTTL
      );
      Logger.info(
        `📈 缓存命中率高 (${(hitRate * 100).toFixed(1)}%)，延长TTL: ${oldTTL}ms → ${newTTL}ms`,
        'RedisCache'
      );
    } else if (
      hitRate < this.adaptiveTTLConfig.lowHitRateThreshold &&
      stats.hits + stats.misses > 10
    ) {
      newTTL = Math.max(
        Math.round(this.ttl * this.adaptiveTTLConfig.downscaleFactor),
        this.adaptiveTTLConfig.minTTL
      );
      Logger.info(
        `📉 缓存命中率低 (${(hitRate * 100).toFixed(1)}%)，缩短TTL: ${oldTTL}ms → ${newTTL}ms`,
        'RedisCache'
      );
    }

    if (newTTL !== oldTTL) {
      this.ttl = newTTL;
      this.ttlAdjustmentLog.push({
        timestamp: Date.now(),
        oldTTL,
        newTTL,
        hitRate,
      });
      if (this.ttlAdjustmentLog.length > 100) {
        this.ttlAdjustmentLog.shift();
      }
    }
  }

  /**
   * 重置TTL为初始值
   */
  resetTTL(): void {
    this.ttl = this.baseTTL;
    Logger.info(`🔄 TTL已重置为初始值: ${this.baseTTL}ms`, 'RedisCache');
  }
}
