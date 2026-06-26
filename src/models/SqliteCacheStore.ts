/**
 * SQLite 持久化缓存存储
 *
 * 跨会话持久化的 LLM 响应缓存，基于 SQLite。
 * 支持 TTL 过期、自动清理、命中率统计。
 * 通过 DatabaseShim 适配 better-sqlite3 / 内存降级。
 *
 * @deprecated 已迁移到 Python agent/llm/prompt_cache.py (PromptCacheStore)。当 AGENT_BACKEND=python（默认）时不再使用此文件。
 *   回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现。
 *   迁移日期：2026-06-22
 */

import path from 'path';
import type { DatabaseAdapter } from '../shared/DatabaseShim';
import { createDatabase } from '../shared/DatabaseShim';
import { Logger } from '../utils/Logger';
import type { CacheStats, ICache } from './ICache';

/** 缓存条目 */
export interface CacheEntry {
  key: string;
  value: string;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
  lastAccess: number;
  /** 缓存类型：response | prefix */
  kind: string;
  /** 元数据（可选，用于语义缓存等扩展） */
  metadata?: Record<string, unknown>;
}

/** 缓存统计 */
export interface SqliteCacheStats {
  totalEntries: number;
  activeEntries: number;
  expiredEntries: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  sizeBytes: number;
  cacheKind: string;
  /** ICache 兼容字段 */
  hits: number;
  misses: number;
  size: number;
}

/** 清理策略 */
export interface EvictionConfig {
  /** 最大条目数（超出时淘汰最久未访问的） */
  maxEntries: number;
  /** 最大存储字节数（超出时淘汰最久未访问的） */
  maxSizeBytes: number;
  /** 清理间隔毫秒 */
  cleanupIntervalMs: number;
}

const DEFAULT_EVICTION: EvictionConfig = {
  maxEntries: 5000,
  maxSizeBytes: 50 * 1024 * 1024, // 50MB
  cleanupIntervalMs: 5 * 60 * 1000, // 5 分钟
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_access INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'response'
);

CREATE INDEX IF NOT EXISTS idx_llm_cache_expires ON llm_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_llm_cache_kind ON llm_cache(kind);
CREATE INDEX IF NOT EXISTS idx_llm_cache_last_access ON llm_cache(last_access);
`;

export class SqliteCacheStore implements ICache<string> {
  private db: DatabaseAdapter;
  private evictionConfig: EvictionConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private dbPath: string;
  private hits = 0;
  private misses = 0;
  private _closed = false;

  constructor(
    dbPath?: string,
    eviction?: Partial<EvictionConfig>,
    /** 测试用：直接注入 DatabaseAdapter */
    testDb?: DatabaseAdapter
  ) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'llm_cache.db');
    this.evictionConfig = { ...DEFAULT_EVICTION, ...eviction };

    this.db = testDb || createDatabase(this.dbPath);
    this.db.exec(SCHEMA);
    this.runCleanup(); // 启动时清理过期条目
    this.startAutoCleanup();
    Logger.info(`🗄️ SQLite 缓存存储已就绪: ${this.dbPath}`, 'SqliteCacheStore');
  }

  /** 获取缓存条目（返回CacheEntry对象） */
  getEntry(key: string): CacheEntry | undefined {
    if (this._closed) return undefined;

    const row = this.db
      .prepare(
        'SELECT key, value, created_at, expires_at, hit_count, last_access, kind FROM llm_cache WHERE key = ?'
      )
      .get(key) as Record<string, unknown> | undefined;

    if (!row) {
      this.misses++;
      return undefined;
    }

    const entry: CacheEntry = {
      key: row.key as string,
      value: row.value as string,
      createdAt: row.created_at as number,
      expiresAt: row.expires_at as number,
      hitCount: row.hit_count as number,
      lastAccess: row.last_access as number,
      kind: row.kind as string,
    };

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      this.misses++;
      return undefined;
    }

    // 更新访问计数
    this.db
      .prepare(
        'UPDATE llm_cache SET hit_count = hit_count + 1, last_access = ? WHERE key = ?'
      )
      .run(Date.now(), key);

    this.hits++;
    return entry;
  }

  /** ICache<string> 接口实现：获取缓存值 */
  get(key: string): string | undefined {
    const entry = this.getEntry(key);
    return entry?.value;
  }

  /** ICache<string> 接口实现 + 存储缓存条目 */
  set(
    key: string,
    value: string,
    ttlMs?: number,
    kind: string = 'response'
  ): void {
    if (this._closed) return;

    const now = Date.now();
    const effectiveTtl = ttlMs ?? 3600000; // 默认 1 小时
    this.db
      .prepare(
        `INSERT OR REPLACE INTO llm_cache (key, value, created_at, expires_at, hit_count, last_access, kind)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(key, value, now, now + effectiveTtl, now, kind);
  }

  /** 删除缓存条目 */
  delete(key: string): boolean {
    if (this._closed) return false;
    const result = this.db
      .prepare('DELETE FROM llm_cache WHERE key = ?')
      .run(key);
    return result.changes > 0;
  }

  /**
   * 按前缀查找缓存条目（用于语义缓存匹配）
   * @param keyPrefix key 前缀
   * @param limit 最大返回条目数
   */
  getByPrefix(keyPrefix: string, limit: number = 20): CacheEntry[] {
    if (this._closed) return [];

    const rows = this.db
      .prepare(
        'SELECT key, value, created_at, expires_at, hit_count, last_access, kind FROM llm_cache WHERE key LIKE ? AND expires_at > ? ORDER BY last_access DESC LIMIT ?'
      )
      .all(keyPrefix + '%', Date.now(), limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      key: row.key as string,
      value: row.value as string,
      createdAt: row.created_at as number,
      expiresAt: row.expires_at as number,
      hitCount: row.hit_count as number,
      lastAccess: row.last_access as number,
      kind: row.kind as string,
    }));
  }

  /** 按类型清除 */
  clearByKind(kind: string): number {
    if (this._closed) return 0;
    const result = this.db
      .prepare('DELETE FROM llm_cache WHERE kind = ?')
      .run(kind);
    Logger.info(
      `🧹 已清除 ${result.changes} 条 ${kind} 类型缓存`,
      'SqliteCacheStore'
    );
    return result.changes;
  }

  /** 清空全部缓存 */
  clear(): number {
    if (this._closed) return 0;
    const result = this.db.prepare('DELETE FROM llm_cache').run();
    Logger.info(`🧹 已清空所有缓存 (${result.changes} 条)`, 'SqliteCacheStore');
    return result.changes;
  }

  /** 清理过期条目 */
  private runCleanup(): number {
    if (this._closed) return 0;
    const result = this.db
      .prepare('DELETE FROM llm_cache WHERE expires_at < ?')
      .run(Date.now());
    if (result.changes > 0) {
      Logger.debug(
        `🧹 清理了 ${result.changes} 条过期缓存`,
        'SqliteCacheStore'
      );
    }
    return result.changes;
  }

  /** 按淘汰策略清理（LRU） */
  private runEviction(): number {
    if (this._closed) return 0;

    // 1. 先检查总条目数
    const countRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM llm_cache')
      .get() as { cnt: number };
    const totalCount = countRow?.cnt ?? 0;

    if (totalCount <= this.evictionConfig.maxEntries) return 0;

    // 2. 超出限制，删除最久未访问的条目
    const toDelete = totalCount - this.evictionConfig.maxEntries;
    const result = this.db
      .prepare(
        `DELETE FROM llm_cache WHERE key IN (
          SELECT key FROM llm_cache ORDER BY last_access ASC LIMIT ?
        )`
      )
      .run(toDelete);

    if (result.changes > 0) {
      Logger.debug(
        `🧹 淘汰了 ${result.changes} 条缓存 (LRU)`,
        'SqliteCacheStore'
      );
    }
    return result.changes;
  }

  /** 获取缓存统计 */
  getStats(): CacheStats {
    if (this._closed) {
      return {
        hits: this.hits,
        misses: this.misses,
        hitRate: this.calcHitRate(),
        size: 0,
      };
    }

    const totalRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM llm_cache')
      .get() as { cnt: number };

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: this.calcHitRate(),
      size: totalRow?.cnt ?? 0,
      extras: { dbStats: this.getDbStats() },
    };
  }

  /** 获取数据库级详细统计（SqliteCacheStats 格式） */
  getDbStats(): Record<string, unknown> {
    if (this._closed) return { cacheKind: 'closed' };

    const totalRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM llm_cache')
      .get() as { cnt: number };
    const activeRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM llm_cache WHERE expires_at > ?')
      .get(Date.now()) as { cnt: number };
    const expiredRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM llm_cache WHERE expires_at <= ?')
      .get(Date.now()) as { cnt: number };
    const sizeRow = this.db
      .prepare('SELECT SUM(LENGTH(value)) as total FROM llm_cache')
      .get() as { total: number | null };

    return {
      totalEntries: totalRow?.cnt ?? 0,
      activeEntries: activeRow?.cnt ?? 0,
      expiredEntries: expiredRow?.cnt ?? 0,
      totalHits: this.hits,
      totalMisses: this.misses,
      hitRate: this.calcHitRate(),
      sizeBytes: sizeRow?.total ?? 0,
      cacheKind: 'persistent',
    };
  }

  /** 获取所有缓存 key 列表（含元数据） */
  listEntries(
    kind?: string,
    limit: number = 100
  ): Array<{
    key: string;
    hitCount: number;
    createdAt: number;
    expiresAt: number;
    lastAccess: number;
    kind: string;
  }> {
    if (this._closed) return [];

    let sql =
      'SELECT key, hit_count, created_at, expires_at, last_access, kind FROM llm_cache';
    const params: unknown[] = [];

    if (kind) {
      sql += ' WHERE kind = ?';
      params.push(kind);
    }
    sql += ' ORDER BY last_access DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      key: r.key as string,
      hitCount: r.hit_count as number,
      createdAt: r.created_at as number,
      expiresAt: r.expires_at as number,
      lastAccess: r.last_access as number,
      kind: r.kind as string,
    }));
  }

  /** 计算命中率 */
  private calcHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  /** 启动自动清理定时器 */
  private startAutoCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup();
      this.runEviction();
    }, this.evictionConfig.cleanupIntervalMs);

    // 允许进程退出时不等待定时器
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object') {
      this.cleanupTimer.unref?.();
    }
  }

  /** 关闭存储 */
  close(): void {
    this._closed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.db.close();
    Logger.info('🗄️ SQLite 缓存存储已关闭', 'SqliteCacheStore');
  }
}
