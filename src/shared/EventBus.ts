import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';

interface HealingResult {
  success: boolean;
  type: string;
  description: string;
  before?: string;
  after?: string;
  error?: string;
}

interface RefactoringResult {
  success: boolean;
  description: string;
  changes?: Array<{ file: string; type: string }>;
  error?: string;
}

interface EnhancementResult {
  success: boolean;
  type: string;
  description: string;
  error?: string;
}

/**
 * 事件类型映射（用于类型安全的 EventBus）
 */
export interface EventMap {
  user_input: [payload: { input: string; userId?: string; traceId?: string }];
  task_completed: [
    payload: {
      taskId: string;
      traceId?: string;
      status: string;
      result?: unknown;
    },
  ];
  task_started: [payload: { taskId: string; taskName: string }];
  task_failed: [payload: { taskId: string; traceId?: string; error: string }];
  context_update: [key: string, value: unknown];
  ws_send: [data: unknown];
  ws_receive: [data: unknown];
  scene_recognized: [scene: string, confidence: number];
  schedule_check: [scheduleId: string, time: Date];
  proactive_schedule: [
    payload: { type: string; content: string; priority?: string },
  ];
  proactive_briefing: [payload: { type: string; context: string }];
  proactive_reminder: [payload: { type: string; message: string }];
  proactive_comfort: [
    payload: {
      type: string;
      emotionTypes?: string;
      intensity?: number;
      message: string;
    },
  ];
  proactive_checkin: [
    payload: { type: string; silenceHours?: number; message: string },
  ];
  proactive_behavior: [
    payload: { pattern: string; confidence: number; message: string },
  ];
  memory_stored: [memoryId: string, type: string];
  evolution_started: [optimizationId: string];
  feedback_collected: [
    payload: {
      traceId: string;
      feedbackRecorded: boolean;
      memoryUpdated: boolean;
      evolutionTriggered: boolean;
      sovereigntyAudited: boolean;
      timestamp: string;
    },
  ];
  optimization_update: [
    payload: {
      id: string;
      timestamp: number;
      toneAdjustments: unknown[];
      skillWeights: Record<string, number>;
      promptExamples: unknown[];
    },
  ];
  optimization_cycle_completed: [
    payload: {
      cycleId: string;
      improvements: number;
      timestamp: number;
      results?: unknown[];
      overallScore?: number;
    },
  ];
  optimization_requested: [
    payload: {
      requestId: string;
      target: string;
      priority: 'high' | 'medium' | 'low';
    },
  ];
  resource_warning: [resourceType: string, usage: number];
  response_ready: [
    payload: {
      response: string;
      traceId: string;
      success?: boolean;
      duration?: number;
      error?: string;
      ws?: unknown;
    },
  ];
  user_correction: [
    payload: {
      toolId?: string;
      tool_name?: string;
      correctionType?: string;
      type?: string;
      reason?: string;
      message?: string;
      severity?: number;
      traceId?: string;
      trace_id?: string;
    },
  ];
  memory_context_ready: [context: unknown];
  memory_context_request: [query: string];
  task_created: [taskId: string, task: unknown];
  memory_update: [memoryId: string, content: unknown];
  dag_task_completed: [taskId: string, result: unknown];
  proactive_interaction: [
    payload: {
      reason: string;
      context?: string;
      scene?: string;
      priority?: string;
      isEmotionBased?: boolean;
    },
  ];
  emotion_detected: [emotion: string, intensity: number];
  llm_model_unavailable: [error: string];
  system_status: [status: string, detail?: string];
  command_executed: [command: string, result: unknown];
  context_switch: [fromScene: string, toScene: string];
  feedback_signal: [traceId: string, feedbackType: string, score?: number];
  active_interaction: [
    data: { input?: string; userId?: string; text?: string },
  ];
  weight_changed: [toolId: string, oldWeight: number, newWeight: number];
  evolution_update: [
    data: {
      version?: string;
      status?: string;
      description?: string;
      metrics?: Record<string, number>;
    },
  ];
  weight_update: [data: { weights?: Record<string, number> }];
  agent_execution_update: [
    payload: {
      traceId: string;
      phase: string;
      status: string;
      result?: unknown;
      timestamp: string;
    },
  ];
  // Scheduler 相关事件
  scheduler_started: [payload: { timestamp: string }];
  scheduler_stopped: [payload: { timestamp: string }];
  proactive_trigger: [
    payload: {
      type: string;
      reason: string;
      priority: number;
      suggestedAction?: string;
      context?: Record<string, unknown>;
    },
  ];
  emotion_analysis: [
    payload: {
      emotion: string;
      intensity: number;
      trend?: string;
      timestamp: string;
    },
  ];
  memory_consolidation: [
    payload: {
      consolidatedCount: number;
      timestamp: string;
    },
  ];
  behavior_analysis: [
    payload: {
      patterns: string[];
      confidence: number;
      timestamp: string;
    },
  ];
  event_traced: [
    payload: {
      eventName: string;
      traceId: string;
      duration: number;
      success: boolean;
      timestamp: string;
      metadata?: Record<string, unknown>;
    },
  ];
  trace_started: [
    payload: { traceId: string; eventName: string; timestamp: string },
  ];
  trace_completed: [
    payload: {
      traceId: string;
      eventName: string;
      duration: number;
      success: boolean;
    },
  ];
  trace_error: [
    payload: {
      traceId: string;
      eventName: string;
      error: string;
      duration: number;
    },
  ];
  // AGENT 状态可视化事件
  perception_update: [
    payload: {
      traceId: string;
      modality: 'voice' | 'image' | 'text' | 'sensor' | 'fusion';
      status: 'started' | 'processing' | 'completed' | 'failed';
      progress?: number;
      result?: unknown;
      confidence?: number;
      error?: string;
      timestamp: string;
    },
  ];
  brain_stage_update: [
    payload: {
      traceId: string;
      stage:
        | 'intent_recognition'
        | 'task_decomposition'
        | 'scene_recognition'
        | 'memory_retrieval'
        | 'llm_generation'
        | 'persona_adjustment'
        | 'function_calling';
      status: 'started' | 'completed' | 'failed';
      duration?: number;
      result?: unknown;
      timestamp: string;
    },
  ];
  skill_execution_update: [
    payload: {
      traceId: string;
      skillName: string;
      step: 'started' | 'retry' | 'fallback' | 'completed' | 'failed';
      attempt?: number;
      maxRetries?: number;
      duration?: number;
      error?: string;
      timestamp: string;
    },
  ];
  // VIBE CODING 事件
  clarification_request: [
    payload: {
      traceId: string;
      question: string;
      options?: string[];
      context?: string;
      timestamp: string;
    },
  ];
  clarification_response: [
    payload: {
      traceId: string;
      response: string;
      timestamp: string;
    },
  ];
  execution_preview: [
    payload: {
      traceId: string;
      summary: string;
      changes: Array<{
        type: 'file' | 'command' | 'api';
        target: string;
        action: string;
        risk: 'low' | 'medium' | 'high';
        preview?: string;
      }>;
      estimatedTime?: number;
      timestamp: string;
    },
  ];
  execution_confirm: [
    payload: {
      traceId: string;
      confirmed: boolean;
      timestamp: string;
    },
  ];
  file_modified: [
    payload: {
      traceId: string;
      filePath: string;
      changeType: 'created' | 'modified' | 'deleted';
      timestamp: string;
    },
  ];
  file_rollback: [
    payload: {
      traceId: string;
      filePath: string;
      success: boolean;
      timestamp: string;
    },
  ];
  multi_file_modified: [
    payload: {
      traceId: string;
      files: Array<{
        path: string;
        changeType: 'created' | 'modified' | 'deleted';
      }>;
      timestamp: string;
    },
  ];
  // P1优化：工具调用链路追踪
  tool_trace: [
    payload: {
      timestamp: string;
      traceId: string;
      toolCallId: string;
      toolName: string;
      status: 'started' | 'completed' | 'failed';
      duration: number;
      success: boolean | null;
      errorMessage: string | null;
    },
  ];
  evolution_event: [
    payload: {
      type:
        | 'quality_assessed'
        | 'micro_optimization'
        | 'deep_optimization'
        | 'strategy_updated'
        | 'threshold_adjusted';
      traceId?: string;
      score?: number;
      description: string;
      metrics?: Record<string, number>;
      timestamp: string;
    },
  ];
  // 智能自动化事件
  automation_task_update: [
    payload: {
      taskId: string;
      name: string;
      enabled: boolean;
      executionCount: number;
      successCount: number;
      lastRun?: string;
      timestamp: string;
    },
  ];
  automation_trigger_fired: [
    payload: {
      type: 'schedule' | 'emotion' | 'behavior' | 'pattern' | 'time' | 'memory';
      reason: string;
      priority: number;
      suggestedAction?: string;
      context?: Record<string, unknown>;
      timestamp: string;
    },
  ];
  automation_pattern_update: [
    payload: {
      activeHours: number[];
      frequentTopics: string[];
      taskCompletionRate: number;
      lastActiveTime: number;
      averageSessionDuration: number;
      preferredCommunicationStyle: string;
      timestamp: string;
    },
  ];
  automation_proactive_message: [
    payload: {
      message: string;
      triggerType: string;
      context?: Record<string, unknown>;
      timestamp: string;
    },
  ];
  // 自我进化事件
  'healing:success': [payload: HealingResult];
  'healing:failed': [payload: HealingResult];
  'refactoring:success': [payload: RefactoringResult];
  'enhancement:success': [payload: EnhancementResult];
  self_healing_completed: [
    payload: {
      total: number;
      success: number;
      results: HealingResult[];
    },
  ];
  self_refactor_completed: [payload: RefactoringResult];
  self_enhancement_completed: [
    payload: {
      total: number;
      success: number;
      results: EnhancementResult[];
    },
  ];
  evolution_cycle_completed: [
    payload: {
      healingSuccess: number;
      refactorSuccess: boolean;
      enhancementSuccess: number;
    },
  ];
  // 集成相关事件
  integration_connected: [
    payload: {
      platform: string;
      timestamp: string;
    },
  ];
  integration_disconnected: [
    payload: {
      platform: string;
      timestamp: string;
    },
  ];
  integration_message: [
    payload: {
      platform: string;
      type: string;
      content: string;
      from?: string;
      fromName?: string;
      timestamp: string;
      rawData?: unknown;
    },
  ];
}

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
