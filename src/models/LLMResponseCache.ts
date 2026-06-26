/**
 * @deprecated 已迁移到 Python agent/llm/cache.py。当 AGENT_BACKEND=python（默认）时不再使用此文件。
 *   回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现。
 *   迁移日期：2026-06-22
 */

import crypto from 'crypto';
import { perf } from '../monitoring/PerformanceMonitor';
import { Logger } from '../utils/Logger';
import { RedisCache } from './RedisCache';

export class LLMResponseCache {
  private cache: RedisCache<string>;
  private static readonly MAX_CACHE_SIZE = 100;
  private cacheTTL: number = 120000;

  // 向后兼容 - 保留旧接口，内部使用新系统
  private legacyCache: Map<string, { text: string; timestamp: number }> =
    new Map();
  private useNewCacheSystem: boolean;

  constructor(ttl?: number) {
    // 检查是否启用新缓存系统
    this.useNewCacheSystem = process.env.USE_NEW_CACHE !== 'false';

    if (ttl !== undefined) {
      this.cacheTTL = ttl;
    }

    if (this.useNewCacheSystem) {
      // 使用新的Redis缓存适配器
      this.cache = new RedisCache<string>({
        ttl: this.cacheTTL,
        maxSize: LLMResponseCache.MAX_CACHE_SIZE,
        namespace: 'llm_response',
      });
      Logger.info('🚀 启用新一代缓存系统', 'LLMResponseCache');
    } else {
      // 旧系统回退
      this.cache = new RedisCache<string>({
        ttl: this.cacheTTL,
        maxSize: LLMResponseCache.MAX_CACHE_SIZE,
      });
      Logger.info('⚠️ 使用兼容模式缓存系统', 'LLMResponseCache');
    }

    this.startCleanup();
  }

  generateKey(input: string, systemPrompt?: string): string {
    const data = JSON.stringify({ input, systemPrompt });
    return crypto.createHash('md5').update(data).digest('hex');
  }

  get(key: string): string | null {
    return measureSync(
      'cache_get',
      () => {
        if (this.useNewCacheSystem) {
          const result = this.cache.get(key);
          if (result) {
            Logger.debug(
              `缓存命中: ${key.substring(0, 8)}...`,
              'LLMResponseCache'
            );
          }
          return result ?? null;
        }

        // 旧接口兼容
        const cached = this.legacyCache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
          Logger.debug(
            `缓存命中: ${key.substring(0, 8)}...`,
            'LLMResponseCache'
          );
          return cached.text;
        }
        return null;
      },
      'cache'
    );
  }

  set(key: string, text: string): void {
    measureSync(
      'cache_set',
      () => {
        if (this.useNewCacheSystem) {
          this.cache.set(key, text);
          Logger.debug(
            `缓存设置: ${key.substring(0, 8)}... (${text.length} chars)`,
            'LLMResponseCache'
          );
          return;
        }

        // 旧接口兼容
        this.legacyCache.set(key, { text, timestamp: Date.now() });

        if (this.legacyCache.size > LLMResponseCache.MAX_CACHE_SIZE) {
          const oldestKey = this.legacyCache.keys().next().value;
          if (oldestKey) this.legacyCache.delete(oldestKey);
        }
      },
      'cache'
    );
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    if (this.useNewCacheSystem) {
      return this.cache.getStats();
    }
    return {
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: this.legacyCache.size,
      maxSize: LLMResponseCache.MAX_CACHE_SIZE,
    };
  }

  /**
   * 获取当前TTL值（自适应）
   */
  getCurrentTTL(): number {
    if (this.useNewCacheSystem) {
      return this.cache.getCurrentTTL();
    }
    return this.cacheTTL;
  }

  /**
   * 获取TTL调整日志
   */
  getTTLAdjustmentLog(): Array<{
    timestamp: number;
    oldTTL: number;
    newTTL: number;
    hitRate: number;
  }> {
    if (this.useNewCacheSystem) {
      return this.cache.getTTLAdjustmentLog();
    }
    return [];
  }

  /**
   * 重置TTL为初始值
   */
  resetTTL(): void {
    if (this.useNewCacheSystem) {
      this.cache.resetTTL();
    }
  }

  private startCleanup(): void {
    // 新缓存系统内部已处理清理，这里保留兼容
  }

  clear(): void {
    if (this.useNewCacheSystem) {
      this.cache.clear();
    }
    this.legacyCache.clear();
    Logger.info('🧹 缓存已清空', 'LLMResponseCache');
  }

  destroy(): void {
    if (this.useNewCacheSystem) {
      this.cache.close?.();
    }
    this.legacyCache.clear();
  }
}

// 便捷的性能测量函数
function measureSync<T>(name: string, fn: () => T, category?: string): T {
  const id = perf.startSpan(name, category || 'llm_cache');
  try {
    const result = fn();
    perf.endSpan(id, true);
    return result;
  } catch (error) {
    perf.endSpan(id, false, { error: (error as Error).message });
    throw error;
  }
}
