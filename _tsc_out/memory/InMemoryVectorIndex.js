"use strict";
/**
 * 内存向量索引实现（作为备用）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryVectorIndex = void 0;
const Logger_1 = require("../utils/Logger");
const BaseMemoryStore_1 = require("./BaseMemoryStore");
class InMemoryVectorIndex extends BaseMemoryStore_1.BaseMemoryStore {
    vectors = new Map();
    constructor() {
        super({ enableOperationLogging: true, enableErrorRetry: false });
    }
    getStoreName() {
        return '内存向量索引';
    }
    async initialize() {
        await this.executeTransaction('initialize', async () => {
            this.initialized = true;
            Logger_1.Logger.info('✅ 内存向量索引初始化成功');
        });
    }
    async storeVector(id, vector, metadata) {
        this.ensureInitialized();
        await this.executeTransaction('storeVector', async () => {
            this.vectors.set(id, { vector, metadata });
        });
    }
    async searchVectors(query, k, filter) {
        this.ensureInitialized();
        return this.executeTransaction('searchVectors', async () => {
            const results = [];
            for (const [id, { vector, metadata }] of this.vectors.entries()) {
                if (filter) {
                    let match = true;
                    for (const [key, value] of Object.entries(filter)) {
                        if (metadata && metadata[key] !== value) {
                            match = false;
                            break;
                        }
                    }
                    if (!match)
                        continue;
                }
                const similarity = this.cosineSimilarity(vector, query);
                results.push({ id, similarity, metadata });
            }
            results.sort((a, b) => b.similarity - a.similarity);
            return results.slice(0, k);
        });
    }
    async updateVector(id, vector, metadata) {
        this.ensureInitialized();
        await this.executeTransaction('updateVector', async () => {
            this.vectors.set(id, { vector, metadata });
        });
    }
    async deleteVector(id) {
        this.ensureInitialized();
        await this.executeTransaction('deleteVector', async () => {
            this.vectors.delete(id);
        });
    }
    async getVectorCount() {
        this.ensureInitialized();
        return this.executeTransaction('getVectorCount', async () => {
            return this.vectors.size;
        });
    }
    async shutdown() {
        await this.executeTransaction('shutdown', async () => {
            if (this.initialized) {
                Logger_1.Logger.info('🔌 关闭内存向量索引');
                this.vectors.clear();
                this.initialized = false;
                Logger_1.Logger.info('✅ 内存向量索引关闭完成');
            }
        });
    }
    cosineSimilarity(vec1, vec2) {
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
exports.InMemoryVectorIndex = InMemoryVectorIndex;
