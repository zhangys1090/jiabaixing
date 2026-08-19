"use strict";
/**
 * P1-2: 情景记忆存储 — 从 Python EpisodicMemoryStore 迁移
 *
 * 存储带有场景(scene)、情绪(emotion)、重要性(importance)等
 * 元数据的情景记忆，支持时间衰减、相关性检索和聚类分析。
 *
 * 迁移自: python/agent/memory/episodic_memory.py
 * 迁移日期: 2026-06-26
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
exports.EpisodicMemoryStore = exports.SceneType = exports.EmotionType = void 0;
const Logger_1 = require("../utils/Logger");
const BaseMemoryStore_1 = require("./BaseMemoryStore");
const LOG_MODULE = 'EpisodicMemoryStore';
const MAX_EPISODES = 500;
const DEFAULT_DECAY_HOURS = 24.0;
const IMPORTANCE_THRESHOLD = 7.0;
var EmotionType;
(function (EmotionType) {
    EmotionType["HAPPY"] = "happy";
    EmotionType["SAD"] = "sad";
    EmotionType["ANGRY"] = "angry";
    EmotionType["FEARFUL"] = "fearful";
    EmotionType["SURPRISED"] = "surprised";
    EmotionType["DISGUSTED"] = "disgusted";
    EmotionType["NEUTRAL"] = "neutral";
    EmotionType["FOCUSED"] = "focused";
    EmotionType["CALM"] = "calm";
})(EmotionType || (exports.EmotionType = EmotionType = {}));
var SceneType;
(function (SceneType) {
    SceneType["DEVELOPMENT"] = "development";
    SceneType["DAILY"] = "daily";
    SceneType["LEARNING"] = "learning";
    SceneType["WORK"] = "work";
    SceneType["SOCIAL"] = "social";
    SceneType["ENTERTAINMENT"] = "entertainment";
    SceneType["OTHER"] = "other";
})(SceneType || (exports.SceneType = SceneType = {}));
function normalizeScene(scene) {
    if (typeof scene === 'string') {
        const lower = scene.toLowerCase();
        return Object.values(SceneType).includes(lower)
            ? lower
            : SceneType.OTHER;
    }
    return scene;
}
function normalizeEmotion(emotion) {
    if (typeof emotion === 'string') {
        const lower = emotion.toLowerCase();
        return Object.values(EmotionType).includes(lower)
            ? lower
            : EmotionType.NEUTRAL;
    }
    return emotion;
}
function generateId() {
    return `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
class EpisodicMemoryStore extends BaseMemoryStore_1.BaseMemoryStore {
    constructor(storagePath = './data/episodic_memory.json') {
        super({
            enableOperationLogging: true,
            enableErrorRetry: true,
            maxRetryAttempts: 2,
        });
        this.episodes = [];
        this.storagePath = storagePath;
    }
    getStoreName() {
        return '情景记忆';
    }
    async initialize() {
        await this.executeTransaction('initialize', async () => {
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                const dataDir = path.dirname(this.storagePath);
                try {
                    await fs.promises.access(dataDir);
                }
                catch (err) {
                    Logger_1.Logger.debug(`情景记忆目录不存在，创建: ${err?.message}`, 'EpisodicMemoryStore');
                    await fs.promises.mkdir(dataDir, { recursive: true });
                }
                try {
                    const data = await fs.promises.readFile(this.storagePath, 'utf-8');
                    const parsed = JSON.parse(data);
                    if (Array.isArray(parsed)) {
                        this.episodes = parsed.map((e) => this.deserializeEpisode(e));
                    }
                }
                catch (err) {
                    Logger_1.Logger.debug(`情景记忆加载失败，使用空数组: ${err?.message}`, 'EpisodicMemoryStore');
                    this.episodes = [];
                }
            }
            catch (error) {
                Logger_1.Logger.warn('Failed to load episodic memory from file', LOG_MODULE, error);
                this.episodes = [];
            }
            this.initialized = true;
            Logger_1.Logger.info('EpisodicMemoryStore initialized', LOG_MODULE, {
                episodeCount: this.episodes.length,
            });
        });
    }
    async shutdown() {
        await this.persist();
        this.initialized = false;
    }
    async store(content, options = {}) {
        this.ensureInitialized();
        const now = Date.now() / 1000;
        const episode = {
            id: generateId(),
            content,
            scene: normalizeScene(options.scene ?? SceneType.OTHER),
            emotion: normalizeEmotion(options.emotion ?? EmotionType.NEUTRAL),
            emotionIntensity: Math.max(0, Math.min(1, options.emotionIntensity ?? 0.5)),
            timestamp: now,
            importance: Math.max(1, Math.min(10, options.importance ?? 5.0)),
            accessCount: 0,
            lastAccessed: now,
            tags: options.tags ?? [],
            metadata: options.metadata ?? {},
            decayScore: 1.0,
        };
        this.episodes.push(episode);
        if (this.episodes.length > MAX_EPISODES) {
            this.cleanupOld();
        }
        Logger_1.Logger.debug('Episode stored', LOG_MODULE, {
            id: episode.id,
            scene: episode.scene,
        });
        await this.persist();
        return episode;
    }
    retrieve(options = {}) {
        this.ensureInitialized();
        const startTime = Date.now();
        const { query = '', scene, emotion, limit = 20, minImportance = 0, since = 0, until = 0, } = options;
        let candidates = [...this.episodes];
        if (scene !== undefined) {
            const normalizedScene = normalizeScene(scene);
            candidates = candidates.filter((e) => e.scene === normalizedScene);
        }
        if (emotion !== undefined) {
            const normalizedEmotion = normalizeEmotion(emotion);
            candidates = candidates.filter((e) => e.emotion === normalizedEmotion);
        }
        if (minImportance > 0) {
            candidates = candidates.filter((e) => e.importance >= minImportance);
        }
        if (since > 0) {
            candidates = candidates.filter((e) => e.timestamp >= since);
        }
        if (until > 0) {
            candidates = candidates.filter((e) => e.timestamp <= until);
        }
        if (query) {
            const queryLower = query.toLowerCase();
            for (const ep of candidates) {
                ep.decayScore = this.calculateRelevance(ep, queryLower);
            }
            candidates.sort((a, b) => b.decayScore - a.decayScore);
        }
        else {
            for (const ep of candidates) {
                ep.decayScore = this.calculateDecayScore(ep);
            }
            candidates.sort((a, b) => b.decayScore - a.decayScore || b.importance - a.importance);
        }
        const resultMemories = candidates.slice(0, limit);
        const now = Date.now() / 1000;
        for (const mem of resultMemories) {
            mem.accessCount += 1;
            mem.lastAccessed = now;
        }
        const elapsed = Date.now() - startTime;
        return {
            memories: resultMemories,
            query,
            totalFound: candidates.length,
            retrievalTimeMs: elapsed,
        };
    }
    getById(memoryId) {
        return this.episodes.find((e) => e.id === memoryId);
    }
    updateImportance(memoryId, delta) {
        const ep = this.getById(memoryId);
        if (!ep)
            return false;
        ep.importance = Math.max(1, Math.min(10, ep.importance + delta));
        Logger_1.Logger.debug('Importance updated', LOG_MODULE, {
            id: memoryId,
            newImportance: ep.importance,
        });
        return true;
    }
    addTag(memoryId, tag) {
        const ep = this.getById(memoryId);
        if (!ep || ep.tags.includes(tag))
            return false;
        ep.tags.push(tag);
        return true;
    }
    delete(memoryId) {
        const originalLen = this.episodes.length;
        this.episodes = this.episodes.filter((e) => e.id !== memoryId);
        return this.episodes.length < originalLen;
    }
    clusterByScene() {
        const groups = new Map();
        for (const ep of this.episodes) {
            const list = groups.get(ep.scene) ?? [];
            list.push(ep);
            groups.set(ep.scene, list);
        }
        const result = new Map();
        for (const [scene, episodes] of groups) {
            const timestamps = episodes.map((e) => e.timestamp);
            const sorted = [...episodes].sort((a, b) => a.timestamp - b.timestamp);
            result.set(scene, {
                scene,
                memories: sorted,
                startTime: timestamps.length > 0 ? Math.min(...timestamps) : 0,
                endTime: timestamps.length > 0 ? Math.max(...timestamps) : 0,
                summary: `${episodes.length} episodes in ${scene}`,
            });
        }
        return result;
    }
    clusterByEmotion() {
        const groups = new Map();
        for (const ep of this.episodes) {
            const list = groups.get(ep.emotion) ?? [];
            list.push(ep);
            groups.set(ep.emotion, list);
        }
        const result = new Map();
        for (const [emotion, episodes] of groups) {
            const timestamps = episodes.map((e) => e.timestamp);
            const sorted = [...episodes].sort((a, b) => a.timestamp - b.timestamp);
            result.set(emotion, {
                scene: SceneType.OTHER,
                emotion,
                memories: sorted,
                startTime: timestamps.length > 0 ? Math.min(...timestamps) : 0,
                endTime: timestamps.length > 0 ? Math.max(...timestamps) : 0,
                summary: `${episodes.length} episodes with ${emotion}`,
            });
        }
        return result;
    }
    getRecent(limit = 10) {
        return [...this.episodes]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }
    getImportant(limit = 10) {
        return this.episodes
            .filter((e) => e.importance >= IMPORTANCE_THRESHOLD)
            .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
            .slice(0, limit);
    }
    getStats() {
        const scenes = {};
        const emotions = {};
        for (const ep of this.episodes) {
            scenes[ep.scene] = (scenes[ep.scene] ?? 0) + 1;
            emotions[ep.emotion] = (emotions[ep.emotion] ?? 0) + 1;
        }
        const totalAccess = this.episodes.reduce((sum, e) => sum + e.accessCount, 0);
        const avgImportance = this.episodes.length > 0
            ? this.episodes.reduce((sum, e) => sum + e.importance, 0) /
                this.episodes.length
            : 0;
        return {
            totalEpisodes: this.episodes.length,
            scenes,
            emotions,
            avgImportance: Math.round(avgImportance * 100) / 100,
            totalAccessCount: totalAccess,
            importantCount: this.episodes.filter((e) => e.importance >= IMPORTANCE_THRESHOLD).length,
        };
    }
    calculateRelevance(episode, queryLower) {
        const contentLower = episode.content.toLowerCase();
        const exactMatch = contentLower.includes(queryLower) ? 1.0 : 0.0;
        const queryWords = new Set(queryLower.split(/\s+/));
        const contentWords = new Set(contentLower.split(/\s+/));
        const wordOverlap = queryWords.size > 0
            ? [...queryWords].filter((w) => contentWords.has(w)).length /
                queryWords.size
            : 0;
        const tagMatch = episode.tags.some((tag) => tag.toLowerCase().includes(queryLower));
        const relevance = (exactMatch * 0.5 + wordOverlap * 0.3 + (tagMatch ? 0.2 : 0)) *
            (episode.importance / 10.0);
        const decay = this.calculateDecayScore(episode);
        return relevance * decay;
    }
    calculateDecayScore(episode) {
        const now = Date.now() / 1000;
        const hoursSince = (now - episode.timestamp) / 3600;
        const timeDecay = 1.0 / (1.0 + hoursSince / DEFAULT_DECAY_HOURS);
        const accessBoost = 1.0 + episode.accessCount * 0.05;
        const importanceFactor = episode.importance / 10.0;
        return timeDecay * accessBoost * importanceFactor;
    }
    cleanupOld() {
        for (const ep of this.episodes) {
            ep.decayScore = this.calculateDecayScore(ep);
        }
        this.episodes.sort((a, b) => a.decayScore - b.decayScore);
        const toRemove = this.episodes.length - MAX_EPISODES;
        if (toRemove > 0) {
            this.episodes = this.episodes.slice(toRemove);
            Logger_1.Logger.info('Old episodes cleaned', LOG_MODULE, { count: toRemove });
        }
    }
    async persist() {
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs')));
            const data = JSON.stringify(this.episodes.map((e) => this.serializeEpisode(e)), null, 2);
            await fs.promises.writeFile(this.storagePath, data, 'utf-8');
        }
        catch (error) {
            Logger_1.Logger.warn('Failed to persist episodic memory', LOG_MODULE, error);
        }
    }
    serializeEpisode(ep) {
        return {
            id: ep.id,
            content: ep.content,
            scene: ep.scene,
            emotion: ep.emotion,
            emotionIntensity: ep.emotionIntensity,
            timestamp: ep.timestamp,
            importance: ep.importance,
            accessCount: ep.accessCount,
            lastAccessed: ep.lastAccessed,
            tags: ep.tags,
            metadata: ep.metadata,
            decayScore: ep.decayScore,
        };
    }
    deserializeEpisode(data) {
        return {
            id: data.id ?? generateId(),
            content: data.content ?? '',
            scene: normalizeScene(data.scene ?? SceneType.OTHER),
            emotion: normalizeEmotion(data.emotion ?? EmotionType.NEUTRAL),
            emotionIntensity: data.emotionIntensity ?? 0.5,
            timestamp: data.timestamp ?? 0,
            importance: data.importance ?? 5.0,
            accessCount: data.accessCount ?? 0,
            lastAccessed: data.lastAccessed ?? 0,
            tags: data.tags ?? [],
            metadata: data.metadata ?? {},
            decayScore: data.decayScore ?? 1.0,
        };
    }
}
exports.EpisodicMemoryStore = EpisodicMemoryStore;
