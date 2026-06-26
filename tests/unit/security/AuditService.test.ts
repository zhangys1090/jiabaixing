/**
 * AuditService 单元测试
 * 测试审计服务的日志记录和报告功能
 */
import { AuditService } from '../../../src/security/AuditService';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../src/security/AuditLogger', () => {
  const mockLogs: any[] = [];
  return {
    AuditLogger: jest.fn().mockImplementation(() => ({
      log: jest.fn((entry: any) => {
        mockLogs.push(entry);
      }),
      queryLogs: jest.fn((filter: any, limit: number, offset: number) => {
        let results = [...mockLogs];
        if (filter?.action) {
          results = results.filter((l) => l.action === filter.action);
        }
        if (filter?.actor) {
          results = results.filter((l) => l.actor === filter.actor);
        }
        if (filter?.result) {
          results = results.filter((l) => l.result === filter.result);
        }
        if (filter?.startDate) {
          results = results.filter(
            (l) => new Date(l.timestamp) >= filter.startDate
          );
        }
        return results.slice(offset, offset + limit);
      }),
      getLogStats: jest.fn(() => ({
        totalLogs: mockLogs.length,
        successCount: mockLogs.filter((l) => l.result === 'success').length,
        failureCount: mockLogs.filter((l) => l.result === 'failure').length,
        warningCount: mockLogs.filter((l) => l.result === 'warning').length,
        recentLogs: mockLogs.slice(-10),
        topCategories: [{ category: 'auth', count: 1 }],
        topActions: [{ action: 'login', count: 1 }],
      })),
      exportLogs: jest.fn().mockResolvedValue(JSON.stringify(mockLogs)),
      shutdown: jest.fn().mockResolvedValue(undefined),
      initialize: jest.fn().mockResolvedValue(undefined),
      clearAllLogs: jest.fn(),
      clearLogs: jest.fn(() => {
        mockLogs.length = 0;
      }),
    })),
  };
});

jest.mock('../../../src/security/DataSovereigntyPipeline', () => ({
  DataSovereigntyPipeline: jest.fn().mockImplementation(() => ({
    auditAccess: jest.fn(),
    generateReport: jest.fn().mockResolvedValue({
      totalRecords: 0,
      accessByUser: {},
      accessByRegion: {},
      violations: [],
    }),
    cleanup: jest.fn().mockResolvedValue(undefined),
    initialize: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

describe('AuditService', () => {
  let service: AuditService;

  beforeEach(async () => {
    AuditService.resetInstance();
    service = AuditService.getInstance({
      auditDbPath: ':memory:',
      sovereigntyDbPath: ':memory:',
      retentionDays: 30,
    });
    await service.initialize();
  });

  afterEach(async () => {
    await service.shutdown();
    AuditService.resetInstance();
  });

  describe('初始化', () => {
    it('应该正确初始化', () => {
      expect(service).toBeInstanceOf(AuditService);
    });
  });

  describe('审计事件', () => {
    it('应该能记录安全事件', () => {
      service.recordSecurityEvent({
        type: 'authentication.success',
        severity: 'low',
        userId: 'test_user',
        description: '用户尝试登录',
        metadata: {},
      });
      const events = service.queryEvents({ type: 'authentication.success' });
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('authentication.success');
    });

    it('应该能记录多个事件', () => {
      service.recordSecurityEvent({
        type: 'authentication.success',
        severity: 'low',
        userId: 'user_a',
        description: '用户A登录成功',
        metadata: {},
      });
      service.recordSecurityEvent({
        type: 'authentication.failure',
        severity: 'medium',
        userId: 'user_b',
        description: '用户B登录失败',
        metadata: {},
      });
      expect(service.queryEvents().length).toBe(2);
    });
  });

  describe('审计报告', () => {
    it('应该能生成审计报告', () => {
      const report = service.generateReport();
      expect(report).toBeDefined();
      expect(typeof report.totalLogs).toBe('number');
      expect(typeof report.summary).toBe('string');
    });
  });

  describe('事件回调', () => {
    it('应该支持事件监听器', () => {
      const listener = jest.fn();
      service.onEvent(listener);

      service.recordSecurityEvent({
        type: 'authentication.success',
        severity: 'low',
        userId: 'test',
        description: '测试登录',
        metadata: {},
      });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('记录事件时所有监听器都应收到通知', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      service.onEvent(listener1);
      service.onEvent(listener2);

      service.recordSecurityEvent({
        type: 'authentication.success',
        severity: 'low',
        userId: 'test',
        description: '测试登录',
        metadata: {},
      });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });
});
