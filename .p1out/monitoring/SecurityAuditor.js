"use strict";
/**
 * 安全审计模块（兼容层）
 *
 * 本模块已重构，核心功能已合并到 src/security/AuditService.ts
 * 此类保留用于向后兼容，新的代码应直接使用 AuditService
 *
 * @deprecated 请使用 src/security/AuditService 代替
 */
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
exports.SecurityAuditor = void 0;
const deprecationWarning_1 = require("../shared/deprecationWarning");
(0, deprecationWarning_1.emitDeprecationWarning)('SecurityAuditor', 'AuditService (src/security/AuditService)', 'V6.0');
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const AuditService_1 = require("../security/AuditService");
const Logger_1 = require("../utils/Logger");
// ── 事件类型映射 ──
const LEGACY_EVENT_TYPE_MAP = {
    login_failed: 'authentication.failure',
    access_denied: 'permission.denied',
    suspicious_activity: 'security.alarm',
    data_breach_attempt: 'security.alarm',
    rate_limit_exceeded: 'security.alarm',
    malicious_input: 'security.alarm',
};
const UNIFIED_TO_LEGACY_EVENT_TYPE_MAP = {
    'authentication.failure': 'login_failed',
    'authentication.success': 'login_failed',
    'permission.denied': 'access_denied',
    'permission.granted': 'access_denied',
    'security.alarm': 'suspicious_activity',
};
/**
 * 安全审计器（兼容层）
 *
 * 维护内存中的日志和事件状态，同时委托 AuditService 进行持久化存储。
 *
 * @deprecated 请使用 AuditService 代替
 */
class SecurityAuditor {
    constructor(options) {
        this.legacyListeners = [];
        // 内存中的日志和事件状态（用于向后兼容）
        this.logs = [];
        this.events = [];
        this.maxLogs = 10000;
        this.maxEvents = 10000;
        this.auditService = AuditService_1.AuditService.getInstance();
        if (options?.maxLogs !== undefined)
            this.maxLogs = options.maxLogs;
        if (options?.maxEvents !== undefined)
            this.maxEvents = options.maxEvents;
        this.logFilePath = options?.logFilePath;
        // 初始化审计服务
        void this.initialize();
        // 注册事件监听器，将事件转换为旧格式
        this.auditService.onEvent((event) => {
            const legacyEvent = this.convertToLegacyEvent(event);
            this.legacyListeners.forEach((callback) => {
                try {
                    callback(legacyEvent);
                }
                catch (error) {
                    Logger_1.Logger.error('安全事件监听器回调失败', error, 'SecurityAuditor');
                }
            });
        });
        Logger_1.Logger.info('⚠️ SecurityAuditor 是向后兼容层，建议迁移到 AuditService', 'SecurityAuditor');
    }
    static getInstance(options) {
        if (!SecurityAuditor.instance) {
            SecurityAuditor.instance = new SecurityAuditor(options);
        }
        return SecurityAuditor.instance;
    }
    async initialize() {
        try {
            await this.auditService.initialize();
        }
        catch (error) {
            Logger_1.Logger.error('SecurityAuditor 初始化失败', error, 'SecurityAuditor');
        }
    }
    /**
     * 记录审计日志（向后兼容方法）
     * @deprecated 使用 auditService.getAuditLogger().log() 代替
     */
    logAuditEntry(entry) {
        const fullEntry = {
            ...entry,
            id: this.generateId(),
            timestamp: new Date(),
            resolved: false,
        };
        // 存储到内存
        this.logs.push(fullEntry);
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }
        // 记录到 AuditService（持久化）
        try {
            this.auditService.getAuditLogger().log({
                action: entry.action,
                actor: entry.userId,
                result: entry.level === 'error'
                    ? 'failure'
                    : entry.level === 'warning'
                        ? 'warning'
                        : 'success',
                category: entry.category,
                details: entry.details,
                userId: entry.userId,
                ipAddress: entry.ipAddress,
                userAgent: entry.userAgent,
            });
        }
        catch (err) {
            Logger_1.Logger.debug(`AuditService 持久化失败，仅保留内存日志: ${err?.message}`, 'SecurityAuditor');
        }
        // 写入文件（如果配置了日志文件路径）
        if (this.logFilePath) {
            this.writeToFile(fullEntry);
        }
        return fullEntry;
    }
    /**
     * 记录安全事件（向后兼容方法）
     * @deprecated 使用 auditService.recordSecurityEvent() 代替
     */
    recordSecurityEvent(event) {
        const fullEvent = {
            ...event,
            id: this.generateEventId(),
            timestamp: new Date(),
            acknowledged: false,
        };
        // 存储到内存
        this.events.push(fullEvent);
        if (this.events.length > this.maxEvents) {
            this.events = this.events.slice(-this.maxEvents);
        }
        // 高严重性事件自动记录审计日志
        if (event.severity === 'high' || event.severity === 'critical') {
            this.logAuditEntry({
                level: event.severity === 'critical' ? 'critical' : 'error',
                category: 'security_event',
                userId: event.userId || 'system',
                action: `security_event:${event.eventType}`,
                details: {
                    eventType: event.eventType,
                    description: event.description,
                    metadata: event.metadata,
                    severity: event.severity,
                },
                severity: event.severity,
            });
        }
        // 记录到 AuditService（持久化 + 高严重性事件审计日志）
        try {
            const unifiedEventType = LEGACY_EVENT_TYPE_MAP[event.eventType] || 'security.alarm';
            this.auditService.recordSecurityEvent({
                type: unifiedEventType,
                userId: event.userId,
                description: event.description,
                severity: event.severity,
                metadata: event.metadata,
            });
        }
        catch (err) {
            Logger_1.Logger.debug(`AuditService 持久化失败，仅保留内存事件: ${err?.message}`, 'SecurityAuditor');
        }
        return fullEvent;
    }
    /**
     * 查询审计日志（向后兼容方法）
     * @deprecated 使用 auditService.getAuditLogger().queryLogs() 代替
     */
    queryLogs(options) {
        let filtered = [...this.logs];
        if (options?.level) {
            filtered = filtered.filter((log) => log.level === options.level);
        }
        if (options?.category) {
            filtered = filtered.filter((log) => log.category === options.category);
        }
        if (options?.userId) {
            filtered = filtered.filter((log) => log.userId === options.userId);
        }
        if (options?.startTime) {
            filtered = filtered.filter((log) => log.timestamp >= options.startTime);
        }
        if (options?.endTime) {
            filtered = filtered.filter((log) => log.timestamp <= options.endTime);
        }
        if (options?.resolved !== undefined) {
            filtered = filtered.filter((log) => log.resolved === options.resolved);
        }
        // 按时间倒序排列
        filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return filtered.slice(0, options?.limit ?? 100);
    }
    /**
     * 查询安全事件（向后兼容方法）
     * @deprecated 使用 auditService.queryEvents() 代替
     */
    queryEvents(options) {
        let filtered = [...this.events];
        if (options?.eventType) {
            filtered = filtered.filter((event) => event.eventType === options.eventType);
        }
        if (options?.severity) {
            filtered = filtered.filter((event) => event.severity === options.severity);
        }
        if (options?.acknowledged !== undefined) {
            filtered = filtered.filter((event) => event.acknowledged === options.acknowledged);
        }
        // 按时间倒序排列
        filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return filtered.slice(0, options?.limit ?? 50);
    }
    /**
     * 标记事件为已确认（向后兼容方法）
     * @deprecated 使用 auditService.acknowledgeEvent() 代替
     */
    acknowledgeEvent(eventId) {
        const event = this.events.find((e) => e.id === eventId);
        if (event) {
            event.acknowledged = true;
            // 同步到 AuditService
            this.auditService.acknowledgeEvent(eventId);
            return true;
        }
        return false;
    }
    /**
     * 标记日志为已解决（向后兼容方法）
     * @deprecated 此方法已弃用
     */
    resolveLog(logId) {
        const log = this.logs.find((l) => l.id === logId);
        if (log) {
            log.resolved = true;
            Logger_1.Logger.debug(`日志已标记为已解决: ${logId}`, 'SecurityAuditor');
            return true;
        }
        return false;
    }
    /**
     * 获取未确认的安全事件数量
     * @deprecated 使用 auditService.getUnacknowledgedEventCount() 代替
     */
    getUnacknowledgedEventCount() {
        return this.events.filter((e) => !e.acknowledged).length;
    }
    /**
     * 生成审计报告（向后兼容方法）
     * @deprecated 使用 auditService.generateReport() 代替
     */
    generateReport(timeWindowHours = 24) {
        const cutoff = new Date(Date.now() - timeWindowHours * 3600000);
        const recentLogs = this.logs.filter((l) => l.timestamp >= cutoff);
        const recentEvents = this.events.filter((e) => e.timestamp >= cutoff);
        // 按类型统计事件（使用旧格式的事件类型）
        const eventsByType = {};
        recentEvents.forEach((e) => {
            eventsByType[e.eventType] = (eventsByType[e.eventType] || 0) + 1;
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
        const unresolvedLogs = recentLogs.filter((l) => !l.resolved).length;
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
     * 添加事件监听器（向后兼容方法）
     * @deprecated 使用 auditService.onEvent() 代替
     */
    onEvent(callback) {
        this.legacyListeners.push(callback);
    }
    /**
     * 清理旧数据（向后兼容方法）
     * @deprecated 使用 auditService.cleanupEvents() 代替
     */
    cleanup(maxAgeHours = 168) {
        const cutoff = new Date(Date.now() - maxAgeHours * 3600000);
        const beforeLogsCount = this.logs.length;
        const beforeEventsCount = this.events.length;
        this.logs = this.logs.filter((l) => l.timestamp >= cutoff);
        this.events = this.events.filter((e) => e.timestamp >= cutoff);
        // 同步清理 AuditService 中的事件
        this.auditService.cleanupEvents(maxAgeHours);
        const removedLogs = beforeLogsCount - this.logs.length;
        const removedEvents = beforeEventsCount - this.events.length;
        if (removedLogs > 0 || removedEvents > 0) {
            Logger_1.Logger.info(`🗑️ 已清理 ${removedLogs} 条过期日志和 ${removedEvents} 条过期事件`, 'SecurityAuditor');
        }
    }
    generateId() {
        return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    generateEventId() {
        return `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    convertToLegacyEvent(event) {
        // 将统一格式的事件转换为旧格式
        const legacyEventType = UNIFIED_TO_LEGACY_EVENT_TYPE_MAP[event.type] || 'suspicious_activity';
        return {
            id: event.id,
            timestamp: event.timestamp,
            eventType: legacyEventType,
            userId: event.userId,
            description: event.description,
            severity: event.severity,
            metadata: event.metadata,
            acknowledged: event.acknowledged,
        };
    }
    /**
     * 将日志写入文件
     */
    writeToFile(entry) {
        if (!this.logFilePath)
            return;
        try {
            const dir = path.dirname(this.logFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const logLine = JSON.stringify(entry) + '\n';
            fs.appendFileSync(this.logFilePath, logLine);
        }
        catch (error) {
            Logger_1.Logger.error('审计日志文件写入失败', error, 'SecurityAuditor');
        }
    }
}
exports.SecurityAuditor = SecurityAuditor;
SecurityAuditor.instance = null;
exports.default = SecurityAuditor;
