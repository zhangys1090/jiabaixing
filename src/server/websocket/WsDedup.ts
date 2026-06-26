/**
 * WebSocket 去重缓存模块
 * 从 websocket.ts 提取，专门处理 traceId 去重
 * 内部复用 RedisCache 统一缓存层，自动 TTL 过期 + LRU 淘汰
 */

import { RedisCache } from '../../models/RedisCache';
import { SYSTEM_CONSTANTS } from '../../shared/contracts';

/** 去重缓存默认 TTL：5 分钟 */
const DEDUP_TTL_MS = 5 * 60 * 1000;

/**
 * 基于 RedisCache 的去重缓存（自动 TTL 过期 + LRU 淘汰）
 */
export class WsDedupCache {
  private cache: RedisCache<number>;

  constructor(maxSize?: number, ttlMs?: number) {
    this.cache = new RedisCache<number>({
      ttl: ttlMs ?? DEDUP_TTL_MS,
      maxSize: maxSize ?? SYSTEM_CONSTANTS.MAX_DEDUP_CACHE_SIZE,
      namespace: 'ws_dedup',
      adaptiveTTL: { enabled: false },
    });
  }

  /**
   * 检查是否已存在（未过期才算存在）
   */
  has(traceId: string): boolean {
    return this.cache.has(traceId);
  }

  /**
   * 添加 traceId
   */
  add(traceId: string): void {
    this.cache.set(traceId, Date.now());
  }

  /**
   * 删除 traceId
   */
  delete(traceId: string): void {
    this.cache.delete(traceId);
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.getStats().size;
  }

  /**
   * 清理过期条目（RedisCache 内部自动清理，此方法保留兼容）
   */
  cleanup(): number {
    // RedisCache 内部每分钟自动清理过期条目
    // 此处返回当前大小作为兼容返回值
    return this.cache.getStats().size;
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
