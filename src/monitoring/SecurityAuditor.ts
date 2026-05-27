/**
 * 安全审计模块
 * 负责记录系统操作日志、安全事件监控与审计报告生成
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';

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

export class SecurityAuditor {
  private logs: AuditLogEntry[] = [];
  private events: SecurityEvent[] = [];
  private maxLogs = 50000;
  private maxEvents = 10000;
  private logFilePath?: string;
  private eventListeners: Map<string, Array<(event: SecurityEvent) => void>> =
    new Map();

  constructor(options?: {
    logFilePath?: string;
    maxLogs?: number;
    maxEvents?: number;
  }) {
    this.logFilePath = options?.logFilePath;
    this.maxLogs = options?.maxLogs ?? 50000;
    this.maxEvents = options?.maxEvents ?? 10000;

    if (this.logFilePath) {
      this.ensureLogFile();
    }
  }

  /**
   * 记录审计日志
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

    this.logs.push(fullEntry);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    if (this.logFilePath) {
      this.writeToFile(fullEntry);
    }

    return fullEntry;
  }

  /**
   * 记录安全事件
   */
  recordSecurityEvent(
    event: Omit<SecurityEvent, 'id' | 'timestamp' | 'acknowledged'>
  ): SecurityEvent {
    const fullEvent: SecurityEvent = {
      ...event,
      id: this.generateId(),
      timestamp: new Date(),
      acknowledged: false,
    };

    this.events.push(fullEvent);

    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // 通知监听器
    this.notifyEventListeners(fullEvent);

    // 高严重性事件同时记录审计日志
    if (fullEvent.severity === 'high' || fullEvent.severity === 'critical') {
      this.logAuditEntry({
        level: fullEvent.severity === 'critical' ? 'critical' : 'error',
        category: 'security_event',
        userId: event.userId ?? 'system',
        action: `security_event:${event.eventType}`,
        details: {
          eventType: event.eventType,
          description: event.description,
          metadata: event.metadata,
        },
        severity: event.severity,
      });
    }

    return fullEvent;
  }

  /**
   * 查询审计日志
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

    return filtered.slice(-(options?.limit ?? 100));
  }

  /**
   * 查询安全事件
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

    return filtered.slice(-(options?.limit ?? 50));
  }

  /**
   * 标记事件为已确认
   */
  acknowledgeEvent(eventId: string): boolean {
    const event = this.events.find((e) => e.id === eventId);
    if (event) {
      event.acknowledged = true;
      return true;
    }
    return false;
  }

  /**
   * 标记日志为已解决
   */
  resolveLog(logId: string): boolean {
    const log = this.logs.find((l) => l.id === logId);
    if (log) {
      log.resolved = true;
      return true;
    }
    return false;
  }

  /**
   * 获取未确认的安全事件数量
   */
  getUnacknowledgedEventCount(): number {
    return this.events.filter((e) => !e.acknowledged).length;
  }

  /**
   * 生成审计报告
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

    // 按类型统计事件
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
    const unresolvedLogs = this.logs.filter((l) => !l.resolved).length;

    return {
      totalLogs: recentLogs.length,
      totalEvents: recentEvents.length,
      eventsByType,
      eventsBySeverity,
      unresolvedLogs,
      unacknowledgedEvents: unacknowledgedEvents,
      topUsers,
      summary: `过去 ${timeWindowHours} 小时内，系统记录了 ${recentLogs.length} 条审计日志和 ${recentEvents.length} 个安全事件。未确认事件: ${unacknowledgedEvents}，未解决日志: ${unresolvedLogs}`,
    };
  }

  /**
   * 添加事件监听器
   */
  onEvent(callback: (event: SecurityEvent) => void): void {
    if (!this.eventListeners.has('all')) {
      this.eventListeners.set('all', []);
    }
    this.eventListeners.get('all')!.push(callback);
  }

  /**
   * 清理旧数据
   */
  cleanup(maxAgeHours: number = 168): void {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600000);
    this.logs = this.logs.filter((l) => l.timestamp >= cutoff);
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }

  private generateId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private ensureLogFile(): void {
    if (!this.logFilePath) return;
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, '');
    }
  }

  private writeToFile(entry: AuditLogEntry): void {
    if (!this.logFilePath) return;
    try {
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.logFilePath, line);
    } catch (error) {
      Logger.error('写入日志文件失败', error as Error, 'SecurityAuditor');
    }
  }

  private notifyEventListeners(event: SecurityEvent): void {
    const listeners = this.eventListeners.get('all');
    if (listeners) {
      listeners.forEach((callback) => {
        try {
          callback(event);
        } catch (error) {
          Logger.error('监听器回调失败', error as Error, 'SecurityAuditor');
        }
      });
    }
  }
}

export default SecurityAuditor;
