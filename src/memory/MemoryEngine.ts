/**
 * MemoryEngine v2 - Performance Optimized
 * Key Optimizations:
 * 1. Vector cache: avoid duplicate query embedding generation
 * 2. Chinese semantic enhancement: N-gram + synonym expansion
 * 3. Tiered retrieval: hot/warm/cold memory layers
 * 4. Batch embedding: reduce LLM API calls
 *
 * 拆分后的模块：
 * - MemoryRetriever: 记忆检索与RRF融合
 * - KnowledgeGraphBuilder: 知识图谱构建
 * - ConversationCompressor: 对话压缩
 * - MemoryEncryption: 加密管理
 * - MemoryTracker: 验证与追踪
 */

import { EmotionTag, SceneTag } from '../interfaces';
import { MultimodalInput } from '../multimodal/MultimodalInput';
import Logger from '../utils/Logger';
import { ConversationCompressor } from './ConversationCompressor';
import { MemoryDatabase, MemoryRecord } from './Database';
import { KnowledgeGraphBuilder } from './KnowledgeGraphBuilder';
import { LongTermMemory } from './LongTermMemory';
import { MemoryEncryption } from './MemoryEncryption';
import {
    LLMEmbeddingModel,
    MemoryRetriever,
    SemanticEmbeddingModel,
} from './MemoryRetriever';
import { MemoryTracker } from './MemoryTracker';
import { ShortTermMemory } from './ShortTermMemory';
import { UserProfile } from './UserProfile';
import {
    VectorDatabase as CloseableVectorDatabase,
    VectorDatabaseFactory,
} from './VectorDatabaseFactory';

// ==================== 类型导出 ====================

export enum MemoryType {
  INSTANT = 'instant',
  SHORT_TERM = 'short_term',
  LONG_TERM = 'long_term',
}

export enum MemoryTier {
  HOT = 'hot',
  WARM = 'warm',
  COLD = 'cold',
}

export type MemoryContent = string | Record<string, unknown> | unknown[];

export interface MemoryItem {
  id: string;
  type: MemoryType;
  content: MemoryContent;
  timestamp: Date;
  scene?: string;
  emotion?: string;
  relevanceScore?: number;
  keywordScore?: number;
  vectorScore?: number;
  accessCount?: number;
  lastAccessTime?: number;
}

export interface TrackedResult {
  success: boolean;
  traceId: string;
  duration: number;
  data?: MemoryItem | MemoryItem[];
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'entity' | 'concept' | 'event';
  weight?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  weight?: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ==================== MemoryEngine 主类 ====================

export class MemoryEngine {
  private userProfile: UserProfile;
  private shortTermMemory: ShortTermMemory;
  private longTermMemory: LongTermMemory;
  private instantMemory: MemoryItem[] = [];
  private instantMemoryExpiry: number = 3600;
  private embeddingModel: SemanticEmbeddingModel;
  private memoryVectors: Map<string, number[]> = new Map();
  private writeQueue: Array<{
    type: string;
    content: unknown;
    scene?: string;
    emotion?: string;
    retryCount: number;
  }> = [];
  private isWriting: boolean = false;
  private readonly MAX_WRITE_QUEUE_SIZE = 1000;
  private readonly MAX_RETRY_COUNT = 3;
  private vectorDatabase: CloseableVectorDatabase | null = null;
  private memoryTierMap: Map<string, MemoryTier> = new Map();
  private memoryAccessCount: Map<string, number> = new Map();
  private memoryLastAccess: Map<string, number> = new Map();
  /** 语义相似度引擎存根（原 SemanticSimilarityEngine 已删除） */
  private semanticSimilarityEngine: {
    initialize(): Promise<void>;
  } = { async initialize() {} };
  private memoryDatabase: MemoryDatabase;

  // 共享的缓存Map（与MemoryRetriever共享引用）
  private queryVectorCache: Map<
    string,
    { vector: number[]; timestamp: number }
  > = new Map();
  private hotMemoryCache: Map<string, MemoryItem> = new Map();

  // 拆分出的子模块
  private memoryRetriever: MemoryRetriever;
  private knowledgeGraphBuilder: KnowledgeGraphBuilder;
  private conversationCompressor: ConversationCompressor;
  private memoryEncryption: MemoryEncryption;
  private memoryTracker: MemoryTracker;

  constructor() {
    this.userProfile = new UserProfile();
    this.shortTermMemory = new ShortTermMemory();
    this.longTermMemory = new LongTermMemory();
    this.embeddingModel = new LLMEmbeddingModel();
    this.semanticSimilarityEngine = { async initialize() {} };
    this.vectorDatabase = null;
    this.memoryDatabase = MemoryDatabase.getInstance();

    // 初始化子模块
    this.memoryEncryption = new MemoryEncryption();

    this.memoryRetriever = new MemoryRetriever({
      semanticSimilarityEngine: this.semanticSimilarityEngine,
      embeddingModel: this.embeddingModel,
      memoryVectors: this.memoryVectors,
      hotMemoryCache: this.hotMemoryCache,
      memoryAccessCount: this.memoryAccessCount,
      memoryLastAccess: this.memoryLastAccess,
      memoryTierMap: this.memoryTierMap,
      vectorDatabase: this.vectorDatabase,
      instantMemoryRef: () => this.instantMemory,
      queryVectorCache: this.queryVectorCache,
    });

    this.knowledgeGraphBuilder = new KnowledgeGraphBuilder();
    this.conversationCompressor = new ConversationCompressor();
    this.memoryTracker = new MemoryTracker();

    this.startMemoryManagement();
  }

  // ==================== 初始化 ====================

  public async initialize(): Promise<void> {
    try {
      await this.shortTermMemory.initialize();
      await this.longTermMemory.initialize();
      await this.userProfile.load();
      await this.semanticSimilarityEngine.initialize();
      this.memoryDatabase = MemoryDatabase.getInstance();
      this.vectorDatabase = await VectorDatabaseFactory.createVectorDatabase();

      // 初始化加密模块
      await this.memoryEncryption.initialize();

      // 更新子模块引用
      this.memoryRetriever.setVectorDatabase(this.vectorDatabase);
      this.memoryRetriever.setMemoryRefs(
        this.shortTermMemory,
        this.longTermMemory
      );
    } catch (error) {
      Logger.error('记忆引擎初始化失败', error as Error);
      throw error;
    }
  }

  // ==================== 存储 ====================

  public async storeShortTermMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    const memoryItem: MemoryItem = {
      id: `short_term_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      type: MemoryType.SHORT_TERM,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };

    const contentStr =
      typeof content === 'string' ? content : JSON.stringify(content);
    this.memoryDatabase.add(contentStr, 'short_term', 'core', 0.6);

    try {
      await this.shortTermMemory.store(content, scene, emotion);
    } catch (error) {
      Logger.warn('短期记忆直接存储失败，回退到写入队列: ' + (error as Error).message, 'MemoryEngine');
      this.enqueueWrite({ type: 'short_term', content, scene, emotion });
    }

    void this.memoryRetriever.scheduleEmbeddingGeneration(memoryItem);

    return memoryItem;
  }

  public async storeLongTermMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    const memoryItem: MemoryItem = {
      id: `long_term_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      type: MemoryType.LONG_TERM,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };

    const contentStr =
      typeof content === 'string' ? content : JSON.stringify(content);
    const importance = this.shouldStoreToLongTerm(
      content,
      undefined,
      emotion || 'neutral'
    )
      ? 0.8
      : 0.5;

    try {
      const encryptedContent =
        await this.memoryEncryption.storeEncryptedLongTermMemory({
          content,
          scene,
          emotion,
        });
      this.memoryDatabase.add(
        encryptedContent,
        'long_term_encrypted',
        'core',
        importance
      );
    } catch {
      this.memoryDatabase.add(contentStr, 'long_term', 'core', importance);
    }

    this.enqueueWrite({ type: 'long_term', content, scene, emotion });
    void this.memoryRetriever.scheduleEmbeddingGeneration(memoryItem);

    return memoryItem;
  }

  public async storeInstantMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    const memoryItem: MemoryItem = {
      id: `instant_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      type: MemoryType.INSTANT,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };

    this.instantMemory.push(memoryItem);
    const contentStr =
      typeof content === 'string' ? content : JSON.stringify(content);
    this.memoryDatabase.add(contentStr, 'instant', 'core', 0.3);
    void this.memoryRetriever.scheduleEmbeddingGeneration(memoryItem);
    this.cleanupInstantMemory();

    return memoryItem;
  }

  public async storeFeedbackSignal(data: {
    traceId?: string;
    toolName?: string;
    feedbackType:
      | 'success'
      | 'failure'
      | 'timeout'
      | 'correction'
      | 'satisfaction';
    rating?: number;
    message?: string;
    userId?: string;
    timestamp?: number;
  }): Promise<void> {
    try {
      const content = JSON.stringify(data);
      this.memoryDatabase.add(
        content,
        'feedback_signal',
        'user_feedback',
        data.rating ? data.rating / 5 : 0.5
      );
    } catch (error) {
      Logger.warn(
        '存储反馈信号失败: ' + (error as Error).message,
        'MemoryEngine'
      );
    }
  }

  // ==================== 检索（委托MemoryRetriever）====================

  public async preciseHybridRetrieval(
    query: string,
    scene?: string,
    emotion?: string,
    topK: number = 10
  ): Promise<MemoryItem[]> {
    return this.memoryRetriever.preciseHybridRetrieval(
      query,
      scene,
      emotion,
      topK,
      this.shortTermMemory,
      this.longTermMemory
    );
  }

  // ==================== 用户配置 ====================

  public getUserProfile(): UserProfile {
    return this.userProfile;
  }

  public isInitialized(): boolean {
    try {
      const checkInit = (obj: unknown): boolean => {
        const o = obj as { isInitialized?: () => boolean };
        return typeof o.isInitialized === 'function' ? o.isInitialized() : true;
      };
      return checkInit(this.shortTermMemory) && checkInit(this.longTermMemory);
    } catch {
      return false;
    }
  }

  public async retrieveTaskMemory(
    query: string,
    _requirements: string[]
  ): Promise<MemoryItem[]> {
    return this.preciseHybridRetrieval(query, undefined, undefined, 10);
  }

  public async retrieveEmotionMemory(
    emotionType: string,
    sceneType: string
  ): Promise<MemoryItem[]> {
    return this.preciseHybridRetrieval(emotionType, sceneType, emotionType, 10);
  }

  public async queryRecentFeedback(
    hours: number = 24
  ): Promise<MemoryRecord[]> {
    try {
      const cutoff = Date.now() - hours * 3600 * 1000;
      const records = this.memoryDatabase.query('feedback_signal', 1000);
      return records.filter((r) => r.timestamp >= cutoff);
    } catch {
      return [];
    }
  }

  public mergeAndSortMemories(
    taskMemories: MemoryItem[],
    emotionMemories: MemoryItem[]
  ): MemoryItem[] {
    const memoryMap = new Map<string, MemoryItem>();
    taskMemories.forEach((m, i) => {
      m.relevanceScore = this.calculateRelevanceScore(
        i,
        taskMemories.length,
        1.0
      );
      memoryMap.set(m.id, m);
    });
    emotionMemories.forEach((m, i) => {
      const existing = memoryMap.get(m.id);
      if (existing) {
        existing.relevanceScore =
          (existing.relevanceScore || 0) +
          this.calculateRelevanceScore(i, emotionMemories.length, 0.7);
      } else {
        m.relevanceScore = this.calculateRelevanceScore(
          i,
          emotionMemories.length,
          0.7
        );
        memoryMap.set(m.id, m);
      }
    });
    return Array.from(memoryMap.values())
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, 10);
  }

  private calculateRelevanceScore(
    index: number,
    total: number,
    weight: number
  ): number {
    return weight * (1 - index / total);
  }

  public async updateMemory(
    input: MultimodalInput,
    result: unknown,
    reflection: unknown,
    emotion: EmotionTag,
    scene: SceneTag
  ): Promise<void> {
    const inputText = input.getText();
    const memoryContent = {
      input: inputText,
      result,
      reflection,
      emotion,
      scene,
    };
    this.storeInstantMemory(memoryContent, scene.type, emotion.type).catch(
      (err: Error) => Logger.error('存储即时记忆失败', err, 'MemoryEngine')
    );
    this.storeShortTermMemory(memoryContent, scene.type, emotion.type).catch(
      (err: Error) => Logger.error('存储短期记忆失败', err, 'MemoryEngine')
    );
    if (this.shouldStoreToLongTerm(inputText, result, emotion.type)) {
      this.storeLongTermMemory(memoryContent, scene.type, emotion.type).catch(
        (err: Error) => Logger.error('存储长期记忆失败', err, 'MemoryEngine')
      );
    }
  }

  private shouldStoreToLongTerm(
    content: MemoryContent,
    _result?: unknown,
    emotion?: string
  ): boolean {
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    const importanceKeywords = [
      '重要',
      '关键',
      '必须',
      '紧急',
      '优先',
      '记住',
      '不要忘记',
      '我喜欢',
      '我讨厌',
    ];
    const hasImportantKeyword = importanceKeywords.some((kw) =>
      text.includes(kw)
    );
    const isEmotional =
      emotion &&
      ['sad', 'angry', 'anxious', 'happy', 'excited'].includes(emotion);
    return hasImportantKeyword || !!isEmotional || text.length > 100;
  }

  // ==================== 加密（委托MemoryEncryption）====================

  public async storeEncryptedLongTermMemory(
    content: Record<string, unknown>
  ): Promise<string> {
    return this.memoryEncryption.storeEncryptedLongTermMemory(content);
  }

  public async decryptLongTermMemory(encryptedData: string): Promise<unknown> {
    return this.memoryEncryption.decryptLongTermMemory(encryptedData);
  }

  // ==================== 内存管理 ====================

  private memoryManagementTimer: ReturnType<typeof setInterval> | null = null;

  private startMemoryManagement(): void {
    this.memoryManagementTimer = setInterval(
      () => {
        this.performMemoryManagement().catch((err: unknown) => {
          Logger.error(
            '内存管理任务失败',
            err instanceof Error ? err : new Error(String(err)),
            'MemoryEngine'
          );
        });
      },
      5 * 60 * 1000
    );
  }

  private async performMemoryManagement(): Promise<void> {
    this.cleanupInstantMemory();
    this.memoryRetriever.cleanupQueryVectorCache();
    this.memoryRetriever.cleanupHotMemoryCache();
  }

  private cleanupInstantMemory(): void {
    const cutoff = Date.now() - this.instantMemoryExpiry * 1000;
    this.instantMemory = this.instantMemory.filter(
      (item) => item.timestamp.getTime() > cutoff
    );
  }

  private enqueueWrite(item: {
    type: string;
    content: unknown;
    scene?: string;
    emotion?: string;
  }): void {
    if (this.writeQueue.length >= this.MAX_WRITE_QUEUE_SIZE) {
      const dropped = this.writeQueue.shift();
      Logger.warn(`写入队列已满，丢弃旧项: ${dropped?.type}`, 'MemoryEngine');
    }
    this.writeQueue.push({ ...item, retryCount: 0 });
    this.processWriteQueue().catch((err: Error) =>
      Logger.error('处理写入队列失败', err, 'MemoryEngine')
    );
  }

  private async processWriteQueue(): Promise<void> {
    if (this.writeQueue.length === 0 || this.isWriting) return;
    this.isWriting = true;
    try {
      while (this.writeQueue.length > 0) {
        const item = this.writeQueue.shift();
        if (!item) continue;
        try {
          switch (item.type) {
            case 'short_term':
              await this.shortTermMemory.store(
                item.content as MemoryContent,
                item.scene,
                item.emotion
              );
              break;
            case 'long_term':
              await this.longTermMemory.store(
                item.content as MemoryContent,
                item.scene,
                item.emotion
              );
              break;
          }
        } catch (error) {
          if (item.retryCount < this.MAX_RETRY_COUNT) {
            item.retryCount++;
            this.writeQueue.unshift(item);
            await new Promise((resolve) =>
              setTimeout(resolve, 100 * item.retryCount)
            );
          } else {
            Logger.error('处理写入请求失败', error as Error, 'MemoryEngine');
          }
        }
      }
    } catch (error) {
      Logger.error('写入队列处理失败:', error as Error, 'MemoryEngine');
    } finally {
      this.isWriting = false;
      if (this.writeQueue.length > 0) {
        this.processWriteQueue().catch((err: Error) =>
          Logger.error('重新处理写入队列失败', err, 'MemoryEngine')
        );
      }
    }
  }

  // ==================== 持久化存储 ====================

  public async retrieveFromPersistentStorage(
    type?: string,
    limit: number = 50
  ): Promise<MemoryRecord[]> {
    try {
      return this.memoryDatabase.query(type || undefined, limit);
    } catch (error) {
      Logger.error('查询记忆失败', error as Error);
      return [];
    }
  }

  public async retrieveByTraceId(traceId: string): Promise<MemoryRecord[]> {
    try {
      return this.memoryDatabase.queryByTraceId(traceId);
    } catch (error) {
      Logger.error('通过TraceId查询失败', error as Error);
      return [];
    }
  }

  public async restoreFromPersistentStorage(): Promise<void> {
    try {
      const longTermRecords = this.memoryDatabase.query('long_term', 200);
      const shortTermRecords = this.memoryDatabase.query('short_term', 100);

      const restoreRecords = async (
        records: MemoryRecord[],
        store: (
          content: unknown,
          scene?: string,
          emotion?: string
        ) => Promise<unknown>
      ): Promise<void> => {
        for (const record of records) {
          try {
            await store(JSON.parse(record.content as string));
          } catch {
            await store(record.content);
          }
        }
      };

      await restoreRecords(longTermRecords, (c, s, e) =>
        this.longTermMemory.store(c as MemoryContent, s, e)
      );
      await restoreRecords(shortTermRecords, (c, s, e) =>
        this.shortTermMemory.store(c as MemoryContent, s, e)
      );

      Logger.info(
        '从持久化存储恢复: 长期记忆' +
          longTermRecords.length +
          '条, 短期记忆' +
          shortTermRecords.length +
          '条'
      );
    } catch (error) {
      Logger.error('从持久化存储恢复失败:', error as Error);
    }
  }

  // ==================== 验证与追踪（委托MemoryTracker）====================

  public async storeWithTracking(
    content: MemoryContent,
    memoryType: MemoryType,
    scene?: string,
    emotion?: string,
    traceId?: string
  ): Promise<TrackedResult> {
    return this.memoryTracker.storeWithTracking(
      content,
      memoryType,
      (c, s, e) => {
        switch (memoryType) {
          case MemoryType.SHORT_TERM:
            return this.storeShortTermMemory(c, s, e);
          case MemoryType.LONG_TERM:
            return this.storeLongTermMemory(c, s, e);
          case MemoryType.INSTANT:
            return this.storeInstantMemory(c, s, e);
          default:
            throw new Error('未知的记忆类型: ' + memoryType);
        }
      },
      scene,
      emotion,
      traceId
    );
  }

  public async retrieveWithTracking(
    query: string,
    scene?: string,
    emotion?: string,
    topK: number = 10,
    traceId?: string
  ): Promise<TrackedResult> {
    return this.memoryTracker.retrieveWithTracking(
      query,
      (q, s, e, k) => this.preciseHybridRetrieval(q, s, e, k),
      scene,
      emotion,
      topK,
      traceId
    );
  }

  // ==================== 对话相关 ====================

  public async getRecentConversations(limit: number = 50): Promise<unknown[]> {
    try {
      const conversations =
        await this.shortTermMemory.getRecentConversations(limit);
      return conversations.map(
        ({ id, timestamp, content, scene, emotion }) => ({
          id,
          timestamp,
          content,
          scene,
          emotion,
        })
      );
    } catch (error) {
      Logger.error('获取最近记忆失败', error as Error, 'MemoryEngine');
      return [];
    }
  }

  /** 对话历史压缩（委托ConversationCompressor） */
  public async compressConversationHistory(
    conversationId: string,
    maxLength: number = 10
  ): Promise<void> {
    await this.conversationCompressor.compressConversationHistory(
      conversationId,
      maxLength,
      this.shortTermMemory,
      async (content, scene, emotion) =>
        this.storeLongTermMemory(content, scene, emotion)
    );
  }

  /** 检索相关对话（委托ConversationCompressor） */
  public async retrieveRelevantConversations(
    currentInput: string,
    limit: number = 5
  ): Promise<
    Array<{
      id: string;
      content: string;
      timestamp: Date;
      relevance: number;
      scene?: string;
      emotion?: string;
    }>
  > {
    return this.conversationCompressor.retrieveRelevantConversations(
      currentInput,
      limit,
      this.shortTermMemory
    );
  }

  // ==================== 知识图谱（委托KnowledgeGraphBuilder）====================

  /** 构建知识图谱（委托KnowledgeGraphBuilder） */
  public async getKnowledgeGraph(
    userId?: string,
    limit: number = 100
  ): Promise<KnowledgeGraph> {
    const memories = await this.getAllMemories(userId, limit);
    return this.knowledgeGraphBuilder.getKnowledgeGraph(memories);
  }

  private async getAllMemories(
    _userId?: string,
    limit: number = 100
  ): Promise<MemoryItem[]> {
    const allMemories: MemoryItem[] = [
      ...this.instantMemory,
      ...(await this.shortTermMemory.retrieve('', [])),
      ...(await this.longTermMemory.retrieve('', [])),
    ];

    return allMemories.slice(0, limit);
  }

  // ==================== 关闭 ====================

  public async shutdown(): Promise<void> {
    Logger.info('正在关闭内存系统...', 'MemoryEngine');
    if (this.memoryManagementTimer) {
      clearInterval(this.memoryManagementTimer);
      this.memoryManagementTimer = null;
    }
    try {
      await this.shortTermMemory.shutdown?.();
      await this.longTermMemory.shutdown?.();
      await this.userProfile.save?.();
      if (this.vectorDatabase) {
        await this.vectorDatabase.close();
      }
      Logger.info('内存系统已安全关闭', 'MemoryEngine');
    } catch (error) {
      Logger.error('关闭内存系统时出错:', error as Error);
    }
  }
}
