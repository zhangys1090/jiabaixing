"use strict";
/**
 * LLM 上下文构建器 - 上下文系统辅助组件
 *
 * 【架构定位】
 * 上下文系统辅助组件，被 UnifiedContextPipeline 调用
 *
 * 【核心职责】
 * - 智能记忆筛选：根据相关性、重要性、时效性等多维度评分
 * - 相关性排序：按综合得分排序记忆
 * - 记忆去重：自动去除重复或高度相似的记忆
 * - 记忆压缩：对长记忆进行智能压缩，节省 Token
 * - 场景感知权重：根据场景动态调整记忆权重
 *
 * 【在整体架构中的位置】
 * UnifiedContextPipeline → LLMContextBuilder（本文件）→ MemoryEngine
 *
 * 【使用场景】
 * - 记忆检索后的智能筛选
 * - 上下文构建时的记忆优化
 * - 确保给 LLM 的记忆最相关、最精炼
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMContextBuilder = void 0;
const Logger_1 = require("../utils/Logger");
const ChineseTokenizer_1 = require("./ChineseTokenizer");
/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
    maxMemories: 8,
    minRelevance: 0.15,
    maxTotalLength: 2000,
    enableDeduplication: true,
    enableCompression: true,
    sceneWeights: {
        development: 1.3,
        work: 1.2,
        comfort: 1.4,
        greeting: 0.8,
        celebration: 1.1,
        daily: 1.0,
        briefing: 1.1,
    },
    typeWeights: {
        instant: 1.2,
        short_term: 1.1,
        long_term: 0.9,
    },
    recencyBoost: 1.0,
    accessBoost: true,
};
/**
 * LLM 上下文构建器
 */
class LLMContextBuilder {
    constructor(config) {
        this.memoryAccessCount = new Map();
        this.MAX_ACCESS_COUNT_KEYS = 10000;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * 构建 LLM 上下文
     * @param query 用户查询
     * @param memories 原始记忆列表
     * @param scene 当前场景
     * @param emotion 当前情绪
     * @returns 构建后的上下文
     */
    buildContext(query, memories, scene = 'daily', emotion = '平静') {
        const startTime = Date.now();
        if (memories.length === 0) {
            return {
                memories: [],
                totalTokens: 0,
                filteredCount: 0,
                deduplicatedCount: 0,
                compressedCount: 0,
                scene,
                emotion,
                buildTimeMs: Date.now() - startTime,
            };
        }
        // 1. 多维度评分
        let scoredMemories = this.scoreMemories(query, memories, scene, emotion);
        // 2. 去重
        let deduplicatedCount = 0;
        if (this.config.enableDeduplication) {
            const beforeCount = scoredMemories.length;
            scoredMemories = this.deduplicateMemories(scoredMemories);
            deduplicatedCount = beforeCount - scoredMemories.length;
        }
        // 3. 筛选
        const filteredCount = scoredMemories.length;
        scoredMemories = scoredMemories
            .filter((sm) => sm.compositeScore >= (this.config.minRelevance || 0.15))
            .sort((a, b) => b.compositeScore - a.compositeScore)
            .slice(0, this.config.maxMemories);
        // 4. 压缩
        let compressedCount = 0;
        if (this.config.enableCompression) {
            const beforeLength = this.estimateTotalLength(scoredMemories);
            scoredMemories = this.compressMemories(scoredMemories);
            const afterLength = this.estimateTotalLength(scoredMemories);
            if (afterLength < beforeLength) {
                compressedCount = scoredMemories.filter((sm) => sm.compressionRatio < 1).length;
            }
        }
        // 5. 确保不超过总长度限制
        scoredMemories = this.enforceLengthLimit(scoredMemories);
        const totalTokens = this.estimateTotalLength(scoredMemories);
        const buildTimeMs = Date.now() - startTime;
        Logger_1.Logger.info(`🧠 上下文构建完成: ${memories.length}→${scoredMemories.length}条 | ` +
            `去重${deduplicatedCount} | 压缩${compressedCount} | ` +
            `${totalTokens}字 | ${buildTimeMs}ms`, 'LLMContextBuilder');
        return {
            memories: scoredMemories,
            totalTokens,
            filteredCount,
            deduplicatedCount,
            compressedCount,
            scene,
            emotion,
            buildTimeMs,
        };
    }
    /**
     * 多维度评分
     */
    scoreMemories(query, memories, scene, emotion) {
        const queryTokens = new Set(ChineseTokenizer_1.ChineseTokenizer.tokenize(query));
        const queryTokenArray = Array.from(queryTokens);
        const _now = Date.now();
        return memories.map((memory) => {
            const memoryText = this.memoryToText(memory);
            const memoryTokens = ChineseTokenizer_1.ChineseTokenizer.tokenize(memoryText);
            // 1. 语义相似度（使用已有的 vectorScore 或 keywordScore）
            const semanticScore = memory.vectorScore || memory.relevanceScore || 0.5;
            // 2. 关键词匹配
            const keywordScore = this.calculateKeywordScore(queryTokenArray, memoryTokens);
            // 3. 时间衰减
            const ageMs = _now - (memory.timestamp?.getTime() || _now);
            const ageHours = ageMs / (1000 * 60 * 60);
            const recencyScore = Math.exp(-ageHours / 168);
            // 4. 上下文匹配（场景 + 情绪）
            let contextualScore = 0.5;
            if (scene && memory.scene) {
                contextualScore += memory.scene === scene ? 0.3 : 0;
            }
            if (emotion && memory.emotion) {
                contextualScore += memory.emotion === emotion ? 0.2 : 0;
            }
            // 5. 访问频率
            let accessScore = 0.5;
            if (this.config.accessBoost) {
                const accessCount = this.memoryAccessCount.get(memory.id) || 0;
                accessScore = Math.min(1, 0.5 + accessCount * 0.05);
            }
            // 6. 场景权重
            const sceneWeight = this.config.sceneWeights?.[memory.scene || ''] || 1.0;
            // 7. 类型权重
            const typeWeight = this.config.typeWeights?.[memory.type] || 1.0;
            // 8. 综合分数
            const compositeScore = semanticScore * 0.35 +
                keywordScore * 0.2 +
                recencyScore * 0.15 * (this.config.recencyBoost || 1) +
                contextualScore * 0.15 +
                accessScore * 0.15;
            const weightedScore = compositeScore * sceneWeight * typeWeight;
            return {
                memory,
                semanticScore,
                keywordScore,
                recencyScore,
                contextualScore,
                accessScore,
                compositeScore: Math.min(1, weightedScore),
                isDuplicate: false,
                compressionRatio: 1,
            };
        });
    }
    /**
     * 计算关键词匹配分数
     */
    calculateKeywordScore(queryTokens, memoryTokens) {
        if (queryTokens.length === 0)
            return 0;
        const querySet = new Set(queryTokens);
        const memorySet = new Set(memoryTokens);
        const intersection = new Set([...querySet].filter((t) => memorySet.has(t)));
        const union = new Set([...querySet, ...memorySet]);
        const jaccard = union.size === 0 ? 0 : intersection.size / union.size;
        // Jaccard + 精确匹配加权
        let exactMatch = 0;
        queryTokens.forEach((t, i) => {
            if (memoryTokens.includes(t)) {
                exactMatch += i < 3 ? 1.5 : 1;
            }
        });
        return Math.min(1, jaccard * 0.6 + (exactMatch / queryTokens.length) * 0.4);
    }
    /**
     * 去重：基于语义相似度合并相似记忆
     */
    deduplicateMemories(scoredMemories) {
        const result = [];
        const seen = new Set();
        for (const sm of scoredMemories.sort((a, b) => b.compositeScore - a.compositeScore)) {
            if (seen.has(sm.memory.id))
                continue;
            // 检查是否与已选记忆过于相似
            let isDuplicate = false;
            const smText = this.memoryToText(sm.memory);
            const smTokens = new Set(ChineseTokenizer_1.ChineseTokenizer.tokenize(smText));
            for (const existing of result) {
                const exText = this.memoryToText(existing.memory);
                const exTokens = new Set(ChineseTokenizer_1.ChineseTokenizer.tokenize(exText));
                const intersection = new Set([...smTokens].filter((t) => exTokens.has(t)));
                const union = new Set([...smTokens, ...exTokens]);
                const similarity = union.size === 0 ? 0 : intersection.size / union.size;
                if (similarity > 0.7) {
                    // 过于相似，合并分数
                    existing.compositeScore = Math.max(existing.compositeScore, sm.compositeScore);
                    existing.isDuplicate = true;
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                seen.add(sm.memory.id);
                result.push(sm);
            }
        }
        return result;
    }
    /**
     * 压缩记忆内容
     */
    compressMemories(scoredMemories) {
        return scoredMemories.map((sm) => {
            const text = this.memoryToText(sm.memory);
            if (text.length <= 100)
                return sm;
            const sentences = text
                .split(/[。！？.!?]/)
                .filter((s) => s.trim().length > 0);
            if (sentences.length <= 2)
                return sm;
            const scoredSentences = sentences.map((sentence, index) => {
                let score = 0;
                if (index === 0)
                    score += 3;
                const hasNumbers = /\d+\.?\d*/.test(sentence);
                if (hasNumbers)
                    score += 2;
                const hasPaths = /[\w/.-]+\/[\w/.-]+/.test(sentence);
                if (hasPaths)
                    score += 2;
                const hasKeywords = /(?:结果|输出|返回|找到|成功|失败|错误|完成|状态|版本|路径|文件名)/.test(sentence);
                if (hasKeywords)
                    score += 2;
                const hasCodeLike = /[`{}()\[\]]/.test(sentence);
                if (hasCodeLike)
                    score += 1;
                const fillerWords = /^(当然|众所周知|需要注意的是|总之|综上|另外|此外|而且)/;
                if (fillerWords.test(sentence.trim()))
                    score -= 2;
                const len = sentence.trim().length;
                if (len < 5)
                    score -= 3;
                else if (len > 10 && len < 80)
                    score += 1;
                return { sentence, score, index };
            });
            scoredSentences.sort((a, b) => b.score - a.score);
            const topCount = Math.min(3, scoredSentences.length);
            const selected = scoredSentences.slice(0, topCount);
            selected.sort((a, b) => a.index - b.index);
            const compressed = selected.map((s) => s.sentence.trim()).join('。') + '。';
            const ratio = compressed.length / text.length;
            return {
                ...sm,
                memory: {
                    ...sm.memory,
                    content: compressed,
                },
                compressionRatio: ratio,
            };
        });
    }
    /**
     * 强制长度限制
     */
    enforceLengthLimit(scoredMemories) {
        const maxLength = this.config.maxTotalLength || 2000;
        let totalLength = 0;
        const result = [];
        for (const sm of scoredMemories) {
            const length = this.memoryToText(sm.memory).length;
            if (totalLength + length > maxLength && result.length >= 3) {
                break; // 至少保留3条
            }
            totalLength += length;
            result.push(sm);
        }
        return result;
    }
    /**
     * 估算总长度
     */
    estimateTotalLength(scoredMemories) {
        return scoredMemories.reduce((sum, sm) => sum + this.memoryToText(sm.memory).length, 0);
    }
    /**
     * 转换记忆为文本
     */
    memoryToText(memory) {
        if (typeof memory.content === 'string')
            return memory.content;
        if (memory.content && typeof memory.content === 'object') {
            const obj = memory.content;
            if (obj.summary && typeof obj.summary === 'string')
                return obj.summary;
            if (obj.input && typeof obj.input === 'string')
                return obj.input;
            return JSON.stringify(memory.content);
        }
        return '';
    }
    /**
     * 更新访问统计
     */
    updateAccessStats(memoryId) {
        const count = (this.memoryAccessCount.get(memoryId) || 0) + 1;
        if (count === 1 && this.memoryAccessCount.size >= this.MAX_ACCESS_COUNT_KEYS) {
            const oldestKey = this.memoryAccessCount.keys().next().value;
            this.memoryAccessCount.delete(oldestKey);
        }
        this.memoryAccessCount.set(memoryId, count);
    }
    /**
     * 将 ScoredMemory 转换为 DialogueGenerator 需要的 MemoryContextItem
     */
    static toMemoryContextItems(scoredMemories) {
        return scoredMemories.map((sm) => ({
            content: typeof sm.memory.content === 'string'
                ? sm.memory.content
                : JSON.stringify(sm.memory.content),
            type: sm.memory.type,
            timestamp: sm.memory.timestamp,
            relevance: sm.compositeScore,
        }));
    }
}
exports.LLMContextBuilder = LLMContextBuilder;
exports.default = LLMContextBuilder;
