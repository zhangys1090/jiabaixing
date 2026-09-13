"use strict";
/**
 * 持久化向量数据库
 * 使用 SQLite + better-sqlite3 实现向量持久化存储，支持跨会话记忆
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
exports.PersistentVectorDatabase = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
const BaseMemoryStore_1 = require("./BaseMemoryStore");
/**
 * 持久化向量数据库实现
 * 使用 SQLite 存储向量，重启后数据不丢失
 */
class PersistentVectorDatabase extends BaseMemoryStore_1.BaseMemoryStore {
    db = null;
    dbPath;
    vectorCache = new Map();
    constructor(dataDir = './data') {
        super({ enableOperationLogging: true, enableErrorRetry: false });
        this.dbPath = path.join(dataDir, 'vectors.db');
    }
    getStoreName() {
        return '持久化向量数据库';
    }
    async initialize() {
        await this.executeTransaction('initialize', async () => {
            const dataDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            this.db = (0, DatabaseShim_1.createDatabase)(this.dbPath);
            if (this.db) {
                try {
                    this.db.pragma('journal_mode = WAL');
                }
                catch { }
                try {
                    this.db.pragma('synchronous = NORMAL');
                }
                catch { }
                this.db.exec(`
          CREATE TABLE IF NOT EXISTS vectors (
            id TEXT PRIMARY KEY,
            vector TEXT NOT NULL,
            metadata TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
          );
          CREATE INDEX IF NOT EXISTS idx_vectors_created ON vectors(created_at);
        `);
                this.loadVectorCache();
                this.initialized = true;
                Logger_1.Logger.info(`✅ 持久化向量数据库初始化成功 - 已加载 ${this.vectorCache.size} 个向量`, 'PersistentVectorDatabase');
            }
            else {
                Logger_1.Logger.warn('⚠️ 持久化向量数据库降级为内存模式（仅缓存）', 'PersistentVectorDatabase');
                this.initialized = true;
            }
        });
    }
    async storeVector(id, vector, metadata) {
        this.ensureInitialized();
        await this.executeTransaction('storeVector', async () => {
            const vectorStr = JSON.stringify(vector);
            const metadataStr = metadata ? JSON.stringify(metadata) : null;
            if (!this.db)
                return;
            const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO vectors (id, vector, metadata, updated_at)
        VALUES (?, ?, ?, strftime('%s', 'now'))
      `);
            stmt.run(id, vectorStr, metadataStr);
            this.vectorCache.set(id, { vector, metadata });
        });
    }
    async searchVectors(query, k, filter) {
        this.ensureInitialized();
        return this.executeTransaction('searchVectors', async () => {
            const results = [];
            for (const [id, { vector, metadata }] of this.vectorCache.entries()) {
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
            const vectorStr = JSON.stringify(vector);
            const metadataStr = metadata ? JSON.stringify(metadata) : null;
            if (!this.db)
                return;
            const stmt = this.db.prepare(`
        UPDATE vectors SET vector = ?, metadata = ?, updated_at = strftime('%s', 'now')
        WHERE id = ?
      `);
            stmt.run(vectorStr, metadataStr, id);
            this.vectorCache.set(id, { vector, metadata });
        });
    }
    async deleteVector(id) {
        this.ensureInitialized();
        await this.executeTransaction('deleteVector', async () => {
            if (!this.db)
                return;
            const stmt = this.db.prepare('DELETE FROM vectors WHERE id = ?');
            stmt.run(id);
            this.vectorCache.delete(id);
        });
    }
    async getVectorCount() {
        this.ensureInitialized();
        return this.executeTransaction('getVectorCount', async () => {
            return this.vectorCache.size;
        });
    }
    async shutdown() {
        await this.executeTransaction('shutdown', async () => {
            if (this.db) {
                this.db.close();
                this.db = null;
            }
            this.vectorCache.clear();
            this.initialized = false;
            Logger_1.Logger.info('🔌 持久化向量数据库已关闭', 'PersistentVectorDatabase');
        });
    }
    loadVectorCache() {
        if (!this.db)
            return;
        const rows = this.db
            .prepare('SELECT id, vector, metadata FROM vectors')
            .all();
        for (const row of rows) {
            try {
                const vector = JSON.parse(row.vector);
                const metadata = row.metadata
                    ? JSON.parse(row.metadata)
                    : undefined;
                this.vectorCache.set(row.id, { vector, metadata });
            }
            catch (error) {
                Logger_1.Logger.warn(`⚠️ 加载向量 ${row.id} 失败: ${error.message}`, 'PersistentVectorDatabase');
            }
        }
    }
    cosineSimilarity(vec1, vec2) {
        if (vec1.length !== vec2.length) {
            return 0;
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
exports.PersistentVectorDatabase = PersistentVectorDatabase;
