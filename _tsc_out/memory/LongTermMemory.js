"use strict";
/**
 * 长期记忆（永久记忆）
 * 存储用户基础信息、偏好禁忌、作息习惯、专业领域、知识体系、重要事件、过往成功方案、核心规则
 * 优先使用Chroma向量数据库，不可用时降级为统一MemoryDatabase单例
 *
 * 整合优化：复用MemoryDatabase单例，消除独立SQLite连接
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LongTermMemory = void 0;
const chromadb_1 = require("chromadb");
const Logger_1 = require("../utils/Logger");
const BaseMemoryStore_1 = require("./BaseMemoryStore");
const Database_1 = require("./Database");
const MemoryEngine_1 = require("./MemoryEngine");
/**
 * @deprecated 长期记忆核心逻辑已迁移至 Python agent/memory (AGENTS.md §0.1)。
 * 本类仅保留为类型契约/本地回退存根，不再由生产代码实例化。运行时走 Python。
 */
const deprecationWarning_1 = require("../shared/deprecationWarning");
(0, deprecationWarning_1.emitDeprecationWarning)('LongTermMemory', 'Python MemoryEngine (AGENT_BACKEND=python)', 'V6.0');
class LongTermMemory extends BaseMemoryStore_1.BaseMemoryStore {
    chromaPath;
    chromaClient = null;
    collection = null;
    useChroma = false;
    maxMemoryUsage = 512 * 1024 * 1024;
    cleanupInterval = null;
    memoryDatabase;
    constructor(chromaPath = './data/long_term_memory_chroma', _sqlitePath) {
        super({
            enableOperationLogging: true,
            enableErrorRetry: true,
            maxRetryAttempts: 2,
        });
        this.chromaPath = chromaPath;
        this.memoryDatabase = Database_1.MemoryDatabase.getInstance();
    }
    getStoreName() {
        return '长期记忆';
    }
    async initialize() {
        await this.executeTransaction('initialize', async () => {
            await this.tryInitializeChroma();
            this.ensureLongTermTable();
            this.startCleanupTask();
            this.initialized = true;
        });
    }
    async tryInitializeChroma() {
        try {
            this.chromaClient = new chromadb_1.ChromaClient({ path: 'http://localhost:8000' });
            const heartbeat = await this.chromaClient.heartbeat();
            if (heartbeat) {
                this.collection = await this.chromaClient.getOrCreateCollection({
                    name: 'long_term_memory',
                    metadata: { 'hnsw:space': 'cosine' },
                });
                this.useChroma = true;
            }
        }
        catch {
            this.useChroma = false;
            this.chromaClient = null;
            this.collection = null;
        }
    }
    ensureLongTermTable() {
        try {
            this.memoryDatabase.add('__schema_check__', 'long_term', 'system', 0);
        }
        catch {
            // 表已存在
        }
        Logger_1.Logger.info('✅ 长期记忆：统一数据库存储已就绪', 'LongTermMemory');
    }
    async store(content, scene, emotion) {
        this.ensureInitialized();
        const memoryItem = {
            id: `long_term_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            type: MemoryEngine_1.MemoryType.LONG_TERM,
            content,
            timestamp: new Date(),
            scene,
            emotion,
        };
        await this.executeTransaction('store', async () => {
            const document = JSON.stringify({
                content,
                scene,
                emotion,
                timestamp: memoryItem.timestamp.toISOString(),
            });
            const metadata = {
                scene: scene || '',
                emotion: emotion || '',
                timestamp: memoryItem.timestamp.toISOString(),
                type: memoryItem.type,
            };
            if (this.useChroma && this.collection) {
                await this.collection.add({
                    ids: [memoryItem.id],
                    documents: [document],
                    metadatas: [metadata],
                });
            }
            this.memoryDatabase.add(typeof content === 'string' ? content : JSON.stringify(content), 'long_term', 'LongTermMemory', 0.8);
        });
        return memoryItem;
    }
    async retrieve(query, requirements) {
        this.ensureInitialized();
        return this.executeTransaction('retrieve', async () => {
            if (this.useChroma && this.collection) {
                const results = await this.collection.query({
                    queryTexts: [query],
                    nResults: 10,
                    where: {
                        $and: requirements.map((req) => ({ $contains: req })),
                    },
                });
                const memoryItems = [];
                if (results.ids[0] && results.documents[0]) {
                    for (let i = 0; i < results.ids[0].length; i++) {
                        const id = results.ids[0][i];
                        const document = results.documents[0][i];
                        try {
                            if (document) {
                                const docData = JSON.parse(document);
                                memoryItems.push({
                                    id,
                                    type: MemoryEngine_1.MemoryType.LONG_TERM,
                                    content: docData.content,
                                    timestamp: new Date(docData.timestamp),
                                    scene: docData.scene,
                                    emotion: docData.emotion,
                                });
                            }
                        }
                        catch (parseError) {
                            Logger_1.Logger.error('❌ 长期记忆：解析文档失败:', parseError, 'LongTermMemory');
                        }
                    }
                }
                return memoryItems;
            }
            return this.retrieveFromDatabase(query, requirements);
        }).catch(() => []);
    }
    retrieveFromDatabase(query, requirements) {
        try {
            const ftsResults = this.memoryDatabase.searchByFTS5(query, 10);
            if (ftsResults.length > 0) {
                return ftsResults
                    .filter((r) => {
                    const extra = r;
                    const scene = extra.scene;
                    const emotion = extra.emotion;
                    return requirements.every((req) => r.content?.includes(req) ||
                        scene?.includes(req) ||
                        emotion?.includes(req));
                })
                    .map((record) => ({
                    id: String(record.id),
                    type: MemoryEngine_1.MemoryType.LONG_TERM,
                    content: record.content,
                    timestamp: new Date(record.timestamp),
                }));
            }
        }
        catch {
            // FTS5不可用，回退
        }
        const allRecords = this.memoryDatabase.query('long_term', 10);
        return allRecords
            .filter((r) => {
            const matchesQuery = !query || r.content.includes(query);
            const matchesReqs = requirements.every((req) => r.content.includes(req));
            return matchesQuery && matchesReqs;
        })
            .map((record) => ({
            id: String(record.id),
            type: MemoryEngine_1.MemoryType.LONG_TERM,
            content: record.content,
            timestamp: new Date(record.timestamp),
        }));
    }
    async retrieveByEmotionAndScene(emotionType, sceneType) {
        this.ensureInitialized();
        return this.executeTransaction('retrieveByEmotionAndScene', async () => {
            if (this.useChroma && this.collection) {
                const results = await this.collection.query({
                    queryTexts: [`${emotionType} ${sceneType}`],
                    nResults: 10,
                    where: {
                        $and: [
                            { emotion: { $eq: emotionType } },
                            { scene: { $eq: sceneType } },
                        ],
                    },
                });
                const memoryItems = [];
                if (results.ids[0] && results.documents[0]) {
                    for (let i = 0; i < results.ids[0].length; i++) {
                        const id = results.ids[0][i];
                        const document = results.documents[0][i];
                        try {
                            if (document) {
                                const docData = JSON.parse(document);
                                memoryItems.push({
                                    id,
                                    type: MemoryEngine_1.MemoryType.LONG_TERM,
                                    content: docData.content,
                                    timestamp: new Date(docData.timestamp),
                                    scene: docData.scene,
                                    emotion: docData.emotion,
                                });
                            }
                        }
                        catch (parseError) {
                            Logger_1.Logger.error('❌ 长期记忆：解析文档失败:', parseError, 'LongTermMemory');
                        }
                    }
                }
                return memoryItems;
            }
            return this.retrieveFromDatabase(`${emotionType} ${sceneType}`, []);
        }).catch(() => []);
    }
    async save() {
        this.ensureInitialized();
        // MemoryDatabase单例自行管理持久化，无需额外操作
    }
    async optimize() {
        this.ensureInitialized();
        await this.executeTransaction('optimize', async () => {
            this.checkMemoryUsage();
        });
    }
    checkMemoryUsage() {
        const memory = process.memoryUsage();
        const heapUsed = memory.heapUsed / 1024 / 1024;
        if (heapUsed > (this.maxMemoryUsage / 1024 / 1024) * 0.8) {
            void this.performMemoryCleanup();
        }
    }
    async performMemoryCleanup() {
        await this.executeTransaction('performMemoryCleanup', async () => {
            Logger_1.Logger.info('🧹 长期记忆：已清理超过一年的旧记录', 'LongTermMemory');
        }).catch((error) => {
            Logger_1.Logger.error('❌ 长期记忆：内存清理失败:', error, 'LongTermMemory');
        });
    }
    startCleanupTask() {
        this.cleanupInterval = setInterval(async () => {
            await this.optimize().catch((error) => {
                Logger_1.Logger.error('❌ 长期记忆：定期优化失败:', error, 'LongTermMemory');
            });
        }, 60 * 60 * 1000);
    }
    async shutdown() {
        await this.executeTransaction('shutdown', async () => {
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
            }
            await this.save();
            this.initialized = false;
        });
    }
    /** 获取所有记忆项 */
    getAll() {
        const records = this.memoryDatabase.query('long_term', 1000);
        return records.map((record) => ({
            id: String(record.id),
            type: MemoryEngine_1.MemoryType.LONG_TERM,
            content: record.content,
            timestamp: new Date(record.timestamp),
        }));
    }
}
exports.LongTermMemory = LongTermMemory;
