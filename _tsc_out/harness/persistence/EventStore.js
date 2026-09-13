"use strict";
/**
 * Harness Layer 4: EventStore — Append-Only 事件溯源存储
 *
 * 设计理念（参考 DeepSeek Harness / Cordis）：
 * - 所有状态变更以事件形式追加写入，不可修改历史
 * - 上下文从事件流派生（projection），而非直接存储
 * - 支持会话回放：从任意时间点重建 Agent 状态
 * - 与现有 EventBus 解耦：EventBus 负责实时广播，EventStore 负责持久化溯源
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStore = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DatabaseShim_1 = require("../../shared/DatabaseShim");
const Logger_1 = require("../../utils/Logger");
const DEFAULT_DB_PATH = path_1.default.join(process.cwd(), 'data', 'event_store.db');
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_SNAPSHOT_INTERVAL = 500;
const DEFAULT_COMPACTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
class EventStore {
    db = null;
    dbPath;
    maxEventsPerSession;
    snapshotInterval;
    enableCompaction;
    compactionAgeMs;
    sequenceCounters = new Map();
    appendBuffer = [];
    flushTimer = null;
    FLUSH_INTERVAL_MS = 50;
    MAX_BUFFER_SIZE = 100;
    MAX_SEQUENCE_COUNTERS = 500;
    initialized = false;
    constructor(options) {
        this.dbPath = options?.dbPath ?? DEFAULT_DB_PATH;
        this.maxEventsPerSession =
            options?.maxEventsPerSession ?? DEFAULT_MAX_EVENTS;
        this.snapshotInterval =
            options?.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
        this.enableCompaction = options?.enableCompaction ?? true;
        this.compactionAgeMs =
            options?.compactionAgeMs ?? DEFAULT_COMPACTION_AGE_MS;
    }
    initialize() {
        if (this.initialized)
            return;
        try {
            const dir = path_1.default.dirname(this.dbPath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            this.db = (0, DatabaseShim_1.createDatabase)(this.dbPath);
            if (this.db) {
                try {
                    this.db.pragma('journal_mode = WAL');
                }
                catch {
                    /* ignore */
                }
                this.initializeSchema();
                this.loadSequenceCounters();
                Logger_1.Logger.info(`📦 EventStore 初始化: ${this.dbPath}`, 'EventStore');
            }
            else {
                Logger_1.Logger.warn('EventStore: 降级为内存模式，事件不会被持久化', 'EventStore');
            }
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 初始化失败', error, 'EventStore');
        }
        this.initialized = true;
    }
    initializeSchema() {
        if (!this.db)
            return;
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence_num INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}',
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_seq
        ON events(session_id, sequence_num);
      CREATE INDEX IF NOT EXISTS idx_events_session_type
        ON events(session_id, event_type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp
        ON events(timestamp);

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sequence_num INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_session
        ON snapshots(session_id, sequence_num DESC);
    `);
    }
    loadSequenceCounters() {
        if (!this.db)
            return;
        try {
            const rows = this.db
                .prepare('SELECT session_id, MAX(sequence_num) as max_seq FROM events GROUP BY session_id')
                .all();
            for (const row of rows) {
                this.sequenceCounters.set(row.session_id, row.max_seq);
            }
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 加载序列号失败', error, 'EventStore');
        }
    }
    getNextSequence(sessionId) {
        const current = this.sequenceCounters.get(sessionId) ?? 0;
        const next = current + 1;
        this.sequenceCounters.set(sessionId, next);
        if (this.sequenceCounters.size > this.MAX_SEQUENCE_COUNTERS) {
            const keys = Array.from(this.sequenceCounters.keys());
            const toRemove = keys.slice(0, this.sequenceCounters.size - this.MAX_SEQUENCE_COUNTERS);
            for (const k of toRemove) {
                this.sequenceCounters.delete(k);
            }
        }
        return next;
    }
    append(event) {
        const fullEvent = {
            ...event,
            sequenceNum: this.getNextSequence(event.sessionId),
            timestamp: Date.now(),
        };
        this.appendBuffer.push(fullEvent);
        if (this.appendBuffer.length >= this.MAX_BUFFER_SIZE) {
            this.flush();
        }
        else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL_MS);
        }
        if (fullEvent.sequenceNum % this.snapshotInterval === 0) {
            this.autoSnapshot(fullEvent.sessionId);
        }
        return fullEvent;
    }
    appendBatch(events) {
        const fullEvents = [];
        for (const event of events) {
            const fullEvent = {
                ...event,
                sequenceNum: this.getNextSequence(event.sessionId),
                timestamp: Date.now(),
            };
            fullEvents.push(fullEvent);
            this.appendBuffer.push(fullEvent);
        }
        if (this.appendBuffer.length >= this.MAX_BUFFER_SIZE) {
            this.flush();
        }
        else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL_MS);
        }
        return fullEvents;
    }
    flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.appendBuffer.length === 0 || !this.db) {
            this.appendBuffer = [];
            return;
        }
        const batch = this.appendBuffer.splice(0);
        try {
            const insertStmt = this.db.prepare(`INSERT OR IGNORE INTO events (event_id, session_id, sequence_num, event_type, payload, metadata, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`);
            const insertMany = this.db.transaction(() => {
                for (const event of batch) {
                    insertStmt.run(event.eventId, event.sessionId, event.sequenceNum, event.eventType, JSON.stringify(event.payload), JSON.stringify(event.metadata), event.timestamp);
                }
            });
            insertMany();
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 批量写入失败', error, 'EventStore');
            if (this.appendBuffer.length < this.MAX_BUFFER_SIZE * 5) {
                this.appendBuffer.unshift(...batch);
            }
        }
    }
    query(query) {
        this.flush();
        if (!this.db)
            return [];
        try {
            const conditions = [];
            const params = [];
            if (query.sessionId) {
                conditions.push('session_id = ?');
                params.push(query.sessionId);
            }
            if (query.eventTypes && query.eventTypes.length > 0) {
                const placeholders = query.eventTypes.map(() => '?').join(', ');
                conditions.push(`event_type IN (${placeholders})`);
                params.push(...query.eventTypes);
            }
            if (query.fromSequence !== undefined) {
                conditions.push('sequence_num >= ?');
                params.push(query.fromSequence);
            }
            if (query.toSequence !== undefined) {
                conditions.push('sequence_num <= ?');
                params.push(query.toSequence);
            }
            if (query.fromTimestamp !== undefined) {
                conditions.push('timestamp >= ?');
                params.push(query.fromTimestamp);
            }
            if (query.toTimestamp !== undefined) {
                conditions.push('timestamp <= ?');
                params.push(query.toTimestamp);
            }
            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const limitClause = query.limit ? `LIMIT ${query.limit}` : '';
            const offsetClause = query.offset ? `OFFSET ${query.offset}` : '';
            const sql = `SELECT * FROM events ${whereClause} ORDER BY sequence_num ASC ${limitClause} ${offsetClause}`;
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params);
            return rows.map((row) => ({
                eventId: row.event_id,
                sessionId: row.session_id,
                sequenceNum: row.sequence_num,
                eventType: row.event_type,
                payload: JSON.parse(row.payload || '{}'),
                metadata: JSON.parse(row.metadata || '{}'),
                timestamp: row.timestamp,
            }));
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 查询失败', error, 'EventStore');
            return [];
        }
    }
    getEvent(eventId) {
        this.flush();
        if (!this.db)
            return null;
        try {
            const stmt = this.db.prepare('SELECT * FROM events WHERE event_id = ?');
            const row = stmt.get(eventId);
            if (!row)
                return null;
            return {
                eventId: row.event_id,
                sessionId: row.session_id,
                sequenceNum: row.sequence_num,
                eventType: row.event_type,
                payload: JSON.parse(row.payload || '{}'),
                metadata: JSON.parse(row.metadata || '{}'),
                timestamp: row.timestamp,
            };
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 获取事件失败', error, 'EventStore');
            return null;
        }
    }
    getSessionEvents(sessionId, limit) {
        return this.query({ sessionId, limit: limit ?? 10000 });
    }
    project(sessionId, reducer, initialState, fromSequence) {
        const snapshot = this.getLatestSnapshot(sessionId);
        let state = initialState;
        let startSeq = fromSequence ?? 0;
        let eventCount = 0;
        if (snapshot && !fromSequence) {
            try {
                state = JSON.parse(snapshot.stateJson);
                startSeq = snapshot.sequenceNum + 1;
                eventCount = snapshot.eventCount;
            }
            catch {
                state = initialState;
            }
        }
        const events = this.query({
            sessionId,
            fromSequence: startSeq,
        });
        for (const event of events) {
            state = reducer(state, event);
            eventCount++;
        }
        return {
            state,
            lastSequenceNum: events.length > 0
                ? events[events.length - 1].sequenceNum
                : startSeq - 1,
            eventCount,
            timestamp: Date.now(),
        };
    }
    projectConversationState(sessionId) {
        const initialState = {
            messages: [],
            toolCalls: [],
            dynamicTools: [],
            context: {},
        };
        return this.project(sessionId, (state, event) => {
            switch (event.eventType) {
                case 'user_input':
                    state.messages.push({
                        role: 'user',
                        content: String(event.payload.content ?? event.payload.input ?? ''),
                        timestamp: event.timestamp,
                    });
                    break;
                case 'agent_thinking':
                    state.messages.push({
                        role: 'assistant',
                        content: String(event.payload.thinking ?? event.payload.content ?? ''),
                        timestamp: event.timestamp,
                    });
                    break;
                case 'tool_call':
                    break;
                case 'tool_result': {
                    const toolName = String(event.payload.toolName ?? 'unknown');
                    const success = Boolean(event.payload.success);
                    const duration = Number(event.payload.duration ?? 0);
                    state.toolCalls.push({ toolName, success, duration });
                    break;
                }
                case 'dynamic_tool_defined': {
                    const name = String(event.payload.name ?? '');
                    if (name && !state.dynamicTools.includes(name)) {
                        state.dynamicTools.push(name);
                    }
                    break;
                }
                case 'dynamic_tool_undefined': {
                    const name = String(event.payload.name ?? '');
                    state.dynamicTools = state.dynamicTools.filter((t) => t !== name);
                    break;
                }
                case 'context_update':
                    state.context = { ...state.context, ...event.payload };
                    break;
                case 'state_transition':
                    state.context._currentState = event.payload.toState;
                    break;
            }
            return state;
        }, initialState);
    }
    saveSnapshot(sessionId, state, eventCount) {
        if (!this.db)
            return;
        const seq = this.sequenceCounters.get(sessionId) ?? 0;
        try {
            const stmt = this.db.prepare(`INSERT INTO snapshots (session_id, sequence_num, state_json, event_count, created_at)
         VALUES (?, ?, ?, ?, ?)`);
            stmt.run(sessionId, seq, JSON.stringify(state), eventCount, Date.now());
            Logger_1.Logger.info(`📸 EventStore 快照已保存: ${sessionId} @ seq=${seq}`, 'EventStore');
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 保存快照失败', error, 'EventStore');
        }
    }
    autoSnapshot(sessionId) {
        const result = this.projectConversationState(sessionId);
        this.saveSnapshot(sessionId, result.state, result.eventCount);
    }
    getLatestSnapshot(sessionId) {
        if (!this.db)
            return null;
        try {
            const stmt = this.db.prepare('SELECT * FROM snapshots WHERE session_id = ? ORDER BY sequence_num DESC LIMIT 1');
            return stmt.get(sessionId);
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 获取快照失败', error, 'EventStore');
            return null;
        }
    }
    replay(sessionId, options = {}) {
        const events = this.query({
            sessionId,
            fromSequence: options.fromSequence,
            toSequence: options.toSequence,
            eventTypes: options.eventFilter,
        });
        if (options.onEvent) {
            events.forEach((event, index) => {
                options.onEvent(event, index);
            });
        }
        if (options.onStateUpdate) {
            const initialState = {
                messages: [],
                toolCalls: [],
                dynamicTools: [],
                context: {},
            };
            let state = initialState;
            for (const event of events) {
                switch (event.eventType) {
                    case 'user_input':
                        state.messages.push({
                            role: 'user',
                            content: String(event.payload.content ?? event.payload.input ?? ''),
                            timestamp: event.timestamp,
                        });
                        break;
                    case 'agent_thinking':
                        state.messages.push({
                            role: 'assistant',
                            content: String(event.payload.thinking ?? event.payload.content ?? ''),
                            timestamp: event.timestamp,
                        });
                        break;
                    case 'tool_result': {
                        const toolName = String(event.payload.toolName ?? 'unknown');
                        const success = Boolean(event.payload.success);
                        const duration = Number(event.payload.duration ?? 0);
                        state.toolCalls.push({ toolName, success, duration });
                        break;
                    }
                    case 'dynamic_tool_defined': {
                        const name = String(event.payload.name ?? '');
                        if (name && !state.dynamicTools.includes(name)) {
                            state.dynamicTools.push(name);
                        }
                        break;
                    }
                    case 'dynamic_tool_undefined': {
                        const name = String(event.payload.name ?? '');
                        state.dynamicTools = state.dynamicTools.filter((t) => t !== name);
                        break;
                    }
                    case 'context_update':
                        state.context = { ...state.context, ...event.payload };
                        break;
                }
                options.onStateUpdate(state);
            }
        }
        return events;
    }
    getEventCount(sessionId) {
        this.flush();
        if (!this.db)
            return 0;
        try {
            if (sessionId) {
                const stmt = this.db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?');
                const result = stmt.get(sessionId);
                return result?.count ?? 0;
            }
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM events');
            const result = stmt.get();
            return result?.count ?? 0;
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 获取事件数量失败', error, 'EventStore');
            return 0;
        }
    }
    compact(sessionId) {
        this.flush();
        if (!this.db || !this.enableCompaction)
            return 0;
        try {
            const cutoff = Date.now() - this.compactionAgeMs;
            if (sessionId) {
                const stmt = this.db.prepare('DELETE FROM events WHERE session_id = ? AND timestamp < ? AND sequence_num < (SELECT MAX(sequence_num) - ? FROM events WHERE session_id = ?)');
                const result = stmt.run(sessionId, cutoff, this.snapshotInterval, sessionId);
                Logger_1.Logger.info(`EventStore 压缩: ${sessionId}, 删除 ${result.changes} 条旧事件`, 'EventStore');
                return result.changes;
            }
            const stmt = this.db.prepare(`DELETE FROM events WHERE timestamp < ? AND sequence_num < (
          SELECT MAX(e2.sequence_num) - ?
          FROM events e2
          WHERE e2.session_id = events.session_id
        )`);
            const result = stmt.run(cutoff, this.snapshotInterval);
            Logger_1.Logger.info(`EventStore 全局压缩: 删除 ${result.changes} 条旧事件`, 'EventStore');
            return result.changes;
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 压缩失败', error, 'EventStore');
            return 0;
        }
    }
    deleteSession(sessionId) {
        this.flush();
        if (!this.db)
            return false;
        try {
            const deleteEvents = this.db.prepare('DELETE FROM events WHERE session_id = ?');
            const deleteSnapshots = this.db.prepare('DELETE FROM snapshots WHERE session_id = ?');
            const txn = this.db.transaction(() => {
                deleteEvents.run(sessionId);
                deleteSnapshots.run(sessionId);
            });
            txn();
            this.sequenceCounters.delete(sessionId);
            Logger_1.Logger.info(`EventStore 删除会话: ${sessionId}`, 'EventStore');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('EventStore 删除会话失败', error, 'EventStore');
            return false;
        }
    }
    destroy() {
        this.flush();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.db) {
            try {
                this.db.close();
            }
            catch {
                /* ignore */
            }
            this.db = null;
        }
        this.sequenceCounters.clear();
        this.initialized = false;
        Logger_1.Logger.info('EventStore 已销毁', 'EventStore');
    }
}
exports.EventStore = EventStore;
