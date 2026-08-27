/**
 * MemoryRetriever - 记忆检索与RRF融合
 * 从MemoryEngine拆分出的检索逻辑：
 * 1. 查询向量缓存
 * 2. 热缓存检索
 * 3. 关键词检索（N-gram + 同义词扩展）
 * 4. 向量相似度检索
 * 5. RRF融合算法
 * 6. 权重计算（时间/场景/情感）
 * 7. 访问统计与分层
 */

import Logger from '../utils/Logger';
import { ChineseTokenizer } from './ChineseTokenizer';
import { MemoryDatabase } from './Database';
import { LongTermMemory } from './LongTermMemory';
import { MemoryItem, MemoryTier } from './MemoryEngine';
import { ShortTermMemory } from './ShortTermMemory';

/** 记忆存储接口（支持获取所有记忆项） */
interface MemoryStoreWithGetAll {
  getAll(): MemoryItem[];
}

/** 向量数据库接口 */
export interface VectorDatabase {
  storeVector(
    id: string,
    vector: number[],
    metadata: Record<string, unknown>
  ): Promise<void>;
  searchVectors(
    query: number[],
    topK: number
  ): Promise<{ id: string; similarity: number }[]>;
}

/** 嵌入模型接口 */
export interface SemanticEmbeddingModel {
  embed(text: string): Promise<number[]>;
}

/** 基于LLM的嵌入模型实现 */
export class LLMEmbeddingModel implements SemanticEmbeddingModel {
  private apiKey?: string;
  private baseURL?: string;
  private model: string;
  private cache: Map<string, number[]> = new Map();
  private fallbackToHash: boolean = false;
  private fallbackLogged: boolean = false;

  constructor(config?: { apiKey?: string; baseURL?: string; model?: string }) {
    this.apiKey =
      config?.apiKey ||
      process.env.EMBEDDING_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.LLM_API_KEY;
    this.baseURL =
      config?.baseURL ||
      process.env.EMBEDDING_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      process.env.LLM_BASE_URL;
    this.model =
      config?.model || process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    if (!this.apiKey || this.fallbackToHash) {
      if (!this.fallbackLogged) {
        Logger.info(
          'Embedding 使用 hash-based 向量（无 API Key 或已降级），语义检索精度有限',
          'LLMEmbeddingModel'
        );
        this.fallbackLogged = true;
      }
      return this.hashBasedEmbed(text);
    }

    try {
      const url = `${this.baseURL || 'https://api.openai.com/v1'}/embeddings`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: text.substring(0, 8000),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Embedding API 返回 ${response.status}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const vector = data.data[0].embedding;

      if (this.cache.size > 500) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
      this.cache.set(text, vector);

      return vector;
    } catch (err) {
      this.fallbackToHash = true;
      if (!this.fallbackLogged) {
        Logger.info(
          `Embedding API 不可用 (${(err as Error).message})，已降级到 hash-based 向量，语义检索精度有限`,
          'LLMEmbeddingModel'
        );
        this.fallbackLogged = true;
      }
      return this.hashBasedEmbed(text);
    }
  }

  /**
   * Hash-based 向量（降级方案）
   * 当 embedding API 不可用时使用，仅支持关键词级匹配，无语义理解
   */
  private hashBasedEmbed(text: string): number[] {
    const tokens = ChineseTokenizer.tokenize(text);
    const vectorDim = 256;
    const vector = new Array(vectorDim).fill(0);

    tokens.forEach((token, i) => {
      const hash = this.simpleHash(token) % vectorDim;
      vector[hash] += 1 + (tokens.length - i) / tokens.length;
    });

    // 归一化向量
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      return vector.map((v) => v / norm);
    }
    return vector;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash);
  }
}

export class MemoryRetriever {
  private embeddingModel: SemanticEmbeddingModel;
  private memoryVectors: Map<string, number[]>;
  private hotMemoryCache: Map<string, MemoryItem>;
  private queryVectorCache: Map<
    string,
    { vector: number[]; timestamp: number }
  >;
  private memoryAccessCount: Map<string, number>;
  private memoryLastAccess: Map<string, number>;
  private memoryTierMap: Map<string, MemoryTier>;
  private vectorDatabase: VectorDatabase | null;
  private memoryDatabase: MemoryDatabase | null = null;

  /** 获取即时记忆的回调（避免数组引用失效） */
  private getInstantMemory: () => MemoryItem[];

  /** 分层阈值 */
  private tierThresholds = { hot: 3600, warm: 86400 };

  // 常量
  private readonly QUERY_CACHE_TTL = 5 * 60 * 1000;
  private readonly QUERY_CACHE_MAX_SIZE = 100;
  private readonly HOT_CACHE_MAX_SIZE = 50;

  /** 嵌入批处理队列 */
  private embeddingBatchQueue: Array<{
    memoryItem: MemoryItem;
    resolve: (value: void) => void;
    reject: (reason: Error) => void;
  }> = [];
  private embeddingBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly EMBEDDING_BATCH_SIZE = 10;
  private readonly EMBEDDING_BATCH_DELAY = 100;

  constructor(deps: {
    embeddingModel: SemanticEmbeddingModel;
    memoryVectors: Map<string, number[]>;
    hotMemoryCache: Map<string, MemoryItem>;
    memoryAccessCount: Map<string, number>;
    memoryLastAccess: Map<string, number>;
    memoryTierMap: Map<string, MemoryTier>;
    vectorDatabase: VectorDatabase | null;
    instantMemoryRef: MemoryItem[] | (() => MemoryItem[]);
    queryVectorCache: Map<string, { vector: number[]; timestamp: number }>;
    memoryDatabase?: MemoryDatabase;
  }) {
    this.embeddingModel = deps.embeddingModel;
    this.memoryVectors = deps.memoryVectors;
    this.hotMemoryCache = deps.hotMemoryCache;
    this.memoryAccessCount = deps.memoryAccessCount;
    this.memoryLastAccess = deps.memoryLastAccess;
    this.memoryTierMap = deps.memoryTierMap;
    this.vectorDatabase = deps.vectorDatabase;
    this.memoryDatabase = deps.memoryDatabase || null;
    this.getInstantMemory =
      typeof deps.instantMemoryRef === 'function'
        ? deps.instantMemoryRef
        : () => deps.instantMemoryRef as MemoryItem[];
    this.queryVectorCache = deps.queryVectorCache;
  }

  /** 设置MemoryDatabase引用（P1增强） */
  setMemoryDatabase(mdb: MemoryDatabase | null): void {
    this.memoryDatabase = mdb;
  }

  /** 更新向量数据库引用（initialize后调用） */
  setVectorDatabase(vdb: VectorDatabase | null): void {
    this.vectorDatabase = vdb;
  }

  // ==================== 精确混合检索 v2 ====================

  /**
   * 精确混合检索v3 - P1增强版
   * 步骤：
   * 1. 查询向量缓存
   * 2. 多路召回（含FTS5）
   * 3. RRF融合排序
   */
  async preciseHybridRetrieval(
    query: string,
    scene?: string,
    emotion?: string,
    topK: number = 10,
    shortTermMemory?: ShortTermMemory,
    longTermMemory?: LongTermMemory
  ): Promise<MemoryItem[]> {
    const startTime = Date.now();

    // 1. 查询向量缓存
    const queryEmbedding = await this.getCachedQueryVector(query);

    // 2. 多路召回并行执行（含FTS5）
    const hotResults = this.retrieveFromHotCache(
      query,
      scene,
      emotion,
      Math.ceil(topK * 0.3)
    );

    // 并行执行：关键词、向量、FTS5
    const [keywordResults, vectorResults] = await Promise.all([
      this.keywordRetrieval(
        query,
        scene,
        emotion,
        Math.ceil(topK * 0.6),
        shortTermMemory,
        longTermMemory
      ),
      this.vectorSimilarityRetrieval(
        queryEmbedding,
        Math.ceil(topK * 0.6),
        shortTermMemory,
        longTermMemory
      ),
    ]);
    const fts5Results = this.fts5Retrieval(query, scene, Math.ceil(topK * 0.8));

    // 3. 应用RRF融合算法（三路融合）
    const mergedResults = this.applyTripleRRFAlgorithm(
      [...hotResults, ...keywordResults],
      vectorResults,
      fts5Results,
      scene,
      emotion
    );

    // 4. 更新访问统计
    mergedResults.slice(0, topK).forEach((m) => this.updateAccessStats(m.id));

    const duration = Date.now() - startTime;
    if (mergedResults.length > 0 || duration > 100) {
      Logger.info(
        '查询完成: ' +
          query.substring(0, 20) +
          '... | ' +
          mergedResults.length +
          '条 | ' +
          duration +
          'ms',
        'MemoryRetriever'
      );
    }

    return mergedResults.slice(0, topK);
  }

  // ==================== 查询向量缓存 ====================

  /** 查询向量缓存 */
  private async getCachedQueryVector(query: string): Promise<number[]> {
    const cached = this.queryVectorCache.get(query);
    if (cached && Date.now() - cached.timestamp < this.QUERY_CACHE_TTL) {
      return cached.vector;
    }

    const vector = await this.embeddingModel.embed(query);

    // LRU 淘汰
    if (this.queryVectorCache.size >= this.QUERY_CACHE_MAX_SIZE) {
      const oldestKey = this.queryVectorCache.keys().next().value;
      if (oldestKey) {
        this.queryVectorCache.delete(oldestKey);
      }
    }

    this.queryVectorCache.set(query, { vector, timestamp: Date.now() });
    return vector;
  }

  // ==================== 热缓存检索 ====================

  /** 热缓存检索 */
  private retrieveFromHotCache(
    query: string,
    scene?: string,
    emotion?: string,
    limit: number = 5
  ): MemoryItem[] {
    const queryTokens = new Set(ChineseTokenizer.tokenize(query));
    const results: Array<{ item: MemoryItem; score: number }> = [];

    for (const item of this.hotMemoryCache.values()) {
      const text = this.memoryToText(item);
      const tokens = ChineseTokenizer.tokenize(text);
      const overlap = tokens.filter((t) => queryTokens.has(t)).length;
      if (overlap === 0) continue;

      let score = overlap / Math.max(queryTokens.size, tokens.length);

      if (scene && item.scene === scene) score *= 1.2;
      if (emotion && item.emotion === emotion) score *= 1.2;

      // 访问频率加权
      const accessCount = this.memoryAccessCount.get(item.id) || 0;
      score *= 1 + Math.log1p(accessCount);

      results.push({ item, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.item);
  }

  // ==================== 关键词检索 ====================

  /**
   * 关键词检索v2：N-gram + 同义词扩展
   */
  private async keywordRetrieval(
    query: string,
    scene?: string,
    emotion?: string,
    limit: number = 20,
    shortTermMemory?: ShortTermMemory,
    longTermMemory?: LongTermMemory
  ): Promise<MemoryItem[]> {
    // 分词 + 扩展
    const queryTokens = ChineseTokenizer.tokenize(query);
    const expandedTokens = this.expandQueryTokens(queryTokens);

    const stm = shortTermMemory || this.shortTermMemoryRef;
    const ltm = longTermMemory || this.longTermMemoryRef;

    const stmMemories = stm
      ? 'retrieve' in stm
        ? await (stm as ShortTermMemory)
            .retrieve(query, [])
            .catch(() => [] as MemoryItem[])
        : (stm as MemoryStoreWithGetAll).getAll()
      : [];
    const ltmMemories = ltm
      ? 'retrieve' in ltm
        ? await (ltm as LongTermMemory)
            .retrieve(query, [])
            .catch(() => [] as MemoryItem[])
        : (ltm as MemoryStoreWithGetAll).getAll()
      : [];

    const allMemories = [
      ...this.getInstantMemory(),
      ...stmMemories,
      ...ltmMemories,
    ];

    if (allMemories.length === 0) return [];

    const scored = allMemories.map((memory) => {
      const text = this.memoryToText(memory);
      const docTokens = ChineseTokenizer.tokenize(text);

      // 加权重叠度：位置加权
      let overlapScore = 0;
      expandedTokens.forEach((token, idx) => {
        const weight = 1 + (expandedTokens.length - idx) * 0.1;
        if (docTokens.includes(token)) {
          overlapScore += weight;
        }
      });

      // Jaccard 相似度
      const intersection = new Set(
        docTokens.filter((t) => expandedTokens.includes(t))
      ).size;
      const union = new Set([...docTokens, ...expandedTokens]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      let score = overlapScore * 0.6 + jaccard * 0.4;

      // 场景/情感加权
      if (scene && memory.scene === scene) score *= 1.3;
      if (emotion && memory.emotion === emotion) score *= 1.3;

      // 时间衰减
      const timestamp =
        typeof memory.timestamp === 'number'
          ? memory.timestamp
          : new Date(memory.timestamp).getTime();
      const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
      score *= Math.exp(-ageHours / 168); // 一周衰减

      return { memory, score };
    });

    return scored
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ ...s.memory, keywordScore: s.score }));
  }

  /** Expand query tokens with synonyms */
  private expandQueryTokens(tokens: string[]): string[] {
    const expanded = new Set(tokens);
    const synonyms: Record<string, string[]> = {
      error: ['exception', 'fail', 'bug', '错误', '异常', '失败'],
      bug: ['issue', 'problem', 'defect', '问题', '缺陷', '漏洞'],
      feature: [
        'function',
        'capability',
        'enhancement',
        '功能',
        '特性',
        '能力',
      ],
      query: ['search', 'find', 'lookup', '查询', '搜索', '查找'],
      task: ['todo', 'job', 'item', '任务', '待办', '工作'],
      code: ['source', 'program', 'script', '代码', '源码', '脚本'],
      test: ['unit-test', 'integration-test', 'e2e', '测试', '单元测试'],
      data: ['information', 'content', 'record', '数据', '信息', '内容'],
      optimize: ['improve', 'enhance', 'refactor', '优化', '改进', '重构'],
      deploy: ['release', 'publish', 'ship', '部署', '发布', '上线'],
      config: [
        'configuration',
        'setting',
        'preference',
        '配置',
        '设置',
        '偏好',
      ],
      fix: ['repair', 'patch', 'resolve', '修复', '修补', '解决'],
      create: ['add', 'new', 'generate', '创建', '新建', '添加'],
      delete: ['remove', 'drop', 'destroy', '删除', '移除', '清除'],
      update: ['modify', 'change', 'edit', '更新', '修改', '编辑'],
      run: ['execute', 'start', 'launch', '运行', '执行', '启动'],
      stop: ['halt', 'terminate', 'kill', '停止', '终止', '关闭'],
      file: ['document', 'resource', '文件', '文档'],
      project: ['repository', 'repo', '项目', '仓库'],
      schedule: ['plan', 'calendar', '日程', '计划', '安排'],
      memory: ['recall', 'remember', '记忆', '回忆', '记住'],
    };

    tokens.forEach((token) => {
      if (synonyms[token]) {
        synonyms[token].forEach((s) => expanded.add(s));
      }
    });

    return Array.from(expanded);
  }

  // ==================== 向量相似度检索 ====================

  /** 向量相似度检索：支持索引和内存回退 */
  private async vectorSimilarityRetrieval(
    queryEmbedding: number[],
    topK: number = 20,
    shortTermMemory?: ShortTermMemory,
    longTermMemory?: LongTermMemory
  ): Promise<MemoryItem[]> {
    let indexResults: { id: string; similarity: number }[] = [];

    if (this.vectorDatabase) {
      indexResults = await this.vectorDatabase.searchVectors(
        queryEmbedding,
        topK
      );
    } else {
      // 内存回退搜索
      for (const [id, vector] of this.memoryVectors.entries()) {
        const similarity = this.cosineSimilarity(vector, queryEmbedding);
        indexResults.push({ id, similarity });
      }
      indexResults.sort((a, b) => b.similarity - a.similarity);
      indexResults = indexResults.slice(0, topK);
    }

    const stm = shortTermMemory || this.shortTermMemoryRef;
    const ltm = longTermMemory || this.longTermMemoryRef;

    const stmMemories = stm
      ? 'retrieve' in stm
        ? await (stm as ShortTermMemory)
            .retrieve('', [])
            .catch(() => [] as MemoryItem[])
        : (stm as MemoryStoreWithGetAll).getAll()
      : [];
    const ltmMemories = ltm
      ? 'retrieve' in ltm
        ? await (ltm as LongTermMemory)
            .retrieve('', [])
            .catch(() => [] as MemoryItem[])
        : (ltm as MemoryStoreWithGetAll).getAll()
      : [];

    const allMemories = [
      ...this.getInstantMemory(),
      ...stmMemories,
      ...ltmMemories,
    ];

    const memoryMap = new Map(allMemories.map((m) => [m.id, m]));
    const results: MemoryItem[] = [];

    for (const { id, similarity } of indexResults) {
      const memory = memoryMap.get(id);
      if (memory) {
        results.push({ ...memory, vectorScore: similarity });
      }
    }

    return results;
  }

  // ==================== 嵌入批处理 ====================

  /** 调度嵌入向量生成（批处理） */
  scheduleEmbeddingGeneration(memoryItem: MemoryItem): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.embeddingBatchQueue.push({ memoryItem, resolve, reject });

      if (!this.embeddingBatchTimer) {
        this.embeddingBatchTimer = setTimeout(() => {
          void this.processEmbeddingBatch();
        }, this.EMBEDDING_BATCH_DELAY);
      }
    });
  }

  /** 处理嵌入批处理请求 */
  private async processEmbeddingBatch(): Promise<void> {
    if (this.embeddingBatchTimer) {
      clearTimeout(this.embeddingBatchTimer);
      this.embeddingBatchTimer = null;
    }

    const batch = this.embeddingBatchQueue.splice(0, this.EMBEDDING_BATCH_SIZE);
    if (batch.length === 0) return;

    try {
      // 并行生成嵌入向量
      const embeddings = await Promise.all(
        batch.map((item) =>
          this.embeddingModel.embed(this.memoryToText(item.memoryItem))
        )
      );

      batch.forEach((item, index) => {
        const embedding = embeddings[index];
        this.memoryVectors.set(item.memoryItem.id, embedding);

        if (this.vectorDatabase) {
          this.vectorDatabase
            .storeVector(item.memoryItem.id, embedding, {
              type: item.memoryItem.type,
              scene: item.memoryItem.scene,
              emotion: item.memoryItem.emotion,
              timestamp: item.memoryItem.timestamp.toISOString(),
            })
            .catch((err: Error) =>
              Logger.error('存储向量失败', err, 'MemoryRetriever')
            );
        }

        this.assignMemoryTier(item.memoryItem);
        item.resolve();
      });
    } catch (error) {
      batch.forEach((item) => item.reject(error as Error));
    }

    // 重新调度批处理
    if (this.embeddingBatchQueue.length > 0) {
      this.embeddingBatchTimer = setTimeout(() => {
        void this.processEmbeddingBatch();
      }, this.EMBEDDING_BATCH_DELAY);
    }
  }

  // ==================== 访问统计 ====================

  /** 更新访问统计 */
  private updateAccessStats(memoryId: string): void {
    const count = (this.memoryAccessCount.get(memoryId) || 0) + 1;
    this.memoryAccessCount.set(memoryId, count);
    this.memoryLastAccess.set(memoryId, Date.now());

    // 热缓存更新
    const allMemories = [
      ...this.getInstantMemory(),
      ...(this.shortTermMemoryRef?.getAll() || []),
      ...(this.longTermMemoryRef?.getAll() || []),
    ];

    const memory = allMemories.find((m) => m.id === memoryId);
    if (memory) {
      this.hotMemoryCache.set(memoryId, memory);

      // LRU 淘汰
      if (this.hotMemoryCache.size > this.HOT_CACHE_MAX_SIZE) {
        const oldestKey = this.hotMemoryCache.keys().next().value;
        if (oldestKey) {
          this.hotMemoryCache.delete(oldestKey);
        }
      }
    }
  }

  /** 短期记忆引用，由MemoryEngine注入（用于回退和访问统计） */
  private shortTermMemoryRef: MemoryStoreWithGetAll | null = null;
  /** 长期记忆引用，由MemoryEngine注入（用于回退和访问统计） */
  private longTermMemoryRef: MemoryStoreWithGetAll | null = null;

  /** 设置短期/长期记忆引用（用于访问统计中的热缓存更新） */
  setMemoryRefs(stm: ShortTermMemory, ltm: LongTermMemory): void {
    this.shortTermMemoryRef = stm;
    this.longTermMemoryRef = ltm;
  }

  // ==================== RRF融合算法 ====================

  private applyRRFAlgorithm(
    keywordResults: MemoryItem[],
    vectorResults: MemoryItem[],
    scene?: string,
    emotion?: string
  ): MemoryItem[] {
    const keywordRanks = new Map<string, number>();
    keywordResults.forEach((memory, index) =>
      keywordRanks.set(memory.id, index + 1)
    );

    const vectorRanks = new Map<string, number>();
    vectorResults.forEach((memory, index) =>
      vectorRanks.set(memory.id, index + 1)
    );

    const allMemoryIds = new Set([
      ...keywordResults.map((m) => m.id),
      ...vectorResults.map((m) => m.id),
    ]);

    const scoredMemories: MemoryItem[] = [];
    const k = 60;

    allMemoryIds.forEach((memoryId) => {
      const memory =
        keywordResults.find((m) => m.id === memoryId) ||
        vectorResults.find((m) => m.id === memoryId);
      if (!memory) return;

      const keywordRank =
        keywordRanks.get(memoryId) || keywordResults.length + 1;
      const vectorRank = vectorRanks.get(memoryId) || vectorResults.length + 1;
      let rrfScore = 1 / (k + keywordRank) + 1 / (k + vectorRank);

      rrfScore *= this.calculateTimeWeight(memory.timestamp);
      if (scene && memory.scene)
        rrfScore *= this.calculateSceneWeight(memory.scene, scene);
      if (emotion && memory.emotion)
        rrfScore *= this.calculateEmotionWeight(memory.emotion, emotion);

      memory.relevanceScore = rrfScore;
      scoredMemories.push(memory);
    });

    return scoredMemories.sort(
      (a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0)
    );
  }

  // ==================== P1增强：FTS5检索 ====================

  /**
   * FTS5全文检索（P1增强）
   */
  private fts5Retrieval(
    query: string,
    scene?: string,
    limit: number = 30
  ): MemoryItem[] {
    if (!this.memoryDatabase) {
      return [];
    }

    try {
      // 转换查询为FTS5语法
      const ftsQuery = this.buildFTS5Query(query);
      const results = this.memoryDatabase.searchByFTS5(ftsQuery, limit);

      return results.map((record) => ({
        id: `fts5_${record.id}`,
        type: record.type as import('./MemoryEngine').MemoryType,
        content: record.content,
        timestamp: new Date(record.timestamp),
        relevanceScore: 1 - (record.rank || 0) / 1000,
        keywordScore: 1 - (record.rank || 0) / 1000,
      }));
    } catch {
      Logger.debug('FTS5检索失败，回退到关键词', 'MemoryRetriever');
      return [];
    }
  }

  /**
   * 构建FTS5查询语法
   * 支持：OR、AND、前缀匹配、短语搜索
   */
  private buildFTS5Query(query: string): string {
    const tokens = query.split(/\s+/).filter((t) => t);

    if (tokens.length === 0) return '*';

    // 对于中文，添加前缀匹配
    return tokens
      .map((token) => {
        // 保留FTS5语法字符
        if (
          token.includes('OR') ||
          token.includes('AND') ||
          token.includes('"')
        ) {
          return token;
        }
        // 添加前缀匹配
        return `${token}*`;
      })
      .join(' ');
  }

  /**
   * 三路RRF融合算法（P1增强）
   * 融合：关键词 + 向量 + FTS5
   */
  private applyTripleRRFAlgorithm(
    keywordResults: MemoryItem[],
    vectorResults: MemoryItem[],
    fts5Results: MemoryItem[],
    scene?: string,
    emotion?: string
  ): MemoryItem[] {
    const keywordRanks = new Map<string, number>();
    keywordResults.forEach((memory, index) =>
      keywordRanks.set(memory.id, index + 1)
    );

    const vectorRanks = new Map<string, number>();
    vectorResults.forEach((memory, index) =>
      vectorRanks.set(memory.id, index + 1)
    );

    const fts5Ranks = new Map<string, number>();
    fts5Results.forEach((memory, index) => fts5Ranks.set(memory.id, index + 1));

    const allMemoryIds = new Set([
      ...keywordResults.map((m) => m.id),
      ...vectorResults.map((m) => m.id),
      ...fts5Results.map((m) => m.id),
    ]);

    const scoredMemories: MemoryItem[] = [];
    const k = 60; // RRF常数

    allMemoryIds.forEach((memoryId) => {
      const memory =
        keywordResults.find((m) => m.id === memoryId) ||
        vectorResults.find((m) => m.id === memoryId) ||
        fts5Results.find((m) => m.id === memoryId);
      if (!memory) return;

      const keywordRank =
        keywordRanks.get(memoryId) || keywordResults.length + 1;
      const vectorRank = vectorRanks.get(memoryId) || vectorResults.length + 1;
      const fts5Rank = fts5Ranks.get(memoryId) || fts5Results.length + 1;

      // 三路RRF：关键词权重0.3，向量权重0.4，FTS5权重0.3
      let rrfScore =
        (1 / (k + keywordRank)) * 0.3 +
        (1 / (k + vectorRank)) * 0.4 +
        (1 / (k + fts5Rank)) * 0.3;

      rrfScore *= this.calculateTimeWeight(memory.timestamp);
      if (scene && memory.scene)
        rrfScore *= this.calculateSceneWeight(memory.scene, scene);
      if (emotion && memory.emotion)
        rrfScore *= this.calculateEmotionWeight(memory.emotion, emotion);

      memory.relevanceScore = rrfScore;
      scoredMemories.push(memory);
    });

    return scoredMemories.sort(
      (a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0)
    );
  }

  // ==================== 权重计算 ====================

  private calculateTimeWeight(timestamp: Date | string | number): number {
    const ts =
      typeof timestamp === 'number'
        ? timestamp
        : timestamp instanceof Date
          ? timestamp.getTime()
          : new Date(timestamp).getTime();
    const ageInHours = (Date.now() - ts) / (1000 * 60 * 60);
    if (ageInHours < 1) return 1.0;
    if (ageInHours < 24) return 0.8;
    if (ageInHours < 72) return 0.6;
    if (ageInHours < 168) return 0.4;
    return 0.2;
  }

  private calculateSceneWeight(
    memoryScene: string,
    currentScene: string
  ): number {
    return memoryScene === currentScene ? 1.2 : 0.8;
  }

  private calculateEmotionWeight(
    memoryEmotion: string,
    currentEmotion: string
  ): number {
    return memoryEmotion === currentEmotion ? 1.2 : 0.8;
  }

  // ==================== 工具方法 ====================

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return normA === 0 || normB === 0
      ? 0
      : dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  memoryToText(memoryItem: MemoryItem): string {
    if (typeof memoryItem.content === 'string') return memoryItem.content;
    if (memoryItem.content && !Array.isArray(memoryItem.content)) {
      const obj = memoryItem.content as Record<string, unknown>;
      if (obj.input && typeof obj.input === 'string') return obj.input;
      if (obj.summary && typeof obj.summary === 'string') return obj.summary;
      return JSON.stringify(memoryItem.content);
    }
    return '';
  }

  private assignMemoryTier(memoryItem: MemoryItem): void {
    const ts =
      typeof memoryItem.timestamp === 'number'
        ? memoryItem.timestamp
        : memoryItem.timestamp instanceof Date
          ? memoryItem.timestamp.getTime()
          : new Date(memoryItem.timestamp).getTime();
    const ageSeconds = (Date.now() - ts) / 1000;
    if (ageSeconds < this.tierThresholds.hot) {
      this.memoryTierMap.set(memoryItem.id, MemoryTier.HOT);
    } else if (ageSeconds < this.tierThresholds.warm) {
      this.memoryTierMap.set(memoryItem.id, MemoryTier.WARM);
    } else {
      this.memoryTierMap.set(memoryItem.id, MemoryTier.COLD);
    }
  }

  // ==================== 缓存清理 ====================

  cleanupQueryVectorCache(): void {
    const now = Date.now();
    for (const [key, value] of this.queryVectorCache.entries()) {
      if (now - value.timestamp > this.QUERY_CACHE_TTL) {
        this.queryVectorCache.delete(key);
      }
    }
  }

  cleanupHotMemoryCache(): void {
    if (this.hotMemoryCache.size <= this.HOT_CACHE_MAX_SIZE) return;
    const sorted = Array.from(this.hotMemoryCache.entries()).sort((a, b) => {
      const countA = this.memoryAccessCount.get(a[0]) || 0;
      const countB = this.memoryAccessCount.get(b[0]) || 0;
      return countB - countA;
    });
    // 清空并重建（因为hotMemoryCache是共享引用）
    this.hotMemoryCache.clear();
    sorted.slice(0, this.HOT_CACHE_MAX_SIZE).forEach(([k, v]) => {
      this.hotMemoryCache.set(k, v);
    });
  }
}
