import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
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
  private db: Database.Database | null = null;
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
      this.db = new Database(dbFilePath);

      this.db.pragma(`journal_mode = ${this.config.journalMode}`);
      this.db.pragma(`synchronous = ${this.config.synchronous}`);
      this.db.pragma(`cache_size = ${this.config.cacheSize}`);

      this.createTables();
      Logger.info('MemoryDatabase: 初始化完成', 'MemoryDatabase');
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
    `);

    this.addTraceIdColumn();
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
  public getRawDatabase(): Database.Database | null {
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
