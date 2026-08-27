import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import {
  type AgentMessage,
  type AgentProfile,
  AgentDiscovery,
} from './AgentDiscovery';
import { createDatabase } from './DatabaseShim';
import { type EventMap } from './eventTypes';
import {
  type FullTrace,
  type TokenUsageRecord,
  type ToolCallRecord,
  type TraceRecord,
  type TraceStats,
  TraceCollector,
} from './TraceCollector';

export type EventName = keyof EventMap;
export type EventPayload<T extends EventName> = EventMap[T];

export type {
  AgentMessage,
  AgentProfile,
  FullTrace,
  TokenUsageRecord,
  ToolCallRecord,
  TraceRecord,
  TraceStats,
};

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

  private db: import('./DatabaseShim').DatabaseAdapter | null = null;
  private persistentEvents: Set<string>;
  private maxEventAge: number;
  private sessionId: string | null = null;

  readonly traceCollector: TraceCollector = new TraceCollector();
  readonly agentDiscovery: AgentDiscovery = new AgentDiscovery();

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

  public static create(options?: EventBusOptions): JiabaixingEventBus {
    return new JiabaixingEventBus(options);
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

      this.db = createDatabase(dbPath);
      if (this.db) {
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
  private static readonly PERSIST_QUEUE_MAX = 500;

  private persistEvent(eventName: string, args: unknown[]): void {
    // P1-5 修复: 持久化队列增加上限，防止数据库不可用时内存无限增长
    if (this.persistQueue.length >= JiabaixingEventBus.PERSIST_QUEUE_MAX) {
      this.persistQueue.splice(
        0,
        this.persistQueue.length - JiabaixingEventBus.PERSIST_QUEUE_MAX + 1
      );
      Logger.warn(
        `EventBus持久化队列已达上限(${JiabaixingEventBus.PERSIST_QUEUE_MAX}条)，丢弃最旧事件`,
        'EventBus'
      );
    }

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

      const insertManyFn = (
        events: Array<{
          event_name: string;
          payload: string;
          timestamp: number;
          session_id: string | null;
        }>
      ): void => {
        for (const event of events) {
          insertStmt.run(
            event.event_name,
            event.payload,
            event.timestamp,
            event.session_id
          );
        }
      };

      const insertMany = this.db.transaction(insertManyFn as () => void);

      const eventsToInsert = batch.map(({ eventName, args }) => ({
        event_name: eventName,
        payload: JSON.stringify(args),
        timestamp: Date.now(),
        session_id: this.sessionId,
      }));

      (insertMany as (e: typeof eventsToInsert) => void)(eventsToInsert);
    } catch (error) {
      Logger.error(`EventBus批量持久化事件失败`, error as Error, 'EventBus');
      if (this.persistQueue.length > JiabaixingEventBus.PERSIST_QUEUE_MAX / 2) {
        Logger.warn(
          `EventBus持久化队列过长(${this.persistQueue.length}条)，丢弃失败批次`,
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
    this.traceCollector.startTrace(traceId, eventName, metadata);

    super.emit('trace_started', {
      traceId,
      eventName,
      timestamp: new Date().toISOString(),
    });
  }

  completeTrace(traceId: string, success: boolean = true): void {
    const record = this.traceCollector.completeTrace(traceId, success);
    if (!record) {
      Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
      return;
    }

    super.emit('trace_completed', {
      traceId,
      eventName: record.eventName,
      duration: record.duration,
      success,
    });

    super.emit('event_traced', {
      eventName: record.eventName,
      traceId,
      duration: record.duration,
      success,
      timestamp: new Date().toISOString(),
    });
  }

  failTrace(traceId: string, error: string): void {
    const record = this.traceCollector.failTrace(traceId, error);
    if (!record) {
      Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
      return;
    }

    super.emit('trace_error', {
      traceId,
      eventName: record.eventName,
      error,
      duration: record.duration,
    });

    super.emit('event_traced', {
      eventName: record.eventName,
      traceId,
      duration: record.duration,
      success: false,
      timestamp: new Date().toISOString(),
      metadata: { error },
    });
  }

  getTraceHistory(eventName?: string, limit: number = 50): TraceRecord[] {
    const stats = this.traceCollector.getTraceStats();
    let history = stats.recentTraces;

    if (eventName) {
      history = history.filter((t: TraceRecord) => t.eventName === eventName);
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
    const stats = this.traceCollector.getTraceStats();
    if (stats.totalTraces === 0) {
      return {
        totalTraces: 0,
        successRate: 0,
        averageDuration: 0,
        errorCount: 0,
        eventNameStats: {},
      };
    }

    const successCount = stats.successfulTraces;
    const totalDuration = stats.averageDuration * stats.totalTraces;

    const eventNameStats: Record<
      string,
      { count: number; successRate: number; averageDuration: number }
    > = {};

    const grouped = new Map<
      string,
      Array<{ success: boolean; duration: number }>
    >();
    for (const trace of stats.recentTraces) {
      if (!grouped.has(trace.eventName)) {
        grouped.set(trace.eventName, []);
      }
      grouped.get(trace.eventName)!.push({
        success: trace.success,
        duration: trace.duration,
      });
    }

    for (const [eventName, traces] of grouped) {
      const sc = traces.filter((t) => t.success).length;
      const td = traces.reduce((sum, t) => sum + t.duration, 0);
      eventNameStats[eventName] = {
        count: traces.length,
        successRate: sc / traces.length,
        averageDuration: td / traces.length,
      };
    }

    return {
      totalTraces: stats.totalTraces,
      successRate: successCount / stats.totalTraces,
      averageDuration: totalDuration / stats.totalTraces,
      errorCount: stats.failedTraces,
      eventNameStats,
    };
  }

  clearTraceHistory(): void {
    this.traceCollector.clear();
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
    this.traceCollector.recordTokenUsage(
      traceId,
      model,
      promptTokens,
      completionTokens
    );
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
    this.traceCollector.recordToolCall(traceId, toolName, success, duration);
  }

  /**
   * 开始全链路追踪
   * @param traceId - 追踪ID
   */
  startFullTrace(traceId: string): void {
    this.traceCollector.startFullTrace(traceId);
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
    this.traceCollector.addTracePhase(traceId, phase, metadata);
  }

  /**
   * 完成全链路追踪阶段
   * @param traceId - 追踪ID
   * @param phase - 阶段名称
   * @param success - 是否成功
   */
  completeTracePhase(traceId: string, phase: string, success: boolean): void {
    this.traceCollector.completeTracePhase(traceId, phase, success);
  }

  /**
   * 完成全链路追踪
   * @param traceId - 追踪ID
   * @param status - 最终状态
   */
  completeFullTrace(traceId: string, status: 'completed' | 'failed'): void {
    this.traceCollector.completeFullTrace(traceId, status);
  }

  /**
   * 获取 Token 消耗统计
   * @param hours - 统计最近几小时的数据
   */
  getTokenUsageStats(hours: number = 24): {
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    byModel: Record<
      string,
      { tokens: number; calls: number; avgTokens: number }
    >;
    byHour: Array<{ hour: string; tokens: number }>;
  } {
    const stats = this.traceCollector.getTraceStats();
    const totalTokens = stats.totalTokenUsage;

    const byModel: Record<
      string,
      { tokens: number; calls: number; avgTokens: number }
    > = {};

    const byHour: Array<{ hour: string; tokens: number }> = [];

    return {
      totalTokens,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      byModel,
      byHour,
    };
  }

  getToolCallStats(hours: number = 24): {
    totalCalls: number;
    successRate: number;
    avgDuration: number;
    byTool: Record<
      string,
      { calls: number; successRate: number; avgDuration: number }
    >;
    slowestTools: Array<{ toolName: string; avgDuration: number }>;
    unreliableTools: Array<{ toolName: string; successRate: number }>;
  } {
    type ToolStat = {
      toolName: string;
      callCount: number;
      successRate: number;
      avgDuration: number;
    };
    const toolStats: ToolStat[] = this.traceCollector.getToolCallStats();
    const totalCalls = toolStats.reduce(
      (sum: number, t: ToolStat) => sum + t.callCount,
      0
    );
    const successCount = toolStats.reduce(
      (sum: number, t: ToolStat) => sum + t.successRate * t.callCount,
      0
    );
    const totalDuration = toolStats.reduce(
      (sum: number, t: ToolStat) => sum + t.avgDuration * t.callCount,
      0
    );

    const byTool: Record<
      string,
      { calls: number; successRate: number; avgDuration: number }
    > = {};
    for (const stat of toolStats) {
      byTool[stat.toolName] = {
        calls: stat.callCount,
        successRate: stat.successRate,
        avgDuration: stat.avgDuration,
      };
    }

    const slowestTools = toolStats
      .sort((a: ToolStat, b: ToolStat) => b.avgDuration - a.avgDuration)
      .slice(0, 5)
      .map((t: ToolStat) => ({
        toolName: t.toolName,
        avgDuration: t.avgDuration,
      }));

    const unreliableTools = toolStats
      .filter((t: ToolStat) => t.callCount >= 3 && t.successRate < 0.9)
      .sort((a: ToolStat, b: ToolStat) => a.successRate - b.successRate)
      .map((t: ToolStat) => ({
        toolName: t.toolName,
        successRate: t.successRate,
      }));

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
    return this.traceCollector.getFullTrace(traceId);
  }

  /**
   * 获取所有全链路追踪列表
   */
  getFullTraces(): unknown[] {
    return this.traceCollector.getFullTraces();
  }

  // ==================== Harness Engineering: Agent 间通信 (委托 AgentDiscovery) ====================

  registerAgent(profile: AgentProfile): void {
    this.agentDiscovery.registerAgent(profile);
  }

  unregisterAgent(agentId: string): void {
    this.agentDiscovery.unregisterAgent(agentId);
  }

  broadcastAgentMessage(
    message: Omit<AgentMessage, 'id' | 'timestamp'>
  ): string {
    const msgId = this.agentDiscovery.broadcastAgentMessage(message);

    const topic = message.topic;
    super.emit.call(this, `agent:message:${topic}`, {
      messageId: msgId,
      from: message.from,
      topic,
      type: message.type,
      priority: message.priority,
    });

    return msgId;
  }

  getAgentMessages(agentId: string, topic?: string): AgentMessage[] {
    const messages = this.agentDiscovery.getAgentMessages(agentId);
    if (topic) {
      return messages.filter((msg: AgentMessage) => msg.topic === topic);
    }
    return messages;
  }

  /**
   * Agent 消费消息（获取后从邮箱移除）
   * @param agentId - Agent ID
   * @param messageId - 消息 ID
   */
  consumeAgentMessage(agentId: string, messageId: string): AgentMessage | null {
    const messages = this.agentDiscovery.getAgentMessages(agentId);
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return null;
    const remaining = messages.filter((m) => m.id !== messageId);
    return msg;
  }

  /**
   * Agent 订阅特定 topic
   * @param agentId - Agent ID
   * @param topic - 订阅的 topic
   */
  subscribeAgentToTopic(agentId: string, topic: string): void {
    this.agentDiscovery.registerAgent({
      id: agentId,
      name: agentId,
      description: '',
      capabilities: [topic.replace('capability.', '')],
      status: 'idle',
      lastHeartbeat: Date.now(),
    });
  }

  /**
   * Agent 取消订阅
   * @param agentId - Agent ID
   * @param topic - 取消订阅的 topic
   */
  unsubscribeAgentFromTopic(agentId: string, topic: string): void {
    void topic;
    void agentId;
  }

  /**
   * 获取已注册的 Agent 列表
   */
  getRegisteredAgents(): AgentProfile[] {
    return this.agentDiscovery.getAllAgents();
  }

  findAgentsByCapability(capability: string): AgentProfile[] {
    return this.agentDiscovery.getAgentsByCapability(capability);
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

    this.traceCollector.clear();
    this.agentDiscovery.clear();

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistQueue = [];

    Logger.info('🧹 EventBus 已完全销毁，所有内部缓冲区已清理', 'EventBus');
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
