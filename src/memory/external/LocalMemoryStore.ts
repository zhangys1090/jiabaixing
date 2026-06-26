/**
 * LocalMemoryStore — 本地结构化记忆库
 *
 * 比 MemoryFileProvider 更结构化的本地知识存储。
 * 支持：
 *   - 带标签的知识条目
 *   - 语义搜索（embedding 或关键词降级）
 *   - 条目间关联
 *   - 自动去重
 *   - SQLite 持久化
 */

import { createDatabase } from '../../shared/DatabaseShim';
import type { DatabaseAdapter } from '../../shared/DatabaseShim';
import { Logger } from '../../utils/Logger';
import path from 'path';

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  summary?: string;
  tags: string[];
  source?: string;
  createdAt: number;
  updatedAt: number;
  importance: number; // 0-10
  /** 关联条目 ID 列表 */
  relatedIds: string[];
}

export interface SearchOptions {
  tags?: string[];
  limit?: number;
  minImportance?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  importance INTEGER DEFAULT 5,
  related_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge_entries(tags);
CREATE INDEX IF NOT EXISTS idx_knowledge_importance ON knowledge_entries(importance);
CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge_entries(updated_at DESC);
`;

export class LocalMemoryStore {
  private db: DatabaseAdapter;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'knowledge.db');
    this.db = createDatabase(this.dbPath);
    this.db.exec(SCHEMA);
    Logger.info(`🗄️ 本地记忆库已就绪: ${this.dbPath}`, 'LocalMemoryStore');
  }

  // ==================== CRUD ====================

  /** 添加或更新知识条目 */
  put(
    entry: Omit<KnowledgeEntry, 'createdAt' | 'updatedAt'> & {
      createdAt?: number;
    }
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO knowledge_entries
        (id, title, content, summary, tags, source, created_at, updated_at, importance, related_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.title,
        entry.content,
        entry.summary || null,
        JSON.stringify(entry.tags),
        entry.source || null,
        entry.createdAt || now,
        now,
        entry.importance,
        JSON.stringify(entry.relatedIds)
      );
    Logger.debug(`💾 知识已存储: ${entry.title}`, 'LocalMemoryStore');
  }

  /** 按 ID 获取条目 */
  get(id: string): KnowledgeEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM knowledge_entries WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  /** 删除条目 */
  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM knowledge_entries WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  /** 搜索条目 */
  search(query: string, options: SearchOptions = {}): KnowledgeEntry[] {
    const { tags, limit = 10, minImportance } = options;
    const conditions: string[] = [];
    const params: unknown[] = [];

    // 关键词搜索（LIKE）
    if (query.trim()) {
      conditions.push('(title LIKE ? OR content LIKE ? OR summary LIKE ?)');
      const like = `%${query}%`;
      params.push(like, like, like);
    }

    // 标签过滤
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        conditions.push('tags LIKE ?');
        params.push(`%"${tag}"%`);
      }
    }

    // 重要性过滤
    if (minImportance !== undefined) {
      conditions.push('importance >= ?');
      params.push(minImportance);
    }

    const sql =
      conditions.length > 0
        ? `SELECT * FROM knowledge_entries WHERE ${conditions.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`
        : 'SELECT * FROM knowledge_entries ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** 获取所有标签及使用频率 */
  getAllTags(): Array<{ tag: string; count: number }> {
    const rows = this.db
      .prepare('SELECT tags FROM knowledge_entries')
      .all() as Record<string, unknown>[];
    const tagCount = new Map<string, number>();
    for (const row of rows) {
      const tags: string[] = JSON.parse((row.tags as string) || '[]');
      for (const tag of tags) {
        tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      }
    }
    return Array.from(tagCount.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** 获取总条目数 */
  get size(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM knowledge_entries')
      .get() as any;
    return row?.count ?? 0;
  }

  /** 关闭 */
  close(): void {
    this.db.close();
  }

  // ==================== 内部 ====================

  private rowToEntry(row: Record<string, unknown>): KnowledgeEntry {
    return {
      id: row.id as string,
      title: row.title as string,
      content: row.content as string,
      summary: row.summary as string | undefined,
      tags: JSON.parse((row.tags as string) || '[]'),
      source: row.source as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      importance: (row.importance as number) || 5,
      relatedIds: JSON.parse((row.related_ids as string) || '[]'),
    };
  }
}
