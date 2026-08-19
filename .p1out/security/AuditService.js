"use strict";
/**
 * AuditService — 审计服务模块
 *
 * 合并自: AuditLogger + DataSovereigntyPipeline + SecurityAuditor
 * 职责: 安全审计日志 + 数据主权审计 + 安全事件监控
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = exports.DataSovereigntyPipeline = exports.AuditLogger = void 0;
// ── 向后兼容: 重新导出原有模块 ──
var AuditLogger_1 = require("./AuditLogger");
Object.defineProperty(exports, "AuditLogger", { enumerable: true, get: function () { return AuditLogger_1.AuditLogger; } });
var DataSovereigntyPipeline_1 = require("./DataSovereigntyPipeline");
Object.defineProperty(exports, "DataSovereigntyPipeline", { enumerable: true, get: function () { return DataSovereigntyPipeline_1.DataSovereigntyPipeline; } });
// ── 导入内部依赖 ──
const Logger_1 = require("../utils/Logger");
const AuditLogger_2 = require("./AuditLogger");
const DataSovereigntyPipeline_2 = require("./DataSovereigntyPipeline");
const DEFAULT_AUDIT_CONFIG = {
    auditDbPath: './data/security/audits.db',
    sovereigntyDbPath: './data/sovereignty_audit.db',
    retentionDays: 90,
};
class AuditService {
    constructor(config) {
        this.initialized = false;
        // ── SecurityEvent 相关 ──
        this.events = [];
        this.maxEvents = 10000;
        this.eventListeners = new Map();
        this.MAX_EVENT_LISTENERS = 50;
        const fullConfig = { ...DEFAULT_AUDIT_CONFIG, ...config };
        this.auditLogger = new AuditLogger_2.AuditLogger({
            retentionDays: fullConfig.retentionDays,
        });
        this.sovereigntyPipeline = new DataSovereigntyPipeline_2.DataSovereigntyPipeline(fullConfig.sovereigntyDbPath);
    }
    static getInstance(config) {
        if (!AuditService.instance) {
            AuditService.instance = new AuditService(config);
        }
        return AuditService.instance;
    }
    /** 重置单例（仅供测试使用） */
    static resetInstance() {
        if (AuditService.instance) {
            AuditService.instance.events = [];
            AuditService.instance.eventListeners.clear();
            AuditService.instance.initialized = false;
            const logger = AuditService.instance.auditLogger;
            if (typeof logger.clearLogs === 'function') {
                logger.clearLogs();
            }
            else if (typeof logger.clearAllLogs === 'function') {
                logger.clearAllLogs();
            }
            AuditService.instance.shutdown().catch((err) => {
                Logger_1.Logger.debug(`审计服务关闭失败: ${err?.message}`, 'AuditService');
            });
        }
        AuditService.instance = null;
    }
    getAuditLogger() {
        return this.auditLogger;
    }
    getSovereigntyPipeline() {
        return this.sovereigntyPipeline;
    }
    async initialize() {
        if (this.initialized)
            return;
        await this.auditLogger.initialize();
        this.sovereigntyPipeline.initialize();
        this.initialized = true;
        Logger_1.Logger.info('✅ AuditService 初始化完成', 'AuditService');
    }
    async shutdown() {
        await this.auditLogger.shutdown();
        this.sovereigntyPipeline.shutdown();
        this.initialized = false;
        Logger_1.Logger.info('✅ AuditService 已关闭', 'AuditService');
    }
    isInitialized() {
        return this.initialized;
    }
    // ── SecurityEvent 方法 ──
    /**
     * 记录安全事件
     * @param event - 安全事件内容（不含 id, timestamp, acknowledged）
     * @returns 完整的安全事件
     */
    recordSecurityEvent(event) {
        const fullEvent = {
            ...event,
            id: this.generateEventId(),
            timestamp: new Date(),
            acknowledged: false,
        };
        this.events.push(fullEvent);
        if (this.events.length > this.maxEvents) {
            this.events = this.events.slice(-this.maxEvents);
        }
        // 通知监听器
        this.notifyEventListeners(fullEvent);
        // 高严重性事件同时记录到审计日志
        if (fullEvent.severity === 'high' || fullEvent.severity === 'critical') {
            this.auditLogger.log({
                action: `security_event:${event.type}`,
                actor: event.userId || 'system',
                result: 'warning',
                category: 'security_event',
                details: {
                    eventType: event.type,
                    description: event.description,
                    metadata: event.metadata,
                    severity: event.severity,
                },
            });
        }
        Logger_1.Logger.debug(`📋 安全事件已记录: ${event.type} - ${event.description}`, 'AuditService');
        return fullEvent;
    }
    /**
     * 查询安全事件
     * @param options - 查询选项
     * @returns 匹配的安全事件列表
     */
    queryEvents(options) {
        let filtered = [...this.events];
        if (options?.type) {
            filtered = filtered.filter((event) => event.type === options.type);
        }
        if (options?.severity) {
            filtered = filtered.filter((event) => event.severity === options.severity);
        }
        if (options?.userId) {
            filtered = filtered.filter((event) => event.userId === options.userId);
        }
        if (options?.acknowledged !== undefined) {
            filtered = filtered.filter((event) => event.acknowledged === options.acknowledged);
        }
        if (options?.startTime) {
            filtered = filtered.filter((event) => event.timestamp >= options.startTime);
        }
        if (options?.endTime) {
            filtered = filtered.filter((event) => event.timestamp <= options.endTime);
        }
        return filtered.slice(-(options?.limit ?? 50));
    }
    /**
     * 标记事件为已确认
     * @param eventId - 事件ID
     * @returns 是否成功确认
     */
    acknowledgeEvent(eventId) {
        const event = this.events.find((e) => e.id === eventId);
        if (event) {
            event.acknowledged = true;
            Logger_1.Logger.debug(`✅ 安全事件已确认: ${eventId}`, 'AuditService');
            return true;
        }
        return false;
    }
    /**
     * 获取未确认的安全事件数量
     * @returns 未确认事件数
     */
    getUnacknowledgedEventCount() {
        return this.events.filter((e) => !e.acknowledged).length;
    }
    /**
     * 生成审计报告
     * @param timeWindowHours - 时间窗口（小时），默认24小时
     * @returns 审计报告
     */
    generateReport(timeWindowHours = 24) {
        const cutoff = new Date(Date.now() - timeWindowHours * 3600000);
        const recentLogs = this.auditLogger.queryLogs({ startDate: cutoff }, 10000, 0);
        const recentEvents = this.events.filter((e) => e.timestamp >= cutoff);
        // 按类型统计事件
        const eventsByType = {};
        recentEvents.forEach((e) => {
            eventsByType[e.type] = (eventsByType[e.type] || 0) + 1;
        });
        // 按严重性统计
        const eventsBySeverity = {};
        recentEvents.forEach((e) => {
            eventsBySeverity[e.severity] = (eventsBySeverity[e.severity] || 0) + 1;
        });
        // 统计活跃用户
        const userCounts = {};
        recentLogs.forEach((l) => {
            userCounts[l.userId] = (userCounts[l.userId] || 0) + 1;
        });
        const topUsers = Object.entries(userCounts)
            .map(([userId, logCount]) => ({ userId, logCount }))
            .sort((a, b) => b.logCount - a.logCount)
            .slice(0, 10);
        const unacknowledgedEvents = this.getUnacknowledgedEventCount();
        const unresolvedLogs = recentLogs.filter((l) => l.result !== 'success').length;
        return {
            totalLogs: recentLogs.length,
            totalEvents: recentEvents.length,
            eventsByType,
            eventsBySeverity,
            unresolvedLogs,
            unacknowledgedEvents,
            topUsers,
            summary: `过去 ${timeWindowHours} 小时内，系统记录了 ${recentLogs.length} 条审计日志和 ${recentEvents.length} 个安全事件。未确认事件: ${unacknowledgedEvents}，未解决日志: ${unresolvedLogs}`,
        };
    }
    /**
     * 添加安全事件监听器
     * @param callback - 事件回调函数
     */
    onEvent(callback) {
        if (!this.eventListeners.has('all')) {
            if (this.eventListeners.size >= this.MAX_EVENT_LISTENERS) {
                const oldestKey = this.eventListeners.keys().next().value;
                this.eventListeners.delete(oldestKey);
            }
            this.eventListeners.set('all', []);
        }
        this.eventListeners.get('all').push(callback);
        Logger_1.Logger.debug('🔔 安全事件监听器已注册', 'AuditService');
    }
    /**
     * 清理旧事件
     * @param maxAgeHours - 最大保留时间（小时），默认168小时（7天）
     */
    cleanupEvents(maxAgeHours = 168) {
        const cutoff = new Date(Date.now() - maxAgeHours * 3600000);
        const beforeCount = this.events.length;
        this.events = this.events.filter((e) => e.timestamp >= cutoff);
        const removed = beforeCount - this.events.length;
        if (removed > 0) {
            Logger_1.Logger.info(`🗑️ 已清理 ${removed} 条过期安全事件`, 'AuditService');
        }
    }
    /**
     * 生成事件ID
     */
    generateEventId() {
        return `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    /**
     * 通知事件监听器
     */
    notifyEventListeners(event) {
        const listeners = this.eventListeners.get('all');
        if (listeners) {
            listeners.forEach((callback) => {
                try {
                    callback(event);
                }
                catch (error) {
                    Logger_1.Logger.error('安全事件监听器回调失败', error, 'AuditService');
                }
            });
        }
    }
}
exports.AuditService = AuditService;
AuditService.instance = null;
