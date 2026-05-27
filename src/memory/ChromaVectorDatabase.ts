/**
 * ChromaDB 向量数据库实现（可选依赖）
 * 需要安装 @chroma-core/chromadb 才能使用
 */

import { Logger } from '../utils/Logger';
import { BaseMemoryStore } from './BaseMemoryStore';
import { VectorDatabase } from './VectorDatabaseInterface';

interface ChromaCollection {
  add: (data: {
    ids: string[];
    embeddings?: number[][];
    metadatas?: Record<string, unknown>[];
  }) => Promise<void>;
  query: (data: {
    queryEmbeddings: number[][];
    nResults: number;
    where?: Record<string, unknown>;
  }) => {
    ids: string[][];
    distances?: number[][];
    metadatas?: Record<string, unknown>[][];
  };
  update: (data: {
    ids: string[];
    embeddings?: number[][];
    metadatas?: Record<string, unknown>[];
  }) => Promise<void>;
  delete: (data: { ids: string[] }) => Promise<void>;
  count: () => Promise<number>;
}

interface ChromaClient {
  getOrCreateCollection: (data: {
    name: string;
    metadata?: Record<string, unknown>;
  }) => Promise<ChromaCollection>;
}

export class ChromaVectorDatabase
  extends BaseMemoryStore
  implements VectorDatabase
{
  private client: ChromaClient | null = null;
  private collection: ChromaCollection | null = null;
  private collectionName: string;

  constructor(collectionName: string = 'jiabaixing-memory') {
    super({ enableOperationLogging: true, enableErrorRetry: false });
    this.collectionName = collectionName;
  }

  protected getStoreName(): string {
    return 'Chroma向量数据库';
  }

  public async initialize(): Promise<void> {
    await this.executeTransaction('initialize', async () => {
      const { ChromaClient } =
        (await import('@chroma-core/chromadb')) as typeof import('@chroma-core/chromadb');
      this.client = new ChromaClient({
        path: 'http://localhost:8000',
      }) as unknown as ChromaClient;

      this.collection = await this.client!.getOrCreateCollection({
        name: this.collectionName,
        metadata: { description: 'jiabaixing memory collection' },
      });

      this.initialized = true;
      Logger.info('✅ Chroma向量数据库初始化成功');
    }).catch((error) => {
      Logger.warn(`⚠️ Chroma向量数据库初始化失败: ${(error as Error).message}`);
      this.initialized = false;
    });
  }

  public async storeVector(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('storeVector', async () => {
      await this.collection!.add({
        ids: [id],
        embeddings: [vector],
        metadatas: metadata ? [metadata] : undefined,
      });
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
      const results = this.collection!.query({
        queryEmbeddings: [query],
        nResults: k,
        where: filter,
      });

      const formattedResults: {
        id: string;
        similarity: number;
        metadata?: Record<string, unknown>;
      }[] = [];
      if (results.ids && results.ids[0]) {
        for (let i = 0; i < results.ids[0].length; i++) {
          formattedResults.push({
            id: results.ids[0][i],
            similarity: results.distances ? 1 - results.distances[0][i] : 0,
            metadata:
              results.metadatas && results.metadatas[0][i]
                ? (results.metadatas[0][i] as Record<string, unknown>)
                : undefined,
          });
        }
      }
      return formattedResults;
    });
  }

  public async updateVector(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('updateVector', async () => {
      await this.collection!.update({
        ids: [id],
        embeddings: [vector],
        metadatas: metadata ? [metadata] : undefined,
      });
    });
  }

  public async deleteVector(id: string): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('deleteVector', async () => {
      await this.collection!.delete({ ids: [id] });
    });
  }

  public async getVectorCount(): Promise<number> {
    this.ensureInitialized();
    return this.executeTransaction('getVectorCount', async () => {
      return this.collection ? this.collection.count() : 0;
    });
  }

  public async shutdown(): Promise<void> {
    await this.executeTransaction('shutdown', async () => {
      if (this.initialized) {
        Logger.info('🔌 关闭 Chroma向量数据库');
        this.initialized = false;
        Logger.info('✅ Chroma向量数据库关闭完成');
      }
    });
  }
}
