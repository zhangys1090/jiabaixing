/**
 * VectorDatabaseFactory 存根
 * 为 MemoryEngine 提供向量数据库创建能力
 */

import { Logger } from '../utils/Logger';

export interface VectorDatabase {
  storeVector(
    id: string,
    vector: number[],
    metadata: Record<string, unknown>
  ): Promise<void>;
  searchVectors(
    query: number[],
    topK: number
  ): Promise<{ id: string; similarity: number }[]>;
  store(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void>;
  search(
    query: number[],
    topK?: number
  ): Promise<
    Array<{ id: string; score: number; metadata?: Record<string, unknown> }>
  >;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

class InMemoryVectorDatabase implements VectorDatabase {
  private vectors: Map<
    string,
    { vector: number[]; metadata?: Record<string, unknown> }
  > = new Map();

  async storeVector(
    id: string,
    vector: number[],
    metadata: Record<string, unknown>
  ): Promise<void> {
    this.vectors.set(id, { vector, metadata });
  }

  async searchVectors(
    query: number[],
    topK: number
  ): Promise<{ id: string; similarity: number }[]> {
    const results: { id: string; similarity: number }[] = [];

    for (const [id, data] of this.vectors.entries()) {
      const similarity = this.cosineSimilarity(query, data.vector);
      results.push({ id, similarity });
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  }

  async store(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.vectors.set(id, { vector, metadata });
  }

  async search(
    query: number[],
    topK: number = 10
  ): Promise<
    Array<{ id: string; score: number; metadata?: Record<string, unknown> }>
  > {
    const results: Array<{
      id: string;
      score: number;
      metadata?: Record<string, unknown>;
    }> = [];

    for (const [id, data] of this.vectors.entries()) {
      const score = this.cosineSimilarity(query, data.vector);
      results.push({ id, score, metadata: data.metadata });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    this.vectors.delete(id);
  }

  async close(): Promise<void> {
    this.vectors.clear();
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

export class VectorDatabaseFactory {
  public static async createVectorDatabase(): Promise<VectorDatabase> {
    Logger.info('创建内存向量数据库', 'VectorDatabaseFactory');
    return new InMemoryVectorDatabase();
  }
}

export default VectorDatabaseFactory;
