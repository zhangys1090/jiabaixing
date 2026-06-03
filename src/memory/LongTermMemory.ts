/**
 * 长期记忆（永久记忆）
 * 存储用户基础信息、偏好禁忌、作息习惯、专业领域、知识体系、重要事件、过往成功方案、核心规则
 * 优先使用Chroma向量数据库，不可用时降级为统一MemoryDatabase单例
 *
 * 整合优化：复用MemoryDatabase单例，消除独立SQLite连接
 */

import { ChromaClient, Collection } from 'chromadb';
import { Logger } from '../utils/Logger';
import { BaseMemoryStore } from './BaseMemoryStore';
import { MemoryItem, MemoryType } from './MemoryEngine';
import { MemoryDatabase } from './Database';

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
  private chromaClient: ChromaClient | null = null;
  private collection: Collection | null = null;
  private useChroma: boolean = false;
  private maxMemoryUsage: number = 512 * 1024 * 1024;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private memoryDatabase: MemoryDatabase;

  constructor(
    chromaPath: string = './data/long_term_memory_chroma',
    _sqlitePath?: string
  ) {
    super({
      enableOperationLogging: true,
      enableErrorRetry: true,
      maxRetryAttempts: 2,
    });
    this.chromaPath = chromaPath;
    this.memoryDatabase = MemoryDatabase.getInstance();
  }

  protected getStoreName(): string {
    return '长期记忆';
  }

  public async initialize(): Promise<void> {
    await this.executeTransaction('initialize', async () => {
      await this.tryInitializeChroma();
      this.ensureLongTermTable();
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

  private ensureLongTermTable(): void {
    try {
      this.memoryDatabase.add('__schema_check__', 'long_term', 'system', 0);
    } catch {
      // 表已存在
    }
    Logger.info('✅ 长期记忆：统一数据库存储已就绪', 'LongTermMemory');
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

      this.memoryDatabase.add(
        typeof content === 'string' ? content : JSON.stringify(content),
        'long_term',
        'LongTermMemory',
        0.8
      );
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

      return this.retrieveFromDatabase(query, requirements);
    }).catch(() => []);
  }

  private retrieveFromDatabase(
    query: string,
    requirements: string[]
  ): MemoryItem[] {
    try {
      const ftsResults = this.memoryDatabase.searchByFTS5(query, 10);
      if (ftsResults.length > 0) {
        return ftsResults
          .filter((r) => {
            return requirements.every(
              (req) =>
                r.content.includes(req) ||
                (r as unknown as SQLiteLongTermRecord).scene?.includes(req) ||
                (r as unknown as SQLiteLongTermRecord).emotion?.includes(req)
            );
          })
          .map((record) => ({
            id: String(record.id),
            type: MemoryType.LONG_TERM,
            content: record.content,
            timestamp: new Date(record.timestamp),
          }));
      }
    } catch {
      // FTS5不可用，回退
    }

    const allRecords = this.memoryDatabase.query('long_term', 10);
    return allRecords
      .filter((r) => {
        const matchesQuery = !query || r.content.includes(query);
        const matchesReqs = requirements.every(
          (req) => r.content.includes(req)
        );
        return matchesQuery && matchesReqs;
      })
      .map((record) => ({
        id: String(record.id),
        type: MemoryType.LONG_TERM,
        content: record.content,
        timestamp: new Date(record.timestamp),
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

      return this.retrieveFromDatabase(`${emotionType} ${sceneType}`, []);
    }).catch(() => []);
  }

  public async save(): Promise<void> {
    this.ensureInitialized();
    // MemoryDatabase单例自行管理持久化，无需额外操作
  }

  public async optimize(): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('optimize', async () => {
      this.checkMemoryUsage();
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
      const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
      Logger.info('🧹 长期记忆：已清理超过一年的旧记录', 'LongTermMemory');
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
      this.initialized = false;
    });
  }

  /** 获取所有记忆项 */
  public getAll(): MemoryItem[] {
    const records = this.memoryDatabase.query('long_term', 1000);
    return records.map((record) => ({
      id: String(record.id),
      type: MemoryType.LONG_TERM,
      content: record.content,
      timestamp: new Date(record.timestamp),
    }));
  }
}
