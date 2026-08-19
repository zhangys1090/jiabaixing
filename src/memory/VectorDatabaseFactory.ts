/**
 * @deprecated 已废弃，请使用 VectorDatabase.ts 中的完整实现。
 * 此存根仅保持向后兼容，V6.0 后移除。
 */
export interface VectorDatabaseConfig {
  dimension?: number;
  metric?: string;
}

export class VectorDatabase {
  dimension: number = 1536;
  metric: string = 'cosine';

  constructor(config?: VectorDatabaseConfig) {
    this.dimension = config?.dimension ?? 1536;
    this.metric = config?.metric ?? 'cosine';
  }

  async storeVector(): Promise<void> {}
  async searchVectors(): Promise<any[]> {
    return [];
  }
  async add(): Promise<void> {}
  async search(): Promise<any[]> {
    return [];
  }
  async delete(): Promise<void> {}
  async close(): Promise<void> {}
}

export class VectorDatabaseFactory {
  static createVectorDatabase(config?: VectorDatabaseConfig): VectorDatabase {
    return new VectorDatabase(config);
  }

  static create(config?: VectorDatabaseConfig): VectorDatabase | null {
    return new VectorDatabase(config);
  }
}
