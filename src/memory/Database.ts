import * as fs from 'fs';
import * as path from 'path';
import { createDatabase } from '../shared/DatabaseShim';
import { Logger } from '../utils/Logger';

/**
 * 记忆记录接口
 */
export interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  timestamp: number;
  source: string;
  importance: number;
  traceId?: string;
}

/**
 * 数据库配置接口
 */
interface DatabaseConfig {
  storagePath: string;
  journalMode?: string;
  synchronous?: string;
  cacheSize?: number;
}

/**
 * 记忆数据库管理类
 * 采用单例模式，负责SQLite连接初始化、表创建、数据CRUD操作
 */
export class MemoryDatabase {
  private static instance: MemoryDatabase | null = null;
  private db: import('../shared/DatabaseShim').DatabaseAdapter | null = null;
  private config: DatabaseConfig;

  private constructor(storagePath: string) {
    this.config = {
      storagePath,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
      cacheSize: -64000,
    };
    this.initialize();
  }

  /**
   * 获取单例实例
   * @param storagePath 存储路径，默认为 './data'
   */
  public static getInstance(storagePath?: string): MemoryDatabase {
    if (!MemoryDatabase.instance) {
      const resolvedPath = storagePath || path.join(process.cwd(), 'data');
      MemoryDatabase.instance = new MemoryDatabase(resolvedPath);
    }
    return MemoryDatabase.instance;
  }

  /**
   * 重置单例实例（用于测试或重新初始化）
   */
  public static resetInstance(): void {
    if (MemoryDatabase.instance) {
      MemoryDatabase.instance.close();
      MemoryDatabase.instance = null;
    }
  }

  /**
   * 初始化数据库连接和表结构
   */
  private initialize(): void {
    try {
      const storageDir = this.config.storagePath;
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }

      const dbFilePath = path.join(storageDir, 'jiabaixing_memory.db');
      this.db = createDatabase(dbFilePath);
      if (this.db) {
        try {
          this.db.pragma(`journal_mode = ${this.config.journalMode}`);
        } catch {}
        try {
          this.db.pragma(`synchronous = ${this.config.synchronous}`);
        } catch {}
        try {
          this.db.pragma(`cache_size = ${this.config.cacheSize}`);
        } catch {}

        this.createTables();
        Logger.info('MemoryDatabase: 初始化完成', 'MemoryDatabase');
      } else {
        Logger.warn('MemoryDatabase: 降级为内存模式', 'MemoryDatabase');
      }
    } catch (error) {
      Logger.error(
        'MemoryDatabase: 初始化失败',
        error as Error,
        'MemoryDatabase'
      );
      this.db = null;
    }
  }

  /**
   * 创建记忆表
   */
  private createTables(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'general',
        timestamp INTEGER NOT NULL,
        source TEXT DEFAULT 'core',
        importance REAL DEFAULT 0.5,
        trace_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_type_time ON memories(type, timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_trace_id ON memories(trace_id);

      -- FTS5全文搜索虚拟表（P1增强）
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content=memories,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      -- FTS5触发器，自动同步数据
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    this.addTraceIdColumn();
    this.backfillFTS();
  }

  /**
   * 回填FTS索引（用于已存在数据）
   */
  private backfillFTS(): void {
    if (!this.db) return;
    try {
      const count = this.db
        .prepare('SELECT COUNT(*) as cnt FROM memories_fts')
        .get() as { cnt: number };
      if (count.cnt === 0) {
        this.db.exec(
          'INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories'
        );
        Logger.info('MemoryDatabase: FTS5索引已回填', 'MemoryDatabase');
      }
    } catch {
      // 忽略错误，可能已经有数据
    }
  }

  /**
   * 确保 trace_id 列存在（兼容旧数据库）
   */
  private addTraceIdColumn(): void {
    if (!this.db) return;
    try {
      const tableInfo = this.db.prepare('PRAGMA table_info(memories)').all();
      const hasTraceId = (tableInfo as { name: string }[]).some(
        (col) => col.name === 'trace_id'
      );
      if (!hasTraceId) {
        this.db.exec('ALTER TABLE memories ADD COLUMN trace_id TEXT');
      }
    } catch {
      Logger.info('数据库表结构检查完成', 'MemoryDatabase');
    }
  }

  /**
   * 添加记忆记录
   * @param content 记忆内容
   * @param type 记忆类型
   * @param source 来源标识
   * @param importance 重要性（0-1）
   * @returns 插入记录的ID
   */
  public add(
    content: string,
    type: string = 'general',
    source: string = 'core',
    importance: number = 0.5
  ): number {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    const traceId = Logger.getTraceId() || null;
    const stmt = this.db.prepare(`
      INSERT INTO memories (content, type, timestamp, source, importance, trace_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      content,
      type,
      Date.now(),
      source,
      importance,
      traceId
    );
    return result.lastInsertRowid as number;
  }

  /**
   * 按traceId查询记忆记录
   * @param traceId 追踪ID
   * @param limit 限制返回数量
   */
  public queryByTraceId(traceId: string, limit: number = 50): MemoryRecord[] {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    const stmt = this.db.prepare(
      'SELECT * FROM memories WHERE trace_id = ? ORDER BY timestamp DESC LIMIT ?'
    );
    return stmt.all(traceId, limit) as MemoryRecord[];
  }

  /**
   * 查询记忆记录
   * @param type 记忆类型过滤
   * @param limit 限制返回数量
   * @param startTime 起始时间戳（可选）
   * @param endTime 结束时间戳（可选）
   */
  public query(
    type?: string,
    limit: number = 50,
    startTime?: number,
    endTime?: number
  ): MemoryRecord[] {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    let sql = 'SELECT * FROM memories';
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (startTime !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(startTime);
    }
    if (endTime !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(endTime);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as MemoryRecord[];
  }

  /**
   * 按ID获取记忆记录
   * @param id 记录ID
   */
  public getById(id: number): MemoryRecord | undefined {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    return stmt.get(id) as MemoryRecord | undefined;
  }

  /**
   * FTS5全文搜索（P1增强）
   * @param query 搜索查询
   * @param limit 返回数量限制
   * @returns 搜索结果，包含BM25评分
   */
  public searchByFTS5(
    query: string,
    limit: number = 20
  ): Array<MemoryRecord & { rank: number }> {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    // FTS5搜索语法：支持OR、AND、前缀匹配等
    const stmt = this.db.prepare(`
      SELECT m.*, rank
      FROM memories_fts fts
      JOIN memories m ON fts.rowid = m.id
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    return stmt.all(query, limit) as Array<MemoryRecord & { rank: number }>;
  }

  /**
   * FTS5高级搜索：支持语法和过滤
   * @param query 搜索查询
   * @param type 类型过滤
   * @param limit 返回数量限制
   * @returns 搜索结果
   */
  public advancedSearch(
    query: string,
    type?: string,
    limit: number = 20
  ): Array<MemoryRecord & { rank: number }> {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    let sql = `
      SELECT m.*, rank
      FROM memories_fts fts
      JOIN memories m ON fts.rowid = m.id
      WHERE memories_fts MATCH ?
    `;

    const params: (string | number)[] = [query];

    if (type) {
      sql += ' AND m.type = ?';
      params.push(type);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Array<MemoryRecord & { rank: number }>;
  }

  /**
   * 按类型统计记忆数量
   * @param type 记忆类型
   */
  public countByType(type?: string): number {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    let sql = 'SELECT COUNT(*) as count FROM memories';
    const params: string[] = [];

    if (type) {
      sql += ' WHERE type = ?';
      params.push(type);
    }

    const stmt = this.db.prepare(sql);
    const result = type ? stmt.get(...params) : stmt.get();
    return (result as { count: number }).count;
  }

  /**
   * 删除记忆记录
   * @param id 记录ID
   */
  public delete(id: number): boolean {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * 清理过期记忆
   * @param maxAgeMs 最大保留时间（毫秒），默认30天
   */
  public cleanupExpired(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    const cutoff = Date.now() - maxAgeMs;
    const stmt = this.db.prepare('DELETE FROM memories WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * 获取数据库实例（底层访问，用于高级操作）
   */
  public getRawDatabase():
    | import('../shared/DatabaseShim').DatabaseAdapter
    | null {
    return this.db;
  }

  /**
   * 关闭数据库连接
   */
  public close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        Logger.error(
          'MemoryDatabase: 关闭数据库失败',
          error as Error,
          'MemoryDatabase'
        );
      }
      this.db = null;
    }
  }
}
