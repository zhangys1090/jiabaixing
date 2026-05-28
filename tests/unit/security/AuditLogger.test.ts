/**
 * 测试 AuditLogger 模块
 */

import { AuditLogger, AuditLogStats } from '../../../src/security/AuditLogger';
import fs from 'fs';
import path from 'path';

describe('AuditLogger', () => {
  let auditLogger: AuditLogger;
  const testDbPath = path.join('./data/security', 'test-audits.db');
  const testLogPath = './logs/audit-test';

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(async () => {
    auditLogger = new AuditLogger({
      storage: {
        type: 'file',
        path: testLogPath,
        maxSize: 1,
        maxFiles: 2,
      },
      retentionDays: 30,
      logLevel: 'error',
      realtimeMonitoring: false,
    });
    await auditLogger.initialize();
  });

  afterEach(async () => {
    await auditLogger.shutdown();
  });

  afterAll(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('基本功能', () => {
    it('应该能初始化 AuditLogger', () => {
      expect(auditLogger).toBeDefined();
    });

    it('应该能记录审计日志', () => {
      auditLogger.log({
        action: 'test_action',
        actor: 'test_actor',
        target: 'test_target',
        result: 'success' as const,
        category: 'test_category',
        userId: 'test_user',
        resource: 'test_resource',
        details: { key: 'value' },
      });

      const logs = auditLogger.queryLogs({}, 10, 0);
      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe('test_action');
      expect(logs[0].result).toBe('success');
    });

    it('应该能记录多个审计日志', () => {
      for (let i = 0; i < 5; i++) {
        auditLogger.log({
          action: `action_${i}`,
          actor: `actor_${i}`,
          target: `target_${i}`,
          result: i % 2 === 0 ? 'success' : 'failure',
          category: i % 2 === 0 ? 'category_a' : 'category_b',
        });
      }

      const logs = auditLogger.queryLogs({}, 10, 0);
      expect(logs.length).toBe(5);
    });
  });

  describe('查询功能', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        auditLogger.log({
          action: `test_query_action_${i}`,
          actor: i < 5 ? 'actor_a' : 'actor_b',
          target: `target_${i}`,
          result: i % 3 === 0 ? 'success' : i % 3 === 1 ? 'failure' : 'warning',
          category: `cat_${i % 2}`,
        });
      }
    });

    it('应该能按 action 过滤查询', () => {
      const logs = auditLogger.queryLogs({ action: 'test_query_action_0' }, 10, 0);
      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe('test_query_action_0');
    });

    it('应该能按 actor 过滤查询', () => {
      const logs = auditLogger.queryLogs({ actor: 'actor_a' }, 10, 0);
      expect(logs.length).toBe(5);
      logs.forEach(log => expect(log.actor).toBe('actor_a'));
    });

    it('应该能按 result 过滤查询', () => {
      const successLogs = auditLogger.queryLogs({ result: 'success' }, 10, 0);
      const failureLogs = auditLogger.queryLogs({ result: 'failure' }, 10, 0);
      expect(successLogs.length).toBeGreaterThan(0);
      expect(failureLogs.length).toBeGreaterThan(0);
    });

    it('应该能按 category 过滤查询', () => {
      const logs = auditLogger.queryLogs({ category: 'cat_0' }, 10, 0);
      expect(logs.length).toBeGreaterThan(0);
      logs.forEach(log => expect(log.category).toBe('cat_0'));
    });

    it('应该支持分页查询', () => {
      const firstPage = auditLogger.queryLogs({}, 3, 0);
      const secondPage = auditLogger.queryLogs({}, 3, 3);
      
      expect(firstPage.length).toBe(3);
      expect(secondPage.length).toBe(3);
    });
  });

  describe('统计功能', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        auditLogger.log({
          action: `stat_action_${i}`,
          result: i % 3 === 0 ? 'success' : i % 3 === 1 ? 'failure' : 'warning',
          category: `cat_${i % 2}`,
        });
      }
    });

    it('应该能获取完整的统计信息', () => {
      const stats = auditLogger.getLogStats();
      
      expect(stats.totalLogs).toBe(10);
      expect(stats.successCount).toBeGreaterThan(0);
      expect(stats.failureCount).toBeGreaterThan(0);
      expect(stats.warningCount).toBeGreaterThan(0);
      expect(stats.recentLogs.length).toBeGreaterThan(0);
      expect(stats.topCategories.length).toBeGreaterThan(0);
      expect(stats.topActions.length).toBeGreaterThan(0);
    });
  });

  describe('导出功能', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        auditLogger.log({
          action: `export_action_${i}`,
          actor: 'test_user',
          target: 'test_target',
          result: 'success',
        });
      }
    });

    it('应该能导出 JSON 格式', async () => {
      const startDate = new Date(Date.now() - 3600000);
      const endDate = new Date(Date.now() + 3600000);
      
      const jsonExport = await auditLogger.exportLogs(startDate, endDate, 'json');
      expect(jsonExport).toContain('[');
      expect(jsonExport).toContain(']');
      
      const parsed = JSON.parse(jsonExport);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it('应该能导出 CSV 格式', async () => {
      const startDate = new Date(Date.now() - 3600000);
      const endDate = new Date(Date.now() + 3600000);
      
      const csvExport = await auditLogger.exportLogs(startDate, endDate, 'csv');
      expect(csvExport).toContain('ID');
      expect(csvExport).toContain('Timestamp');
      expect(csvExport).toContain('Action');
    });
  });

  describe('日期范围查询', () => {
    it('应该能按日期范围过滤', async () => {
      auditLogger.log({
        action: 'date_range_test',
        result: 'success',
      });

      const startDate = new Date(Date.now() - 3600000);
      const endDate = new Date(Date.now() + 3600000);
      
      const logs = auditLogger.queryLogs({ startDate, endDate }, 10, 0);
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe('详细信息功能', () => {
    it('应该能存储和检索详细信息', () => {
      const testDetails = { 
        param1: 'value1', 
        param2: 42, 
        nested: { key: 'value' } 
      };
      
      auditLogger.log({
        action: 'details_test',
        result: 'success',
        details: testDetails,
      });

      const logs = auditLogger.queryLogs({ action: 'details_test' }, 1, 0);
      expect(logs.length).toBe(1);
      expect(logs[0].details).toEqual(testDetails);
    });
  });
});
