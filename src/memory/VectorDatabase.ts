/**
 * 向量数据库管理模块（主实现）
 * 提供向量数据库工厂，支持持久化、ChromaDB 和内存模式
 *
 * 注意：这是向量数据库的完整实现。
 *       VectorDatabaseFactory.ts 为简化版存根（已废弃），仅用于向后兼容。
 *
 * 支持的数据库类型：
 * - persistent: 持久化向量数据库（默认），支持跨会话记忆
 * - chroma: ChromaDB 向量数据库（可选依赖）
 * - memory: 内存向量索引，重启后数据丢失
 */

import { Logger } from '../utils/Logger';
import { InMemoryVectorIndex } from './InMemoryVectorIndex';
import { PersistentVectorDatabase } from './PersistentVectorDatabase';
import { VectorDatabase } from './VectorDatabaseInterface';

export { InMemoryVectorIndex } from './InMemoryVectorIndex';
export { PersistentVectorDatabase } from './PersistentVectorDatabase';
export { VectorDatabase } from './VectorDatabaseInterface';

/**
 * 向量数据库工厂
 */
export class VectorDatabaseFactory {
  /**
   * 创建向量数据库实例
   * @param type 数据库类型: 'persistent' (默认), 'chroma', 'memory'
   * @param dataDir 数据存储目录
   */
  public static async createVectorDatabase(
    type: 'persistent' | 'chroma' | 'memory' = 'persistent',
    dataDir: string = './data'
  ): Promise<VectorDatabase> {
    try {
      switch (type) {
        case 'persistent': {
          const persistentDb = new PersistentVectorDatabase(dataDir);
          await persistentDb.initialize();
          if (persistentDb.isInitialized()) {
            Logger.info(
              '✅ 使用持久化向量数据库（支持跨会话记忆）',
              'VectorDatabaseFactory'
            );
            return persistentDb;
          }
          Logger.warn(
            '⚠️ 持久化数据库初始化失败，降级为内存向量索引',
            'VectorDatabaseFactory'
          );
          const memoryDb = new InMemoryVectorIndex();
          await memoryDb.initialize();
          return memoryDb;
        }
        case 'chroma': {
          // ChromaDB 为可选依赖，动态加载
          const { ChromaVectorDatabase } =
            await import('./ChromaVectorDatabase');
          const chromaDb = new ChromaVectorDatabase('jiabaixing-memory');
          await chromaDb.initialize();
          if (chromaDb.isInitialized()) {
            Logger.info('✅ 使用 ChromaDB 向量数据库', 'VectorDatabaseFactory');
            return chromaDb;
          }
          Logger.warn(
            '⚠️ ChromaDB 初始化失败，降级为持久化向量数据库',
            'VectorDatabaseFactory'
          );
          const persistentDb = new PersistentVectorDatabase(dataDir);
          await persistentDb.initialize();
          return persistentDb;
        }
        case 'memory':
        default: {
          const memoryDb = new InMemoryVectorIndex();
          await memoryDb.initialize();
          Logger.info(
            '✅ 使用内存向量索引（重启后数据丢失）',
            'VectorDatabaseFactory'
          );
          return memoryDb;
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      Logger.error(
        `❌ 向量数据库初始化失败: ${errorMessage}，使用内存降级方案`,
        undefined,
        'VectorDatabaseFactory'
      );
      const memoryDb = new InMemoryVectorIndex();
      await memoryDb.initialize();
      return memoryDb;
    }
  }
}
