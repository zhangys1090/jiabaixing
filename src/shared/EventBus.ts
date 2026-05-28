import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { type EventMap } from './eventTypes';

export type EventName = keyof EventMap;
export type EventPayload<T extends EventName> = EventMap[T];

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

  private db: Database.Database | null = null;
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

      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

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
    if (this.persistentEvents.has(eventName)) {
      this.persistEvent(eventName, args);
    }

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

const eventBus = JiabaixingEventBus.getInstance();

export { eventBus as EventBus, JiabaixingEventBus };
export type { EventBusOptions, PersistedEvent };
export default eventBus;
