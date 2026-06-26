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
 *
 * @deprecated 已迁移到 Python agent/memory/。
 *
 * 废弃状态说明：
 * - 废弃版本：V5.0
 * - 迁移日期：2026-06-22
 * - 预计移除版本：V6.0（约 2026-09）
 * - 替代方案：使用 Python 后端（AGENT_BACKEND=python，默认）
 * - 回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现（不推荐）
 * - 维护状态：仅安全修复，不再新增功能
 *
 * 注意：当 AGENT_BACKEND=python（默认）时，此文件不会被使用。
 *       仅当显式设置 AGENT_BACKEND=local 时才会使用此 TS 实现。
 */

import { EmotionTag, SceneTag } from '../interfaces';
import { perf } from '../monitoring/PerformanceMonitor';
import { MultimodalInput } from '../multimodal/MultimodalInput';
import Logger from '../utils/Logger';
import { ConversationCompressor } from './ConversationCompressor';
import { MemoryDatabase, MemoryRecord } from './Database';
import { EpisodicMemoryStore } from './EpisodicMemoryStore';
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
  /** 衰减分数 (0-1)，由时间衰减和访问强化计算得出，越低越应被清理 */
  decayScore?: number;
  /** 重要性评分 (1-10)，>=7 可晋升长期记忆 */
  importance?: number;
  /** 记忆分类：preference/fact/task/event/conversation/other */
  category?: string;
  /** 是否已被压缩合并 */
  isCompressed?: boolean;
  /** 合并来源ID列表（被合并掉的原始记忆ID） */
  mergedFrom?: string[];
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
  private episodicMemoryStore: EpisodicMemoryStore;
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
  private readonly HIGH_WATERMARK = 800;
  private readonly MAX_RETRY_COUNT = 3;
  private writeQueueBackpressureResolvers: Array<() => void> = [];
  private writeQueueDrainWaiters: Array<() => void> = [];
  private vectorDatabase: CloseableVectorDatabase | null = null;
  private memoryTierMap: Map<string, MemoryTier> = new Map();
  private memoryAccessCount: Map<string, number> = new Map();
  private memoryLastAccess: Map<string, number> = new Map();
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

  // ==================== 衰减与"做梦"机制 ====================

  /** 衰减配置 */
  private static readonly DECAY_CONFIG = {
    /** 短期记忆半衰期（小时） */
    SHORT_TERM_HALF_LIFE: 24,
    /** 长期记忆半衰期（小时） */
    LONG_TERM_HALF_LIFE: 720,
    /** 访问强化因子：每次访问增加的权重 */
    ACCESS_BOOST: 0.15,
    /** 最大访问强化上限 */
    MAX_ACCESS_BOOST: 2.0,
    /** 衰减清理阈值：低于此值的记忆可被清理 */
    DECAY_CLEANUP_THRESHOLD: 0.1,
    /** 做梦间隔（毫秒）：30分钟 */
    DREAM_INTERVAL: 30 * 60 * 1000,
    /** 做梦时最大处理记忆数 */
    DREAM_BATCH_SIZE: 100,
    /** 去重相似度阈值 */
    DEDUP_SIMILARITY_THRESHOLD: 0.8,
  };

  /** "做梦"定时器 */
  private dreamTimer: ReturnType<typeof setInterval> | null = null;
  /** 上次用户活跃时间 */
  private lastActiveTime: number = Date.now();
  /** 是否正在"做梦" */
  private isDreaming: boolean = false;
  /** 做梦统计 */
  private dreamStats: {
    totalDreams: number;
    memoriesConsolidated: number;
    memoriesDeduplicated: number;
    memoriesDecayed: number;
    lastDreamTime: number | null;
  } = {
    totalDreams: 0,
    memoriesConsolidated: 0,
    memoriesDeduplicated: 0,
    memoriesDecayed: 0,
    lastDreamTime: null,
  };

  constructor() {
    this.userProfile = new UserProfile();
    this.shortTermMemory = new ShortTermMemory();
    this.longTermMemory = new LongTermMemory();
    this.episodicMemoryStore = new EpisodicMemoryStore();
    this.embeddingModel = new LLMEmbeddingModel();
    this.vectorDatabase = null;
    this.memoryDatabase = MemoryDatabase.getInstance();

    // 初始化子模块
    this.memoryEncryption = new MemoryEncryption();

    this.memoryRetriever = new MemoryRetriever({
      embeddingModel: this.embeddingModel,
      memoryVectors: this.memoryVectors,
      hotMemoryCache: this.hotMemoryCache,
      memoryAccessCount: this.memoryAccessCount,
      memoryLastAccess: this.memoryLastAccess,
      memoryTierMap: this.memoryTierMap,
      vectorDatabase: this.vectorDatabase,
      instantMemoryRef: () => this.instantMemory,
      queryVectorCache: this.queryVectorCache,
      memoryDatabase: this.memoryDatabase,
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
      await this.episodicMemoryStore.initialize();
      await this.userProfile.load();
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
    await this.waitForBackpressure();

    return perf.measure(
      'memory.storeShortTerm',
      async () => {
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
          Logger.warn(
            '短期记忆直接存储失败，回退到写入队列: ' + (error as Error).message,
            'MemoryEngine'
          );
          this.enqueueWrite({ type: 'short_term', content, scene, emotion });
        }

        void this.memoryRetriever.scheduleEmbeddingGeneration(memoryItem);

        return memoryItem;
      },
      'memory'
    );
  }

  public async storeLongTermMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    await this.waitForBackpressure();

    return perf.measure(
      'memory.storeLongTerm',
      async () => {
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
      },
      'memory'
    );
  }

  public async storeInstantMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    return perf.measure(
      'memory.storeInstant',
      async () => {
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
      },
      'memory'
    );
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

  // ==================== P1-2: 情景记忆（EpisodicMemoryStore）====================

  public async storeEpisodicMemory(
    content: string,
    options?: import('./EpisodicMemoryStore').StoreOptions
  ): Promise<import('./EpisodicMemoryStore').EpisodicMemory> {
    return this.episodicMemoryStore.store(content, options);
  }

  public retrieveEpisodicMemory(
    options?: import('./EpisodicMemoryStore').RetrieveOptions
  ): import('./EpisodicMemoryStore').RetrievalResult {
    return this.episodicMemoryStore.retrieve(options);
  }

  public getEpisodicMemoryStats(): Record<string, unknown> {
    return this.episodicMemoryStore.getStats();
  }

  // ==================== 检索（委托MemoryRetriever）====================

  public async preciseHybridRetrieval(
    query: string,
    scene?: string,
    emotion?: string,
    topK: number = 10
  ): Promise<MemoryItem[]> {
    return perf.measure(
      'memory.recall',
      async () => {
        const results = await this.memoryRetriever.preciseHybridRetrieval(
          query,
          scene,
          emotion,
          topK,
          this.shortTermMemory,
          this.longTermMemory
        );

        // 应用衰减分数加权：衰减分数影响最终排序
        return results.map((memory) => {
          const decayScore =
            memory.decayScore ?? this.calculateDecayScore(memory);
          return {
            ...memory,
            decayScore,
            relevanceScore: (memory.relevanceScore || 0) * decayScore,
          };
        });
      },
      'memory'
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

    // 启动"做梦"机制：在用户不活跃时自动整理记忆
    this.dreamTimer = setInterval(() => {
      this.performDream().catch((err: unknown) => {
        Logger.error(
          '记忆整理（做梦）失败',
          err instanceof Error ? err : new Error(String(err)),
          'MemoryEngine'
        );
      });
    }, MemoryEngine.DECAY_CONFIG.DREAM_INTERVAL);
  }

  // ==================== 衰减计算 ====================

  /**
   * 计算记忆的衰减分数
   * 衰减分数 = 时间衰减 × 访问强化
   * - 时间衰减：指数衰减，半衰期取决于记忆类型
   * - 访问强化：每次访问增加权重，有上限
   *
   * @param memory - 记忆项
   * @returns 衰减分数 (0-1)，1=最新最强，0=完全衰减
   */
  public calculateDecayScore(memory: MemoryItem): number {
    const now = Date.now();
    const timestamp =
      memory.timestamp instanceof Date
        ? memory.timestamp.getTime()
        : new Date(memory.timestamp).getTime();

    const ageHours = (now - timestamp) / (1000 * 60 * 60);

    // 根据记忆类型选择半衰期
    const halfLife =
      memory.type === MemoryType.LONG_TERM
        ? MemoryEngine.DECAY_CONFIG.LONG_TERM_HALF_LIFE
        : MemoryEngine.DECAY_CONFIG.SHORT_TERM_HALF_LIFE;

    // 时间衰减：指数衰减
    const timeDecay = Math.exp((-0.693 * ageHours) / halfLife);

    // 访问强化：log(1 + accessCount) * boost
    const accessCount = memory.accessCount || 0;
    const accessBoost = Math.min(
      1 + Math.log1p(accessCount) * MemoryEngine.DECAY_CONFIG.ACCESS_BOOST,
      MemoryEngine.DECAY_CONFIG.MAX_ACCESS_BOOST
    );

    // 重要性加权：importance >= 7 的记忆衰减更慢
    const importanceBoost = memory.importance
      ? 1 + (memory.importance / 10) * 0.5
      : 1;

    return Math.min(1, timeDecay * accessBoost * importanceBoost);
  }

  /**
   * 批量更新记忆衰减分数
   * @param memories - 需要更新的记忆列表
   * @returns 更新后的记忆列表
   */
  public updateDecayScores(memories: MemoryItem[]): MemoryItem[] {
    return memories.map((memory) => ({
      ...memory,
      decayScore: this.calculateDecayScore(memory),
    }));
  }

  // ==================== "做梦"机制 ====================

  /**
   * 记录用户活跃时间（由外部调用）
   * 在每次用户交互时调用，用于判断用户是否不活跃
   */
  public markUserActive(): void {
    this.lastActiveTime = Date.now();
  }

  /**
   * 执行"做梦"：在用户不活跃时自动整理记忆
   * 类比人类睡眠时的记忆固化过程：
   * 1. 衰减计算 - 更新所有记忆的衰减分数
   * 2. 去重合并 - 合并相似记忆
   * 3. 晋升/降级 - 高价值短期记忆晋升长期，低价值长期记忆降级
   * 4. 清理 - 移除完全衰减的记忆
   */
  private async performDream(): Promise<void> {
    // 如果正在做梦或用户活跃（5分钟内有交互），跳过
    const idleThreshold = 5 * 60 * 1000;
    if (this.isDreaming) return;
    if (Date.now() - this.lastActiveTime < idleThreshold) return;

    this.isDreaming = true;
    const startTime = Date.now();

    try {
      Logger.info('💤 开始记忆整理（做梦）...', 'MemoryEngine');

      // 步骤1：衰减计算
      const decayedCount = await this.dreamDecayCalculation();

      // 步骤2：去重合并
      const dedupedCount = await this.dreamDeduplication();

      // 步骤3：晋升/降级
      const consolidatedCount = await this.dreamConsolidation();

      // 步骤4：清理
      const cleanedCount = await this.dreamCleanup();

      this.dreamStats.totalDreams++;
      this.dreamStats.memoriesConsolidated += consolidatedCount;
      this.dreamStats.memoriesDeduplicated += dedupedCount;
      this.dreamStats.memoriesDecayed += decayedCount;
      this.dreamStats.lastDreamTime = Date.now();

      const duration = Date.now() - startTime;
      Logger.info(
        `💤 记忆整理完成: 衰减=${decayedCount} 去重=${dedupedCount} ` +
          `晋升=${consolidatedCount} 清理=${cleanedCount} 耗时=${duration}ms`,
        'MemoryEngine'
      );
    } catch (error) {
      Logger.error('记忆整理失败', error as Error, 'MemoryEngine');
    } finally {
      this.isDreaming = false;
    }
  }

  /**
   * 做梦步骤1：衰减计算
   * 更新短期和长期记忆的衰减分数
   */
  private async dreamDecayCalculation(): Promise<number> {
    let updatedCount = 0;

    // 更新短期记忆衰减分数
    const stmMemories = this.shortTermMemory.getAll();
    for (const memory of stmMemories.slice(
      0,
      MemoryEngine.DECAY_CONFIG.DREAM_BATCH_SIZE
    )) {
      const decayScore = this.calculateDecayScore(memory);
      if (memory.decayScore !== decayScore) {
        memory.decayScore = decayScore;
        updatedCount++;
      }
    }

    // 更新长期记忆衰减分数
    const ltmMemories = this.longTermMemory.getAll();
    for (const memory of ltmMemories.slice(
      0,
      MemoryEngine.DECAY_CONFIG.DREAM_BATCH_SIZE
    )) {
      const decayScore = this.calculateDecayScore(memory);
      if (memory.decayScore !== decayScore) {
        memory.decayScore = decayScore;
        updatedCount++;
      }
    }

    return updatedCount;
  }

  /**
   * 做梦步骤2：去重合并
   * 找出相似度 >80% 的记忆，合并为一条精炼记忆
   */
  private async dreamDeduplication(): Promise<number> {
    let dedupedCount = 0;

    const stmMemories = this.shortTermMemory.getAll();
    const merged: Set<string> = new Set();

    for (let i = 0; i < stmMemories.length && dedupedCount < 20; i++) {
      const memA = stmMemories[i];
      if (merged.has(memA.id) || memA.isCompressed) continue;

      const textA = this.memoryToText(memA);
      if (!textA) continue;

      for (let j = i + 1; j < stmMemories.length; j++) {
        const memB = stmMemories[j];
        if (merged.has(memB.id) || memB.isCompressed) continue;

        const textB = this.memoryToText(memB);
        if (!textB) continue;

        const similarity = this.computeTextSimilarity(textA, textB);
        if (similarity > MemoryEngine.DECAY_CONFIG.DEDUP_SIMILARITY_THRESHOLD) {
          // 合并：保留较新的记忆，标记较旧的为已压缩
          const newer = memA.timestamp > memB.timestamp ? memA : memB;
          const older = memA.timestamp > memB.timestamp ? memB : memA;

          // 将旧记忆的关键信息合并到新记忆
          const mergedContent = this.mergeMemoryContent(newer, older);
          newer.content = mergedContent;
          newer.mergedFrom = [
            ...(newer.mergedFrom || []),
            older.id,
            ...(older.mergedFrom || []),
          ];
          newer.importance = Math.max(
            newer.importance || 5,
            older.importance || 5
          );

          merged.add(older.id);
          dedupedCount++;
        }
      }
    }

    return dedupedCount;
  }

  /**
   * 做梦步骤3：晋升/降级
   * - 高衰减分数的短期记忆 → 晋升长期记忆
   * - 低衰减分数的长期记忆 → 标记待清理
   */
  private async dreamConsolidation(): Promise<number> {
    let consolidatedCount = 0;

    // 短期→长期晋升：衰减分数 > 0.5 且 importance >= 7 的短期记忆
    const stmMemories = this.shortTermMemory.getAll();
    for (const memory of stmMemories.slice(
      0,
      MemoryEngine.DECAY_CONFIG.DREAM_BATCH_SIZE
    )) {
      const decayScore = memory.decayScore ?? this.calculateDecayScore(memory);
      const importance = memory.importance ?? 5;

      if (decayScore > 0.5 && importance >= 7 && !memory.isCompressed) {
        try {
          await this.storeLongTermMemory(
            memory.content,
            memory.scene,
            memory.emotion
          );
          consolidatedCount++;
        } catch {
          // 晋升失败不阻塞
        }
      }
    }

    return consolidatedCount;
  }

  /**
   * 做梦步骤4：清理完全衰减的记忆
   * 移除衰减分数低于阈值的即时记忆
   */
  private async dreamCleanup(): Promise<number> {
    let cleanedCount = 0;

    // 清理即时记忆中衰减严重的
    const before = this.instantMemory.length;
    this.instantMemory = this.instantMemory.filter((memory) => {
      const decayScore = memory.decayScore ?? this.calculateDecayScore(memory);
      return decayScore >= MemoryEngine.DECAY_CONFIG.DECAY_CLEANUP_THRESHOLD;
    });
    cleanedCount += before - this.instantMemory.length;

    return cleanedCount;
  }

  // ==================== 去重与合并辅助方法 ====================

  /**
   * 计算两个文本的相似度（0-1）
   * 基于 Jaccard 相似度 + 中文分词
   */
  private computeTextSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const tokensA = new Set(this.tokenizeForSimilarity(a));
    const tokensB = new Set(this.tokenizeForSimilarity(b));

    const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
    const union = new Set([...tokensA, ...tokensB]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 为相似度计算进行分词
   * 简单的字符级 N-gram + 关键词提取
   */
  private tokenizeForSimilarity(text: string): string[] {
    const tokens: string[] = [];

    // 提取中文关键词（2-4字）
    const chineseWords = text.match(/[\u4e00-\u9fa5]{2,4}/g);
    if (chineseWords) {
      tokens.push(...chineseWords);
    }

    // 提取英文单词
    const englishWords = text.match(/[a-zA-Z]{2,}/g);
    if (englishWords) {
      tokens.push(...englishWords.map((w) => w.toLowerCase()));
    }

    // 2-gram 补充
    const cleanText = text.replace(/\s+/g, '');
    for (let i = 0; i < cleanText.length - 1; i++) {
      tokens.push(cleanText.substring(i, i + 2));
    }

    return tokens;
  }

  /**
   * 合并两条记忆的内容
   * 保留较新的内容，补充旧内容中的独特信息
   */
  private mergeMemoryContent(
    newer: MemoryItem,
    older: MemoryItem
  ): MemoryContent {
    const textA =
      typeof newer.content === 'string'
        ? newer.content
        : JSON.stringify(newer.content);
    const textB =
      typeof older.content === 'string'
        ? older.content
        : JSON.stringify(older.content);

    // 如果两条记忆内容非常相似，直接保留较新的
    if (this.computeTextSimilarity(textA, textB) > 0.9) {
      return newer.content;
    }

    // 否则合并为结构化摘要
    return {
      type: 'merged_memory',
      primary: newer.content,
      supplementary: older.content,
      mergedAt: new Date().toISOString(),
      reason: '自动去重合并',
    };
  }

  /**
   * 将记忆转为文本（用于相似度计算）
   */
  private memoryToText(memory: MemoryItem): string {
    if (typeof memory.content === 'string') return memory.content;
    if (
      memory.content &&
      typeof memory.content === 'object' &&
      !Array.isArray(memory.content)
    ) {
      const obj = memory.content as Record<string, unknown>;
      if (obj.input && typeof obj.input === 'string') return obj.input;
      if (obj.summary && typeof obj.summary === 'string') return obj.summary;
      if (obj.primary && typeof obj.primary === 'string') return obj.primary;
    }
    return JSON.stringify(memory.content);
  }

  /**
   * 获取做梦统计信息
   */
  public getDreamStats(): typeof this.dreamStats {
    return { ...this.dreamStats };
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

  private async waitForBackpressure(): Promise<void> {
    if (this.writeQueue.length < this.HIGH_WATERMARK) {
      return;
    }

    Logger.warn(
      `写入队列水位过高(${this.writeQueue.length}/${this.MAX_WRITE_QUEUE_SIZE})，启动背压等待`,
      'MemoryEngine'
    );

    return new Promise<void>((resolve) => {
      this.writeQueueBackpressureResolvers.push(resolve);
    });
  }

  private notifyBackpressureRelieved(): void {
    if (this.writeQueue.length >= this.HIGH_WATERMARK) {
      return;
    }

    const resolvers = this.writeQueueBackpressureResolvers;
    this.writeQueueBackpressureResolvers = [];
    resolvers.forEach((resolve) => resolve());

    if (this.writeQueue.length === 0) {
      const drainWaiters = this.writeQueueDrainWaiters;
      this.writeQueueDrainWaiters = [];
      drainWaiters.forEach((resolve) => resolve());
    }
  }

  public getWriteQueueStats(): {
    queueLength: number;
    maxQueueSize: number;
    highWatermark: number;
    isWriting: boolean;
    backpressureActive: boolean;
  } {
    return {
      queueLength: this.writeQueue.length,
      maxQueueSize: this.MAX_WRITE_QUEUE_SIZE,
      highWatermark: this.HIGH_WATERMARK,
      isWriting: this.isWriting,
      backpressureActive: this.writeQueue.length >= this.HIGH_WATERMARK,
    };
  }

  public async waitForDrain(): Promise<void> {
    if (this.writeQueue.length === 0 && !this.isWriting) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.writeQueueDrainWaiters.push(resolve);
    });
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

        this.notifyBackpressureRelieved();
      }
    } catch (error) {
      Logger.error('写入队列处理失败:', error as Error, 'MemoryEngine');
    } finally {
      this.isWriting = false;
      this.notifyBackpressureRelieved();
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

  /**
   * 识别知识缺口（委托KnowledgeGraphBuilder.identifyGaps）
   * @param userId - 用户ID
   * @param limit - 记忆数量限制
   * @returns 知识缺口列表
   */
  public async identifyKnowledgeGaps(
    userId?: string,
    limit: number = 100
  ): Promise<Array<{ entity: string; reason: string; confidence: number }>> {
    const memories = await this.getAllMemories(userId, limit);
    return this.knowledgeGraphBuilder.identifyGaps(memories);
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
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
      this.dreamTimer = null;
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
