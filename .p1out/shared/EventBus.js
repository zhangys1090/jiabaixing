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
const DatabaseShim_1 = require("./DatabaseShim");
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
    constructor(options) {
        super();
        this.db = null;
        this.sessionId = null;
        this.activeTraces = new Map();
        this.traceHistory = [];
        this.MAX_TRACE_HISTORY = 1000;
        // ==================== Harness Engineering: 全链路可观测性 ====================
        /** Token 消耗追踪 */
        this.tokenUsage = [];
        this.MAX_TOKEN_RECORDS = 5000;
        /** 工具调用追踪 */
        this.toolCallRecords = [];
        this.MAX_TOOL_CALL_RECORDS = 5000;
        /** 全链路追踪：从用户输入到最终响应 */
        this.fullTraces = new Map();
        this.MAX_FULL_TRACES = 100;
        this.persistQueue = [];
        this.persistTimer = null;
        this.BATCH_INTERVAL_MS = 100;
        this.MAX_BATCH_SIZE = 50;
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
        this.agentRegistry = new Map();
        /** 最大注册Agent数 */
        this.MAX_REGISTERED_AGENTS = 200;
        /** Agent 订阅关系：topic → Set<agentId> */
        this.agentSubscriptions = new Map();
        /** Agent 消息队列：agentId → AgentMessage[] */
        this.agentMailboxes = new Map();
        /** 最大邮箱大小 */
        this.MAX_MAILBOX_SIZE = 100;
        /** 消息过期时间（默认5分钟） */
        this.MESSAGE_TTL = 5 * 60 * 1000;
        this.setMaxListeners(options?.maxListeners ?? 100);
        this.persistentEvents = new Set(options?.persistentEvents ?? DEFAULT_PERSISTENT_EVENTS);
        this.maxEventAge = options?.maxEventAge ?? 86400000 * 7;
        this.initializeDatabase(options?.dbPath ?? DEFAULT_DB_PATH);
        this.cleanupOldEvents();
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
    persistEvent(eventName, args) {
        this.persistQueue.push({ eventName, args });
        if (this.persistQueue.length >= this.MAX_BATCH_SIZE) {
            this.flushPersistQueue();
        }
        else if (!this.persistTimer) {
            this.persistTimer = setTimeout(() => this.flushPersistQueue(), this.BATCH_INTERVAL_MS);
            if (this.persistTimer.unref)
                this.persistTimer.unref();
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
            // 限制重试次数：如果队列已超过 MAX_BATCH_SIZE * 5 条，丢弃最旧的失败批次
            if (this.persistQueue.length > this.MAX_BATCH_SIZE * 5) {
                Logger_1.Logger.warn(`EventBus持久化队列过长(${this.persistQueue.length}条)，丢弃旧事件`, 'EventBus');
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
                    catch (err) {
                        Logger_1.Logger.debug(`EventBus事件payload解析失败，使用原始值: ${err?.message}`, 'EventBus');
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
        if (this.activeTraces.size >= this.MAX_ACTIVE_TRACES) {
            const oldestKey = this.activeTraces.keys().next().value;
            this.activeTraces.delete(oldestKey);
        }
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
    completeTrace(traceId, success = true) {
        const trace = this.activeTraces.get(traceId);
        if (!trace) {
            Logger_1.Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
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
    failTrace(traceId, error) {
        const trace = this.activeTraces.get(traceId);
        if (!trace) {
            Logger_1.Logger.warn(`未找到追踪记录: ${traceId}`, 'EventBus');
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
    getTraceHistory(eventName, limit = 50) {
        let history = this.traceHistory;
        if (eventName) {
            history = history.filter((t) => t.eventName === eventName);
        }
        return history.slice(-limit);
    }
    getTraceStatistics() {
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
        const totalDuration = this.traceHistory.reduce((sum, t) => sum + t.duration, 0);
        const eventNameStats = {};
        // 先按eventName分组，避免O(n²)的循环内filter
        const grouped = new Map();
        for (const trace of this.traceHistory) {
            if (!grouped.has(trace.eventName)) {
                grouped.set(trace.eventName, []);
            }
            grouped.get(trace.eventName).push({
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
    clearTraceHistory() {
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
    recordTokenUsage(traceId, model, promptTokens, completionTokens) {
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
    recordToolCall(traceId, toolName, success, duration) {
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
    startFullTrace(traceId) {
        if (this.fullTraces.size >= this.MAX_FULL_TRACES) {
            // 移除最早的已完成追踪
            const oldestKey = this.fullTraces.keys().next().value;
            if (oldestKey)
                this.fullTraces.delete(oldestKey);
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
    addTracePhase(traceId, phase, metadata) {
        const fullTrace = this.fullTraces.get(traceId);
        if (!fullTrace)
            return;
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
    completeTracePhase(traceId, phase, success) {
        const fullTrace = this.fullTraces.get(traceId);
        if (!fullTrace)
            return;
        const phaseRecord = fullTrace.phases.find((p) => p.phase === phase && !p.endTime);
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
    completeFullTrace(traceId, status) {
        const fullTrace = this.fullTraces.get(traceId);
        if (!fullTrace)
            return;
        fullTrace.endTime = Date.now();
        fullTrace.status = status;
    }
    /**
     * 获取 Token 消耗统计
     * @param hours - 统计最近几小时的数据
     */
    getTokenUsageStats(hours = 24) {
        const cutoff = Date.now() - hours * 3600 * 1000;
        const recent = this.tokenUsage.filter((r) => r.timestamp >= cutoff);
        const totalTokens = recent.reduce((sum, r) => sum + r.totalTokens, 0);
        const totalPromptTokens = recent.reduce((sum, r) => sum + r.promptTokens, 0);
        const totalCompletionTokens = recent.reduce((sum, r) => sum + r.completionTokens, 0);
        // 按模型分组
        const byModel = {};
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
        const byHourMap = new Map();
        for (const record of recent) {
            const hour = new Date(record.timestamp).toISOString().substring(0, 13);
            byHourMap.set(hour, (byHourMap.get(hour) || 0) + record.totalTokens);
        }
        const byHour = Array.from(byHourMap.entries())
            .map(([hour, tokens]) => ({ hour, tokens }))
            .sort((a, b) => a.hour.localeCompare(b.hour));
        return {
            totalTokens,
            totalPromptTokens,
            totalCompletionTokens,
            byModel,
            byHour,
        };
    }
    /**
     * 获取工具调用统计
     * @param hours - 统计最近几小时的数据
     */
    getToolCallStats(hours = 24) {
        const cutoff = Date.now() - hours * 3600 * 1000;
        const recent = this.toolCallRecords.filter((r) => r.timestamp >= cutoff);
        const totalCalls = recent.length;
        const successCount = recent.filter((r) => r.success).length;
        const totalDuration = recent.reduce((sum, r) => sum + r.duration, 0);
        // 按工具分组
        const byToolMap = new Map();
        for (const record of recent) {
            const existing = byToolMap.get(record.toolName) || {
                calls: 0,
                successes: 0,
                totalDuration: 0,
            };
            existing.calls++;
            if (record.success)
                existing.successes++;
            existing.totalDuration += record.duration;
            byToolMap.set(record.toolName, existing);
        }
        const byTool = {};
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
            .map(([toolName, stats]) => ({
            toolName,
            avgDuration: stats.avgDuration,
        }));
        // 最不可靠的工具
        const unreliableTools = Object.entries(byTool)
            .filter(([, stats]) => stats.calls >= 3 && stats.successRate < 0.9)
            .sort((a, b) => a[1].successRate - b[1].successRate)
            .map(([toolName, stats]) => ({
            toolName,
            successRate: stats.successRate,
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
        return this.fullTraces.get(traceId) || null;
    }
    /**
     * 获取所有全链路追踪列表
     */
    getFullTraces() {
        return Array.from(this.fullTraces.values());
    }
    /**
     * 注册 Agent
     * @param profile - Agent 描述信息
     */
    registerAgent(profile) {
        if (this.agentRegistry.size >= this.MAX_REGISTERED_AGENTS && !this.agentRegistry.has(profile.id)) {
            Logger_1.Logger.warn(`Agent注册已达上限(${this.MAX_REGISTERED_AGENTS})，拒绝注册: ${profile.id}`, 'EventBus');
            return;
        }
        this.agentRegistry.set(profile.id, profile);
        // 根据 capabilities 自动订阅相关 topic
        for (const capability of profile.capabilities) {
            const topic = this.capabilityToTopic(capability);
            if (!this.agentSubscriptions.has(topic)) {
                this.agentSubscriptions.set(topic, new Set());
            }
            this.agentSubscriptions.get(topic).add(profile.id);
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
    unregisterAgent(agentId) {
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
    broadcastAgentMessage(message) {
        const fullMessage = {
            id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            timestamp: Date.now(),
            ...message,
        };
        // 投递到订阅了相关 topic 的 Agent 邮箱
        const topic = message.topic;
        const subscribers = this.agentSubscriptions.get(topic);
        if (subscribers) {
            for (const agentId of subscribers) {
                if (agentId === message.from)
                    continue; // 不投递给自己
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
    getAgentMessages(agentId, topic) {
        const mailbox = this.agentMailboxes.get(agentId) || [];
        // 过滤过期消息
        const now = Date.now();
        const validMessages = mailbox.filter((msg) => now - msg.timestamp < (msg.ttl || this.MESSAGE_TTL));
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
    consumeAgentMessage(agentId, messageId) {
        const mailbox = this.agentMailboxes.get(agentId);
        if (!mailbox)
            return null;
        const index = mailbox.findIndex((msg) => msg.id === messageId);
        if (index === -1)
            return null;
        const [message] = mailbox.splice(index, 1);
        return message;
    }
    /**
     * Agent 订阅特定 topic
     * @param agentId - Agent ID
     * @param topic - 订阅的 topic
     */
    subscribeAgentToTopic(agentId, topic) {
        if (!this.agentSubscriptions.has(topic)) {
            this.agentSubscriptions.set(topic, new Set());
        }
        this.agentSubscriptions.get(topic).add(agentId);
    }
    /**
     * Agent 取消订阅
     * @param agentId - Agent ID
     * @param topic - 取消订阅的 topic
     */
    unsubscribeAgentFromTopic(agentId, topic) {
        const subscribers = this.agentSubscriptions.get(topic);
        if (subscribers) {
            subscribers.delete(agentId);
        }
    }
    /**
     * 获取已注册的 Agent 列表
     */
    getRegisteredAgents() {
        return Array.from(this.agentRegistry.values());
    }
    /**
     * 根据 capability 查找可用的 Agent
     * @param capability - 需要的能力
     */
    findAgentsByCapability(capability) {
        return Array.from(this.agentRegistry.values()).filter((profile) => profile.capabilities.includes(capability));
    }
    /**
     * 将 capability 映射为 topic
     */
    capabilityToTopic(capability) {
        const topicMap = {
            code_generation: 'code',
            code_review: 'code',
            code_analysis: 'code',
            file_operations: 'file',
            web_search: 'network',
            web_fetch: 'network',
            memory_operations: 'memory',
            shell_execution: 'system',
            desktop_automation: 'desktop',
            voice_interaction: 'voice',
            task_planning: 'planning',
            quality_evaluation: 'evaluation',
        };
        return topicMap[capability] || capability;
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
        this.activeTraces.clear();
        this.traceHistory = [];
        this.tokenUsage = [];
        this.toolCallRecords = [];
        this.fullTraces.clear();
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.persistQueue = [];
        Logger_1.Logger.info('🧹 EventBus 已完全销毁，所有内部缓冲区已清理', 'EventBus');
    }
}
exports.JiabaixingEventBus = JiabaixingEventBus;
JiabaixingEventBus.instance = null;
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
