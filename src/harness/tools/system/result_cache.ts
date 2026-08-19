/**
 * Harness Tool: result_cache - 统一结果缓存
 *
 * 提供跨工具的结果缓存层，避免重复计算和网络请求。
 * 支持 TTL、标签分组、手动失效、缓存统计。
 * 与 ToolCallGuard 的基础缓存互补，提供更精细的控制。
 */

import crypto from 'crypto';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const RESULT_CACHE_DEF: ToolDefinition = {
  name: 'result_cache',
  description:
    '统一结果缓存管理。支持操作：get=获取缓存, set=写入缓存, invalidate=失效缓存, stats=缓存统计, clear=清空缓存。适用场景：避免重复网络请求、缓存工具执行结果、跨会话共享数据。',
  category: ToolCategory.SYSTEM,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型：get|set|invalidate|stats|clear',
      enum: ['get', 'set', 'invalidate', 'stats', 'clear'],
    },
    key: {
      type: 'string',
      description: '缓存键（get/set/invalidate 操作必填）',
    },
    value: {
      type: 'string',
      description: '缓存值（set 操作必填）',
    },
    ttl: {
      type: 'number',
      description: '缓存存活时间（秒），默认 300（5分钟）',
      default: 300,
    },
    tags: {
      type: 'array',
      items: { type: 'string', description: '标签名' },
      description: '缓存标签，用于分组失效',
    },
    namespace: {
      type: 'string',
      description: '缓存命名空间，默认 default',
      default: 'default',
    },
    pattern: {
      type: 'string',
      description: '失效模式（invalidate 操作时使用，支持通配符 *）',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

interface CacheEntry {
  key: string;
  value: string;
  namespace: string;
  tags: string[];
  createdAt: number;
  expiresAt: number;
  hitCount: number;
  lastAccessedAt: number;
  contentHash: string;
}

class ResultCacheStore {
  private entries: Map<string, CacheEntry> = new Map();
  private tagIndex: Map<string, Set<string>> = new Map();
  private stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    invalidations: 0,
    evictions: 0,
  };

  private buildCacheKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  get(namespace: string, key: string): CacheEntry | null {
    const cacheKey = this.buildCacheKey(namespace, key);
    const entry = this.entries.get(cacheKey);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(cacheKey);
      this.removeFromTagIndex(entry);
      this.stats.misses++;
      this.stats.evictions++;
      return null;
    }

    entry.hitCount++;
    entry.lastAccessedAt = Date.now();
    this.stats.hits++;
    return entry;
  }

  set(
    namespace: string,
    key: string,
    value: string,
    ttlSeconds: number,
    tags: string[] = []
  ): void {
    const cacheKey = this.buildCacheKey(namespace, key);
    const now = Date.now();

    const existing = this.entries.get(cacheKey);
    if (existing) {
      this.removeFromTagIndex(existing);
    }

    const entry: CacheEntry = {
      key,
      value,
      namespace,
      tags,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      hitCount: 0,
      lastAccessedAt: now,
      contentHash: crypto
        .createHash('md5')
        .update(value)
        .digest('hex')
        .slice(0, 8),
    };

    this.entries.set(cacheKey, entry);

    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(cacheKey);
    }

    this.stats.sets++;

    if (this.entries.size > 500) {
      this.evictExpired();
    }
  }

  invalidate(namespace: string, key: string): boolean {
    const cacheKey = this.buildCacheKey(namespace, key);
    const entry = this.entries.get(cacheKey);
    if (!entry) return false;

    this.removeFromTagIndex(entry);
    this.entries.delete(cacheKey);
    this.stats.invalidations++;
    return true;
  }

  invalidateByPattern(namespace: string, pattern: string): number {
    let count = 0;
    const regex = new RegExp(
      `^${namespace}:${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`
    );

    for (const [cacheKey, entry] of this.entries) {
      if (regex.test(cacheKey)) {
        this.removeFromTagIndex(entry);
        this.entries.delete(cacheKey);
        count++;
      }
    }

    this.stats.invalidations += count;
    return count;
  }

  invalidateByTag(tag: string): number {
    const keys = this.tagIndex.get(tag);
    if (!keys) return 0;

    let count = 0;
    for (const cacheKey of keys) {
      const entry = this.entries.get(cacheKey);
      if (entry) {
        this.entries.delete(cacheKey);
        count++;
      }
    }

    this.tagIndex.delete(tag);
    this.stats.invalidations += count;
    return count;
  }

  clear(): number {
    const count = this.entries.size;
    this.entries.clear();
    this.tagIndex.clear();
    this.stats.invalidations += count;
    return count;
  }

  getStats(): {
    size: number;
    hits: number;
    misses: number;
    sets: number;
    invalidations: number;
    evictions: number;
    hitRate: string;
    namespaces: Record<string, number>;
    topTags: Array<{ tag: string; count: number }>;
  } {
    const namespaces: Record<string, number> = {};
    for (const [, entry] of this.entries) {
      namespaces[entry.namespace] = (namespaces[entry.namespace] || 0) + 1;
    }

    const tagCounts: Record<string, number> = {};
    for (const [tag, keys] of this.tagIndex) {
      tagCounts[tag] = keys.size;
    }

    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    const total = this.stats.hits + this.stats.misses;
    const hitRate =
      total > 0 ? `${((this.stats.hits / total) * 100).toFixed(1)}%` : 'N/A';

    return {
      size: this.entries.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      invalidations: this.stats.invalidations,
      evictions: this.stats.evictions,
      hitRate,
      namespaces,
      topTags,
    };
  }

  private removeFromTagIndex(entry: CacheEntry): void {
    for (const tag of entry.tags) {
      const keys = this.tagIndex.get(tag);
      if (keys) {
        const cacheKey = this.buildCacheKey(entry.namespace, entry.key);
        keys.delete(cacheKey);
        if (keys.size === 0) {
          this.tagIndex.delete(tag);
        }
      }
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [cacheKey, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.removeFromTagIndex(entry);
        this.entries.delete(cacheKey);
        this.stats.evictions++;
      }
    }
  }
}

const globalCacheStore = new ResultCacheStore();

export function createResultCacheExecutor() {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const action = String(params.action || '');
    const key = params.key ? String(params.key) : undefined;
    const value = params.value ? String(params.value) : undefined;
    const ttl = Number(params.ttl) || 300;
    const tags = (params.tags as string[]) || [];
    const namespace = String(params.namespace || 'default');
    const pattern = params.pattern ? String(params.pattern) : undefined;

    switch (action) {
      case 'get': {
        if (!key) {
          return {
            success: false,
            output: '',
            error: 'get 操作需要提供 key 参数',
            duration: Date.now() - startTime,
            validated: false,
          };
        }

        const entry = globalCacheStore.get(namespace, key);
        if (!entry) {
          return {
            success: true,
            output: `缓存未命中: ${namespace}:${key}`,
            duration: Date.now() - startTime,
            validated: false,
            metadata: { hit: false },
          };
        }

        const age = ((Date.now() - entry.createdAt) / 1000).toFixed(0);
        return {
          success: true,
          output: entry.value,
          duration: Date.now() - startTime,
          validated: false,
          metadata: {
            hit: true,
            age: `${age}s`,
            hitCount: entry.hitCount,
            contentHash: entry.contentHash,
            expiresAt: new Date(entry.expiresAt).toISOString(),
          },
        };
      }

      case 'set': {
        if (!key || value === undefined) {
          return {
            success: false,
            output: '',
            error: 'set 操作需要提供 key 和 value 参数',
            duration: Date.now() - startTime,
            validated: false,
          };
        }

        globalCacheStore.set(namespace, key, value, ttl, tags);
        Logger.info(
          `💾 result_cache set: ${namespace}:${key} (TTL=${ttl}s)`,
          'ResultCache'
        );

        return {
          success: true,
          output: `✅ 缓存已写入: ${namespace}:${key} (TTL=${ttl}s${tags.length > 0 ? `, tags=[${tags.join(',')}]` : ''})`,
          duration: Date.now() - startTime,
          validated: false,
          metadata: { key, namespace, ttl, tags },
        };
      }

      case 'invalidate': {
        if (pattern) {
          const count = globalCacheStore.invalidateByPattern(
            namespace,
            pattern
          );
          return {
            success: true,
            output: `🗑️ 按模式失效: ${namespace}:${pattern} — 清除 ${count} 条缓存`,
            duration: Date.now() - startTime,
            validated: false,
            metadata: { invalidated: count },
          };
        }

        if (tags.length > 0) {
          let total = 0;
          for (const tag of tags) {
            total += globalCacheStore.invalidateByTag(tag);
          }
          return {
            success: true,
            output: `🗑️ 按标签失效: [${tags.join(',')}] — 清除 ${total} 条缓存`,
            duration: Date.now() - startTime,
            validated: false,
            metadata: { invalidated: total },
          };
        }

        if (key) {
          const removed = globalCacheStore.invalidate(namespace, key);
          return {
            success: true,
            output: removed
              ? `🗑️ 缓存已失效: ${namespace}:${key}`
              : `缓存不存在: ${namespace}:${key}`,
            duration: Date.now() - startTime,
            validated: false,
            metadata: { invalidated: removed ? 1 : 0 },
          };
        }

        return {
          success: false,
          output: '',
          error: 'invalidate 操作需要提供 key、pattern 或 tags 参数',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      case 'stats': {
        const stats = globalCacheStore.getStats();
        const lines = [
          '📊 缓存统计',
          '',
          `总条目: ${stats.size}`,
          `命中率: ${stats.hitRate}`,
          `  命中: ${stats.hits} | 未命中: ${stats.misses}`,
          `  写入: ${stats.sets} | 失效: ${stats.invalidations} | 淘汰: ${stats.evictions}`,
        ];

        const nsEntries = Object.entries(stats.namespaces);
        if (nsEntries.length > 0) {
          lines.push('', '命名空间:');
          for (const [ns, count] of nsEntries) {
            lines.push(`  ${ns}: ${count} 条`);
          }
        }

        if (stats.topTags.length > 0) {
          lines.push('', '热门标签:');
          for (const { tag, count } of stats.topTags) {
            lines.push(`  #${tag}: ${count} 条`);
          }
        }

        return {
          success: true,
          output: lines.join('\n'),
          duration: Date.now() - startTime,
          validated: false,
          metadata: stats,
        };
      }

      case 'clear': {
        const count = globalCacheStore.clear();
        Logger.info(`🧹 result_cache clear: 清除 ${count} 条`, 'ResultCache');
        return {
          success: true,
          output: `🧹 缓存已清空: 清除 ${count} 条缓存`,
          duration: Date.now() - startTime,
          validated: false,
          metadata: { cleared: count },
        };
      }

      default:
        return {
          success: false,
          output: '',
          error: `不支持的操作: ${action}。支持: get, set, invalidate, stats, clear`,
          duration: Date.now() - startTime,
          validated: false,
        };
    }
  };
}

export { globalCacheStore as ResultCacheStore };
