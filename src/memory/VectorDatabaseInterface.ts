/**
 * 向量数据库接口定义
 * 避免循环依赖，独立定义接口
 */

/**
 * 向量数据库接口
 */
export interface VectorDatabase {
  initialize(): Promise<void>;
  storeVector(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void>;
  searchVectors(
    query: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<
    { id: string; similarity: number; metadata?: Record<string, unknown> }[]
  >;
  updateVector(
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void>;
  deleteVector(id: string): Promise<void>;
  getVectorCount(): Promise<number>;
  shutdown(): Promise<void>;
}
