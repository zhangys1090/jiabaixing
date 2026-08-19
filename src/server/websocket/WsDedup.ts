/**
 * WebSocket 去重缓存模块
 * 从 websocket.ts 提取，专门处理 traceId 去重
 * V6.0: 替换 RedisCache 为纯内存 TTL 缓存（RedisCache 已废弃迁移至 Python 端）
 */

import { SYSTEM_CONSTANTS } from '../../shared/contracts';

const DEDUP_TTL_MS = 5 * 60 * 1000;

interface DedupEntry {
  timestamp: number;
  expiresAt: number;
}

export class WsDedupCache {
  private cache = new Map<string, DedupEntry>();
  private _maxSize: number;
  private _ttlMs: number;

  constructor(maxSize?: number, ttlMs?: number) {
    this._maxSize = maxSize ?? SYSTEM_CONSTANTS.MAX_DEDUP_CACHE_SIZE;
    this._ttlMs = ttlMs ?? DEDUP_TTL_MS;
  }

  has(traceId: string): boolean {
    const entry = this.cache.get(traceId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(traceId);
      return false;
    }
    return true;
  }

  add(traceId: string): void {
    if (this.cache.size >= this._maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(traceId, {
      timestamp: Date.now(),
      expiresAt: Date.now() + this._ttlMs,
    });
  }

  delete(traceId: string): void {
    this.cache.delete(traceId);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  cleanup(): number {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
    return this.cache.size;
  }
}

/**
 * 全局去重缓存实例
 */
export const processedResponses = new WsDedupCache();

/**
 * 检查并标记响应（去重）
 * RedisCache 内部自动 TTL 过期，无需手动 setTimeout 清理
 * @returns true 如果已处理过（应跳过）
 */
export function checkAndMarkResponse(traceId: string): boolean {
  if (processedResponses.has(traceId)) {
    return true;
  }
  processedResponses.add(traceId);
  return false;
}
