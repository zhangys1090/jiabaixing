/**
 * 内存向量索引实现（作为备用）
 */

import { Logger } from '../utils/Logger';
import { BaseMemoryStore } from './BaseMemoryStore';
import { VectorDatabase } from './VectorDatabaseInterface';

export class InMemoryVectorIndex
  extends BaseMemoryStore
  implements VectorDatabase
{
  private vectors: Map<
    string,
    { vector: number[]; metadata?: Record<string, unknown> }
  > = new Map();

  constructor() {
    super({ enableOperationLogging: true, enableErrorRetry: false });
  }

  protected getStoreName(): string {
    return '内存向量索引';
  }

  public async initialize(): Promise<void> {
    await this.executeTransaction('initialize', async () => {
      this.initialized = true;
      Logger.info('✅ 内存向量索引初始化成功');
    });
  }

  public async storeVector(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('storeVector', async () => {
      this.vectors.set(id, { vector, metadata });
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

      for (const [id, { vector, metadata }] of this.vectors.entries()) {
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
      this.vectors.set(id, { vector, metadata });
    });
  }

  public async deleteVector(id: string): Promise<void> {
    this.ensureInitialized();
    await this.executeTransaction('deleteVector', async () => {
      this.vectors.delete(id);
    });
  }

  public async getVectorCount(): Promise<number> {
    this.ensureInitialized();
    return this.executeTransaction('getVectorCount', async () => {
      return this.vectors.size;
    });
  }

  public async shutdown(): Promise<void> {
    await this.executeTransaction('shutdown', async () => {
      if (this.initialized) {
        Logger.info('🔌 关闭内存向量索引');
        this.vectors.clear();
        this.initialized = false;
        Logger.info('✅ 内存向量索引关闭完成');
      }
    });
  }

  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error('向量维度不匹配');
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
