/**
 * SecurityAuditor 单元测试
 * 覆盖：审计日志记录、安全事件记录、查询、确认/解决、报告生成、监听器
 */

import * as fs from 'fs';
import * as path from 'path';
import { SecurityAuditor } from '../../../src/monitoring/SecurityAuditor';

jest.mock('fs');

describe('SecurityAuditor', () => {
  let auditor: SecurityAuditor;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.appendFileSync as jest.Mock).mockImplementation(() => {});
    (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
    (fs.mkdirSync as jest.Mock).mockImplementation(() => {});

    auditor = new SecurityAuditor();
  });

  afterEach(() => {
    auditor.cleanup(0);
  });

  describe('logAuditEntry', () => {
    it('成功记录审计日志', () => {
      const entry = auditor.logAuditEntry({
        level: 'info',
        category: 'user_action',
        userId: 'user123',
        action: 'login',
        details: { ip: '192.168.1.1' },
        severity: 'low',
      });

      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.resolved).toBe(false);
      expect(entry.level).toBe('info');
      expect(entry.userId).toBe('user123');
    });

    it('限制日志数量', () => {
      const smallAuditor = new SecurityAuditor();
      (smallAuditor as any).maxLogs = 3;

      for (let i = 0; i < 10; i++) {
        smallAuditor.logAuditEntry({
          level: 'info',
          category: 'system',
          userId: 'system',
          action: `action_${i}`,
          details: {},
          severity: 'low',
        });
      }

      const logs = smallAuditor.queryLogs();
      expect(logs.length).toBeLessThanOrEqual(3);
    });
  });

  describe('recordSecurityEvent', () => {
    it('记录安全事件', () => {
      const event = auditor.recordSecurityEvent({
        eventType: 'login_failed',
        userId: 'user123',
        description: '连续3次登录失败',
        severity: 'medium',
        metadata: { attempts: 3 },
      });

      expect(event).toBeDefined();
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.acknowledged).toBe(false);
      expect(event.eventType).toBe('login_failed');
    });

    it('高严重性事件自动记录审计日志', () => {
      const event = auditor.recordSecurityEvent({
        eventType: 'data_breach_attempt',
        userId: 'attacker',
        description: '尝试访问未经授权的数据',
        severity: 'critical',
        metadata: { source: 'external' },
      });

      expect(event.severity).toBe('critical');

      const logs = auditor.queryLogs({ category: 'security_event' });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].action).toContain('security_event');
    });

    it('限制事件数量', () => {
      const smallAuditor = new SecurityAuditor();
      (smallAuditor as any).maxEvents = 3;

      for (let i = 0; i < 10; i++) {
        smallAuditor.recordSecurityEvent({
          eventType: 'suspicious_activity',
          description: `Event ${i}`,
          severity: 'low',
          metadata: {},
        });
      }

      const events = smallAuditor.queryEvents();
      expect(events.length).toBeLessThanOrEqual(3);
    });
  });

  describe('queryLogs', () => {
    it('查询所有日志', () => {
      auditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'user1',
        action: 'action1',
        details: {},
        severity: 'low',
      });
      auditor.logAuditEntry({
        level: 'warning',
        category: 'user_action',
        userId: 'user2',
        action: 'action2',
        details: {},
        severity: 'medium',
      });

      const logs = auditor.queryLogs();

      expect(logs).toHaveLength(2);
    });

    it('按级别过滤', () => {
      auditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'user1',
        action: 'action1',
        details: {},
        severity: 'low',
      });
      auditor.logAuditEntry({
        level: 'error',
        category: 'system',
        userId: 'user1',
        action: 'action2',
        details: {},
        severity: 'high',
      });

      const errorLogs = auditor.queryLogs({ level: 'error' });

      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0].level).toBe('error');
    });

    it('按类别过滤', () => {
      auditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'user1',
        action: 'action1',
        details: {},
        severity: 'low',
      });
      auditor.logAuditEntry({
        level: 'info',
        category: 'user_action',
        userId: 'user1',
        action: 'action2',
        details: {},
        severity: 'low',
      });

      const systemLogs = auditor.queryLogs({ category: 'system' });

      expect(systemLogs).toHaveLength(1);
    });

    it('按用户过滤', () => {
      auditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'user1',
        action: 'action1',
        details: {},
        severity: 'low',
      });
      auditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'user2',
        action: 'action2',
        details: {},
        severity: 'low',
      });

      const user1Logs = auditor.queryLogs({ userId: 'user1' });

      expect(user1Logs).toHaveLength(1);
    });

    it('按解决状态过滤', () => {
      const log1 = auditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'user1',
        action: 'action1',
        details: {},
        severity: 'low',
      });
      auditor.logAuditEntry({
        level: 'error',
        category: 'system',
        userId: 'user1',
        action: 'action2',
        details: {},
        severity: 'high',
      });

      auditor.resolveLog(log1.id);

      const unresolvedLogs = auditor.queryLogs({ resolved: false });

      expect(unresolvedLogs).toHaveLength(1);
    });

    it('限制返回数量', () => {
      for (let i = 0; i < 10; i++) {
        auditor.logAuditEntry({
          level: 'info',
          category: 'system',
          userId: 'user1',
          action: `action_${i}`,
          details: {},
          severity: 'low',
        });
      }

      const logs = auditor.queryLogs({ limit: 3 });

      expect(logs).toHaveLength(3);
    });
  });

  describe('queryEvents', () => {
    it('查询所有事件', () => {
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed login',
        severity: 'medium',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'access_denied',
        description: 'Access denied',
        severity: 'high',
        metadata: {},
      });

      const events = auditor.queryEvents();

      expect(events).toHaveLength(2);
    });

    it('按事件类型过滤', () => {
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed login 1',
        severity: 'medium',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed login 2',
        severity: 'medium',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'access_denied',
        description: 'Access denied',
        severity: 'high',
        metadata: {},
      });

      const loginEvents = auditor.queryEvents({ eventType: 'login_failed' });

      expect(loginEvents).toHaveLength(2);
    });

    it('按严重性过滤', () => {
      auditor.recordSecurityEvent({
        eventType: 'suspicious_activity',
        description: 'Low severity',
        severity: 'low',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'data_breach_attempt',
        description: 'Critical severity',
        severity: 'critical',
        metadata: {},
      });

      const criticalEvents = auditor.queryEvents({ severity: 'critical' });

      expect(criticalEvents).toHaveLength(1);
    });

    it('按确认状态过滤', () => {
      const event = auditor.recordSecurityEvent({
        eventType: 'rate_limit_exceeded',
        description: 'Rate limit',
        severity: 'medium',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'malicious_input',
        description: 'Malicious input',
        severity: 'high',
        metadata: {},
      });

      auditor.acknowledgeEvent(event.id);

      const unacknowledged = auditor.queryEvents({ acknowledged: false });

      expect(unacknowledged).toHaveLength(1);
    });
  });

  describe('acknowledgeEvent', () => {
    it('确认事件成功', () => {
      const event = auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed login',
        severity: 'medium',
        metadata: {},
      });

      const result = auditor.acknowledgeEvent(event.id);

      expect(result).toBe(true);

      const events = auditor.queryEvents({ acknowledged: true });
      expect(events).toHaveLength(1);
    });

    it('确认不存在的事件返回false', () => {
      const result = auditor.acknowledgeEvent('nonexistent-id');

      expect(result).toBe(false);
    });
  });

  describe('resolveLog', () => {
    it('解决日志成功', () => {
      const log = auditor.logAuditEntry({
        level: 'error',
        category: 'system',
        userId: 'system',
        action: 'error_occurred',
        details: {},
        severity: 'high',
      });

      const result = auditor.resolveLog(log.id);

      expect(result).toBe(true);

      const resolvedLogs = auditor.queryLogs({ resolved: true });
      expect(resolvedLogs).toHaveLength(1);
    });

    it('解决不存在的日志返回false', () => {
      const result = auditor.resolveLog('nonexistent-id');

      expect(result).toBe(false);
    });
  });

  describe('getUnacknowledgedEventCount', () => {
    it('获取未确认事件数量', () => {
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Event 1',
        severity: 'medium',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'access_denied',
        description: 'Event 2',
        severity: 'high',
        metadata: {},
      });

      const count = auditor.getUnacknowledgedEventCount();

      expect(count).toBe(2);
    });

    it('确认后减少未确认数量', () => {
      const event = auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Event',
        severity: 'medium',
        metadata: {},
      });

      expect(auditor.getUnacknowledgedEventCount()).toBe(1);

      auditor.acknowledgeEvent(event.id);

      expect(auditor.getUnacknowledgedEventCount()).toBe(0);
    });
  });

  describe('generateReport', () => {
    it('生成审计报告', () => {
      auditor.logAuditEntry({
        level: 'info',
        category: 'user_action',
        userId: 'user1',
        action: 'login',
        details: {},
        severity: 'low',
      });
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed login',
        severity: 'medium',
        metadata: {},
      });

      const report = auditor.generateReport(24);

      expect(report.totalLogs).toBeGreaterThan(0);
      expect(report.totalEvents).toBeGreaterThan(0);
      expect(report.eventsByType).toBeDefined();
      expect(report.eventsBySeverity).toBeDefined();
      expect(report.topUsers).toBeDefined();
      expect(report.summary).toContain('小时');
    });

    it('空数据生成空报告', () => {
      const report = auditor.generateReport(1);

      expect(report.totalLogs).toBe(0);
      expect(report.totalEvents).toBe(0);
      expect(report.unacknowledgedEvents).toBe(0);
    });

    it('统计按类型分组', () => {
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed 1',
        severity: 'medium',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed 2',
        severity: 'medium',
        metadata: {},
      });
      auditor.recordSecurityEvent({
        eventType: 'access_denied',
        description: 'Denied',
        severity: 'high',
        metadata: {},
      });

      const report = auditor.generateReport(24);

      expect(report.eventsByType['login_failed']).toBe(2);
      expect(report.eventsByType['access_denied']).toBe(1);
    });

    it('统计前10活跃用户', () => {
      for (let i = 0; i < 15; i++) {
        auditor.logAuditEntry({
          level: 'info',
          category: 'user_action',
          userId: `user${i % 5}`,
          action: 'action',
          details: {},
          severity: 'low',
        });
      }

      const report = auditor.generateReport(24);

      expect(report.topUsers.length).toBeLessThanOrEqual(10);
      expect(report.topUsers[0].logCount).toBeGreaterThanOrEqual(report.topUsers[1]?.logCount || 0);
    });
  });

  describe('onEvent', () => {
    it('添加事件监听器', () => {
      const callback = jest.fn();

      auditor.onEvent(callback);
      auditor.recordSecurityEvent({
        eventType: 'login_failed',
        description: 'Failed login',
        severity: 'medium',
        metadata: {},
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].eventType).toBe('login_failed');
    });

    it('多个监听器都被调用', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      auditor.onEvent(callback1);
      auditor.onEvent(callback2);
      auditor.recordSecurityEvent({
        eventType: 'access_denied',
        description: 'Access denied',
        severity: 'high',
        metadata: {},
      });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup', () => {
    it('清理旧数据', () => {
      const oldLog = auditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'system',
        action: 'old_action',
        details: {},
        severity: 'low',
      });

      const oldTimestamp = new Date(Date.now() - 100000);
      (oldLog as any).timestamp = oldTimestamp;

      auditor.cleanup(0.00001);

      expect(auditor.queryLogs()).toHaveLength(0);
      expect(auditor.queryEvents()).toHaveLength(0);
    });
  });

  describe('文件写入', () => {
    it('配置日志文件路径时写入文件', () => {
      const filePath = path.join('/tmp', 'test-audit.log');
      const dirPath = '/tmp';

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === dirPath;
      });
      (fs.appendFileSync as jest.Mock).mockImplementation(() => {});

      const fileAuditor = new SecurityAuditor({
        logFilePath: filePath,
      });

      fileAuditor.logAuditEntry({
        level: 'info',
        category: 'system',
        userId: 'system',
        action: 'test',
        details: {},
        severity: 'low',
      });

      expect(fs.appendFileSync).toHaveBeenCalled();
    });

    it('文件写入失败不影响内存日志', () => {
      const filePath = path.join('/tmp', 'test-audit2.log');

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.appendFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('Disk full');
      });

      const fileAuditor = new SecurityAuditor({
        logFilePath: filePath,
      });

      expect(() => {
        fileAuditor.logAuditEntry({
          level: 'info',
          category: 'system',
          userId: 'system',
          action: 'test',
          details: {},
          severity: 'low',
        });
      }).not.toThrow();

      expect(fileAuditor.queryLogs()).toHaveLength(1);
    });
  });
});
