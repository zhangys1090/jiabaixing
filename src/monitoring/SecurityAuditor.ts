/**
 * 安全审计模块（兼容层）
 *
 * 本模块已重构，核心功能已合并到 src/security/AuditService.ts
 * 此类保留用于向后兼容，新的代码应直接使用 AuditService
 *
 * @deprecated 请使用 src/security/AuditService 代替
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuditService } from '../security/AuditService';
import type {
  SecurityEventType,
  SecurityEvent as UnifiedSecurityEvent,
} from '../security/types';
import { Logger } from '../utils/Logger';

// ── 向后兼容的类型定义 ──

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'warning' | 'error' | 'critical';
  category:
    | 'authentication'
    | 'authorization'
    | 'data_access'
    | 'system'
    | 'security_event'
    | 'user_action';
  userId: string;
  action: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  resolved: boolean;
}

export interface SecurityEvent {
  id: string;
  timestamp: Date;
  eventType:
    | 'login_failed'
    | 'access_denied'
    | 'suspicious_activity'
    | 'data_breach_attempt'
    | 'rate_limit_exceeded'
    | 'malicious_input';
  userId?: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
  acknowledged: boolean;
}

// ── 事件类型映射 ──

const LEGACY_EVENT_TYPE_MAP: Record<
  SecurityEvent['eventType'],
  SecurityEventType
> = {
  login_failed: 'authentication.failure',
  access_denied: 'permission.denied',
  suspicious_activity: 'security.alarm',
  data_breach_attempt: 'security.alarm',
  rate_limit_exceeded: 'security.alarm',
  malicious_input: 'security.alarm',
};

const UNIFIED_TO_LEGACY_EVENT_TYPE_MAP: Record<
  string,
  SecurityEvent['eventType']
> = {
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
export class SecurityAuditor {
  private static instance: SecurityAuditor | null = null;
  private auditService: AuditService;
  private legacyListeners: Array<(event: SecurityEvent) => void> = [];

  // 内存中的日志和事件状态（用于向后兼容）
  private logs: AuditLogEntry[] = [];
  private events: SecurityEvent[] = [];
  private maxLogs: number = 10000;
  private maxEvents: number = 10000;
  private logFilePath?: string;

  constructor(options?: {
    logFilePath?: string;
    maxLogs?: number;
    maxEvents?: number;
  }) {
    this.auditService = AuditService.getInstance();

    if (options?.maxLogs !== undefined) this.maxLogs = options.maxLogs;
    if (options?.maxEvents !== undefined) this.maxEvents = options.maxEvents;
    this.logFilePath = options?.logFilePath;

    // 初始化审计服务
    void this.initialize();

    // 注册事件监听器，将事件转换为旧格式
    this.auditService.onEvent((event: UnifiedSecurityEvent) => {
      const legacyEvent = this.convertToLegacyEvent(event);
      this.legacyListeners.forEach((callback) => {
        try {
          callback(legacyEvent);
        } catch (error) {
          Logger.error(
            '安全事件监听器回调失败',
            error as Error,
            'SecurityAuditor'
          );
        }
      });
    });

    Logger.info(
      '⚠️ SecurityAuditor 是向后兼容层，建议迁移到 AuditService',
      'SecurityAuditor'
    );
  }

  static getInstance(options?: {
    logFilePath?: string;
    maxLogs?: number;
    maxEvents?: number;
  }): SecurityAuditor {
    if (!SecurityAuditor.instance) {
      SecurityAuditor.instance = new SecurityAuditor(options);
    }
    return SecurityAuditor.instance;
  }

  private async initialize(): Promise<void> {
    try {
      await this.auditService.initialize();
    } catch (error) {
      Logger.error(
        'SecurityAuditor 初始化失败',
        error as Error,
        'SecurityAuditor'
      );
    }
  }

  /**
   * 记录审计日志（向后兼容方法）
   * @deprecated 使用 auditService.getAuditLogger().log() 代替
   */
  logAuditEntry(
    entry: Omit<AuditLogEntry, 'id' | 'timestamp' | 'resolved'>
  ): AuditLogEntry {
    const fullEntry: AuditLogEntry = {
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
        result:
          entry.level === 'error'
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
    } catch {
      Logger.debug(
        'AuditService 持久化失败，仅保留内存日志',
        'SecurityAuditor'
      );
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
  recordSecurityEvent(
    event: Omit<SecurityEvent, 'id' | 'timestamp' | 'acknowledged'>
  ): SecurityEvent {
    const fullEvent: SecurityEvent = {
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
      const unifiedEventType =
        LEGACY_EVENT_TYPE_MAP[event.eventType] || 'security.alarm';

      this.auditService.recordSecurityEvent({
        type: unifiedEventType,
        userId: event.userId,
        description: event.description,
        severity: event.severity,
        metadata: event.metadata,
      });
    } catch {
      Logger.debug(
        'AuditService 持久化失败，仅保留内存事件',
        'SecurityAuditor'
      );
    }

    return fullEvent;
  }

  /**
   * 查询审计日志（向后兼容方法）
   * @deprecated 使用 auditService.getAuditLogger().queryLogs() 代替
   */
  queryLogs(options?: {
    level?: AuditLogEntry['level'];
    category?: AuditLogEntry['category'];
    userId?: string;
    startTime?: Date;
    endTime?: Date;
    resolved?: boolean;
    limit?: number;
  }): AuditLogEntry[] {
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
      filtered = filtered.filter((log) => log.timestamp >= options.startTime!);
    }
    if (options?.endTime) {
      filtered = filtered.filter((log) => log.timestamp <= options.endTime!);
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
  queryEvents(options?: {
    eventType?: SecurityEvent['eventType'];
    severity?: SecurityEvent['severity'];
    acknowledged?: boolean;
    limit?: number;
  }): SecurityEvent[] {
    let filtered = [...this.events];

    if (options?.eventType) {
      filtered = filtered.filter(
        (event) => event.eventType === options.eventType
      );
    }
    if (options?.severity) {
      filtered = filtered.filter(
        (event) => event.severity === options.severity
      );
    }
    if (options?.acknowledged !== undefined) {
      filtered = filtered.filter(
        (event) => event.acknowledged === options.acknowledged
      );
    }

    // 按时间倒序排列
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return filtered.slice(0, options?.limit ?? 50);
  }

  /**
   * 标记事件为已确认（向后兼容方法）
   * @deprecated 使用 auditService.acknowledgeEvent() 代替
   */
  acknowledgeEvent(eventId: string): boolean {
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
  resolveLog(logId: string): boolean {
    const log = this.logs.find((l) => l.id === logId);
    if (log) {
      log.resolved = true;
      Logger.debug(`日志已标记为已解决: ${logId}`, 'SecurityAuditor');
      return true;
    }
    return false;
  }

  /**
   * 获取未确认的安全事件数量
   * @deprecated 使用 auditService.getUnacknowledgedEventCount() 代替
   */
  getUnacknowledgedEventCount(): number {
    return this.events.filter((e) => !e.acknowledged).length;
  }

  /**
   * 生成审计报告（向后兼容方法）
   * @deprecated 使用 auditService.generateReport() 代替
   */
  generateReport(timeWindowHours: number = 24): {
    totalLogs: number;
    totalEvents: number;
    eventsByType: Record<string, number>;
    eventsBySeverity: Record<string, number>;
    unresolvedLogs: number;
    unacknowledgedEvents: number;
    topUsers: Array<{ userId: string; logCount: number }>;
    summary: string;
  } {
    const cutoff = new Date(Date.now() - timeWindowHours * 3600000);

    const recentLogs = this.logs.filter((l) => l.timestamp >= cutoff);
    const recentEvents = this.events.filter((e) => e.timestamp >= cutoff);

    // 按类型统计事件（使用旧格式的事件类型）
    const eventsByType: Record<string, number> = {};
    recentEvents.forEach((e) => {
      eventsByType[e.eventType] = (eventsByType[e.eventType] || 0) + 1;
    });

    // 按严重性统计
    const eventsBySeverity: Record<string, number> = {};
    recentEvents.forEach((e) => {
      eventsBySeverity[e.severity] = (eventsBySeverity[e.severity] || 0) + 1;
    });

    // 统计活跃用户
    const userCounts: Record<string, number> = {};
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
  onEvent(callback: (event: SecurityEvent) => void): void {
    this.legacyListeners.push(callback);
  }

  /**
   * 清理旧数据（向后兼容方法）
   * @deprecated 使用 auditService.cleanupEvents() 代替
   */
  cleanup(maxAgeHours: number = 168): void {
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
      Logger.info(
        `🗑️ 已清理 ${removedLogs} 条过期日志和 ${removedEvents} 条过期事件`,
        'SecurityAuditor'
      );
    }
  }

  private generateId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private generateEventId(): string {
    return `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private convertToLegacyEvent(event: UnifiedSecurityEvent): SecurityEvent {
    // 将统一格式的事件转换为旧格式
    const legacyEventType: SecurityEvent['eventType'] =
      UNIFIED_TO_LEGACY_EVENT_TYPE_MAP[event.type] || 'suspicious_activity';

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
  private writeToFile(entry: AuditLogEntry): void {
    if (!this.logFilePath) return;

    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const logLine = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.logFilePath, logLine);
    } catch (error) {
      Logger.error('审计日志文件写入失败', error as Error, 'SecurityAuditor');
    }
  }
}

export default SecurityAuditor;
