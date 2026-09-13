"use strict";
/**
 * ChromaDB 向量数据库实现（可选依赖）
 * 需要安装 @chroma-core/chromadb 才能使用
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
exports.ChromaVectorDatabase = void 0;
const Logger_1 = require("../utils/Logger");
const BaseMemoryStore_1 = require("./BaseMemoryStore");
class ChromaVectorDatabase extends BaseMemoryStore_1.BaseMemoryStore {
    client = null;
    collection = null;
    collectionName;
    constructor(collectionName = 'jiabaixing-memory') {
        super({ enableOperationLogging: true, enableErrorRetry: false });
        this.collectionName = collectionName;
    }
    getStoreName() {
        return 'Chroma向量数据库';
    }
    async initialize() {
        await this.executeTransaction('initialize', async () => {
            const ImportedChromaClient = (await Promise.resolve().then(() => __importStar(require('@chroma-core/chromadb'))))
                .ChromaClient;
            this.client = new ImportedChromaClient({
                path: 'http://localhost:8000',
            });
            this.collection = await this.client.getOrCreateCollection({
                name: this.collectionName,
                metadata: { description: 'jiabaixing memory collection' },
            });
            this.initialized = true;
            Logger_1.Logger.info('✅ Chroma向量数据库初始化成功');
        }).catch((error) => {
            Logger_1.Logger.warn(`⚠️ Chroma向量数据库初始化失败: ${error.message}`);
            this.initialized = false;
        });
    }
    async storeVector(id, vector, metadata) {
        this.ensureInitialized();
        await this.executeTransaction('storeVector', async () => {
            await this.collection.add({
                ids: [id],
                embeddings: [vector],
                metadatas: metadata ? [metadata] : undefined,
            });
        });
    }
    async searchVectors(query, k, filter) {
        this.ensureInitialized();
        return this.executeTransaction('searchVectors', async () => {
            const results = this.collection.query({
                queryEmbeddings: [query],
                nResults: k,
                where: filter,
            });
            const formattedResults = [];
            if (results.ids && results.ids[0]) {
                for (let i = 0; i < results.ids[0].length; i++) {
                    formattedResults.push({
                        id: results.ids[0][i],
                        similarity: results.distances ? 1 - results.distances[0][i] : 0,
                        metadata: results.metadatas && results.metadatas[0][i]
                            ? results.metadatas[0][i]
                            : undefined,
                    });
                }
            }
            return formattedResults;
        });
    }
    async updateVector(id, vector, metadata) {
        this.ensureInitialized();
        await this.executeTransaction('updateVector', async () => {
            await this.collection.update({
                ids: [id],
                embeddings: [vector],
                metadatas: metadata ? [metadata] : undefined,
            });
        });
    }
    async deleteVector(id) {
        this.ensureInitialized();
        await this.executeTransaction('deleteVector', async () => {
            await this.collection.delete({ ids: [id] });
        });
    }
    async getVectorCount() {
        this.ensureInitialized();
        return this.executeTransaction('getVectorCount', async () => {
            return this.collection ? this.collection.count() : 0;
        });
    }
    async shutdown() {
        await this.executeTransaction('shutdown', async () => {
            if (this.initialized) {
                Logger_1.Logger.info('🔌 关闭 Chroma向量数据库');
                this.initialized = false;
                Logger_1.Logger.info('✅ Chroma向量数据库关闭完成');
            }
        });
    }
}
exports.ChromaVectorDatabase = ChromaVectorDatabase;
