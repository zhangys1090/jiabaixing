/**
 * 语义相似度计算引擎
 * 实现高级语义相似度计算，支持向量相似度检索
 */

import { MemoryItem, MemoryType } from './MemoryEngine';

export interface SemanticVector {
  id: string;
  vector: number[];
  memoryId: string;
  memoryType: MemoryType;
  timestamp: Date;
  metadata: {
    text: string;
    scene?: string;
    emotion?: string;
    tags?: string[];
  };
}

export interface SimilarityResult {
  memory: MemoryItem;
  similarity: number;
  semanticScore: number;
  keywordScore: number;
  contextualScore: number;
  combinedScore: number;
  explanation: string[];
}

export interface SemanticSearchOptions {
  topK?: number;
  threshold?: number;
  memoryTypes?: MemoryType[];
  scenes?: string[];
  emotions?: string[];
  recencyWeight?: number; // 时间权重 0-1
  semanticWeight?: number; // 语义权重 0-1
  keywordWeight?: number; // 关键词权重 0-1
}

export class SemanticSimilarityEngine {
  private vectors: Map<string, SemanticVector> = new Map();
  private vectorDimension = 384; // 标准sentence-transformers维度
  private embeddingCache: Map<string, number[]> = new Map();
  private maxCacheSize = 1000;
  private usePreTrainedModel = false; // 实际应用中应设置为true

  /**
   * 初始化语义相似度引擎
   */
  async initialize(): Promise<void> {
    console.log('🔍 语义相似度引擎：初始化中...');

    try {
      // 实际应用中应加载预训练模型
      // this.model = await loadModel('sentence-transformers/all-MiniLM-L6-v2');

      // 模拟模型加载
      await new Promise((resolve) => setTimeout(resolve, 1000));

      this.usePreTrainedModel = true;
      console.log('✅ 语义相似度引擎：初始化完成');
    } catch (error) {
      console.error('❌ 语义相似度引擎初始化失败：', error);
      // 失败时回退到基础实现
      this.usePreTrainedModel = false;
      console.log('⚠️  语义相似度引擎：回退到基础实现');
    }
  }

  /**
   * 生成文本的语义向量
   */
  async generateVector(text: string): Promise<number[]> {
    // 检查缓存
    if (this.embeddingCache.has(text)) {
      return this.embeddingCache.get(text)!;
    }

    let vector: number[];

    if (this.usePreTrainedModel) {
      // 实际应用中使用预训练模型
      // vector = await this.model.encode(text);
      vector = this.generateMockVector(text);
    } else {
      // 基础实现：基于词频和语义特征
      vector = this.generateBasicVector(text);
    }

    // 归一化向量
    vector = this.normalizeVector(vector);

    // 缓存结果
    this.cacheEmbedding(text, vector);

    return vector;
  }

  /**
   * 存储记忆的语义向量
   */
  async storeVector(memory: MemoryItem): Promise<SemanticVector> {
    const text = this.extractMemoryText(memory);
    const vector = await this.generateVector(text);

    const semanticVector: SemanticVector = {
      id: `vec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      vector,
      memoryId: memory.id,
      memoryType: memory.type,
      timestamp: new Date(),
      metadata: {
        text,
        scene: memory.scene,
        emotion: memory.emotion,
        tags: this.extractTags(memory),
      },
    };

    this.vectors.set(memory.id, semanticVector);
    return semanticVector;
  }

  /**
   * 批量存储记忆向量
   */
  async batchStoreVectors(memories: MemoryItem[]): Promise<void> {
    for (const memory of memories) {
      await this.storeVector(memory);
    }
  }

  /**
   * 计算查询与记忆的相似度
   */
  async computeSimilarity(
    query: string,
    memories: MemoryItem[]
  ): Promise<SimilarityResult[]> {
    const queryVector = await this.generateVector(query);
    const queryWords = this.tokenize(query);
    const queryScenes = this.extractScenesFromText(query);
    const queryEmotions = this.extractEmotionsFromText(query);

    const results: SimilarityResult[] = [];

    for (const memory of memories) {
      const storedVector = this.vectors.get(memory.id);

      // 计算语义相似度
      let semanticScore = 0;
      if (storedVector) {
        semanticScore = this.cosineSimilarity(queryVector, storedVector.vector);
      } else {
        // 如果没有预存储的向量，实时生成
        const memoryText = this.extractMemoryText(memory);
        const memoryVector = await this.generateVector(memoryText);
        semanticScore = this.cosineSimilarity(queryVector, memoryVector);
      }

      // 计算关键词匹配分数
      const keywordScore = this.calculateKeywordScore(queryWords, memory);

      // 计算上下文相关性分数
      const contextualScore = this.calculateContextualScore(
        { scenes: queryScenes, emotions: queryEmotions },
        memory
      );

      // 计算时间权重
      const recencyScore = this.calculateRecencyScore(memory);

      // 综合分数
      const combinedScore = this.calculateCombinedScore(
        semanticScore,
        keywordScore,
        contextualScore,
        recencyScore
      );

      // 生成解释
      const explanation = this.generateExplanation(
        semanticScore,
        keywordScore,
        contextualScore,
        recencyScore,
        memory
      );

      results.push({
        memory,
        similarity: combinedScore,
        semanticScore,
        keywordScore,
        contextualScore,
        combinedScore,
        explanation,
      });
    }

    // 按综合分数排序
    return results.sort((a, b) => b.combinedScore - a.combinedScore);
  }

  /**
   * 语义搜索
   */
  async search(
    query: string,
    memories: MemoryItem[],
    options: SemanticSearchOptions = {}
  ): Promise<MemoryItem[]> {
    const {
      topK = 5,
      threshold = 0.3,
      memoryTypes,
      scenes,
      emotions,
    } = options;

    // 过滤记忆
    let filteredMemories = memories;

    if (memoryTypes && memoryTypes.length > 0) {
      filteredMemories = filteredMemories.filter((m) =>
        memoryTypes.includes(m.type)
      );
    }

    if (scenes && scenes.length > 0) {
      filteredMemories = filteredMemories.filter(
        (m) => m.scene && scenes.includes(m.scene)
      );
    }

    if (emotions && emotions.length > 0) {
      filteredMemories = filteredMemories.filter(
        (m) => m.emotion && emotions.includes(m.emotion)
      );
    }

    // 计算相似度
    const results = await this.computeSimilarity(query, filteredMemories);

    // 过滤并返回结果
    return results
      .filter((result) => result.combinedScore >= threshold)
      .slice(0, topK)
      .map((result) => result.memory);
  }

  /**
   * 计算两个向量的余弦相似度
   */
  private cosineSimilarity(vec1: number[], vec2: number[]): number {
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

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * 归一化向量
   */
  private normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return magnitude === 0 ? vector : vector.map((v) => v / magnitude);
  }

  /**
   * 计算关键词匹配分数
   */
  private calculateKeywordScore(
    queryWords: string[],
    memory: MemoryItem
  ): number {
    const memoryText = this.extractMemoryText(memory);
    const memoryWords = this.tokenize(memoryText);

    if (queryWords.length === 0) return 0;

    // Jaccard相似度
    const querySet = new Set(queryWords);
    const memorySet = new Set(memoryWords);
    const intersection = new Set(
      [...querySet].filter((word) => memorySet.has(word))
    );
    const union = new Set([...querySet, ...memorySet]);

    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * 计算上下文相关性分数
   */
  private calculateContextualScore(
    queryContext: { scenes: string[]; emotions: string[] },
    memory: MemoryItem
  ): number {
    let score = 0.5; // 基础分数

    // 场景匹配
    if (queryContext.scenes.length > 0 && memory.scene) {
      const sceneMatch = queryContext.scenes.some(
        (scene) =>
          memory.scene!.toLowerCase().includes(scene.toLowerCase()) ||
          scene.toLowerCase().includes(memory.scene!.toLowerCase())
      );
      if (sceneMatch) score += 0.3;
    }

    // 情绪匹配
    if (queryContext.emotions.length > 0 && memory.emotion) {
      const emotionMatch = queryContext.emotions.some(
        (emotion) =>
          memory.emotion!.toLowerCase().includes(emotion.toLowerCase()) ||
          emotion.toLowerCase().includes(memory.emotion!.toLowerCase())
      );
      if (emotionMatch) score += 0.2;
    }

    return Math.min(1, score);
  }

  /**
   * 计算时间权重分数
   */
  private calculateRecencyScore(memory: MemoryItem): number {
    const now = new Date();
    const memoryTime = memory.timestamp;
    const ageInHours =
      (now.getTime() - memoryTime.getTime()) / (1000 * 60 * 60);

    // 时间衰减函数
    if (ageInHours < 1) return 1; // 1小时内
    if (ageInHours < 24) return 0.9; // 1天内
    if (ageInHours < 72) return 0.7; // 3天内
    if (ageInHours < 168) return 0.5; // 1周内
    if (ageInHours < 720) return 0.3; // 1个月内
    return 0.1; // 1个月以上
  }

  /**
   * 计算综合分数
   */
  private calculateCombinedScore(
    semanticScore: number,
    keywordScore: number,
    contextualScore: number,
    recencyScore: number
  ): number {
    // 权重分配
    const semanticWeight = 0.4;
    const keywordWeight = 0.2;
    const contextualWeight = 0.2;
    const recencyWeight = 0.2;

    return (
      semanticScore * semanticWeight +
      keywordScore * keywordWeight +
      contextualScore * contextualWeight +
      recencyScore * recencyWeight
    );
  }

  /**
   * 生成相似度解释
   */
  private generateExplanation(
    semanticScore: number,
    keywordScore: number,
    contextualScore: number,
    recencyScore: number,
    _memory: MemoryItem
  ): string[] {
    const explanations: string[] = [];

    if (semanticScore > 0.7) {
      explanations.push('语义内容高度相关');
    } else if (semanticScore > 0.4) {
      explanations.push('语义内容部分相关');
    }

    if (keywordScore > 0.6) {
      explanations.push('包含多个匹配关键词');
    }

    if (contextualScore > 0.7) {
      explanations.push('场景和情绪匹配度高');
    }

    if (recencyScore > 0.8) {
      explanations.push('近期记忆，相关性高');
    }

    return explanations;
  }

  /**
   * 提取记忆文本
   */
  private extractMemoryText(memory: MemoryItem): string {
    if (typeof memory.content === 'string') {
      return memory.content;
    }
    if (typeof memory.content === 'object') {
      return JSON.stringify(memory.content);
    }
    return '';
  }

  /**
   * 分词
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1);
  }

  /**
   * 从文本中提取场景
   */
  private extractScenesFromText(text: string): string[] {
    const sceneKeywords = [
      '工作',
      '学习',
      '娱乐',
      '休息',
      '运动',
      '购物',
      '社交',
      '家庭',
      '旅行',
      '会议',
    ];
    const lowerText = text.toLowerCase();

    return sceneKeywords.filter((keyword) =>
      lowerText.includes(keyword.toLowerCase())
    );
  }

  /**
   * 从文本中提取情绪
   */
  private extractEmotionsFromText(text: string): string[] {
    const emotionKeywords = [
      '开心',
      '高兴',
      '快乐',
      '悲伤',
      '难过',
      '愤怒',
      '生气',
      '平静',
      '紧张',
      '焦虑',
    ];
    const lowerText = text.toLowerCase();

    return emotionKeywords.filter((keyword) =>
      lowerText.includes(keyword.toLowerCase())
    );
  }

  /**
   * 提取记忆标签
   */
  private extractTags(memory: MemoryItem): string[] {
    const tags: string[] = [];

    if (memory.scene) tags.push(memory.scene);
    if (memory.emotion) tags.push(memory.emotion);

    // 从内容中提取标签
    const contentText = this.extractMemoryText(memory);
    const contentWords = this.tokenize(contentText);

    // 提取高频词作为标签
    const wordCount = new Map<string, number>();
    contentWords.forEach((word) => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });

    const topWords = Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    return [...tags, ...topWords];
  }

  /**
   * 缓存嵌入向量
   */
  private cacheEmbedding(text: string, vector: number[]): void {
    if (this.embeddingCache.size >= this.maxCacheSize) {
      // 移除最旧的缓存
      const oldestKey = this.embeddingCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.embeddingCache.delete(oldestKey);
      }
    }
    this.embeddingCache.set(text, vector);
  }

  /**
   * 生成模拟向量（用于演示）
   */
  private generateMockVector(text: string): number[] {
    const vector = new Array(this.vectorDimension).fill(0);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < vector.length; i++) {
      const wordIndex = i % words.length;
      const word = words[wordIndex] || '';
      vector[i] = (word.charCodeAt(0) / 255) * Math.sin(i * 0.1);
    }

    return vector;
  }

  /**
   * 生成基础向量（无预训练模型时使用）
   */
  private generateBasicVector(text: string): number[] {
    const vector = new Array(128).fill(0); // 简化维度
    const words = this.tokenize(text);

    // 基于词频和位置生成向量
    words.forEach((word, index) => {
      const wordHash = word.split('').reduce((hash, char) => {
        return hash * 31 + char.charCodeAt(0);
      }, 0);

      const vectorIndex = Math.abs(wordHash) % vector.length;
      vector[vectorIndex] += 1 / (index + 1); // 位置越靠前权重越高
    });

    return vector;
  }

  /**
   * 清除向量缓存
   */
  clearVectors(): void {
    this.vectors.clear();
    this.embeddingCache.clear();
  }

  /**
   * 获取向量统计信息
   */
  getVectorStatistics(): {
    totalVectors: number;
    cacheSize: number;
    memoryTypeDistribution: { [key: string]: number };
  } {
    const memoryTypeDistribution: { [key: string]: number } = {};

    this.vectors.forEach((vector) => {
      const type = vector.memoryType;
      memoryTypeDistribution[type] = (memoryTypeDistribution[type] || 0) + 1;
    });

    return {
      totalVectors: this.vectors.size,
      cacheSize: this.embeddingCache.size,
      memoryTypeDistribution,
    };
  }

  /**
   * 同步生成文本的语义向量（用于嵌入函数注入场景）
   * 使用基础词频向量，无需异步模型调用
   */
  generateVectorSync(text: string): number[] {
    if (this.embeddingCache.has(text)) {
      return this.embeddingCache.get(text)!;
    }
    const vector = this.generateBasicVector(text);
    const normalized = this.normalizeVector(vector);
    this.cacheEmbedding(text, normalized);
    return normalized;
  }
}

export default SemanticSimilarityEngine;
