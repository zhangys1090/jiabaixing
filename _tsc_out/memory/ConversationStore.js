"use strict";
/**
 * ConversationStore — 会话持久化层
 *
 * 用 SQLite + FTS5 实现会话的 CRUD、全文搜索、血缘追踪。
 * 替代当前 ConversationHistoryManager 的 JSON 文件方案。
 *
 * 核心功能：
 *   1. 会话 CRUD（创建/读取/更新/删除/列表）
 *   2. FTS5 全文搜索（按关键词搜索历史对话）
 *   3. 会话血缘（记录会话间的衍生关系）
 *   4. 标题自动生成（存储 + 检索）
 *   5. 轨迹导出（ShareGPT 格式）
 *
 * 目标：让 Agent 能跨会话检索历史上下文，
 * 使得"记忆"不再是短期存储，而是持久可检索的知识库。
 */
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
exports.ConversationStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
class ConversationStore {
    db;
    dbPath;
    constructor(dbPath) {
        this.dbPath =
            dbPath || path.join(process.cwd(), 'data', 'jiabaixing_conversations.db');
        // 确保 data 目录存在
        const dataDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        this.db = (0, DatabaseShim_1.createDatabase)(this.dbPath);
        try {
            this.db.pragma('foreign_keys = ON');
        }
        catch { }
        this.initialize();
    }
    /**
     * 初始化数据库表和 FTS5 索引
     */
    initialize() {
        // 会话表
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        model TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '',
        summary TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
    `);
        // 消息表
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp DESC);
    `);
        // FTS5 全文搜索虚拟表
        this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        conversation_id,
        title,
        content,
        summary,
        tags,
        content=conversations,
        content_rowid=rowid
      );
    `);
        // 消息内容的 FTS5 索引
        this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id,
        conversation_id,
        role,
        content,
        content=messages,
        content_rowid=rowid
      );
    `);
        // 会话血缘表
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_lineage (
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK(relation_type IN ('fork', 'continuation', 'summary')),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES conversations(id),
        FOREIGN KEY (child_id) REFERENCES conversations(id)
      );
    `);
        Logger_1.Logger.info('ConversationStore 数据库初始化完成', 'ConversationStore');
    }
    // ── 会话 CRUD ──
    /**
     * 创建新会话
     */
    createConversation(record) {
        const now = Date.now();
        const full = {
            id: record.id,
            title: record.title || '',
            userId: record.userId || 'default',
            model: record.model || '',
            createdAt: now,
            updatedAt: now,
            messageCount: 0,
            tags: record.tags || [],
            summary: record.summary,
        };
        this.db
            .prepare(`
      INSERT INTO conversations (id, title, user_id, model, created_at, updated_at, message_count, tags, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
            .run(full.id, full.title, full.userId, full.model, full.createdAt, full.updatedAt, full.messageCount, JSON.stringify(full.tags), full.summary || null);
        // 同步到 FTS5
        this.syncConversationToFTS(full.id);
        Logger_1.Logger.debug(`创建会话: ${full.id}`, 'ConversationStore');
        return full;
    }
    /**
     * 获取会话详情
     */
    getConversation(id) {
        const row = this.db
            .prepare(`
      SELECT * FROM conversations WHERE id = ?
    `)
            .get(id);
        if (!row)
            return null;
        return this.rowToRecord(row);
    }
    /**
     * 更新会话元数据
     */
    updateConversation(id, updates) {
        const fields = [];
        const values = [];
        if (updates.title !== undefined) {
            fields.push('title = ?');
            values.push(updates.title);
        }
        if (updates.model !== undefined) {
            fields.push('model = ?');
            values.push(updates.model);
        }
        if (updates.tags !== undefined) {
            fields.push('tags = ?');
            values.push(JSON.stringify(updates.tags));
        }
        if (updates.summary !== undefined) {
            fields.push('summary = ?');
            values.push(updates.summary);
        }
        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        const result = this.db
            .prepare(`
      UPDATE conversations SET ${fields.join(', ')} WHERE id = ?
    `)
            .run(...values);
        if (result.changes > 0) {
            this.syncConversationToFTS(id);
        }
        return result.changes > 0;
    }
    /**
     * 列出会话（按更新时间降序）
     */
    listConversations(userId, limit, offset) {
        const sql = userId
            ? `SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`
            : `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
        const params = userId
            ? [userId, limit || 50, offset || 0]
            : [limit || 50, offset || 0];
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((row) => this.rowToRecord(row));
    }
    /**
     * 删除会话及其消息
     */
    deleteConversation(id) {
        const result = this.db
            .prepare(`DELETE FROM conversations WHERE id = ?`)
            .run(id);
        // CASCADE 会自动删除 messages
        // FTS5 的 content= 模式会自动同步
        return result.changes > 0;
    }
    // ── 消息 CRUD ──
    /**
     * 添加消息到会话
     */
    addMessage(msg) {
        this.db
            .prepare(`
      INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
            .run(msg.id, msg.conversationId, msg.role, msg.content, msg.timestamp, msg.metadata ? JSON.stringify(msg.metadata) : null);
        // 更新会话的 message_count 和 updated_at
        this.db
            .prepare(`
      UPDATE conversations
      SET message_count = message_count + 1, updated_at = ?
      WHERE id = ?
    `)
            .run(msg.timestamp, msg.conversationId);
        // 同步消息到 FTS5
        this.syncMessageToFTS(msg.id);
    }
    /**
     * 获取会话的所有消息
     */
    getMessages(conversationId, limit) {
        const sql = limit
            ? `SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT ?`
            : `SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`;
        const rows = this.db.prepare(sql).all(conversationId, limit);
        return rows.map((row) => this.messageRowToRecord(row));
    }
    // ── FTS5 搜索 ──
    /**
     * 搜索对话 — 在消息内容中搜索关键词
     * 返回包含关键词的会话列表（带摘要片段）
     */
    searchConversations(query, limit) {
        const sql = `
      SELECT
        m.conversation_id,
        c.title,
        snippet(messages_fts, 3, '[', ']', '...', 30) as snippet,
        rank,
        c.updated_at as timestamp
      FROM messages_fts
      JOIN messages m ON messages_fts.message_id = m.id
      JOIN conversations c ON m.conversation_id = c.id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
        const rows = this.db.prepare(sql).all(query, limit || 20);
        return rows.map((row) => ({
            conversationId: row.conversation_id,
            title: row.title,
            snippet: row.snippet,
            rank: row.rank,
            timestamp: row.timestamp,
        }));
    }
    /**
     * 搜索会话标题/标签
     */
    searchConversationTitles(query, limit) {
        const sql = `
      SELECT
        conversation_id,
        title,
        snippet(conversations_fts, 1, '[', ']', '...', 30) as snippet,
        rank,
        updated_at as timestamp
      FROM conversations_fts
      WHERE conversations_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
        const rows = this.db.prepare(sql).all(query, limit || 20);
        return rows.map((row) => ({
            conversationId: row.conversation_id,
            title: row.title,
            snippet: row.snippet,
            rank: row.rank,
            timestamp: row.timestamp,
        }));
    }
    // ── 会话血缘 ──
    /**
     * 记录会话衍生关系
     */
    addLineage(parentId, childId, relationType) {
        this.db
            .prepare(`
      INSERT INTO conversation_lineage (parent_id, child_id, relation_type, created_at)
      VALUES (?, ?, ?, ?)
    `)
            .run(parentId, childId, relationType, Date.now());
    }
    /**
     * 获取会话的血缘链
     */
    getLineage(conversationId) {
        const rows = this.db
            .prepare(`
      SELECT * FROM conversation_lineage
      WHERE parent_id = ? OR child_id = ?
      ORDER BY created_at ASC
    `)
            .all(conversationId, conversationId);
        return rows.map((row) => ({
            parentId: row.parent_id,
            childId: row.child_id,
            relationType: row.relation_type,
            createdAt: row.created_at,
        }));
    }
    // ── 轨迹导出 ──
    /**
     * 导出 ShareGPT 格式轨迹
     */
    exportShareGPT(conversationId) {
        const conv = this.getConversation(conversationId);
        if (!conv)
            return null;
        const messages = this.getMessages(conversationId);
        const conversations = messages.map((msg) => ({
            from: msg.role === 'user'
                ? 'human'
                : msg.role === 'assistant'
                    ? 'gpt'
                    : 'system',
            value: msg.content,
        }));
        return {
            id: conversationId,
            conversations,
            title: conv.title,
            model: conv.model,
            timestamp: conv.createdAt,
        };
    }
    // ── 内部辅助 ──
    rowToRecord(row) {
        return {
            id: row.id,
            title: row.title,
            userId: row.user_id,
            model: row.model,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            messageCount: row.message_count,
            tags: JSON.parse(row.tags || '[]'),
            summary: row.summary || undefined,
        };
    }
    messageRowToRecord(row) {
        return {
            id: row.id,
            conversationId: row.conversation_id,
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        };
    }
    /**
     * 同步会话数据到 FTS5
     * FTS5 content= 模式需要手动同步
     */
    syncConversationToFTS(id) {
        const row = this.db
            .prepare(`SELECT * FROM conversations WHERE id = ?`)
            .get(id);
        if (!row)
            return;
        // 先删除旧的 FTS 行
        this.db
            .prepare(`DELETE FROM conversations_fts WHERE conversation_id = ?`)
            .run(id);
        // 插入新行
        this.db
            .prepare(`
      INSERT INTO conversations_fts (conversation_id, title, content, summary, tags)
      VALUES (?, ?, ?, ?, ?)
    `)
            .run(id, row.title, '', // 会话内容在 messages_fts 中索引
        row.summary || '', row.tags || '');
    }
    syncMessageToFTS(id) {
        const row = this.db
            .prepare(`SELECT * FROM messages WHERE id = ?`)
            .get(id);
        if (!row)
            return;
        this.db.prepare(`DELETE FROM messages_fts WHERE message_id = ?`).run(id);
        this.db
            .prepare(`
      INSERT INTO messages_fts (message_id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `)
            .run(id, row.conversation_id, row.role, row.content);
    }
    /**
     * 关闭数据库连接
     */
    close() {
        this.db.close();
    }
}
exports.ConversationStore = ConversationStore;
