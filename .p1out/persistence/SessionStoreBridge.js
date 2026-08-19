"use strict";
/**
 * SessionStore — 统一会话存储（参考 Hermes hermes_state.py）
 *
 * 使用 SQLite 持久化会话元数据、消息历史。
 * 支持 WAL 模式、Schema 迁移、写入竞争重试。
 *
 * 数据文件: data/sessions.db
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStoreBridge = void 0;
const path_1 = __importDefault(require("path"));
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
// ─── Schema ────────────────────────────────────────────────
const SCHEMA_VERSION = 3;
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'unknown',
    user_id TEXT,
    model TEXT,
    title TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION});
`;
// 列声明（用于声明式迁移）
const SESSION_COLUMNS = [
    'id',
    'source',
    'user_id',
    'model',
    'title',
    'parent_session_id',
    'started_at',
    'ended_at',
    'end_reason',
    'message_count',
    'tool_call_count',
    'input_tokens',
    'output_tokens',
    'estimated_cost_usd',
    'created_at',
];
const MESSAGE_COLUMNS = [
    'id',
    'session_id',
    'role',
    'content',
    'tool_call_id',
    'tool_calls',
    'tool_name',
    'timestamp',
    'token_count',
    'finish_reason',
];
// ─── 写入竞争配置 ─────────────────────────────────────
const WRITE_MAX_RETRIES = 15;
const CHECKPOINT_EVERY_N_WRITES = 50;
/**
 * @deprecated 已迁移 Python (`python/agent/persistence/session_store.py`)。
 * 仅作本地回退存根；生产路径经 `PythonAgentBridge.getSessions()` 等桥接。
 * `AgentHarness` 仍 `new SessionStore()`，经 `SessionStore.ts` 重导出壳解析为本类。
 */
class SessionStoreBridge {
    constructor(dbPath) {
        this.writeCount = 0;
        this.dbPath = dbPath || path_1.default.join(process.cwd(), 'data', 'sessions.db');
        const dir = path_1.default.dirname(this.dbPath);
        const fs = require('fs');
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        this.db = (0, DatabaseShim_1.createDatabase)(this.dbPath);
        this.initialize();
    }
    // ─── 初始化 ─────────────────────────────────────────
    initialize() {
        // NFS 感知的 journal_mode — NFS 环境降级为 DELETE 模式
        const journalMode = this.dbPath.startsWith('nfs:') ? 'delete' : 'wal';
        this.db.pragma('journal_mode = ' + journalMode);
        if (journalMode === 'delete') {
            Logger_1.Logger.warn(`⚠️ 检测到 NFS 环境，journal_mode 降级为 DELETE（不支持并发读）`, 'SessionStore');
        }
        // 创建表
        this.db.exec(SCHEMA_SQL);
        // 声明式列迁移
        this.reconcileColumns('sessions', SESSION_COLUMNS);
        this.reconcileColumns('messages', MESSAGE_COLUMNS);
        // 尝试创建 FTS5 虚拟表（原生 SQLite 需要 FTS5 支持）
        this.tryCreateFTS();
        Logger_1.Logger.info(`🗄️ 会话存储已就绪: ${this.dbPath}`, 'SessionStore');
    }
    /** 声明式列添加 — 对比现有列，添加缺失列 */
    reconcileColumns(table, expectedCols) {
        try {
            const existing = this.db.pragma(`table_info(${table})`);
            if (!existing)
                return;
            const existingNames = new Set(existing.map((c) => c.name));
            for (const col of expectedCols) {
                if (!existingNames.has(col)) {
                    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
                    Logger_1.Logger.debug(`📦 添加列 ${table}.${col}`, 'SessionStore');
                }
            }
        }
        catch (err) {
            Logger_1.Logger.debug(`pragma设置失败（MemoryDatabase可能不支持）: ${err?.message}`, 'SessionStore');
        }
    }
    /** 尝试创建 FTS5 虚拟表（优雅降级） */
    tryCreateFTS() {
        try {
            this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content=messages,
          content_rowid=id
        )
      `);
        }
        catch (err) {
            Logger_1.Logger.debug(`📦 FTS5 不可用（内存模式或无 FTS5 支持）: ${err?.message}，全文搜索已降级`, 'SessionStore');
        }
    }
    // ─── 写入重试 ───────────────────────────────────────
    /** 带重试和随机抖动的安全写入 */
    retryWrite(fn) {
        for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
            try {
                const result = fn();
                this.writeCount++;
                if (this.writeCount % CHECKPOINT_EVERY_N_WRITES === 0) {
                    this.db.pragma('wal_checkpoint(PASSIVE)');
                }
                return result;
            }
            catch (err) {
                const errMsg = err?.message;
                if (errMsg?.includes('SQLITE_BUSY') &&
                    attempt < WRITE_MAX_RETRIES - 1) {
                    continue;
                }
                throw err;
            }
        }
        throw new Error('写入失败：超过最大重试次数');
    }
    // ─── 会话 CRUD ─────────────────────────────────────
    createSession(session) {
        this.retryWrite(() => {
            this.db
                .prepare(`
        INSERT INTO sessions (id, source, user_id, model, title, parent_session_id, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
                .run(session.id, session.source, session.userId || null, session.model || null, session.title || null, session.parentSessionId || null, Date.now() / 1000);
        });
    }
    endSession(sessionId, endReason) {
        this.retryWrite(() => {
            this.db
                .prepare(`
        UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?
      `)
                .run(Date.now() / 1000, endReason || null, sessionId);
        });
    }
    getSession(sessionId) {
        const row = this.db
            .prepare('SELECT * FROM sessions WHERE id = ?')
            .get(sessionId);
        if (!row)
            return undefined;
        return this.rowToSession(row);
    }
    getSessions(limit = 20, source) {
        let sql = 'SELECT * FROM sessions';
        const params = [];
        if (source) {
            sql += ' WHERE source = ?';
            params.push(source);
        }
        sql += ' ORDER BY started_at DESC LIMIT ?';
        params.push(limit);
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((r) => this.rowToSession(r));
    }
    setSessionTitle(sessionId, title) {
        this.retryWrite(() => {
            this.db
                .prepare('UPDATE sessions SET title = ? WHERE id = ?')
                .run(title, sessionId);
        });
    }
    updateSessionTokens(sessionId, inputTokens, outputTokens, cost) {
        this.retryWrite(() => {
            this.db
                .prepare(`
        UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
          estimated_cost_usd = COALESCE(estimated_cost_usd, 0) + ?
        WHERE id = ?
      `)
                .run(inputTokens, outputTokens, cost || 0, sessionId);
        });
    }
    // ─── 消息 CRUD ─────────────────────────────────────
    appendMessage(msg) {
        return this.retryWrite(() => {
            const result = this.db
                .prepare(`
        INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
                .run(msg.sessionId, msg.role, msg.content || null, msg.toolCallId || null, msg.toolCalls || null, msg.toolName || null, Date.now() / 1000, msg.tokenCount || null, msg.finishReason || null);
            // 更新会话消息计数
            this.db
                .prepare('UPDATE sessions SET message_count = message_count + 1 WHERE id = ?')
                .run(msg.sessionId);
            // 更新工具调用计数
            if (msg.role === 'tool') {
                this.db
                    .prepare('UPDATE sessions SET tool_call_count = tool_call_count + 1 WHERE id = ?')
                    .run(msg.sessionId);
            }
            return result.lastInsertRowid;
        });
    }
    getMessages(sessionId) {
        const rows = this.db
            .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, id')
            .all(sessionId);
        return rows.map((r) => this.rowToMessage(r));
    }
    getConversation(sessionId) {
        const rows = this.db
            .prepare('SELECT role, content FROM messages WHERE session_id = ? AND role IN (?, ?, ?) ORDER BY timestamp, id')
            .all(sessionId, 'system', 'user', 'assistant');
        return rows.map((r) => ({
            role: r.role,
            content: r.content || undefined,
        }));
    }
    // ─── 搜索 ─────────────────────────────────────────
    searchMessages(query, limit = 10) {
        // 尝试 FTS5 搜索
        try {
            const rows = this.db
                .prepare(`
        SELECT m.id, m.session_id, m.role, m.timestamp,
               snippet(messages_fts, 0, '>>>', '<<<', '...', 40) as snippet,
               s.source, s.model
        FROM messages_fts fts
        JOIN messages m ON fts.rowid = m.id
        LEFT JOIN sessions s ON m.session_id = s.id
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
                .all(this.sanitizeQuery(query), limit);
            return rows.map((r) => ({
                id: r.id,
                sessionId: r.session_id,
                role: r.role,
                timestamp: r.timestamp,
                snippet: r.snippet || '',
                source: r.source,
                model: r.model,
            }));
        }
        catch (err) {
            Logger_1.Logger.debug(`FTS5搜索失败，回退到LIKE搜索: ${err?.message}`, 'SessionStore');
            return this.fallbackSearch(query, limit);
        }
    }
    fallbackSearch(query, limit = 10) {
        const likeQuery = `%${query}%`;
        const rows = this.db
            .prepare(`
      SELECT m.id, m.session_id, m.role, m.timestamp,
             SUBSTR(m.content, 1, 100) as snippet,
             s.source, s.model
      FROM messages m
      LEFT JOIN sessions s ON m.session_id = s.id
      WHERE m.content LIKE ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `)
            .all(likeQuery, limit);
        return rows.map((r) => ({
            id: r.id,
            sessionId: r.session_id,
            role: r.role,
            timestamp: r.timestamp,
            snippet: r.snippet || '',
            source: r.source,
            model: r.model,
        }));
    }
    /** 清理 FTS5 查询文本 */
    sanitizeQuery(query) {
        return query
            .replace(/['"()*]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    // ─── 维护 ─────────────────────────────────────────
    pruneSessions(olderThanDays = 90, source) {
        const cutoff = Date.now() / 1000 - olderThanDays * 86400;
        let sql = 'DELETE FROM sessions WHERE ended_at IS NOT NULL AND started_at < ?';
        const params = [cutoff];
        if (source) {
            sql += ' AND source = ?';
            params.push(source);
        }
        return this.retryWrite(() => {
            const result = this.db.prepare(sql).run(...params);
            return result.changes;
        });
    }
    deleteSession(sessionId) {
        this.retryWrite(() => {
            this.db
                .prepare('DELETE FROM messages WHERE session_id = ?')
                .run(sessionId);
            this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        });
    }
    clearMessages(sessionId) {
        this.retryWrite(() => {
            this.db
                .prepare('DELETE FROM messages WHERE session_id = ?')
                .run(sessionId);
            this.db
                .prepare('UPDATE sessions SET message_count = 0 WHERE id = ?')
                .run(sessionId);
        });
    }
    close() {
        this.db.close();
    }
    getStats() {
        const s = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get()?.c ?? 0;
        const m = this.db.prepare('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
        return { sessions: s, messages: m };
    }
    // ─── 转换 ─────────────────────────────────────────
    rowToSession(row) {
        return {
            id: row.id,
            source: row.source || 'unknown',
            userId: row.user_id,
            model: row.model,
            title: row.title,
            parentSessionId: row.parent_session_id,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            endReason: row.end_reason,
            messageCount: Number(row.message_count) || 0,
            toolCallCount: Number(row.tool_call_count) || 0,
            inputTokens: Number(row.input_tokens) || 0,
            outputTokens: Number(row.output_tokens) || 0,
            estimatedCostUsd: row.estimated_cost_usd,
        };
    }
    rowToMessage(row) {
        return {
            id: row.id,
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            toolCallId: row.tool_call_id,
            toolCalls: row.tool_calls,
            toolName: row.tool_name,
            timestamp: row.timestamp,
            tokenCount: row.token_count,
            finishReason: row.finish_reason,
        };
    }
}
exports.SessionStoreBridge = SessionStoreBridge;
