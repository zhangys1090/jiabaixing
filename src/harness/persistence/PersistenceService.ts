/**
 * Harness Layer 4: Persistence - 统一持久化服务
 *
 * 统一包装分散在 MemoryEngine/ConversationHistoryManager/ChatService/EventBus/UserProfile 等模块的持久化逻辑
 * 新增跨会话任务状态管理
 */

import { Logger } from '../../utils/Logger';
import type { ChatMessage } from '../types';
import fs from 'fs';
import path from 'path';

// ============ 类型定义 ============

/** 记忆存储选项 */
export interface MemoryStoreOptions {
  type?: 'instant' | 'short_term' | 'long_term';
  scene?: string;
  emotion?: string;
  traceId?: string;
  source?: string;
  importance?: number;
}

/** 记忆检索选项 */
export interface MemoryRecallOptions {
  limit?: number;
  scene?: string;
  emotion?: string;
  startTime?: number;
  endTime?: number;
}

/** 记忆条目 */
export interface MemoryItem {
  id: string;
  content: string;
  type: string;
  timestamp: number;
  scene?: string;
  emotion?: string;
  relevanceScore?: number;
  importance?: number;
  accessCount?: number;
  lastAccessedAt?: number;
}

/** 跨会话任务状态 */
export interface TaskState {
  taskId: string;
  userId: string;
  description: string;
  status: 'pending' | 'in_progress' | 'paused' | 'completed' | 'failed';
  planJson?: string;
  currentStepIndex: number;
  stepResultsJson?: string;
  createdAt: number;
  updatedAt: number;
  resumeContext?: string;
}

/** 用户画像 */
export interface UserProfile {
  name?: string;
  preferences: Record<string, string[]>;
  facts: string[];
  communicationStyle?: string;
  activeHours?: string;
  lastUpdated: number;
}

/** 进化指标 */
export interface EvolutionMetric {
  metricType: string;
  value: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ============ 持久化依赖 ============

/** PersistenceService 依赖 — 委托给现有模块 */
export interface PersistenceServiceDeps {
  /** 记忆引擎 */
  memoryEngine?: {
    storeShortTermMemory(
      content: string,
      scene?: string,
      emotion?: string
    ): Promise<unknown>;
    storeLongTermMemory(
      content: string,
      scene?: string,
      emotion?: string
    ): Promise<unknown>;
    storeInstantMemory(
      content: string,
      scene?: string,
      emotion?: string
    ): Promise<unknown>;
    preciseHybridRetrieval(query: {
      query: string;
      scene?: string;
      emotion?: string;
      topK?: number;
    }): Promise<MemoryItem[]>;
    storeFeedbackSignal(data: {
      feedbackType: string;
      rating?: number;
      message?: string;
      traceId?: string;
      toolName?: string;
      userId?: string;
      timestamp?: number;
    }): Promise<void>;
  } | null;

  /** 对话历史管理器 */
  conversationHistory?: {
    addUserMessage(content: string): void;
    addAssistantMessage(content: string): void;
    getRecent(count?: number): Array<{ role: string; content: string }>;
    formatForLLM(): Array<{ role: string; content: string }>;
    saveState(): Promise<void>;
    clear(): Promise<void>;
  } | null;

  /** 用户画像 */
  userProfile?: {
    load(): Promise<void>;
    save(): Promise<void>;
    getData(): UserProfile | null;
    update(data: Partial<UserProfile>): Promise<void>;
  } | null;
}

export class PersistenceService {
  private deps: PersistenceServiceDeps;
  /** 跨会话任务状态 — 内存缓存 + 文件持久化 */
  private taskStates: Map<string, TaskState> = new Map();
  /** 进化指标 — 内存缓存 */
  private evolutionMetrics: EvolutionMetric[] = [];
  private initialized = false;
  private taskStatesPath: string;
  private evolutionMetricsPath: string;
  private evolutionMetricsSinceLastFlush = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: PersistenceServiceDeps, dataDir?: string) {
    this.deps = deps;
    const baseDir =
      dataDir || path.resolve(process.cwd(), 'data', 'persistence');
    this.taskStatesPath = path.join(baseDir, 'task-states.json');
    this.evolutionMetricsPath = path.join(baseDir, 'evolution-metrics.json');
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    Logger.info('💾 PersistenceService 初始化', 'PersistenceService');
    await this.loadTaskStatesFromDisk();
    await this.loadEvolutionMetricsFromDisk();
    this.flushTimer = setInterval(() => {
      void this.flushTaskStatesToDisk();
      void this.flushEvolutionMetricsToDisk();
      this.promoteMemories().catch((err: Error) => {
        Logger.error('定时记忆晋升失败', err, 'PersistenceService');
      });
    }, 30_000);
    this.initialized = true;
  }

  // ============ 记忆 CRUD ============

  /**
   * 存储记忆
   */
  async storeMemory(
    content: string,
    options: MemoryStoreOptions = {}
  ): Promise<string> {
    const { type = 'short_term', scene, emotion } = options;

    if (!this.deps.memoryEngine) {
      Logger.warn('记忆引擎不可用，跳过存储', 'PersistenceService');
      return '';
    }

    try {
      switch (type) {
        case 'instant':
          await this.deps.memoryEngine.storeInstantMemory(
            content,
            scene,
            emotion
          );
          break;
        case 'long_term':
          await this.deps.memoryEngine.storeLongTermMemory(
            content,
            scene,
            emotion
          );
          break;
        default:
          await this.deps.memoryEngine.storeShortTermMemory(
            content,
            scene,
            emotion
          );
      }
      return 'stored';
    } catch (err) {
      Logger.error('记忆存储失败', err as Error, 'PersistenceService');
      return '';
    }
  }

  /**
   * 检索记忆
   */
  async recallMemory(
    query: string,
    options: MemoryRecallOptions = {}
  ): Promise<MemoryItem[]> {
    if (!this.deps.memoryEngine) return [];

    try {
      return await this.deps.memoryEngine.preciseHybridRetrieval({
        query,
        scene: options.scene,
        emotion: options.emotion,
        topK: options.limit || 5,
      });
    } catch (err) {
      Logger.error('记忆检索失败', err as Error, 'PersistenceService');
      return [];
    }
  }

  /**
   * 存储反馈信号
   */
  async storeFeedback(data: {
    feedbackType: string;
    rating?: number;
    message?: string;
    traceId?: string;
    toolName?: string;
  }): Promise<void> {
    if (!this.deps.memoryEngine) return;

    try {
      await this.deps.memoryEngine.storeFeedbackSignal({
        ...data,
        timestamp: Date.now(),
      });
    } catch (err) {
      Logger.error('反馈存储失败', err as Error, 'PersistenceService');
    }
  }

  // ============ 记忆生命周期管理 ============

  /**
   * 晋升短期记忆为长期记忆
   *
   * 扫描短期记忆，将满足以下条件之一的记忆晋升为长期记忆：
   * - importance >= 7（高重要性）
   * - accessCount >= 3（频繁访问）
   *
   * 晋升后从短期存储中移除已晋升的条目
   *
   * @returns 晋升的记忆数量
   */
  async promoteMemories(): Promise<number> {
    if (!this.deps.memoryEngine) {
      Logger.warn('记忆引擎不可用，跳过晋升', 'PersistenceService');
      return 0;
    }

    try {
      const shortTermMemories =
        await this.deps.memoryEngine.preciseHybridRetrieval({
          query: '',
          topK: 100,
        });

      const candidates = shortTermMemories.filter(
        (m) =>
          m.type === 'short_term' &&
          ((m.importance != null && m.importance >= 7) ||
            (m.accessCount != null && m.accessCount >= 3))
      );

      if (candidates.length === 0) {
        return 0;
      }

      let promoted = 0;
      for (const memory of candidates) {
        try {
          await this.deps.memoryEngine.storeLongTermMemory(
            memory.content,
            memory.scene,
            memory.emotion
          );
          promoted++;
          Logger.info(
            `💾 记忆晋升: id=${memory.id} importance=${memory.importance ?? '-'} accessCount=${memory.accessCount ?? '-'}`,
            'PersistenceService'
          );
        } catch (err) {
          Logger.error(
            `记忆晋升失败: id=${memory.id}`,
            err as Error,
            'PersistenceService'
          );
        }
      }

      if (promoted > 0) {
        Logger.info(
          `💾 记忆晋升完成: ${promoted}/${candidates.length} 条记忆已晋升为长期记忆`,
          'PersistenceService'
        );
      }

      return promoted;
    } catch (err) {
      Logger.error('记忆晋升扫描失败', err as Error, 'PersistenceService');
      return 0;
    }
  }

  // ============ 对话历史 ============

  /**
   * 保存对话消息
   */
  saveConversationMessage(role: 'user' | 'assistant', content: string): void {
    if (!this.deps.conversationHistory) return;

    if (role === 'user') {
      this.deps.conversationHistory.addUserMessage(content);
    } else {
      this.deps.conversationHistory.addAssistantMessage(content);
    }
  }

  /**
   * 获取对话历史
   */
  getConversationHistory(limit?: number): ChatMessage[] {
    if (!this.deps.conversationHistory) return [];

    const recent = this.deps.conversationHistory.getRecent(limit || 20);
    return recent.map((entry) => ({
      role: entry.role as ChatMessage['role'],
      content: entry.content,
    }));
  }

  /**
   * 持久化对话状态
   */
  async saveConversationState(): Promise<void> {
    if (!this.deps.conversationHistory) return;
    try {
      await this.deps.conversationHistory.saveState();
    } catch (err) {
      Logger.error('对话状态保存失败', err as Error, 'PersistenceService');
    }
  }

  /**
   * 清空对话历史
   */
  async clearConversation(): Promise<void> {
    if (!this.deps.conversationHistory) return;
    try {
      await this.deps.conversationHistory.clear();
    } catch (err) {
      Logger.error('对话清空失败', err as Error, 'PersistenceService');
    }
  }

  // ============ 跨会话任务状态（新增） ============

  /**
   * 保存任务状态
   */
  async saveTaskState(task: TaskState): Promise<void> {
    task.updatedAt = Date.now();
    this.taskStates.set(task.taskId, task);
    Logger.info(
      `💾 任务状态保存: ${task.taskId} status=${task.status}`,
      'PersistenceService'
    );
    await this.flushTaskStatesToDisk();
  }

  /**
   * 加载任务状态
   */
  async loadTaskState(taskId: string): Promise<TaskState | null> {
    return this.taskStates.get(taskId) || null;
  }

  /**
   * 列出活跃任务
   */
  async listActiveTasks(): Promise<TaskState[]> {
    return Array.from(this.taskStates.values()).filter(
      (t) =>
        t.status === 'pending' ||
        t.status === 'in_progress' ||
        t.status === 'paused'
    );
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskState['status'],
    resumeContext?: string
  ): Promise<boolean> {
    const task = this.taskStates.get(taskId);
    if (!task) return false;

    task.status = status;
    task.updatedAt = Date.now();
    if (resumeContext) task.resumeContext = resumeContext;
    await this.flushTaskStatesToDisk();
    return true;
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<boolean> {
    const deleted = this.taskStates.delete(taskId);
    if (deleted) {
      await this.flushTaskStatesToDisk();
    }
    return deleted;
  }

  // ============ 用户画像 ============

  /**
   * 加载用户画像
   */
  async loadUserProfile(): Promise<UserProfile | null> {
    if (!this.deps.userProfile) return null;

    try {
      await this.deps.userProfile.load();
      return this.deps.userProfile.getData();
    } catch (err) {
      Logger.error('用户画像加载失败', err as Error, 'PersistenceService');
      return null;
    }
  }

  /**
   * 保存用户画像
   */
  async saveUserProfile(data: Partial<UserProfile>): Promise<void> {
    if (!this.deps.userProfile) return;

    try {
      await this.deps.userProfile.update(data);
    } catch (err) {
      Logger.error('用户画像保存失败', err as Error, 'PersistenceService');
    }
  }

  // ============ 进化指标 ============

  /**
   * 记录进化指标
   */
  recordEvolutionMetric(metric: EvolutionMetric): void {
    this.evolutionMetrics.push(metric);
    if (this.evolutionMetrics.length > 1000) {
      this.evolutionMetrics = this.evolutionMetrics.slice(-1000);
    }
    this.evolutionMetricsSinceLastFlush++;
    if (this.evolutionMetricsSinceLastFlush >= 10) {
      void this.flushEvolutionMetricsToDisk();
    }
  }

  /**
   * 获取进化指标
   */
  getEvolutionMetrics(metricType?: string, limit?: number): EvolutionMetric[] {
    let metrics = this.evolutionMetrics;
    if (metricType) {
      metrics = metrics.filter((m) => m.metricType === metricType);
    }
    if (limit) {
      metrics = metrics.slice(-limit);
    }
    return metrics;
  }

  // ============ 生命周期 ============

  /**
   * 关闭
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushTaskStatesToDisk();
    await this.flushEvolutionMetricsToDisk();
    Logger.info('💾 PersistenceService 关闭', 'PersistenceService');
    this.initialized = false;
  }

  // ============ 文件持久化 ============

  /**
   * 将任务状态写入磁盘
   */
  private async flushTaskStatesToDisk(): Promise<void> {
    try {
      const dir = path.dirname(this.taskStatesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.taskStates.values());
      fs.writeFileSync(
        this.taskStatesPath,
        JSON.stringify(data, null, 2),
        'utf-8'
      );
    } catch (err) {
      Logger.error('任务状态刷盘失败', err as Error, 'PersistenceService');
    }
  }

  /**
   * 从磁盘加载任务状态
   */
  private async loadTaskStatesFromDisk(): Promise<void> {
    try {
      if (!fs.existsSync(this.taskStatesPath)) {
        Logger.info('💾 无持久化任务状态文件，跳过加载', 'PersistenceService');
        return;
      }
      const raw = fs.readFileSync(this.taskStatesPath, 'utf-8');
      const data = JSON.parse(raw) as TaskState[];
      for (const task of data) {
        this.taskStates.set(task.taskId, task);
      }
      Logger.info(
        `💾 已从磁盘加载 ${data.length} 个任务状态`,
        'PersistenceService'
      );
    } catch (err) {
      Logger.error('任务状态加载失败', err as Error, 'PersistenceService');
    }
  }

  private async flushEvolutionMetricsToDisk(): Promise<void> {
    try {
      const dir = path.dirname(this.evolutionMetricsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.evolutionMetricsPath,
        JSON.stringify(this.evolutionMetrics, null, 2),
        'utf-8'
      );
      this.evolutionMetricsSinceLastFlush = 0;
    } catch (err) {
      Logger.error('进化指标刷盘失败', err as Error, 'PersistenceService');
    }
  }

  private async loadEvolutionMetricsFromDisk(): Promise<void> {
    try {
      if (!fs.existsSync(this.evolutionMetricsPath)) {
        Logger.info('💾 无持久化进化指标文件，跳过加载', 'PersistenceService');
        return;
      }
      const raw = fs.readFileSync(this.evolutionMetricsPath, 'utf-8');
      const data = JSON.parse(raw) as EvolutionMetric[];
      this.evolutionMetrics = data.slice(-1000);
      Logger.info(
        `💾 已从磁盘加载 ${this.evolutionMetrics.length} 条进化指标`,
        'PersistenceService'
      );
    } catch (err) {
      Logger.error('进化指标加载失败', err as Error, 'PersistenceService');
    }
  }
}
