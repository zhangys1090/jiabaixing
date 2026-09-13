"use strict";
/**
 * 短期记忆（近端记忆）
 * 存储最近30天的所有对话、任务执行记录、用户行为日志、工具调用结果
 * 使用文件系统存储，带写入队列防并发
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
exports.ShortTermMemory = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const FileSystem_1 = require("../io/FileSystem");
const Logger_1 = require("../utils/Logger");
const BaseMemoryStore_1 = require("./BaseMemoryStore");
const ChineseTokenizer_1 = require("./ChineseTokenizer");
const MemoryEngine_1 = require("./MemoryEngine");
const fileSystem = new FileSystem_1.FileSystem();
/**
 * @deprecated 短期记忆核心逻辑已迁移至 Python agent/memory (AGENTS.md §0.1)。
 * 本类仅保留为类型契约/本地回退存根，不再由生产代码实例化。运行时走 Python。
 */
const deprecationWarning_1 = require("../shared/deprecationWarning");
(0, deprecationWarning_1.emitDeprecationWarning)('ShortTermMemory', 'Python MemoryEngine (AGENT_BACKEND=python)', 'V6.0');
class ShortTermMemory extends BaseMemoryStore_1.BaseMemoryStore {
    storagePath;
    memories = [];
    writeQueue = Promise.resolve();
    static MAX_MEMORIES = 5000;
    constructor(storagePath = './data/short_term_memory.json') {
        super({
            enableOperationLogging: true,
            enableErrorRetry: true,
            maxRetryAttempts: 2,
        });
        this.storagePath = storagePath;
    }
    getStoreName() {
        return '短期记忆';
    }
    async initialize() {
        await this.executeTransaction('initialize', async () => {
            const dataDir = path.dirname(this.storagePath);
            await fileSystem.exists(dataDir).then(async (exists) => {
                if (!exists) {
                    await fs.promises.mkdir(dataDir, { recursive: true });
                }
            });
            const exists = await fileSystem.exists(this.storagePath);
            if (exists) {
                const data = await fileSystem.readFile(this.storagePath);
                this.memories = JSON.parse(data);
            }
            this.initialized = true;
        });
    }
    async store(content, scene, emotion) {
        this.ensureInitialized();
        const memoryItem = {
            id: `short_term_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            type: MemoryEngine_1.MemoryType.SHORT_TERM,
            content,
            timestamp: new Date(),
            scene,
            emotion,
        };
        await this.executeTransaction('store', async () => {
            this.memories.push(memoryItem);
            if (this.memories.length > ShortTermMemory.MAX_MEMORIES) {
                this.memories = this.memories.slice(-ShortTermMemory.MAX_MEMORIES);
            }
            this.enqueueSave();
        });
        return memoryItem;
    }
    async retrieve(query, requirements) {
        this.ensureInitialized();
        return this.executeTransaction('retrieve', async () => {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            let filteredMemories = this.memories.filter((memory) => {
                const memoryDate = new Date(memory.timestamp);
                return memoryDate >= thirtyDaysAgo;
            });
            if (query) {
                const queryTokens = ChineseTokenizer_1.ChineseTokenizer.tokenize(query);
                if (queryTokens.length > 0) {
                    filteredMemories = filteredMemories.filter((memory) => {
                        const contentStr = typeof memory.content === 'string'
                            ? memory.content
                            : JSON.stringify(memory.content);
                        const contentTokens = ChineseTokenizer_1.ChineseTokenizer.tokenize(contentStr);
                        const queryTokenSet = new Set(queryTokens);
                        const matchCount = contentTokens.filter((t) => queryTokenSet.has(t)).length;
                        return matchCount > 0;
                    });
                    filteredMemories.sort((a, b) => {
                        const contentStrA = typeof a.content === 'string'
                            ? a.content
                            : JSON.stringify(a.content);
                        const contentStrB = typeof b.content === 'string'
                            ? b.content
                            : JSON.stringify(b.content);
                        const tokensA = ChineseTokenizer_1.ChineseTokenizer.tokenize(contentStrA);
                        const tokensB = ChineseTokenizer_1.ChineseTokenizer.tokenize(contentStrB);
                        const queryTokenSet = new Set(queryTokens);
                        const matchA = tokensA.filter((t) => queryTokenSet.has(t)).length;
                        const matchB = tokensB.filter((t) => queryTokenSet.has(t)).length;
                        return matchB - matchA;
                    });
                }
                else {
                    const queryLower = query.toLowerCase();
                    filteredMemories = filteredMemories.filter((memory) => {
                        const contentStr = JSON.stringify(memory.content).toLowerCase();
                        return contentStr.includes(queryLower);
                    });
                }
            }
            for (const req of requirements) {
                filteredMemories = filteredMemories.filter((memory) => {
                    const contentStr = JSON.stringify(memory.content).toLowerCase();
                    return (contentStr.includes(req.toLowerCase()) ||
                        (memory.scene && memory.scene.includes(req)) ||
                        (memory.emotion && memory.emotion.includes(req)));
                });
            }
            return filteredMemories.slice(0, 10);
        }).catch(() => []);
    }
    async retrieveByEmotionAndScene(emotionType, sceneType) {
        this.ensureInitialized();
        return this.executeTransaction('retrieveByEmotionAndScene', async () => {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            let filteredMemories = this.memories.filter((memory) => {
                const memoryDate = new Date(memory.timestamp);
                return memoryDate >= thirtyDaysAgo;
            });
            if (emotionType) {
                filteredMemories = filteredMemories.filter((memory) => memory.emotion === emotionType);
            }
            if (sceneType) {
                filteredMemories = filteredMemories.filter((memory) => memory.scene === sceneType);
            }
            filteredMemories.sort((a, b) => {
                const dateA = new Date(a.timestamp).getTime();
                const dateB = new Date(b.timestamp).getTime();
                return dateB - dateA;
            });
            return filteredMemories.slice(0, 10);
        }).catch(() => []);
    }
    async save() {
        this.ensureInitialized();
        await this.executeTransaction('save', async () => {
            await this.cleanupExpired();
            await fileSystem.writeFile(this.storagePath, JSON.stringify(this.memories, null, 2));
        });
    }
    enqueueSave() {
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                await this.cleanupExpired();
                await fileSystem.writeFile(this.storagePath, JSON.stringify(this.memories, null, 2));
            }
            catch (error) {
                Logger_1.Logger.error('短期记忆写入失败', error, 'ShortTermMemory');
            }
        });
    }
    async cleanupExpired() {
        this.ensureInitialized();
        await this.executeTransaction('cleanupExpired', async () => {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            const initialCount = this.memories.length;
            this.memories = this.memories.filter((memory) => {
                const memoryDate = new Date(memory.timestamp);
                return memoryDate >= thirtyDaysAgo;
            });
            const deletedCount = initialCount - this.memories.length;
            if (deletedCount > 0) {
                void deletedCount;
            }
        });
    }
    async shutdown() {
        await this.executeTransaction('shutdown', async () => {
            await this.writeQueue;
            await this.save();
            this.initialized = false;
        });
    }
    /** 获取所有记忆项的副本 */
    getAll() {
        return [...this.memories];
    }
    async getRecentConversations(limit = 50) {
        this.ensureInitialized();
        return this.executeTransaction('getRecentConversations', async () => {
            const conversationMemories = this.memories
                .filter((memory) => {
                const contentStr = typeof memory.content === 'string'
                    ? memory.content
                    : JSON.stringify(memory.content);
                return (contentStr.includes('user_input') ||
                    contentStr.includes('response') ||
                    contentStr.includes('message') ||
                    memory.scene === 'chat' ||
                    memory.scene === 'daily');
            })
                .sort((a, b) => {
                const dateA = new Date(a.timestamp).getTime();
                const dateB = new Date(b.timestamp).getTime();
                return dateB - dateA;
            })
                .slice(0, limit);
            return conversationMemories;
        }).catch(() => []);
    }
}
exports.ShortTermMemory = ShortTermMemory;
