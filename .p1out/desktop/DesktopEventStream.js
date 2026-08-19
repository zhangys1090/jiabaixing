"use strict";
/**
 * 桌面Agent事件流系统
 * 参考 UI-TARS Event Stream 设计
 * 实时推送Agent状态、操作、观察结果，支持前端可视化
 *
 * v2: 推进能力边界增强
 *   - 事件持久化: 将事件写入磁盘，支持审计追踪和崩溃恢复
 *   - 实时事件分析: 统计动作成功率、延迟分布、任务进展
 *   - 事件过滤与聚合: 按类型/任务/严重级别过滤，支持滑动窗口聚合
 *   - 事件重放: 从持久化日志重放事件序列，用于调试和回归测试
 *   - 事件订阅增强: 支持模式匹配订阅（通配符、正则）
 *
 * 事件类型：
 * - task_start: 任务开始
 * - task_end: 任务结束
 * - observation: 观察结果（截图）
 * - planning: 规划中
 * - action_start: 动作开始执行
 * - action_end: 动作执行完成
 * - action_error: 动作执行错误
 * - retry: 重试
 * - checkpoint: 检查点
 * - status_change: 状态变化
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventStream = exports.DesktopEventStream = void 0;
const events_1 = require("events");
const Logger_1 = require("../utils/Logger");
const fs_1 = require("fs");
const path_1 = require("path");
const PERSISTENCE_DEFAULTS = {
    enabled: false,
    dir: '',
    maxFileSize: 10 * 1024 * 1024,
    rotateOnSize: true,
    flushIntervalMs: 5000,
};
const ANALYTICS_WINDOW_MS = 60000;
class DesktopEventStream extends events_1.EventEmitter {
    constructor(options) {
        super();
        this.eventBuffer = [];
        this.maxBufferSize = 1000;
        this.sequenceCounter = 0;
        this.currentTaskId = '';
        this.subscribers = new Set();
        this.maxBufferSize = options?.maxBufferSize || 1000;
        this._persistenceConfig = { ...PERSISTENCE_DEFAULTS, ...options?.persistence };
        this._persistStream = null;
        this._persistFlushTimer = null;
        this._persistBuffer = [];
        this._analytics = {
            totalEvents: 0,
            actionSuccess: 0,
            actionFailed: 0,
            actionDurations: [],
            taskDurations: [],
            eventsByType: {},
            lastMinuteEvents: [],
        };
        this._patternSubscribers = new Map();
        this._replayMode = false;
        if (this._persistenceConfig.enabled && this._persistenceConfig.dir) {
            this._initPersistence();
        }
    }
    static getInstance(options) {
        if (!DesktopEventStream.instance) {
            DesktopEventStream.instance = new DesktopEventStream(options);
        }
        return DesktopEventStream.instance;
    }
    /**
     * 开始一个新任务
     */
    startTask(taskDescription) {
        this.currentTaskId = this.generateId();
        this.sequenceCounter = 0;
        this.emitEvent('task_start', {
            description: taskDescription,
            startTime: Date.now(),
        });
        Logger_1.Logger.info(`📋 任务开始: ${taskDescription}`, 'EventStream');
        return this.currentTaskId;
    }
    /**
     * 结束任务
     */
    endTask(success, result, details) {
        this.emitEvent('task_end', {
            success,
            result,
            endTime: Date.now(),
            ...details,
        });
        Logger_1.Logger.info(`🏁 任务结束: ${success ? '成功' : '失败'} - ${result.substring(0, 50)}`, 'EventStream');
    }
    /**
     * 发送观察事件
     */
    emitObservation(screenshotBase64, screenWidth, screenHeight, uiElements) {
        this.emitEvent('observation', {
            screenshot: screenshotBase64,
            screenWidth,
            screenHeight,
            uiElements: uiElements || [],
            timestamp: Date.now(),
        });
    }
    /**
     * 发送规划事件
     */
    emitPlanning(plan, reasoning) {
        this.emitEvent('planning', {
            plan,
            reasoning: reasoning || '',
            stepCount: Array.isArray(plan) ? plan.length : 0,
        });
        Logger_1.Logger.debug(`🧠 规划完成，共 ${Array.isArray(plan) ? plan.length : 0} 步`, 'EventStream');
    }
    /**
     * 发送动作开始事件
     */
    emitActionStart(actionType, description, params) {
        this.emitEvent('action_start', {
            actionType,
            description,
            params,
            startTime: Date.now(),
        });
        Logger_1.Logger.debug(`▶️ 动作开始: ${description}`, 'EventStream');
    }
    /**
     * 发送动作完成事件
     */
    emitActionEnd(actionType, description, success, result) {
        this.emitEvent('action_end', {
            actionType,
            description,
            success,
            result,
            endTime: Date.now(),
        });
        Logger_1.Logger.debug(`✅ 动作完成: ${description} (${success ? '成功' : '失败'})`, 'EventStream');
    }
    /**
     * 发送动作错误事件
     */
    emitActionError(actionType, description, error, willRetry = false) {
        this.emitEvent('action_error', {
            actionType,
            description,
            error,
            willRetry,
            timestamp: Date.now(),
        });
        Logger_1.Logger.warn(`❌ 动作错误: ${description} - ${error}`, 'EventStream');
    }
    /**
     * 发送重试事件
     */
    emitRetry(retryCount, maxRetries, reason) {
        this.emitEvent('retry', {
            retryCount,
            maxRetries,
            reason,
            timestamp: Date.now(),
        });
        Logger_1.Logger.warn(`🔄 重试 ${retryCount}/${maxRetries}: ${reason}`, 'EventStream');
    }
    /**
     * 发送检查点事件
     */
    emitCheckpoint(checkpointId, description) {
        this.emitEvent('checkpoint', {
            checkpointId,
            description,
            timestamp: Date.now(),
        });
        Logger_1.Logger.info(`💾 检查点: ${description}`, 'EventStream');
    }
    /**
     * 发送状态变化事件
     */
    emitStatusChange(status, details) {
        this.emitEvent('status_change', {
            status,
            details: details || '',
            timestamp: Date.now(),
        });
        Logger_1.Logger.info(`📊 状态变化: ${status}`, 'EventStream');
    }
    /**
     * 发送安全警告事件
     */
    emitSafetyWarning(warningType, message, severity = 'medium') {
        this.emitEvent('safety_warning', {
            warningType,
            message,
            severity,
            timestamp: Date.now(),
        });
        Logger_1.Logger.warn(`⚠️ 安全警告 [${severity}]: ${message}`, 'EventStream');
    }
    /**
     * 发送需要用户干预事件
     */
    emitUserInterventionRequired(reason, options = ['继续', '取消', '重试']) {
        this.emitEvent('user_intervention_required', {
            reason,
            options,
            timestamp: Date.now(),
        });
        Logger_1.Logger.info(`👤 需要用户干预: ${reason}`, 'EventStream');
    }
    /**
     * 订阅事件流
     */
    subscribe(callback) {
        this.subscribers.add(callback);
        // 返回取消订阅函数
        return () => {
            this.subscribers.delete(callback);
        };
    }
    /**
     * 获取历史事件
     */
    getHistory(limit) {
        const events = [...this.eventBuffer];
        if (limit) {
            return events.slice(-limit);
        }
        return events;
    }
    /**
     * 获取当前任务的事件
     */
    getCurrentTaskEvents() {
        return this.eventBuffer.filter((e) => e.taskId === this.currentTaskId);
    }
    /**
     * 清空事件缓冲区
     */
    clearBuffer() {
        this.eventBuffer = [];
        this.sequenceCounter = 0;
        Logger_1.Logger.debug('🧹 事件缓冲区已清空', 'EventStream');
    }
    /**
     * 导出事件为JSON
     */
    exportEvents(taskId) {
        const events = taskId
            ? this.eventBuffer.filter((e) => e.taskId === taskId)
            : this.eventBuffer;
        return JSON.stringify(events, null, 2);
    }
    /**
     * 发送事件（内部方法）
     */
    emitEvent(type, data) {
        const event = {
            id: this.generateId(),
            type,
            timestamp: Date.now(),
            taskId: this.currentTaskId,
            data,
            sequence: this.sequenceCounter++,
        };
        this.eventBuffer.push(event);
        if (this.eventBuffer.length > this.maxBufferSize) {
            this.eventBuffer.shift();
        }
        this._updateAnalytics(event);
        if (this._persistenceConfig.enabled) {
            this._persistBuffer.push(event);
        }
        this.subscribers.forEach((callback) => {
            try {
                callback(event);
            }
            catch (err) {
                Logger_1.Logger.error(`事件订阅者错误: ${err.message}`, err, 'EventStream');
            }
        });
        this._patternSubscribers.forEach((patterns, callback) => {
            for (const pattern of patterns) {
                if (this._matchesPattern(type, pattern)) {
                    try {
                        callback(event, pattern);
                    }
                    catch (err) {
                        Logger_1.Logger.error(`模式订阅者错误: ${err.message}`, err, 'EventStream');
                    }
                    break;
                }
            }
        });
        if (!this._replayMode) {
            this.emit(type, event);
            this.emit('*', event);
        }
    }
    generateId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    _initPersistence() {
        try {
            const dir = this._persistenceConfig.dir;
            if (!(0, fs_1.existsSync)(dir)) {
                (0, fs_1.mkdirSync)(dir, { recursive: true });
            }
            const filePath = (0, path_1.join)(dir, `events-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
            this._persistStream = (0, fs_1.createWriteStream)(filePath, { flags: 'a' });
            this._persistFlushTimer = setInterval(() => this._flushPersistence(), this._persistenceConfig.flushIntervalMs);
            Logger_1.Logger.info(`💾 事件持久化已启用: ${filePath}`, 'EventStream');
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 事件持久化初始化失败: ${err.message}`, 'EventStream');
            this._persistenceConfig.enabled = false;
        }
    }
    _flushPersistence() {
        if (this._persistBuffer.length === 0 || !this._persistStream) return;
        try {
            const events = this._persistBuffer.splice(0);
            const lines = [];
            for (const event of events) {
                lines.push(JSON.stringify({
                    id: event.id,
                    type: event.type,
                    ts: event.timestamp,
                    taskId: event.taskId,
                    seq: event.sequence,
                    data: event.data,
                }));
            }
            const canWrite = this._persistStream.write(lines.join('\n') + '\n');
            if (!canWrite) {
                this._persistStream.once('drain', () => {
                    Logger_1.Logger.debug('💾 持久化写入恢复', 'EventStream');
                });
            }
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 事件持久化写入失败: ${err.message}`, 'EventStream');
        }
    }
    _updateAnalytics(event) {
        this._analytics.totalEvents++;
        this._analytics.eventsByType[event.type] = (this._analytics.eventsByType[event.type] || 0) + 1;
        this._analytics.lastMinuteEvents.push(event.timestamp);
        const cutoff = Date.now() - ANALYTICS_WINDOW_MS;
        this._analytics.lastMinuteEvents = this._analytics.lastMinuteEvents.filter((t) => t > cutoff);
        if (event.type === 'action_end') {
            if (event.data?.success) {
                this._analytics.actionSuccess++;
            }
            else {
                this._analytics.actionFailed++;
            }
            if (event.data?.startTime) {
                const duration = event.timestamp - event.data.startTime;
                this._analytics.actionDurations.push(duration);
                if (this._analytics.actionDurations.length > 100) {
                    this._analytics.actionDurations.shift();
                }
            }
        }
        if (event.type === 'task_end') {
            const taskStart = this.eventBuffer.find((e) => e.type === 'task_start' && e.taskId === event.taskId);
            if (taskStart) {
                this._analytics.taskDurations.push(event.timestamp - taskStart.timestamp);
                if (this._analytics.taskDurations.length > 50) {
                    this._analytics.taskDurations.shift();
                }
            }
        }
    }
    _matchesPattern(type, pattern) {
        if (pattern === '*') return true;
        if (pattern.startsWith('/') && pattern.endsWith('/')) {
            try {
                const regex = new RegExp(pattern.slice(1, -1));
                return regex.test(type);
            }
            catch {
                return false;
            }
        }
        if (pattern.includes('*')) {
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`).test(type);
        }
        return type === pattern;
    }
    getAnalytics() {
        const a = this._analytics;
        const totalActions = a.actionSuccess + a.actionFailed;
        const successRate = totalActions > 0 ? a.actionSuccess / totalActions : 0;
        const sortedDurations = [...a.actionDurations].sort((x, y) => x - y);
        const p50 = sortedDurations.length > 0 ? sortedDurations[Math.floor(sortedDurations.length * 0.5)] : 0;
        const p95 = sortedDurations.length > 0 ? sortedDurations[Math.floor(sortedDurations.length * 0.95)] : 0;
        const avgTaskDuration = a.taskDurations.length > 0
            ? a.taskDurations.reduce((s, d) => s + d, 0) / a.taskDurations.length
            : 0;
        return {
            totalEvents: a.totalEvents,
            eventsByType: { ...a.eventsByType },
            actionSuccessRate: successRate,
            actionP50Ms: p50,
            actionP95Ms: p95,
            avgTaskDurationMs: Math.round(avgTaskDuration),
            eventsLastMinute: a.lastMinuteEvents.length,
        };
    }
    subscribePattern(pattern, callback) {
        if (!this._patternSubscribers.has(callback)) {
            this._patternSubscribers.set(callback, []);
        }
        this._patternSubscribers.get(callback).push(pattern);
        return () => {
            const patterns = this._patternSubscribers.get(callback);
            if (patterns) {
                const idx = patterns.indexOf(pattern);
                if (idx >= 0) patterns.splice(idx, 1);
                if (patterns.length === 0) this._patternSubscribers.delete(callback);
            }
        };
    }
    filterEvents(filter) {
        return this.eventBuffer.filter((e) => {
            if (filter.type && e.type !== filter.type) return false;
            if (filter.taskId && e.taskId !== filter.taskId) return false;
            if (filter.since && e.timestamp < filter.since) return false;
            if (filter.until && e.timestamp > filter.until) return false;
            if (filter.severity && e.data?.severity !== filter.severity) return false;
            return true;
        });
    }
    aggregateEvents(windowMs, type) {
        const now = Date.now();
        const cutoff = now - windowMs;
        const events = this.eventBuffer.filter((e) => e.timestamp >= cutoff && (!type || e.type === type));
        const buckets = new Map();
        const bucketSize = Math.max(1000, Math.floor(windowMs / 60));
        for (const event of events) {
            const bucketKey = Math.floor((event.timestamp - cutoff) / bucketSize);
            if (!buckets.has(bucketKey)) {
                buckets.set(bucketKey, { count: 0, startTime: cutoff + bucketKey * bucketSize });
            }
            buckets.get(bucketKey).count++;
        }
        return Array.from(buckets.values()).sort((a, b) => a.startTime - b.startTime);
    }
    async replayFromFile(filePath, callback, options) {
        try {
            const content = (0, fs_1.readFileSync)(filePath, 'utf-8');
            const lines = content.trim().split('\n');
            const speed = options?.speed ?? 1;
            this._replayMode = true;
            Logger_1.Logger.info(`🔄 开始重放事件: ${filePath} (${lines.length} 条, ${speed}x速度)`, 'EventStream');
            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                try {
                    const event = JSON.parse(lines[lineIdx]);
                    if (callback) {
                        callback(event);
                    }
                    if (options?.emitEvents) {
                        this.emit(event.type, event);
                    }
                    if (speed < 1 && event.data?.startTime && lineIdx + 1 < lines.length) {
                        try {
                            const next = JSON.parse(lines[lineIdx + 1]);
                            const delay = (next.timestamp - event.timestamp) * speed;
                            if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
                        }
                        catch { }
                    }
                }
                catch { }
            }
            this._replayMode = false;
            Logger_1.Logger.info('🔄 事件重放完成', 'EventStream');
        }
        catch (err) {
            this._replayMode = false;
            Logger_1.Logger.error(`❌ 事件重放失败: ${err.message}`, err, 'EventStream');
        }
    }
    configurePersistence(config) {
        this._persistenceConfig = { ...this._persistenceConfig, ...config };
        if (config.enabled && config.dir && !this._persistStream) {
            this._initPersistence();
        }
        else if (!config.enabled && this._persistStream) {
            this._flushPersistence();
            this._persistStream.end();
            this._persistStream = null;
            if (this._persistFlushTimer) {
                clearInterval(this._persistFlushTimer);
                this._persistFlushTimer = null;
            }
        }
        Logger_1.Logger.info(`💾 持久化配置已更新: enabled=${this._persistenceConfig.enabled}`, 'EventStream');
    }
    shutdown() {
        if (this._persistStream) {
            this._flushPersistence();
            this._persistStream.end();
            this._persistStream = null;
        }
        if (this._persistFlushTimer) {
            clearInterval(this._persistFlushTimer);
            this._persistFlushTimer = null;
        }
        this.eventBuffer = [];
        this.subscribers.clear();
        this._patternSubscribers.clear();
        this._persistBuffer = [];
        this.removeAllListeners();
        Logger_1.Logger.info('📋 DesktopEventStream 已关闭', 'EventStream');
    }
}
exports.DesktopEventStream = DesktopEventStream;
DesktopEventStream.instance = null;
let _eventStreamInstance = null;
function getEventStream() {
    if (!_eventStreamInstance) {
        _eventStreamInstance = DesktopEventStream.getInstance();
    }
    return _eventStreamInstance;
}
exports.eventStream = { get instance() { return getEventStream(); } };
