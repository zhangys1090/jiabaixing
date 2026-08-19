"use strict";
/**
 * 审计日志器 - 处理安全相关的日志记录和审计
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogger = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const winston_1 = require("winston");
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
const DEFAULT_AUDIT_CONFIG = {
    logLevel: 'info',
    storage: {
        type: 'file',
        path: './logs/audit',
        maxSize: 10,
    },
    retentionDays: 90,
    realtimeMonitoring: false,
};
class AuditLogger {
    constructor(config = {}) {
        this.db = null;
        this.initialized = false;
        this.config = { ...DEFAULT_AUDIT_CONFIG, ...config };
        const storagePath = this.config.storage.path || './data/security';
        this.dbPath = path_1.default.join(storagePath, 'audits.db');
    }
    async initialize() {
        if (this.initialized) {
            return;
        }
        try {
            this.ensureLogDirectory();
            this.initializeDatabase();
            this.configureLogger();
            this.setupLogCleanup();
            this.initialized = true;
            Logger_1.Logger.info('✅ 审计日志器：初始化完成');
        }
        catch (error) {
            Logger_1.Logger.error('❌ 审计日志器：初始化失败:', error);
            throw error;
        }
    }
    ensureLogDirectory() {
        const storagePath = this.config.storage.path || './logs/audit';
        if (!fs_1.default.existsSync(storagePath)) {
            fs_1.default.mkdirSync(storagePath, { recursive: true });
        }
        const dbDir = path_1.default.dirname(this.dbPath);
        if (!fs_1.default.existsSync(dbDir)) {
            fs_1.default.mkdirSync(dbDir, { recursive: true });
        }
    }
    initializeDatabase() {
        this.db = (0, DatabaseShim_1.createDatabase)(this.dbPath);
        if (!this.db) {
            Logger_1.Logger.warn('⚠️ 审计日志器：数据库降级为内存模式，日志不会被持久化');
            return;
        }
        try {
            this.db.pragma('journal_mode = WAL');
        }
        catch (err) {
            Logger_1.Logger.debug(`审计日志器: WAL模式设置失败: ${err?.message}`);
        }
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        actor TEXT,
        target TEXT,
        result TEXT NOT NULL,
        category TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_logs(result);
      CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);
    `);
    }
    configureLogger() {
        const logFormat = winston_1.format.combine(winston_1.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss',
        }), winston_1.format.json());
        const logTransports = [
            new winston_1.transports.Console({
                format: winston_1.format.combine(winston_1.format.colorize(), winston_1.format.timestamp(), winston_1.format.printf((info) => {
                    return `${info.timestamp} [${info.level}] ${info.message}`;
                })),
                level: this.config.logLevel,
            }),
        ];
        if (this.config.storage.type === 'file' && this.config.storage.path) {
            const maxSize = this.config.storage.maxSize
                ? this.config.storage.maxSize * 1024 * 1024
                : 10 * 1024 * 1024;
            const maxFiles = this.config.storage.maxFiles || 5;
            const fileTransport = new winston_1.transports.File({
                filename: path_1.default.join(this.config.storage.path, 'audit.log'),
                format: logFormat,
                level: this.config.logLevel,
                maxsize: maxSize,
                maxFiles: maxFiles,
                tailable: true,
                zippedArchive: true,
            });
            logTransports.push(fileTransport);
            const errorFileTransport = new winston_1.transports.File({
                filename: path_1.default.join(this.config.storage.path, 'audit-error.log'),
                format: logFormat,
                level: 'error',
                maxsize: maxSize,
                maxFiles: maxFiles,
                tailable: true,
                zippedArchive: true,
            });
            logTransports.push(errorFileTransport);
        }
        this.logger = (0, winston_1.createLogger)({
            level: this.config.logLevel,
            format: logFormat,
            transports: logTransports,
        });
    }
    setupLogCleanup() {
        this.cleanupTimer = setInterval(() => {
            this.cleanupOldLogs();
        }, 24 * 60 * 60 * 1000);
        if (this.cleanupTimer.unref)
            this.cleanupTimer.unref();
    }
    cleanupOldLogs() {
        try {
            if (!this.db)
                return;
            const retentionTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
            const deleteStmt = this.db.prepare('DELETE FROM audit_logs WHERE timestamp < @retention_time');
            const result = deleteStmt.run({ retention_time: retentionTime });
            if (result.changes > 0) {
                Logger_1.Logger.info(`🗑️  清理了 ${result.changes} 条过期审计日志`);
            }
            if (this.config.storage.type === 'file' && this.config.storage.path) {
                const logDir = this.config.storage.path;
                const files = fs_1.default
                    .readdirSync(logDir)
                    .filter((file) => file.startsWith('audit.') &&
                    (file.endsWith('.log') || file.endsWith('.log.gz')))
                    .map((file) => ({
                    name: file,
                    path: path_1.default.join(logDir, file),
                    mtime: fs_1.default.statSync(path_1.default.join(logDir, file)).mtime.getTime(),
                }));
                const oldFiles = files.filter((file) => file.mtime < retentionTime);
                oldFiles.forEach((file) => {
                    fs_1.default.unlinkSync(file.path);
                    Logger_1.Logger.info(`🗑️  删除旧审计日志文件：${file.name}`);
                });
            }
        }
        catch (error) {
            Logger_1.Logger.error('❌ 清理旧审计日志失败:', error);
        }
    }
    log(entry) {
        if (!this.initialized) {
            throw new Error('审计日志器未初始化');
        }
        try {
            const logEntry = {
                id: this.generateLogId(),
                timestamp: new Date(),
                userId: entry.userId || 'system',
                resource: entry.resource || 'system',
                ...entry,
            };
            if (!this.db)
                return;
            const stmt = this.db.prepare(`
        INSERT INTO audit_logs (
          id, timestamp, action, actor, target, result, category, details,
          ip_address, user_agent, created_at
        ) VALUES (
          @id, @timestamp, @action, @actor, @target, @result, @category, @details,
          @ip_address, @user_agent, @created_at
        )
      `);
            stmt.run({
                id: logEntry.id,
                timestamp: logEntry.timestamp.getTime(),
                action: logEntry.action,
                actor: logEntry.actor || null,
                target: logEntry.target || null,
                result: logEntry.result,
                category: logEntry.category || null,
                details: logEntry.details ? JSON.stringify(logEntry.details) : null,
                ip_address: logEntry.ipAddress || null,
                user_agent: logEntry.userAgent || null,
                created_at: Date.now(),
            });
            this.logger.log({
                level: entry.result === 'failure' ? 'error' : this.config.logLevel,
                message: 'Audit log entry',
                ...logEntry,
            });
            if (this.config.realtimeMonitoring) {
                this.notifyRealtimeMonitoring(logEntry);
            }
        }
        catch (error) {
            Logger_1.Logger.error('❌ 记录审计日志失败:', error);
        }
    }
    generateLogId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }
    notifyRealtimeMonitoring(logEntry) {
        Logger_1.Logger.debug('🔔 实时监控通知:', JSON.stringify(logEntry));
    }
    queryLogs(filter, limit = 100, offset = 0) {
        if (!this.initialized) {
            throw new Error('审计日志器未初始化');
        }
        try {
            let sql = 'SELECT * FROM audit_logs WHERE 1=1';
            const params = {};
            if (filter) {
                if (filter.action) {
                    sql += ' AND action = @action';
                    params.action = filter.action;
                }
                if (filter.actor) {
                    sql += ' AND actor = @actor';
                    params.actor = filter.actor;
                }
                if (filter.target) {
                    sql += ' AND target = @target';
                    params.target = filter.target;
                }
                if (filter.result) {
                    sql += ' AND result = @result';
                    params.result = filter.result;
                }
                if (filter.category) {
                    sql += ' AND category = @category';
                    params.category = filter.category;
                }
                if (filter.startDate) {
                    sql += ' AND timestamp >= @start_ts';
                    params.start_ts = filter.startDate.getTime();
                }
                if (filter.endDate) {
                    sql += ' AND timestamp <= @end_ts';
                    params.end_ts = filter.endDate.getTime();
                }
            }
            sql += ' ORDER BY timestamp DESC';
            if (!this.db)
                return [];
            const stmt = this.db.prepare(sql);
            let rows = stmt.all(params);
            // 手动处理分页
            rows = rows.slice(offset, offset + limit);
            return rows.map((row) => ({
                id: row.id,
                timestamp: new Date(row.timestamp),
                action: row.action,
                userId: row.actor || '',
                resource: row.target || '',
                actor: row.actor || undefined,
                target: row.target || undefined,
                result: row.result,
                category: row.category || undefined,
                details: row.details ? JSON.parse(row.details) : undefined,
                ipAddress: row.ip_address || undefined,
                userAgent: row.user_agent || undefined,
            }));
        }
        catch (error) {
            Logger_1.Logger.error('❌ 查询审计日志失败:', error);
            return [];
        }
    }
    async exportLogs(startDate, endDate, format = 'json') {
        if (!this.initialized) {
            throw new Error('审计日志器未初始化');
        }
        try {
            const logs = this.queryLogs({ startDate, endDate }, 10000, 0);
            if (format === 'csv') {
                const headers = [
                    'ID',
                    'Timestamp',
                    'Action',
                    'Actor',
                    'Target',
                    'Result',
                    'Category',
                ];
                const csvRows = [headers.join(',')];
                for (const log of logs) {
                    const row = [
                        log.id,
                        log.timestamp.toISOString(),
                        `"${log.action.replace(/"/g, '""')}"`,
                        log.actor ? `"${log.actor.replace(/"/g, '""')}"` : '',
                        log.target ? `"${log.target.replace(/"/g, '""')}"` : '',
                        log.result,
                        log.category ? `"${log.category.replace(/"/g, '""')}"` : '',
                    ];
                    csvRows.push(row.join(','));
                }
                return csvRows.join('\n');
            }
            return JSON.stringify(logs, null, 2);
        }
        catch (error) {
            Logger_1.Logger.error('❌ 导出审计日志失败:', error);
            return JSON.stringify([]);
        }
    }
    getLogStats() {
        if (!this.initialized) {
            throw new Error('审计日志器未初始化');
        }
        try {
            // 先获取所有日志，手动计算统计信息（提高测试兼容性）
            const allLogs = this.queryLogs({}, 10000, 0);
            const successCount = allLogs.filter((l) => l.result === 'success').length;
            const failureCount = allLogs.filter((l) => l.result === 'failure').length;
            const warningCount = allLogs.filter((l) => l.result === 'warning').length;
            // 计算 top categories
            const categoryMap = new Map();
            for (const log of allLogs) {
                if (log.category) {
                    categoryMap.set(log.category, (categoryMap.get(log.category) || 0) + 1);
                }
            }
            const topCategories = Array.from(categoryMap.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([category, count]) => ({ category, count }));
            // 计算 top actions
            const actionMap = new Map();
            for (const log of allLogs) {
                actionMap.set(log.action, (actionMap.get(log.action) || 0) + 1);
            }
            const topActions = Array.from(actionMap.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([action, count]) => ({ action, count }));
            const recentLogs = allLogs.slice(0, 20);
            return {
                totalLogs: allLogs.length,
                successCount,
                failureCount,
                warningCount,
                recentLogs,
                topCategories,
                topActions,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取审计日志统计失败:', error);
            return {
                totalLogs: 0,
                successCount: 0,
                failureCount: 0,
                warningCount: 0,
                recentLogs: [],
                topCategories: [],
                topActions: [],
            };
        }
    }
    async shutdown() {
        if (!this.initialized) {
            return;
        }
        Logger_1.Logger.info('📋 审计日志器：关闭中...');
        try {
            if (this.cleanupTimer) {
                clearInterval(this.cleanupTimer);
                this.cleanupTimer = undefined;
            }
            if (this.logger) {
                await new Promise((resolve) => {
                    this.logger.on('finish', () => resolve());
                    this.logger.end();
                });
            }
            if (this.db) {
                this.db.close();
            }
            this.initialized = false;
            Logger_1.Logger.info('✅ 审计日志器：关闭完成！');
        }
        catch (error) {
            Logger_1.Logger.error('❌ 审计日志器：关闭失败:', error);
            throw error;
        }
    }
    /** 清空所有日志（仅供测试使用） */
    clearLogs() {
        if (this.db) {
            try {
                this.db.exec('DELETE FROM audit_logs');
            }
            catch (err) {
                Logger_1.Logger.debug(`审计日志清理失败（非关键）: ${err?.message}`, 'AuditLogger');
            }
        }
    }
    /**
     * 追踪请求的完整生命周期
     *
     * 记录从用户输入到最终输出的每一步操作，
     * 包括工具调用、LLM 请求、上下文构建等
     */
    traceRequest(traceId, step, data) {
        this.log({
            action: `trace:${traceId}:${step}`,
            actor: data.actor || 'system',
            target: data.target || `trace:${traceId}`,
            result: data.result,
            category: data.category || 'request_trace',
            details: {
                traceId,
                step,
                duration: data.duration,
                ...data.details,
            },
        });
    }
    /**
     * 查询请求的完整轨迹
     *
     * 通过 traceId 查询请求从输入到输出的所有步骤
     */
    getRequestTrace(traceId) {
        return this.queryLogs({
            action: `trace:${traceId}`,
            category: 'request_trace',
        }, 1000, 0).filter((log) => log.action.startsWith(`trace:${traceId}:`));
    }
    /**
     * 获取请求轨迹摘要
     */
    getRequestTraceSummary(traceId) {
        const trace = this.getRequestTrace(traceId);
        const steps = trace.map((log) => {
            const details = log.details;
            return {
                step: details?.step || log.action.split(':').pop() || 'unknown',
                result: log.result,
                duration: details?.duration,
                timestamp: log.timestamp,
            };
        });
        return {
            traceId,
            totalSteps: steps.length,
            successSteps: steps.filter((s) => s.result === 'success').length,
            failureSteps: steps.filter((s) => s.result === 'failure').length,
            totalDuration: steps.reduce((sum, s) => sum + (s.duration || 0), 0),
            steps,
        };
    }
}
exports.AuditLogger = AuditLogger;
