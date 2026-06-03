/**
 * 持久化向量数据库
 * 使用 SQLite + better-sqlite3 实现向量持久化存储，支持跨会话记忆
 */

import { createDatabase } from '../shared/DatabaseShim';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { BaseMemoryStore } from './BaseMemoryStore';
import { VectorDatabase } from './VectorDatabaseInterface';

/**
 * 持久化向量数据库实现
 * 使用 SQLite 存储向量，重启后数据不丢失
 */
export class PersistentVectorDatabase
  extends BaseMemoryStore
  implements VectorDatabase
{
  private db: any = null;
  private dbPath: string;
  private vectorCache: Map<
    string,
    { vector: number[]; metadata?: Record<string, unknown> }
  > = new Map();

  constructor(dataDir: string = './data') {
    super({ enableOperationLogging: true, enableErrorRetry: false });
    this.dbPath = path.join(dataDir, 'vectors.db');
  }

  protected getStoreName(): string {
    return '持久化向量数据库';
  }

  public async initialize(): Promise<void> {
    await this.executeTransaction('initialize', async () => {
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      this.db = createDatabase(this.dbPath);
      if (this.db) {
        try { this.db.pragma('journal_mode = WAL'); } catch {}
        try { this.db.pragma('synchronous = NORMAL'); } catch {}

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS vectors (
            id TEXT PRIMARY KEY,
            vector TEXT NOT NULL,
            metadata TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
          );
          CREATE INDEX IF NOT EXISTS idx_vectors_created ON vectors(created_at);
        `);

        this.loadVectorCache();
        this.initialized = true;
        Logger.info(
          `✅ 持久化向量数据库初始化成功 - 已加载 ${this.vectorCache.size} 个向量`,
          'PersistentVectorDatabase'
        );
      } else {
        Logger.warn(
          '⚠️ 持久化向量数据库降级为内存模式（仅缓存）',
          'PersistentVectorDatabase'
        );
        this.initialized = true;
      }
    });
  }

  public async storeVector(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('storeVector', async () => {
      const vectorStr = JSON.stringify(vector);
      const metadataStr = metadata ? JSON.stringify(metadata) : null;

      if (!this.db) return;

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO vectors (id, vector, metadata, updated_at)
        VALUES (?, ?, ?, strftime('%s', 'now'))
      `);
      stmt.run(id, vectorStr, metadataStr);

      this.vectorCache.set(id, { vector, metadata });
    });
  }

  public async searchVectors(
    query: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<
    { id: string; similarity: number; metadata?: Record<string, unknown> }[]
  > {
    this.ensureInitialized();

    return this.executeTransaction('searchVectors', async () => {
      const results: {
        id: string;
        similarity: number;
        metadata?: Record<string, unknown>;
      }[] = [];

      for (const [id, { vector, metadata }] of this.vectorCache.entries()) {
        if (filter) {
          let match = true;
          for (const [key, value] of Object.entries(filter)) {
            if (metadata && metadata[key] !== value) {
              match = false;
              break;
            }
          }
          if (!match) continue;
        }

        const similarity = this.cosineSimilarity(vector, query);
        results.push({ id, similarity, metadata });
      }

      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, k);
    });
  }

  public async updateVector(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('updateVector', async () => {
      const vectorStr = JSON.stringify(vector);
      const metadataStr = metadata ? JSON.stringify(metadata) : null;

      if (!this.db) return;

      const stmt = this.db.prepare(`
        UPDATE vectors SET vector = ?, metadata = ?, updated_at = strftime('%s', 'now')
        WHERE id = ?
      `);
      stmt.run(vectorStr, metadataStr, id);

      this.vectorCache.set(id, { vector, metadata });
    });
  }

  public async deleteVector(id: string): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('deleteVector', async () => {
      if (!this.db) return;

      const stmt = this.db.prepare('DELETE FROM vectors WHERE id = ?');
      stmt.run(id);

      this.vectorCache.delete(id);
    });
  }

  public async getVectorCount(): Promise<number> {
    this.ensureInitialized();
    return this.executeTransaction('getVectorCount', async () => {
      return this.vectorCache.size;
    });
  }

  public async shutdown(): Promise<void> {
    await this.executeTransaction('shutdown', async () => {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      this.vectorCache.clear();
      this.initialized = false;
      Logger.info('🔌 持久化向量数据库已关闭', 'PersistentVectorDatabase');
    });
  }

  private loadVectorCache(): void {
    if (!this.db) return;

    const rows = this.db
      .prepare('SELECT id, vector, metadata FROM vectors')
      .all() as Array<{ id: string; vector: string; metadata: string | null }>;

    for (const row of rows) {
      try {
        const vector = JSON.parse(row.vector) as number[];
        const metadata = row.metadata
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : undefined;
        this.vectorCache.set(row.id, { vector, metadata });
      } catch (error) {
        Logger.warn(
          `⚠️ 加载向量 ${row.id} 失败: ${(error as Error).message}`,
          'PersistentVectorDatabase'
        );
      }
    }
  }

  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      return 0;
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (norm1 * norm2);
  }
}
