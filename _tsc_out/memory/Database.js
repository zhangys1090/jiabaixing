"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryDatabase = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
/**
 * 记忆数据库管理类
 * 采用单例模式，负责SQLite连接初始化、表创建、数据CRUD操作
 */
class MemoryDatabase {
    static instance = null;
    db = null;
    config;
    constructor(storagePath) {
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
    static getInstance(storagePath) {
        if (!MemoryDatabase.instance) {
            const resolvedPath = storagePath || path.join(process.cwd(), 'data');
            MemoryDatabase.instance = new MemoryDatabase(resolvedPath);
        }
        return MemoryDatabase.instance;
    }
    /**
     * 重置单例实例（用于测试或重新初始化）
     */
    static resetInstance() {
        if (MemoryDatabase.instance) {
            MemoryDatabase.instance.close();
            MemoryDatabase.instance = null;
        }
    }
    /**
     * 初始化数据库连接和表结构
     */
    initialize() {
        try {
            const storageDir = this.config.storagePath;
            if (!fs.existsSync(storageDir)) {
                fs.mkdirSync(storageDir, { recursive: true });
            }
            const dbFilePath = path.join(storageDir, 'jiabaixing_memory.db');
            this.db = (0, DatabaseShim_1.createDatabase)(dbFilePath);
            if (this.db) {
                try {
                    this.db.pragma(`journal_mode = ${this.config.journalMode}`);
                }
                catch { }
                try {
                    this.db.pragma(`synchronous = ${this.config.synchronous}`);
                }
                catch { }
                try {
                    this.db.pragma(`cache_size = ${this.config.cacheSize}`);
                }
                catch { }
                this.createTables();
                Logger_1.Logger.info('MemoryDatabase: 初始化完成', 'MemoryDatabase');
            }
            else {
                Logger_1.Logger.warn('MemoryDatabase: 降级为内存模式', 'MemoryDatabase');
            }
        }
        catch (error) {
            Logger_1.Logger.error('MemoryDatabase: 初始化失败', error, 'MemoryDatabase');
            this.db = null;
        }
    }
    /**
     * 创建记忆表
     */
    createTables() {
        if (!this.db)
            return;
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
    backfillFTS() {
        if (!this.db)
            return;
        try {
            const count = this.db
                .prepare('SELECT COUNT(*) as cnt FROM memories_fts')
                .get();
            if (count.cnt === 0) {
                this.db.exec('INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories');
                Logger_1.Logger.info('MemoryDatabase: FTS5索引已回填', 'MemoryDatabase');
            }
        }
        catch {
            // 忽略错误，可能已经有数据
        }
    }
    /**
     * 确保 trace_id 列存在（兼容旧数据库）
     */
    addTraceIdColumn() {
        if (!this.db)
            return;
        try {
            const tableInfo = this.db.prepare('PRAGMA table_info(memories)').all();
            const hasTraceId = tableInfo.some((col) => col.name === 'trace_id');
            if (!hasTraceId) {
                this.db.exec('ALTER TABLE memories ADD COLUMN trace_id TEXT');
            }
        }
        catch {
            Logger_1.Logger.info('数据库表结构检查完成', 'MemoryDatabase');
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
    add(content, type = 'general', source = 'core', importance = 0.5) {
        if (!this.db) {
            throw new Error('数据库未初始化');
        }
        const traceId = Logger_1.Logger.getTraceId() || null;
        const stmt = this.db.prepare(`
      INSERT INTO memories (content, type, timestamp, source, importance, trace_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
        const result = stmt.run(content, type, Date.now(), source, importance, traceId);
        return result.lastInsertRowid;
    }
    /**
     * 按traceId查询记忆记录
     * @param traceId 追踪ID
     * @param limit 限制返回数量
     */
    queryByTraceId(traceId, limit = 50) {
        if (!this.db) {
            throw new Error('数据库未初始化');
        }
        const stmt = this.db.prepare('SELECT * FROM memories WHERE trace_id = ? ORDER BY timestamp DESC LIMIT ?');
        return stmt.all(traceId, limit);
    }
    /**
     * 查询记忆记录
     * @param type 记忆类型过滤
     * @param limit 限制返回数量
     * @param startTime 起始时间戳（可选）
     * @param endTime 结束时间戳（可选）
     */
    query(type, limit = 50, startTime, endTime) {
        if (!this.db) {
            throw new Error('数据库未初始化');
        }
        let sql = 'SELECT * FROM memories';
        const params = [];
        const conditions = [];
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
        return stmt.all(...params);
    }
    /**
     * 按ID获取记忆记录
     * @param id 记录ID
     */
    getById(id) {
        if (!this.db) {
            throw new Error('数据库未初始化');
        }
        const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
        return stmt.get(id);
    }
    /**
     * FTS5全文搜索（P1增强）
     * @param query 搜索查询
     * @param limit 返回数量限制
     * @returns 搜索结果，包含BM25评分
     */
    searchByFTS5(query, limit = 20) {
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
        return stmt.all(query, limit);
    }
    /**
     * FTS5高级搜索：支持语法和过滤
     * @param query 搜索查询
     * @param type 类型过滤
     * @param limit 返回数量限制
     * @returns 搜索结果
     */
    advancedSearch(query, type, limit = 20) {
        if (!this.db) {
            throw new Error('数据库未初始化');
        }
        let sql = `
      SELECT m.*, rank
      FROM memories_fts fts
      JOIN memories m ON fts.rowid = m.id
      WHERE memories_fts MATCH ?
    `;
        const params = [query];
        if (type) {
            sql += ' AND m.type = ?';
            params.push(type);
        }
        sql += ' ORDER BY rank LIMIT ?';
        params.push(limit);
        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }
    /**
     * 按类型统计记忆数量
     * @param type 记忆类型
     */
    countByType(type) {
        if (!this.db) {
            throw new Error('数据库未初始化');
        }
        let sql = 'SELECT COUNT(*) as count FROM memories';
        const params = [];
        if (type) {
            sql += ' WHERE type = ?';
            params.push(type);
        }
        const stmt = this.db.prepare(sql);
        const result = type ? stmt.get(...params) : stmt.get();
        return result.count;
    }
    /**
     * 删除记忆记录
     * @param id 记录ID
     */
    delete(id) {
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
    cleanupExpired(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
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
    getRawDatabase() {
        return this.db;
    }
    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            try {
                this.db.close();
            }
            catch (error) {
                Logger_1.Logger.error('MemoryDatabase: 关闭数据库失败', error, 'MemoryDatabase');
            }
            this.db = null;
        }
    }
}
exports.MemoryDatabase = MemoryDatabase;
