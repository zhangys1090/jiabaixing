/**
 * AuditService — 审计服务模块
 *
 * 合并自: AuditLogger + DataSovereigntyPipeline + SecurityAuditor
 * 职责: 安全审计日志 + 数据主权审计 + 安全事件监控
 */

// ── 向后兼容: 重新导出原有模块 ──
export { AuditLogger } from './AuditLogger';
export type { AuditLogStats, ExportOptions } from './AuditLogger';

export { DataSovereigntyPipeline } from './DataSovereigntyPipeline';
export type {
  DataAccessRecord,
  DataSovereigntyReport,
} from './DataSovereigntyPipeline';

// ── 导入内部依赖 ──
import { AuditLogger } from './AuditLogger';
import { DataSovereigntyPipeline } from './DataSovereigntyPipeline';
import { Logger } from '../utils/Logger';
import type { SecurityEvent, SecurityEventType } from './types';

export interface AuditServiceConfig {
  auditDbPath: string;
  sovereigntyDbPath: string;
  retentionDays: number;
}

const DEFAULT_AUDIT_CONFIG: AuditServiceConfig = {
  auditDbPath: './data/security/audits.db',
  sovereigntyDbPath: './data/sovereignty_audit.db',
  retentionDays: 90,
};

/**
 * 审计报告
 */
export interface AuditReport {
  totalLogs: number;
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  unresolvedLogs: number;
  unacknowledgedEvents: number;
  topUsers: Array<{ userId: string; logCount: number }>;
  summary: string;
}

export class AuditService {
  private static instance: AuditService | null = null;
  private readonly auditLogger: AuditLogger;
  private readonly sovereigntyPipeline: DataSovereigntyPipeline;
  private initialized = false;

  // ── SecurityEvent 相关 ──
  private events: SecurityEvent[] = [];
  private readonly maxEvents = 10000;
  private eventListeners: Map<string, Array<(event: SecurityEvent) => void>> =
    new Map();

  private constructor(config?: Partial<AuditServiceConfig>) {
    const fullConfig = { ...DEFAULT_AUDIT_CONFIG, ...config };
    this.auditLogger = new AuditLogger({
      retentionDays: fullConfig.retentionDays,
    });
    this.sovereigntyPipeline = new DataSovereigntyPipeline(
      fullConfig.sovereigntyDbPath
    );
  }

  static getInstance(config?: Partial<AuditServiceConfig>): AuditService {
    if (!AuditService.instance) {
      AuditService.instance = new AuditService(config);
    }
    return AuditService.instance;
  }

  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  getSovereigntyPipeline(): DataSovereigntyPipeline {
    return this.sovereigntyPipeline;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.auditLogger.initialize();
    this.sovereigntyPipeline.initialize();
    this.initialized = true;

    Logger.info('✅ AuditService 初始化完成', 'AuditService');
  }

  async shutdown(): Promise<void> {
    await this.auditLogger.shutdown();
    this.sovereigntyPipeline.shutdown();
    this.initialized = false;

    Logger.info('✅ AuditService 已关闭', 'AuditService');
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ── SecurityEvent 方法 ──

  /**
   * 记录安全事件
   * @param event - 安全事件内容（不含 id, timestamp, acknowledged）
   * @returns 完整的安全事件
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

    Logger.debug(
      `📋 安全事件已记录: ${event.type} - ${event.description}`,
      'AuditService'
    );

    return fullEvent;
  }

  /**
   * 查询安全事件
   * @param options - 查询选项
   * @returns 匹配的安全事件列表
   */
  queryEvents(options?: {
    type?: SecurityEventType;
    severity?: SecurityEvent['severity'];
    userId?: string;
    acknowledged?: boolean;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): SecurityEvent[] {
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
      filtered = filtered.filter(
        (event) => event.acknowledged === options.acknowledged
      );
    }
    if (options?.startTime) {
      filtered = filtered.filter(
        (event) => event.timestamp >= options.startTime!
      );
    }
    if (options?.endTime) {
      filtered = filtered.filter(
        (event) => event.timestamp <= options.endTime!
      );
    }

    return filtered.slice(-(options?.limit ?? 50));
  }

  /**
   * 标记事件为已确认
   * @param eventId - 事件ID
   * @returns 是否成功确认
   */
  acknowledgeEvent(eventId: string): boolean {
    const event = this.events.find((e) => e.id === eventId);
    if (event) {
      event.acknowledged = true;
      Logger.debug(`✅ 安全事件已确认: ${eventId}`, 'AuditService');
      return true;
    }
    return false;
  }

  /**
   * 获取未确认的安全事件数量
   * @returns 未确认事件数
   */
  getUnacknowledgedEventCount(): number {
    return this.events.filter((e) => !e.acknowledged).length;
  }

  /**
   * 生成审计报告
   * @param timeWindowHours - 时间窗口（小时），默认24小时
   * @returns 审计报告
   */
  generateReport(timeWindowHours: number = 24): AuditReport {
    const cutoff = new Date(Date.now() - timeWindowHours * 3600000);

    const recentLogs = this.auditLogger.queryLogs(
      { startDate: cutoff },
      10000,
      0
    );
    const recentEvents = this.events.filter((e) => e.timestamp >= cutoff);

    // 按类型统计事件
    const eventsByType: Record<string, number> = {};
    recentEvents.forEach((e) => {
      eventsByType[e.type] = (eventsByType[e.type] || 0) + 1;
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
    const unresolvedLogs = recentLogs.filter((l) => l.result !== 'success')
      .length;

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
  onEvent(callback: (event: SecurityEvent) => void): void {
    if (!this.eventListeners.has('all')) {
      this.eventListeners.set('all', []);
    }
    this.eventListeners.get('all')!.push(callback);
    Logger.debug('🔔 安全事件监听器已注册', 'AuditService');
  }

  /**
   * 清理旧事件
   * @param maxAgeHours - 最大保留时间（小时），默认168小时（7天）
   */
  cleanupEvents(maxAgeHours: number = 168): void {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600000);
    const beforeCount = this.events.length;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
    const removed = beforeCount - this.events.length;

    if (removed > 0) {
      Logger.info(`🗑️ 已清理 ${removed} 条过期安全事件`, 'AuditService');
    }
  }

  /**
   * 生成事件ID
   */
  private generateEventId(): string {
    return `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 通知事件监听器
   */
  private notifyEventListeners(event: SecurityEvent): void {
    const listeners = this.eventListeners.get('all');
    if (listeners) {
      listeners.forEach((callback) => {
        try {
          callback(event);
        } catch (error) {
          Logger.error('安全事件监听器回调失败', error as Error, 'AuditService');
        }
      });
    }
  }
}
