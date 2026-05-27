/**
 * 长期记忆（永久记忆）
 * 存储用户基础信息、偏好禁忌、作息习惯、专业领域、知识体系、重要事件、过往成功方案、核心规则
 * 优先使用Chroma向量数据库，不可用时降级为SQLite关系型数据库存储
 */

import Database from 'better-sqlite3';
import { ChromaClient, Collection } from 'chromadb';
import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/Logger';
import { BaseMemoryStore } from './BaseMemoryStore';
import { MemoryItem, MemoryType } from './MemoryEngine';

interface SQLiteLongTermRecord {
  id: string;
  content: string;
  scene: string;
  emotion: string;
  timestamp: string;
  type: string;
}

export class LongTermMemory extends BaseMemoryStore {
  private chromaPath: string;
  private sqlitePath: string;
  private chromaClient: ChromaClient | null = null;
  private collection: Collection | null = null;
  private sqliteDb: Database.Database | null = null;
  private useChroma: boolean = false;
  private maxMemoryUsage: number = 512 * 1024 * 1024;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    chromaPath: string = './data/long_term_memory_chroma',
    sqlitePath: string = './data/long_term_memory_sqlite.db'
  ) {
    super({
      enableOperationLogging: true,
      enableErrorRetry: true,
      maxRetryAttempts: 2,
    });
    this.chromaPath = chromaPath;
    this.sqlitePath = sqlitePath;
  }

  protected getStoreName(): string {
    return '长期记忆';
  }

  public async initialize(): Promise<void> {
    await this.executeTransaction('initialize', async () => {
      await this.tryInitializeChroma();

      if (!this.useChroma) {
        this.initializeSQLiteFallback();
      }

      this.startCleanupTask();
      this.initialized = true;
    });
  }

  private async tryInitializeChroma(): Promise<void> {
    try {
      this.chromaClient = new ChromaClient({ path: 'http://localhost:8000' });
      const heartbeat = await this.chromaClient.heartbeat();
      if (heartbeat) {
        this.collection = await this.chromaClient.getOrCreateCollection({
          name: 'long_term_memory',
          metadata: { 'hnsw:space': 'cosine' },
        });
        this.useChroma = true;
      }
    } catch {
      this.useChroma = false;
      this.chromaClient = null;
      this.collection = null;
    }
  }

  private initializeSQLiteFallback(): void {
    const dir = path.dirname(this.sqlitePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.sqliteDb = new Database(this.sqlitePath);
    this.sqliteDb.pragma('journal_mode = WAL');

    this.sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS long_term_memory (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        scene TEXT DEFAULT '',
        emotion TEXT DEFAULT '',
        timestamp TEXT NOT NULL,
        type TEXT DEFAULT 'LONG_TERM'
      )
    `);
    this.sqliteDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_ltm_timestamp ON long_term_memory(timestamp)
    `);
    this.sqliteDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_ltm_scene ON long_term_memory(scene)
    `);
    this.sqliteDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_ltm_emotion ON long_term_memory(emotion)
    `);
    this.sqliteDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_ltm_emotion_scene ON long_term_memory(emotion, scene)
    `);

    Logger.info('✅ 长期记忆：SQLite降级存储已初始化', 'LongTermMemory');
  }

  public async store(
    content: string | Record<string, unknown> | unknown[],
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    this.ensureInitialized();

    const memoryItem: MemoryItem = {
      id: `long_term_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      type: MemoryType.LONG_TERM,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };

    await this.executeTransaction('store', async () => {
      const document = JSON.stringify({
        content,
        scene,
        emotion,
        timestamp: memoryItem.timestamp.toISOString(),
      });

      const metadata = {
        scene: scene || '',
        emotion: emotion || '',
        timestamp: memoryItem.timestamp.toISOString(),
        type: memoryItem.type,
      };

      if (this.useChroma && this.collection) {
        await this.collection.add({
          ids: [memoryItem.id],
          documents: [document],
          metadatas: [metadata],
        });
      }

      if (this.sqliteDb) {
        const insertStmt = this.sqliteDb.prepare(
          'INSERT INTO long_term_memory (id, content, scene, emotion, timestamp, type) VALUES (?, ?, ?, ?, ?, ?)'
        );
        insertStmt.run(
          memoryItem.id,
          typeof content === 'string' ? content : JSON.stringify(content),
          scene || '',
          emotion || '',
          memoryItem.timestamp.toISOString(),
          memoryItem.type
        );
      }
    });

    return memoryItem;
  }

  public async retrieve(
    query: string,
    requirements: string[]
  ): Promise<MemoryItem[]> {
    this.ensureInitialized();

    return this.executeTransaction('retrieve', async () => {
      if (this.useChroma && this.collection) {
        const results = await this.collection.query({
          queryTexts: [query],
          nResults: 10,
          where: {
            $and: requirements.map((req) => ({ $contains: req })),
          },
        });

        const memoryItems: MemoryItem[] = [];
        if (results.ids[0] && results.documents[0]) {
          for (let i = 0; i < results.ids[0].length; i++) {
            const id = results.ids[0][i];
            const document = results.documents[0][i];

            try {
              if (document) {
                const docData = JSON.parse(document);
                memoryItems.push({
                  id,
                  type: MemoryType.LONG_TERM,
                  content: docData.content,
                  timestamp: new Date(docData.timestamp),
                  scene: docData.scene,
                  emotion: docData.emotion,
                });
              }
            } catch (parseError) {
              Logger.error(
                '❌ 长期记忆：解析文档失败:',
                parseError as Error,
                'LongTermMemory'
              );
            }
          }
        }
        return memoryItems;
      }

      if (this.sqliteDb) {
        return this.retrieveFromSQLite(query, requirements);
      }

      return [];
    }).catch(() => []);
  }

  private retrieveFromSQLite(
    query: string,
    requirements: string[]
  ): MemoryItem[] {
    let sql = 'SELECT * FROM long_term_memory WHERE 1=1';
    const params: string[] = [];

    if (query) {
      sql += ' AND content LIKE ?';
      params.push(`%${query}%`);
    }

    for (const req of requirements) {
      sql += ' AND (content LIKE ? OR scene LIKE ? OR emotion LIKE ?)';
      params.push(`%${req}%`, `%${req}%`, `%${req}%`);
    }

    sql += ' ORDER BY timestamp DESC LIMIT 10';

    const stmt = this.sqliteDb!.prepare(sql);
    const rows = stmt.all(...params) as SQLiteLongTermRecord[];

    return rows.map((row) => ({
      id: row.id,
      type: MemoryType.LONG_TERM,
      content: row.content,
      timestamp: new Date(row.timestamp),
      scene: row.scene,
      emotion: row.emotion,
    }));
  }

  public async retrieveByEmotionAndScene(
    emotionType: string,
    sceneType: string
  ): Promise<MemoryItem[]> {
    this.ensureInitialized();

    return this.executeTransaction('retrieveByEmotionAndScene', async () => {
      if (this.useChroma && this.collection) {
        const results = await this.collection.query({
          queryTexts: [`${emotionType} ${sceneType}`],
          nResults: 10,
          where: {
            $and: [
              { emotion: { $eq: emotionType } },
              { scene: { $eq: sceneType } },
            ],
          },
        });

        const memoryItems: MemoryItem[] = [];
        if (results.ids[0] && results.documents[0]) {
          for (let i = 0; i < results.ids[0].length; i++) {
            const id = results.ids[0][i];
            const document = results.documents[0][i];

            try {
              if (document) {
                const docData = JSON.parse(document);
                memoryItems.push({
                  id,
                  type: MemoryType.LONG_TERM,
                  content: docData._content,
                  timestamp: new Date(docData._timestamp),
                  scene: docData.scene,
                  emotion: docData.emotion,
                });
              }
            } catch (parseError) {
              Logger.error(
                '❌ 长期记忆：解析文档失败:',
                parseError as Error,
                'LongTermMemory'
              );
            }
          }
        }
        return memoryItems;
      }

      if (this.sqliteDb) {
        const stmt = this.sqliteDb.prepare(
          'SELECT * FROM long_term_memory WHERE emotion = ? AND scene = ? ORDER BY timestamp DESC LIMIT 10'
        );
        const rows = stmt.all(emotionType, sceneType) as SQLiteLongTermRecord[];
        return rows.map((row) => ({
          id: row.id,
          type: MemoryType.LONG_TERM,
          content: row.content,
          timestamp: new Date(row.timestamp),
          scene: row.scene,
          emotion: row.emotion,
        }));
      }

      return [];
    }).catch(() => []);
  }

  public async save(): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('save', async () => {
      if (this.sqliteDb) {
        this.sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
      }
    });
  }

  public async optimize(): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('optimize', async () => {
      this.checkMemoryUsage();
      if (this.sqliteDb) {
        this.sqliteDb.pragma('optimize');
      }
    });
  }

  private checkMemoryUsage(): void {
    const memory = process.memoryUsage();
    const heapUsed = memory.heapUsed / 1024 / 1024;

    if (heapUsed > (this.maxMemoryUsage / 1024 / 1024) * 0.8) {
      void this.performMemoryCleanup();
    }
  }

  private async performMemoryCleanup(): Promise<void> {
    await this.executeTransaction('performMemoryCleanup', async () => {
      if (this.sqliteDb) {
        const cutoff = new Date(
          Date.now() - 365 * 24 * 60 * 60 * 1000
        ).toISOString();
        this.sqliteDb
          .prepare('DELETE FROM long_term_memory WHERE timestamp < ?')
          .run(cutoff);
        Logger.info('🧹 长期记忆：已清理超过一年的旧记录', 'LongTermMemory');
      }
    }).catch((error) => {
      Logger.error(
        '❌ 长期记忆：内存清理失败:',
        error as Error,
        'LongTermMemory'
      );
    });
  }

  private startCleanupTask(): void {
    this.cleanupInterval = setInterval(
      async () => {
        await this.optimize().catch((error) => {
          Logger.error(
            '❌ 长期记忆：定期优化失败:',
            error as Error,
            'LongTermMemory'
          );
        });
      },
      60 * 60 * 1000
    );
  }

  public async shutdown(): Promise<void> {
    await this.executeTransaction('shutdown', async () => {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }

      await this.save();

      if (this.sqliteDb) {
        this.sqliteDb.close();
        this.sqliteDb = null;
      }

      this.initialized = false;
    });
  }

  /** 获取所有记忆项 */
  public getAll(): MemoryItem[] {
    if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(
        'SELECT * FROM long_term_memory ORDER BY timestamp DESC'
      );
      const rows = stmt.all() as SQLiteLongTermRecord[];
      return rows.map((row) => ({
        id: row.id,
        type: MemoryType.LONG_TERM,
        content: row.content,
        timestamp: new Date(row.timestamp),
        scene: row.scene,
        emotion: row.emotion,
      }));
    }
    return [];
  }
}
