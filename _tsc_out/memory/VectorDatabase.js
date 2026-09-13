"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VectorDatabaseFactory = exports.PersistentVectorDatabase = exports.InMemoryVectorIndex = void 0;
const Logger_1 = require("../utils/Logger");
const InMemoryVectorIndex_1 = require("./InMemoryVectorIndex");
const PersistentVectorDatabase_1 = require("./PersistentVectorDatabase");
var InMemoryVectorIndex_2 = require("./InMemoryVectorIndex");
Object.defineProperty(exports, "InMemoryVectorIndex", { enumerable: true, get: function () { return InMemoryVectorIndex_2.InMemoryVectorIndex; } });
var PersistentVectorDatabase_2 = require("./PersistentVectorDatabase");
Object.defineProperty(exports, "PersistentVectorDatabase", { enumerable: true, get: function () { return PersistentVectorDatabase_2.PersistentVectorDatabase; } });
/**
 * 向量数据库工厂
 */
class VectorDatabaseFactory {
    /**
     * 创建向量数据库实例
     * @param type 数据库类型: 'persistent' (默认), 'chroma', 'memory'
     * @param dataDir 数据存储目录
     */
    static async createVectorDatabase(type = 'persistent', dataDir = './data') {
        try {
            switch (type) {
                case 'persistent': {
                    const persistentDb = new PersistentVectorDatabase_1.PersistentVectorDatabase(dataDir);
                    await persistentDb.initialize();
                    if (persistentDb.isInitialized()) {
                        Logger_1.Logger.info('✅ 使用持久化向量数据库（支持跨会话记忆）', 'VectorDatabaseFactory');
                        return persistentDb;
                    }
                    Logger_1.Logger.warn('⚠️ 持久化数据库初始化失败，降级为内存向量索引', 'VectorDatabaseFactory');
                    const memoryDb = new InMemoryVectorIndex_1.InMemoryVectorIndex();
                    await memoryDb.initialize();
                    return memoryDb;
                }
                case 'chroma': {
                    // ChromaDB 为可选依赖，动态加载
                    const { ChromaVectorDatabase } = await Promise.resolve().then(() => __importStar(require('./ChromaVectorDatabase')));
                    const chromaDb = new ChromaVectorDatabase('jiabaixing-memory');
                    await chromaDb.initialize();
                    if (chromaDb.isInitialized()) {
                        Logger_1.Logger.info('✅ 使用 ChromaDB 向量数据库', 'VectorDatabaseFactory');
                        return chromaDb;
                    }
                    Logger_1.Logger.warn('⚠️ ChromaDB 初始化失败，降级为持久化向量数据库', 'VectorDatabaseFactory');
                    const persistentDb = new PersistentVectorDatabase_1.PersistentVectorDatabase(dataDir);
                    await persistentDb.initialize();
                    return persistentDb;
                }
                case 'memory':
                default: {
                    const memoryDb = new InMemoryVectorIndex_1.InMemoryVectorIndex();
                    await memoryDb.initialize();
                    Logger_1.Logger.info('✅ 使用内存向量索引（重启后数据丢失）', 'VectorDatabaseFactory');
                    return memoryDb;
                }
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger_1.Logger.error(`❌ 向量数据库初始化失败: ${errorMessage}，使用内存降级方案`, undefined, 'VectorDatabaseFactory');
            const memoryDb = new InMemoryVectorIndex_1.InMemoryVectorIndex();
            await memoryDb.initialize();
            return memoryDb;
        }
    }
}
exports.VectorDatabaseFactory = VectorDatabaseFactory;
