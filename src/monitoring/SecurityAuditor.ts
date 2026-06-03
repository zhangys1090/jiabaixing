/**
 * 安全审计模块（兼容层）
 *
 * 本模块已重构，核心功能已合并到 src/security/AuditService.ts
 * 此类保留用于向后兼容，新的代码应直接使用 AuditService
 *
 * @deprecated 请使用 src/security/AuditService 代替
 */

import { Logger } from '../utils/Logger';
import { AuditService } from '../security/AuditService';
import type { SecurityEvent as UnifiedSecurityEvent, SecurityEventType } from '../security/types';

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

const LEGACY_EVENT_TYPE_MAP: Record<SecurityEvent['eventType'], SecurityEventType> = {
  login_failed: 'authentication.failure',
  access_denied: 'permission.denied',
  suspicious_activity: 'security.alarm',
  data_breach_attempt: 'security.alarm',
  rate_limit_exceeded: 'security.alarm',
  malicious_input: 'security.alarm',
};

/**
 * 安全审计器（兼容层）
 *
 * @deprecated 请使用 AuditService 代替
 */
export class SecurityAuditor {
  private static instance: SecurityAuditor | null = null;
  private auditService: AuditService;
  private legacyListeners: Array<(event: SecurityEvent) => void> = [];

  constructor(options?: {
    logFilePath?: string;
    maxLogs?: number;
    maxEvents?: number;
  }) {
    this.auditService = AuditService.getInstance();

    // 初始化审计服务
    this.initialize();

    // 注册事件监听器，将事件转换为旧格式
    this.auditService.onEvent((event: UnifiedSecurityEvent) => {
      const legacyEvent = this.convertToLegacyEvent(event);
      this.legacyListeners.forEach((callback) => {
        try {
          callback(legacyEvent);
        } catch (error) {
          Logger.error('安全事件监听器回调失败', error as Error, 'SecurityAuditor');
        }
      });
    });

    Logger.info('⚠️ SecurityAuditor 是向后兼容层，建议迁移到 AuditService', 'SecurityAuditor');
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
      Logger.error('SecurityAuditor 初始化失败', error as Error, 'SecurityAuditor');
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

    // 记录到 AuditService
    this.auditService.getAuditLogger().log({
      action: entry.action,
      actor: entry.userId,
      result: entry.level === 'error' ? 'failure' : entry.level === 'warning' ? 'warning' : 'success',
      category: entry.category,
      details: entry.details,
      userId: entry.userId,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
    });

    return fullEntry;
  }

  /**
   * 记录安全事件（向后兼容方法）
   * @deprecated 使用 auditService.recordSecurityEvent() 代替
   */
  recordSecurityEvent(
    event: Omit<SecurityEvent, 'id' | 'timestamp' | 'acknowledged'>
  ): SecurityEvent {
    const unifiedEventType = LEGACY_EVENT_TYPE_MAP[event.eventType] || 'security.alarm';

    const unifiedEvent = this.auditService.recordSecurityEvent({
      type: unifiedEventType,
      userId: event.userId,
      description: event.description,
      severity: event.severity,
      metadata: event.metadata,
    });

    return this.convertToLegacyEvent(unifiedEvent);
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
    const category = options?.category;
    const logs = this.auditService.getAuditLogger().queryLogs(
      {
        startDate: options?.startTime,
        endDate: options?.endTime,
      },
      options?.limit ?? 100,
      0
    );

    return logs
      .filter((log) => {
        if (options?.level) {
          const levelMap: Record<string, AuditLogEntry['level']> = {
            success: 'info',
            failure: 'error',
            warning: 'warning',
          };
          if (levelMap[log.result] !== options.level) return false;
        }
        if (options?.userId && log.userId !== options.userId) return false;
        if (category && log.category !== category) return false;
        return true;
      })
      .map((log) => ({
        id: log.id,
        timestamp: log.timestamp,
        level: log.result === 'failure' ? 'error' : log.result === 'warning' ? 'warning' : 'info',
        category: (log.category as AuditLogEntry['category']) || 'system',
        userId: log.userId,
        action: log.action,
        details: log.details || {},
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        severity: (log.details?.severity as AuditLogEntry['severity']) || 'low',
        resolved: false,
      }));
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
    const events = this.auditService.queryEvents({
      limit: options?.limit ?? 50,
    });

    return events
      .filter((event) => {
        if (options?.severity && event.severity !== options.severity) return false;
        if (options?.acknowledged !== undefined && event.acknowledged !== options.acknowledged) return false;
        return true;
      })
      .map((event) => this.convertToLegacyEvent(event));
  }

  /**
   * 标记事件为已确认（向后兼容方法）
   * @deprecated 使用 auditService.acknowledgeEvent() 代替
   */
  acknowledgeEvent(eventId: string): boolean {
    return this.auditService.acknowledgeEvent(eventId);
  }

  /**
   * 标记日志为已解决（向后兼容方法）
   * @deprecated 此方法已弃用
   */
  resolveLog(logId: string): boolean {
    // 日志解决功能在 AuditService 中未实现，此处返回 false
    Logger.debug(`日志解决功能已弃用: ${logId}`, 'SecurityAuditor');
    return false;
  }

  /**
   * 获取未确认的安全事件数量
   * @deprecated 使用 auditService.getUnacknowledgedEventCount() 代替
   */
  getUnacknowledgedEventCount(): number {
    return this.auditService.getUnacknowledgedEventCount();
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
    return this.auditService.generateReport(timeWindowHours);
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
    this.auditService.cleanupEvents(maxAgeHours);
  }

  private generateId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private convertToLegacyEvent(event: UnifiedSecurityEvent): SecurityEvent {
    // 将统一格式的事件转换为旧格式
    let legacyEventType: SecurityEvent['eventType'] = 'suspicious_activity';

    if (event.type === 'authentication.failure') {
      legacyEventType = 'login_failed';
    } else if (event.type === 'permission.denied') {
      legacyEventType = 'access_denied';
    }

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
}

export default SecurityAuditor;
