import { createDatabase, nativeAvailable } from './DatabaseShim';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { type EventMap } from './eventTypes';

export type EventName = keyof EventMap;
export type EventPayload<T extends EventName> = EventMap[T];

/** Agent 描述信息 */
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  status: 'idle' | 'busy' | 'offline';
  lastHeartbeat: number;
  metadata?: Record<string, unknown>;
}

/** Agent 间通信消息 */
export interface AgentMessage {
  id: string;
  from: string;
  to?: string;
  topic: string;
  type: 'request' | 'response' | 'notification' | 'broadcast';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  payload: unknown;
  replyTo?: string;
  ttl?: number;
  timestamp: number;
}

interface PersistedEvent {
  id: number;
  event_name: string;
  payload: string;
  timestamp: number;
  session_id: string | null;
}

interface EventBusOptions {
  dbPath?: string;
  maxListeners?: number;
  persistentEvents?: string[];
  maxEventAge?: number;
}

const DEFAULT_PERSISTENT_EVENTS = [
  'user_input',
  'task_completed',
  'task_started',
  'task_failed',
  'context_update',
  'ws_send',
  'ws_receive',
];

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'event_bus.db');

class JiabaixingEventBus extends EventEmitter {
  private static instance: JiabaixingEventBus | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any | null = null;
  private persistentEvents: Set<string>;
  private maxEventAge: number;
  private sessionId: string | null = null;

  private activeTraces: Map<
    string,
    { eventName: string; startTime: number; metadata?: Record<string, unknown> }
  > = new Map();
  private traceHistory: Array<{
    traceId: string;
    eventName: string;
    duration: number;
    success: boolean;
    timestamp: number;
  }> = [];
  private readonly MAX_TRACE_HISTORY = 1000;

  // ==================== Harness Engineering: 全链路可观测性 ====================

  /** Token 消耗追踪 */
  private tokenUsage: Array<{
    traceId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    timestamp: number;
  }> = [];
  private readonly MAX_TOKEN_RECORDS = 5000;

  /** 工具调用追踪 */
  private toolCallRecords: Array<{
    traceId: string;
    toolName: string;
    success: boolean;
    duration: number;
    tokenCost?: number;
    timestamp: number;
  }> = [];
  private readonly MAX_TOOL_CALL_RECORDS = 5000;

  /** 全链路追踪：从用户输入到最终响应 */
  private fullTraces: Map<string, {
    traceId: string;
    startTime: number;
    endTime?: number;
    phases: Array<{
      phase: string;
      startTime: number;
      endTime?: number;
      duration?: number;
      success?: boolean;
      metadata?: Record<string, unknown>;
    }>;
    totalTokens: number;
    totalToolCalls: number;
    status: 'running' | 'completed' | 'failed';
  }> = new Map();
  private readonly MAX_FULL_TRACES = 100;

  private constructor(options?: EventBusOptions) {
    super();
    this.setMaxListeners(options?.maxListeners ?? 100);
    this.persistentEvents = new Set(
      options?.persistentEvents ?? DEFAULT_PERSISTENT_EVENTS
    );
    this.maxEventAge = options?.maxEventAge ?? 86400000 * 7;

    this.initializeDatabase(options?.dbPath ?? DEFAULT_DB_PATH);
    this.cleanupOldEvents();
  }

  public static getInstance(options?: EventBusOptions): JiabaixingEventBus {
    if (!JiabaixingEventBus.instance) {
      JiabaixingEventBus.instance = new JiabaixingEventBus(options);
    }
    return JiabaixingEventBus.instance;
  }

  public static resetInstance(): void {
    if (JiabaixingEventBus.instance) {
      JiabaixingEventBus.instance.destroy();
      JiabaixingEventBus.instance = null;
    }
  }

  private initializeDatabase(dbPath: string): void {
    try {
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = createDatabase(dbPath) as any;
      if (this.db) {
        try { this.db.pragma('journal_mode = WAL'); } catch {}
        try { this.db.pragma('synchronous = NORMAL'); } catch {}

        this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_name TEXT NOT NULL,
          payload TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          session_id TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        );

        CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      `);
      }
    } catch (error) {
      Logger.error('EventBus数据库初始化失败:', error as Error, 'EventBus');
      this.db = null;
    }
  }

  private cleanupOldEvents(): void {
    if (!this.db) return;

    try {
      const cutoff = Date.now() - this.maxEventAge;
      const stmt = this.db.prepare('DELETE FROM events WHERE timestamp < ?');
      const deleted = stmt.run(cutoff);
      if (deleted.changes > 0) {
        Logger.info(`EventBus清理了${deleted.changes}条过期事件`, 'EventBus');
      }
    } catch (error) {
      Logger.error('EventBus清理过期事件失败:', error as Error, 'EventBus');
    }
  }

  override emit<T extends EventName>(
    eventName: T,
    ...args: EventPayload<T>
  ): boolean {
    // 异步持久化，不阻塞事件广播
    if (this.persistentEvents.has(eventName)) {
      setImmediate(() => {
        this.persistEvent(eventName, args);
      });
    }

    // 事件广播本身是同步的，但我们已经把持久化移到异步了
    return super.emit(eventName, ...args);
  }

  on<T extends EventName>(
    eventName: T,
    listener: (...args: EventPayload<T>) => void
  ): this {
    return super.on(eventName, listener as (...args: unknown[]) => void);
  }

  once<T extends EventName>(
    eventName: T,
    listener: (...args: EventPayload<T>) => void
  ): this {
    return super.once(eventName, listener as (...args: unknown[]) => void);
  }

  off<T extends EventName>(
    eventName: T,
    listener: (...args: EventPayload<T>) => void
  ): this {
    return super.off(eventName, listener as (...args: unknown[]) => void);
  }

  private persistQueue: Array<{ eventName: string; args: unknown[] }> = [];
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_INTERVAL_MS = 100;
  private readonly MAX_BATCH_SIZE = 50;

  private persistEvent(eventName: string, args: unknown[]): void {
    this.persistQueue.push({ eventName, args });

    if (this.persistQueue.length >= this.MAX_BATCH_SIZE) {
      this.flushPersistQueue();
    } else if (!this.persistTimer) {
      this.persistTimer = setTimeout(
        () => this.flushPersistQueue(),
        this.BATCH_INTERVAL_MS
      );
    }
  }

  private flushPersistQueue(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (this.persistQueue.length === 0 || !this.db) {
      this.persistQueue = [];
      return;
    }

    const batch = this.persistQueue.splice(0, this.MAX_BATCH_SIZE);

    try {
      const insertStmt = this.db.prepare(
        'INSERT INTO events (event_name, payload, timestamp, session_id) VALUES (?, ?, ?, ?)'
      );

      const insertMany = this.db.transaction(
        (
          events: Array<{
            event_name: string;
            payload: string;
            timestamp: number;
            session_id: string | null;
          }>
        ) => {
          for (const event of events) {
            insertStmt.run(
              event.event_name,
              event.payload,
              event.timestamp,
              event.session_id
            );
          }
        }
      );

      const events = batch.map(({ eventName, args }) => ({
        event_name: eventName,
        payload: JSON.stringify(args),
        timestamp: Date.now(),
        session_id: this.sessionId,
      }));

      insertMany(events);
    } catch (error) {
      Logger.error(`EventBus批量持久化事件失败`, error as Error, 'EventBus');
      // 限制重试次数：如果队列已超过 MAX_BATCH_SIZE * 5 条，丢弃最旧的失败批次
      if (this.persistQueue.length > this.MAX_BATCH_SIZE * 5) {
        Logger.warn(
          `EventBus持久化队列过长(${this.persistQueue.length}条)，丢弃旧事件`,
          'EventBus'
        );
      } else {
        this.persistQueue.unshift(...batch);
      }
    }
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getRecentEvents(eventName: string, limit = 50): PersistedEvent[] {
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(
        'SELECT id, event_name, payload, timestamp, session_id FROM events WHERE event_name = ? ORDER BY timestamp DESC LIMIT ?'
      );
      return stmt.all(eventName, limit) as PersistedEvent[];
    } catch (error) {
      Logger.error(
        `EventBus查询事件失败: ${eventName}`,
        error as Error,
        'EventBus'
      );
      return [];
    }
  }

  getContextForRecovery(): Record<string, unknown[]> {
    if (!this.db) return {};

    const context: Record<string, unknown[]> = {};

    try {
      for (const eventName of this.persistentEvents) {
        const recentEvents = this.getRecentEvents(eventName, 20);
        context[eventName] = recentEvents.map((event) => {
          try {
            return JSON.parse(event.payload);
          } catch {
            return event.payload;
          }
        });
      }
    } catch (error) {
      Logger.error('EventBus恢复上下文失败:', error as Error, 'EventBus');
    }

    return context;
  }

  emitRecoveredEvents(): void {
    const context = this.getContextForRecovery();

    for (const [eventName, payloads] of Object.entries(context)) {
      for (const payload of payloads.reverse()) {
        const args = Array.isArray(payload) ? payload : [payload];
        super.emit(`recovered:${eventName}`, ...args);
      }
    }
  }

  clearEvents(eventName?: string): void {
    if (!this.db) return;

    try {
      if (eventName) {
        const stmt = this.db.prepare('DELETE FROM events WHERE event_name = ?');
        stmt.run(eventName);
      } else {
        const stmt = this.db.prepare('DELETE FROM events');
        stmt.run();
      }
    } catch (error) {
      Logger.error('EventBus清理事件失败:', error as Error, 'EventBus');
    }
  }

  getEventCount(eventName?: string): number {
    if (!this.db) return 0;

    try {
      const sql = eventName
        ? 'SELECT COUNT(*) as count FROM events WHERE event_name = ?'
        : 'SELECT COUNT(*) as count FROM events';
      const stmt = this.db?.prepare(sql);
      const result = eventName ? stmt?.get(eventName) : stmt?.get();
      return (result as { count: number })?.count || 0;
    } catch (error) {
      Logger.error('EventBus查询事件数量失败:', error as Error, 'EventBus');
      return 0;
    }
  }

  startTrace(
    traceId: string,
    eventName: string,
    metadata?: Record<string, unknown>
  ): void {
    this.activeTraces.set(traceId, {
      eventName,
      startTime: Date.now(),
      metadata,
    });

    super.emit('trace_started', {
      traceId,
      eventName,
      timestamp: new Date().toISOString(),
    });
  }

  completeTrace(traceId: string, success: boolean = true): void {
    const trace = this.activeTraces.get(traceId);
    if (!trace) {
      Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
      return;
    }

    const duration = Date.now() - trace.startTime;

    this.traceHistory.push({
      traceId,
      eventName: trace.eventName,
      duration,
      success,
      timestamp: Date.now(),
    });

    if (this.traceHistory.length > this.MAX_TRACE_HISTORY) {
      this.traceHistory = this.traceHistory.slice(-this.MAX_TRACE_HISTORY);
    }

    this.activeTraces.delete(traceId);

    super.emit('trace_completed', {
      traceId,
      eventName: trace.eventName,
      duration,
      success,
    });

    super.emit('event_traced', {
      eventName: trace.eventName,
      traceId,
      duration,
      success,
      timestamp: new Date().toISOString(),
      metadata: trace.metadata,
    });
  }

  failTrace(traceId: string, error: string): void {
    const trace = this.activeTraces.get(traceId);
    if (!trace) {
      Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
      return;
    }

    const duration = Date.now() - trace.startTime;

    this.traceHistory.push({
      traceId,
      eventName: trace.eventName,
      duration,
      success: false,
      timestamp: Date.now(),
    });

    if (this.traceHistory.length > this.MAX_TRACE_HISTORY) {
      this.traceHistory = this.traceHistory.slice(-this.MAX_TRACE_HISTORY);
    }

    this.activeTraces.delete(traceId);

    super.emit('trace_error', {
      traceId,
      eventName: trace.eventName,
      error,
      duration,
    });

    super.emit('event_traced', {
      eventName: trace.eventName,
      traceId,
      duration,
      success: false,
      timestamp: new Date().toISOString(),
      metadata: { ...trace.metadata, error },
    });
  }

  getTraceHistory(
    eventName?: string,
    limit: number = 50
  ): Array<{
    traceId: string;
    eventName: string;
    duration: number;
    success: boolean;
    timestamp: number;
  }> {
    let history = this.traceHistory;

    if (eventName) {
      history = history.filter((t) => t.eventName === eventName);
    }

    return history.slice(-limit);
  }

  getTraceStatistics(): {
    totalTraces: number;
    successRate: number;
    averageDuration: number;
    errorCount: number;
    eventNameStats: Record<
      string,
      { count: number; successRate: number; averageDuration: number }
    >;
  } {
    if (this.traceHistory.length === 0) {
      return {
        totalTraces: 0,
        successRate: 0,
        averageDuration: 0,
        errorCount: 0,
        eventNameStats: {},
      };
    }

    const successCount = this.traceHistory.filter((t) => t.success).length;
    const totalDuration = this.traceHistory.reduce(
      (sum, t) => sum + t.duration,
      0
    );

    const eventNameStats: Record<
      string,
      { count: number; successRate: number; averageDuration: number }
    > = {};

    // 先按eventName分组，避免O(n²)的循环内filter
    const grouped = new Map<
      string,
      Array<{ success: boolean; duration: number }>
    >();
    for (const trace of this.traceHistory) {
      if (!grouped.has(trace.eventName)) {
        grouped.set(trace.eventName, []);
      }
      grouped.get(trace.eventName)!.push({
        success: trace.success,
        duration: trace.duration,
      });
    }

    for (const [eventName, traces] of grouped) {
      const successCount = traces.filter((t) => t.success).length;
      const totalDuration = traces.reduce((sum, t) => sum + t.duration, 0);
      eventNameStats[eventName] = {
        count: traces.length,
        successRate: successCount / traces.length,
        averageDuration: totalDuration / traces.length,
      };
    }

    return {
      totalTraces: this.traceHistory.length,
      successRate: successCount / this.traceHistory.length,
      averageDuration: totalDuration / this.traceHistory.length,
      errorCount: this.traceHistory.length - successCount,
      eventNameStats,
    };
  }

  clearTraceHistory(): void {
    this.traceHistory = [];
    this.activeTraces.clear();
  }

  // ==================== Harness Engineering: 全链路可观测性方法 ====================

  /**
   * 记录 Token 消耗
   * @param traceId - 追踪ID
   * @param model - 模型名称
   * @param promptTokens - 输入 Token 数
   * @param completionTokens - 输出 Token 数
   */
  recordTokenUsage(
    traceId: string,
    model: string,
    promptTokens: number,
    completionTokens: number
  ): void {
    this.tokenUsage.push({
      traceId,
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      timestamp: Date.now(),
    });

    if (this.tokenUsage.length > this.MAX_TOKEN_RECORDS) {
      this.tokenUsage = this.tokenUsage.slice(-this.MAX_TOKEN_RECORDS);
    }

    // 更新全链路追踪的 Token 统计
    const fullTrace = this.fullTraces.get(traceId);
    if (fullTrace) {
      fullTrace.totalTokens += promptTokens + completionTokens;
    }
  }

  /**
   * 记录工具调用
   * @param traceId - 追踪ID
   * @param toolName - 工具名称
   * @param success - 是否成功
   * @param duration - 执行时长(ms)
   */
  recordToolCall(
    traceId: string,
    toolName: string,
    success: boolean,
    duration: number
  ): void {
    this.toolCallRecords.push({
      traceId,
      toolName,
      success,
      duration,
      timestamp: Date.now(),
    });

    if (this.toolCallRecords.length > this.MAX_TOOL_CALL_RECORDS) {
      this.toolCallRecords = this.toolCallRecords.slice(-this.MAX_TOOL_CALL_RECORDS);
    }

    // 更新全链路追踪的工具调用统计
    const fullTrace = this.fullTraces.get(traceId);
    if (fullTrace) {
      fullTrace.totalToolCalls++;
    }
  }

  /**
   * 开始全链路追踪
   * @param traceId - 追踪ID
   */
  startFullTrace(traceId: string): void {
    if (this.fullTraces.size >= this.MAX_FULL_TRACES) {
      // 移除最早的已完成追踪
      const oldestKey = this.fullTraces.keys().next().value;
      if (oldestKey) this.fullTraces.delete(oldestKey);
    }

    this.fullTraces.set(traceId, {
      traceId,
      startTime: Date.now(),
      phases: [],
      totalTokens: 0,
      totalToolCalls: 0,
      status: 'running',
    });
  }

  /**
   * 添加全链路追踪阶段
   * @param traceId - 追踪ID
   * @param phase - 阶段名称（如 planning, executing, evaluating, reporting）
   * @param metadata - 阶段元数据
   */
  addTracePhase(
    traceId: string,
    phase: string,
    metadata?: Record<string, unknown>
  ): void {
    const fullTrace = this.fullTraces.get(traceId);
    if (!fullTrace) return;

    fullTrace.phases.push({
      phase,
      startTime: Date.now(),
      metadata,
    });
  }

  /**
   * 完成全链路追踪阶段
   * @param traceId - 追踪ID
   * @param phase - 阶段名称
   * @param success - 是否成功
   */
  completeTracePhase(
    traceId: string,
    phase: string,
    success: boolean
  ): void {
    const fullTrace = this.fullTraces.get(traceId);
    if (!fullTrace) return;

    const phaseRecord = fullTrace.phases.find(
      (p) => p.phase === phase && !p.endTime
    );
    if (phaseRecord) {
      phaseRecord.endTime = Date.now();
      phaseRecord.duration = phaseRecord.endTime - phaseRecord.startTime;
      phaseRecord.success = success;
    }
  }

  /**
   * 完成全链路追踪
   * @param traceId - 追踪ID
   * @param status - 最终状态
   */
  completeFullTrace(
    traceId: string,
    status: 'completed' | 'failed'
  ): void {
    const fullTrace = this.fullTraces.get(traceId);
    if (!fullTrace) return;

    fullTrace.endTime = Date.now();
    fullTrace.status = status;
  }

  /**
   * 获取 Token 消耗统计
   * @param hours - 统计最近几小时的数据
   */
  getTokenUsageStats(hours: number = 24): {
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    byModel: Record<string, { tokens: number; calls: number; avgTokens: number }>;
    byHour: Array<{ hour: string; tokens: number }>;
  } {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const recent = this.tokenUsage.filter((r) => r.timestamp >= cutoff);

    const totalTokens = recent.reduce((sum, r) => sum + r.totalTokens, 0);
    const totalPromptTokens = recent.reduce((sum, r) => sum + r.promptTokens, 0);
    const totalCompletionTokens = recent.reduce((sum, r) => sum + r.completionTokens, 0);

    // 按模型分组
    const byModel: Record<string, { tokens: number; calls: number; avgTokens: number }> = {};
    for (const record of recent) {
      if (!byModel[record.model]) {
        byModel[record.model] = { tokens: 0, calls: 0, avgTokens: 0 };
      }
      byModel[record.model].tokens += record.totalTokens;
      byModel[record.model].calls++;
    }
    for (const model of Object.keys(byModel)) {
      byModel[model].avgTokens = byModel[model].tokens / byModel[model].calls;
    }

    // 按小时分组
    const byHourMap = new Map<string, number>();
    for (const record of recent) {
      const hour = new Date(record.timestamp).toISOString().substring(0, 13);
      byHourMap.set(hour, (byHourMap.get(hour) || 0) + record.totalTokens);
    }
    const byHour = Array.from(byHourMap.entries())
      .map(([hour, tokens]) => ({ hour, tokens }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    return { totalTokens, totalPromptTokens, totalCompletionTokens, byModel, byHour };
  }

  /**
   * 获取工具调用统计
   * @param hours - 统计最近几小时的数据
   */
  getToolCallStats(hours: number = 24): {
    totalCalls: number;
    successRate: number;
    avgDuration: number;
    byTool: Record<string, { calls: number; successRate: number; avgDuration: number }>;
    slowestTools: Array<{ toolName: string; avgDuration: number }>;
    unreliableTools: Array<{ toolName: string; successRate: number }>;
  } {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const recent = this.toolCallRecords.filter((r) => r.timestamp >= cutoff);

    const totalCalls = recent.length;
    const successCount = recent.filter((r) => r.success).length;
    const totalDuration = recent.reduce((sum, r) => sum + r.duration, 0);

    // 按工具分组
    const byToolMap = new Map<string, { calls: number; successes: number; totalDuration: number }>();
    for (const record of recent) {
      const existing = byToolMap.get(record.toolName) || { calls: 0, successes: 0, totalDuration: 0 };
      existing.calls++;
      if (record.success) existing.successes++;
      existing.totalDuration += record.duration;
      byToolMap.set(record.toolName, existing);
    }

    const byTool: Record<string, { calls: number; successRate: number; avgDuration: number }> = {};
    for (const [toolName, stats] of byToolMap) {
      byTool[toolName] = {
        calls: stats.calls,
        successRate: stats.calls > 0 ? stats.successes / stats.calls : 0,
        avgDuration: stats.calls > 0 ? stats.totalDuration / stats.calls : 0,
      };
    }

    // 最慢的工具
    const slowestTools = Object.entries(byTool)
      .sort((a, b) => b[1].avgDuration - a[1].avgDuration)
      .slice(0, 5)
      .map(([toolName, stats]) => ({ toolName, avgDuration: stats.avgDuration }));

    // 最不可靠的工具
    const unreliableTools = Object.entries(byTool)
      .filter(([, stats]) => stats.calls >= 3 && stats.successRate < 0.9)
      .sort((a, b) => a[1].successRate - b[1].successRate)
      .map(([toolName, stats]) => ({ toolName, successRate: stats.successRate }));

    return {
      totalCalls,
      successRate: totalCalls > 0 ? successCount / totalCalls : 0,
      avgDuration: totalCalls > 0 ? totalDuration / totalCalls : 0,
      byTool,
      slowestTools,
      unreliableTools,
    };
  }

  /**
   * 获取全链路追踪详情
   * @param traceId - 追踪ID
   */
  getFullTrace(traceId: string): unknown {
    return this.fullTraces.get(traceId) || null;
  }

  /**
   * 获取所有全链路追踪列表
   */
  getFullTraces(): unknown[] {
    return Array.from(this.fullTraces.values());
  }

  // ==================== Harness Engineering: Agent 间通信 ====================

  /**
   * Agent 通信层 — 基于发布-订阅模式
   * 借鉴 EigenFlux：Agent 向网络广播信息，其他 Agent 按画像订阅
   *
   * 设计原则：
   * - 每个 Agent 有一个 profile（能力描述）
   * - Agent 可以广播消息（不需要知道接收者）
   * - Agent 可以按 topic 订阅感兴趣的消息
   * - 消息带有元数据（发送者、类型、优先级、过期时间）
   */

  /** Agent 注册信息 */
  private agentRegistry: Map<string, AgentProfile> = new Map();

  /** Agent 订阅关系：topic → Set<agentId> */
  private agentSubscriptions: Map<string, Set<string>> = new Map();

  /** Agent 消息队列：agentId → AgentMessage[] */
  private agentMailboxes: Map<string, AgentMessage[]> = new Map();

  /** 最大邮箱大小 */
  private readonly MAX_MAILBOX_SIZE = 100;

  /** 消息过期时间（默认5分钟） */
  private readonly MESSAGE_TTL = 5 * 60 * 1000;

  /**
   * 注册 Agent
   * @param profile - Agent 描述信息
   */
  registerAgent(profile: AgentProfile): void {
    this.agentRegistry.set(profile.id, profile);

    // 根据 capabilities 自动订阅相关 topic
    for (const capability of profile.capabilities) {
      const topic = this.capabilityToTopic(capability);
      if (!this.agentSubscriptions.has(topic)) {
        this.agentSubscriptions.set(topic, new Set());
      }
      this.agentSubscriptions.get(topic)!.add(profile.id);
    }

    // 初始化邮箱
    if (!this.agentMailboxes.has(profile.id)) {
      this.agentMailboxes.set(profile.id, []);
    }
  }

  /**
   * 注销 Agent
   * @param agentId - Agent ID
   */
  unregisterAgent(agentId: string): void {
    this.agentRegistry.delete(agentId);
    this.agentMailboxes.delete(agentId);

    // 从所有订阅中移除
    for (const subscribers of this.agentSubscriptions.values()) {
      subscribers.delete(agentId);
    }
  }

  /**
   * Agent 广播消息
   * @param message - 消息内容
   */
  broadcastAgentMessage(message: Omit<AgentMessage, 'id' | 'timestamp'>): string {
    const fullMessage: AgentMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      timestamp: Date.now(),
      ...message,
    };

    // 投递到订阅了相关 topic 的 Agent 邮箱
    const topic = message.topic;
    const subscribers = this.agentSubscriptions.get(topic);

    if (subscribers) {
      for (const agentId of subscribers) {
        if (agentId === message.from) continue; // 不投递给自己

        const mailbox = this.agentMailboxes.get(agentId);
        if (mailbox) {
          mailbox.push(fullMessage);

          // 邮箱大小限制
          if (mailbox.length > this.MAX_MAILBOX_SIZE) {
            mailbox.shift();
          }
        }
      }
    }

    // 同时通过 EventEmitter 原生事件系统广播（绕过 EventMap 类型限制）
    super.emit.call(this, `agent:message:${topic}`, {
      messageId: fullMessage.id,
      from: message.from,
      topic,
      type: message.type,
      priority: message.priority,
    });

    return fullMessage.id;
  }

  /**
   * Agent 获取未读消息
   * @param agentId - Agent ID
   * @param topic - 可选，只获取特定 topic 的消息
   */
  getAgentMessages(agentId: string, topic?: string): AgentMessage[] {
    const mailbox = this.agentMailboxes.get(agentId) || [];

    // 过滤过期消息
    const now = Date.now();
    const validMessages = mailbox.filter(
      (msg) => now - msg.timestamp < (msg.ttl || this.MESSAGE_TTL)
    );

    // 更新邮箱（移除过期消息）
    this.agentMailboxes.set(agentId, validMessages);

    if (topic) {
      return validMessages.filter((msg) => msg.topic === topic);
    }
    return validMessages;
  }

  /**
   * Agent 消费消息（获取后从邮箱移除）
   * @param agentId - Agent ID
   * @param messageId - 消息 ID
   */
  consumeAgentMessage(agentId: string, messageId: string): AgentMessage | null {
    const mailbox = this.agentMailboxes.get(agentId);
    if (!mailbox) return null;

    const index = mailbox.findIndex((msg) => msg.id === messageId);
    if (index === -1) return null;

    const [message] = mailbox.splice(index, 1);
    return message;
  }

  /**
   * Agent 订阅特定 topic
   * @param agentId - Agent ID
   * @param topic - 订阅的 topic
   */
  subscribeAgentToTopic(agentId: string, topic: string): void {
    if (!this.agentSubscriptions.has(topic)) {
      this.agentSubscriptions.set(topic, new Set());
    }
    this.agentSubscriptions.get(topic)!.add(agentId);
  }

  /**
   * Agent 取消订阅
   * @param agentId - Agent ID
   * @param topic - 取消订阅的 topic
   */
  unsubscribeAgentFromTopic(agentId: string, topic: string): void {
    const subscribers = this.agentSubscriptions.get(topic);
    if (subscribers) {
      subscribers.delete(agentId);
    }
  }

  /**
   * 获取已注册的 Agent 列表
   */
  getRegisteredAgents(): AgentProfile[] {
    return Array.from(this.agentRegistry.values());
  }

  /**
   * 根据 capability 查找可用的 Agent
   * @param capability - 需要的能力
   */
  findAgentsByCapability(capability: string): AgentProfile[] {
    return Array.from(this.agentRegistry.values()).filter(
      (profile) => profile.capabilities.includes(capability)
    );
  }

  /**
   * 将 capability 映射为 topic
   */
  private capabilityToTopic(capability: string): string {
    const topicMap: Record<string, string> = {
      'code_generation': 'code',
      'code_review': 'code',
      'code_analysis': 'code',
      'file_operations': 'file',
      'web_search': 'network',
      'web_fetch': 'network',
      'memory_operations': 'memory',
      'shell_execution': 'system',
      'desktop_automation': 'desktop',
      'voice_interaction': 'voice',
      'task_planning': 'planning',
      'quality_evaluation': 'evaluation',
    };

    return topicMap[capability] || capability;
  }

  destroy(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        Logger.error('EventBus关闭数据库失败:', error as Error, 'EventBus');
      }
      this.db = null;
    }
    this.removeAllListeners();
    this.clearTraceHistory();
  }
}

let _eventBusInstance: JiabaixingEventBus | null = null;

export function getEventBus(options?: EventBusOptions): JiabaixingEventBus {
  if (!_eventBusInstance) {
    _eventBusInstance = JiabaixingEventBus.getInstance(options);
  }
  return _eventBusInstance;
}

export function resetEventBus(): void {
  if (_eventBusInstance) {
    JiabaixingEventBus.resetInstance();
    _eventBusInstance = null;
  }
}

const eventBus = getEventBus();

export { eventBus as EventBus, JiabaixingEventBus };
export type { EventBusOptions, PersistedEvent };
export default eventBus;
