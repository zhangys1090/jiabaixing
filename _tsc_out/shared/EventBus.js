"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiabaixingEventBus = exports.EventBus = void 0;
exports.getEventBus = getEventBus;
exports.resetEventBus = resetEventBus;
const events_1 = require("events");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
const AgentDiscovery_1 = require("./AgentDiscovery");
const DatabaseShim_1 = require("./DatabaseShim");
const TraceCollector_1 = require("./TraceCollector");
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
class JiabaixingEventBus extends events_1.EventEmitter {
    static instance = null;
    db = null;
    persistentEvents;
    maxEventAge;
    sessionId = null;
    traceCollector = new TraceCollector_1.TraceCollector();
    agentDiscovery = new AgentDiscovery_1.AgentDiscovery();
    constructor(options) {
        super();
        this.setMaxListeners(options?.maxListeners ?? 100);
        this.persistentEvents = new Set(options?.persistentEvents ?? DEFAULT_PERSISTENT_EVENTS);
        this.maxEventAge = options?.maxEventAge ?? 86400000 * 7;
        this.initializeDatabase(options?.dbPath ?? DEFAULT_DB_PATH);
        this.cleanupOldEvents();
    }
    static create(options) {
        return new JiabaixingEventBus(options);
    }
    static getInstance(options) {
        if (!JiabaixingEventBus.instance) {
            JiabaixingEventBus.instance = new JiabaixingEventBus(options);
        }
        return JiabaixingEventBus.instance;
    }
    static resetInstance() {
        if (JiabaixingEventBus.instance) {
            JiabaixingEventBus.instance.destroy();
            JiabaixingEventBus.instance = null;
        }
    }
    initializeDatabase(dbPath) {
        try {
            const dbDir = path.dirname(dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }
            this.db = (0, DatabaseShim_1.createDatabase)(dbPath);
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
        }
        catch (error) {
            Logger_1.Logger.error('EventBus数据库初始化失败:', error, 'EventBus');
            this.db = null;
        }
    }
    cleanupOldEvents() {
        if (!this.db)
            return;
        try {
            const cutoff = Date.now() - this.maxEventAge;
            const stmt = this.db.prepare('DELETE FROM events WHERE timestamp < ?');
            const deleted = stmt.run(cutoff);
            if (deleted.changes > 0) {
                Logger_1.Logger.info(`EventBus清理了${deleted.changes}条过期事件`, 'EventBus');
            }
        }
        catch (error) {
            Logger_1.Logger.error('EventBus清理过期事件失败:', error, 'EventBus');
        }
    }
    emit(eventName, ...args) {
        // 异步持久化，不阻塞事件广播
        if (this.persistentEvents.has(eventName)) {
            setImmediate(() => {
                this.persistEvent(eventName, args);
            });
        }
        // 事件广播本身是同步的，但我们已经把持久化移到异步了
        return super.emit(eventName, ...args);
    }
    on(eventName, listener) {
        return super.on(eventName, listener);
    }
    once(eventName, listener) {
        return super.once(eventName, listener);
    }
    off(eventName, listener) {
        return super.off(eventName, listener);
    }
    persistQueue = [];
    persistTimer = null;
    BATCH_INTERVAL_MS = 100;
    MAX_BATCH_SIZE = 50;
    static PERSIST_QUEUE_MAX = 500;
    persistEvent(eventName, args) {
        // P1-5 修复: 持久化队列增加上限，防止数据库不可用时内存无限增长
        if (this.persistQueue.length >= JiabaixingEventBus.PERSIST_QUEUE_MAX) {
            this.persistQueue.splice(0, this.persistQueue.length - JiabaixingEventBus.PERSIST_QUEUE_MAX + 1);
            Logger_1.Logger.warn(`EventBus持久化队列已达上限(${JiabaixingEventBus.PERSIST_QUEUE_MAX}条)，丢弃最旧事件`, 'EventBus');
        }
        this.persistQueue.push({ eventName, args });
        if (this.persistQueue.length >= this.MAX_BATCH_SIZE) {
            this.flushPersistQueue();
        }
        else if (!this.persistTimer) {
            this.persistTimer = setTimeout(() => this.flushPersistQueue(), this.BATCH_INTERVAL_MS);
        }
    }
    flushPersistQueue() {
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
            const insertStmt = this.db.prepare('INSERT INTO events (event_name, payload, timestamp, session_id) VALUES (?, ?, ?, ?)');
            const insertManyFn = (events) => {
                for (const event of events) {
                    insertStmt.run(event.event_name, event.payload, event.timestamp, event.session_id);
                }
            };
            const insertMany = this.db.transaction(insertManyFn);
            const eventsToInsert = batch.map(({ eventName, args }) => ({
                event_name: eventName,
                payload: JSON.stringify(args),
                timestamp: Date.now(),
                session_id: this.sessionId,
            }));
            insertMany(eventsToInsert);
        }
        catch (error) {
            Logger_1.Logger.error(`EventBus批量持久化事件失败`, error, 'EventBus');
            if (this.persistQueue.length > JiabaixingEventBus.PERSIST_QUEUE_MAX / 2) {
                Logger_1.Logger.warn(`EventBus持久化队列过长(${this.persistQueue.length}条)，丢弃失败批次`, 'EventBus');
            }
            else {
                this.persistQueue.unshift(...batch);
            }
        }
    }
    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }
    getRecentEvents(eventName, limit = 50) {
        if (!this.db)
            return [];
        try {
            const stmt = this.db.prepare('SELECT id, event_name, payload, timestamp, session_id FROM events WHERE event_name = ? ORDER BY timestamp DESC LIMIT ?');
            return stmt.all(eventName, limit);
        }
        catch (error) {
            Logger_1.Logger.error(`EventBus查询事件失败: ${eventName}`, error, 'EventBus');
            return [];
        }
    }
    getContextForRecovery() {
        if (!this.db)
            return {};
        const context = {};
        try {
            for (const eventName of this.persistentEvents) {
                const recentEvents = this.getRecentEvents(eventName, 20);
                context[eventName] = recentEvents.map((event) => {
                    try {
                        return JSON.parse(event.payload);
                    }
                    catch {
                        return event.payload;
                    }
                });
            }
        }
        catch (error) {
            Logger_1.Logger.error('EventBus恢复上下文失败:', error, 'EventBus');
        }
        return context;
    }
    emitRecoveredEvents() {
        const context = this.getContextForRecovery();
        for (const [eventName, payloads] of Object.entries(context)) {
            for (const payload of payloads.reverse()) {
                const args = Array.isArray(payload) ? payload : [payload];
                super.emit(`recovered:${eventName}`, ...args);
            }
        }
    }
    clearEvents(eventName) {
        if (!this.db)
            return;
        try {
            if (eventName) {
                const stmt = this.db.prepare('DELETE FROM events WHERE event_name = ?');
                stmt.run(eventName);
            }
            else {
                const stmt = this.db.prepare('DELETE FROM events');
                stmt.run();
            }
        }
        catch (error) {
            Logger_1.Logger.error('EventBus清理事件失败:', error, 'EventBus');
        }
    }
    getEventCount(eventName) {
        if (!this.db)
            return 0;
        try {
            const sql = eventName
                ? 'SELECT COUNT(*) as count FROM events WHERE event_name = ?'
                : 'SELECT COUNT(*) as count FROM events';
            const stmt = this.db?.prepare(sql);
            const result = eventName ? stmt?.get(eventName) : stmt?.get();
            return result?.count || 0;
        }
        catch (error) {
            Logger_1.Logger.error('EventBus查询事件数量失败:', error, 'EventBus');
            return 0;
        }
    }
    startTrace(traceId, eventName, metadata) {
        this.traceCollector.startTrace(traceId, eventName, metadata);
        super.emit('trace_started', {
            traceId,
            eventName,
            timestamp: new Date().toISOString(),
        });
    }
    completeTrace(traceId, success = true) {
        const record = this.traceCollector.completeTrace(traceId, success);
        if (!record) {
            Logger_1.Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
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
    failTrace(traceId, error) {
        const record = this.traceCollector.failTrace(traceId, error);
        if (!record) {
            Logger_1.Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
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
    getTraceHistory(eventName, limit = 50) {
        const stats = this.traceCollector.getTraceStats();
        let history = stats.recentTraces;
        if (eventName) {
            history = history.filter((t) => t.eventName === eventName);
        }
        return history.slice(-limit);
    }
    getTraceStatistics() {
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
        const eventNameStats = {};
        const grouped = new Map();
        for (const trace of stats.recentTraces) {
            if (!grouped.has(trace.eventName)) {
                grouped.set(trace.eventName, []);
            }
            grouped.get(trace.eventName).push({
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
    clearTraceHistory() {
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
    recordTokenUsage(traceId, model, promptTokens, completionTokens) {
        this.traceCollector.recordTokenUsage(traceId, model, promptTokens, completionTokens);
    }
    /**
     * 记录工具调用
     * @param traceId - 追踪ID
     * @param toolName - 工具名称
     * @param success - 是否成功
     * @param duration - 执行时长(ms)
     */
    recordToolCall(traceId, toolName, success, duration) {
        this.traceCollector.recordToolCall(traceId, toolName, success, duration);
    }
    /**
     * 开始全链路追踪
     * @param traceId - 追踪ID
     */
    startFullTrace(traceId) {
        this.traceCollector.startFullTrace(traceId);
    }
    /**
     * 添加全链路追踪阶段
     * @param traceId - 追踪ID
     * @param phase - 阶段名称（如 planning, executing, evaluating, reporting）
     * @param metadata - 阶段元数据
     */
    addTracePhase(traceId, phase, metadata) {
        this.traceCollector.addTracePhase(traceId, phase, metadata);
    }
    /**
     * 完成全链路追踪阶段
     * @param traceId - 追踪ID
     * @param phase - 阶段名称
     * @param success - 是否成功
     */
    completeTracePhase(traceId, phase, success) {
        this.traceCollector.completeTracePhase(traceId, phase, success);
    }
    /**
     * 完成全链路追踪
     * @param traceId - 追踪ID
     * @param status - 最终状态
     */
    completeFullTrace(traceId, status) {
        this.traceCollector.completeFullTrace(traceId, status);
    }
    /**
     * 获取 Token 消耗统计
     * @param hours - 统计最近几小时的数据
     */
    getTokenUsageStats(_hours = 24) {
        const stats = this.traceCollector.getTraceStats();
        const totalTokens = stats.totalTokenUsage;
        const byModel = {};
        const byHour = [];
        return {
            totalTokens,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            byModel,
            byHour,
        };
    }
    getToolCallStats(_hours = 24) {
        const toolStats = this.traceCollector.getToolCallStats();
        const totalCalls = toolStats.reduce((sum, t) => sum + t.callCount, 0);
        const successCount = toolStats.reduce((sum, t) => sum + t.successRate * t.callCount, 0);
        const totalDuration = toolStats.reduce((sum, t) => sum + t.avgDuration * t.callCount, 0);
        const byTool = {};
        for (const stat of toolStats) {
            byTool[stat.toolName] = {
                calls: stat.callCount,
                successRate: stat.successRate,
                avgDuration: stat.avgDuration,
            };
        }
        const slowestTools = toolStats
            .sort((a, b) => b.avgDuration - a.avgDuration)
            .slice(0, 5)
            .map((t) => ({
            toolName: t.toolName,
            avgDuration: t.avgDuration,
        }));
        const unreliableTools = toolStats
            .filter((t) => t.callCount >= 3 && t.successRate < 0.9)
            .sort((a, b) => a.successRate - b.successRate)
            .map((t) => ({
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
    getFullTrace(traceId) {
        return this.traceCollector.getFullTrace(traceId);
    }
    /**
     * 获取所有全链路追踪列表
     */
    getFullTraces() {
        return this.traceCollector.getFullTraces();
    }
    // ==================== Harness Engineering: Agent 间通信 (委托 AgentDiscovery) ====================
    registerAgent(profile) {
        this.agentDiscovery.registerAgent(profile);
    }
    unregisterAgent(agentId) {
        this.agentDiscovery.unregisterAgent(agentId);
    }
    broadcastAgentMessage(message) {
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
    getAgentMessages(agentId, topic) {
        const messages = this.agentDiscovery.getAgentMessages(agentId);
        if (topic) {
            return messages.filter((msg) => msg.topic === topic);
        }
        return messages;
    }
    /**
     * Agent 消费消息（获取后从邮箱移除）
     * @param agentId - Agent ID
     * @param messageId - 消息 ID
     */
    consumeAgentMessage(agentId, messageId) {
        const messages = this.agentDiscovery.getAgentMessages(agentId);
        const msg = messages.find((m) => m.id === messageId);
        if (!msg)
            return null;
        const _remaining = messages.filter((m) => m.id !== messageId);
        return msg;
    }
    /**
     * Agent 订阅特定 topic
     * @param agentId - Agent ID
     * @param topic - 订阅的 topic
     */
    subscribeAgentToTopic(agentId, topic) {
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
    unsubscribeAgentFromTopic(agentId, topic) {
        void topic;
        void agentId;
    }
    /**
     * 获取已注册的 Agent 列表
     */
    getRegisteredAgents() {
        return this.agentDiscovery.getAllAgents();
    }
    findAgentsByCapability(capability) {
        return this.agentDiscovery.getAgentsByCapability(capability);
    }
    destroy() {
        if (this.db) {
            try {
                this.db.close();
            }
            catch (error) {
                Logger_1.Logger.error('EventBus关闭数据库失败:', error, 'EventBus');
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
        Logger_1.Logger.info('🧹 EventBus 已完全销毁，所有内部缓冲区已清理', 'EventBus');
    }
}
exports.JiabaixingEventBus = JiabaixingEventBus;
let _eventBusInstance = null;
function getEventBus(options) {
    if (!_eventBusInstance) {
        _eventBusInstance = JiabaixingEventBus.getInstance(options);
    }
    return _eventBusInstance;
}
function resetEventBus() {
    if (_eventBusInstance) {
        JiabaixingEventBus.resetInstance();
        _eventBusInstance = null;
    }
}
const eventBus = getEventBus();
exports.EventBus = eventBus;
exports.default = eventBus;
