/**
 * IntegrationStandard 增强功能测试
 */

import {
  ConfigSchema,
  createLogEntry,
  createMetric,
  createStandardError,
  ErrorCategory,
  ErrorSeverity,
  formatError,
  formatLogEntry,
  formatMetric,
  generateTraceId,
  LogLevel,
  validateConfig,
} from '../../src/shared/IntegrationStandard';

describe('IntegrationStandard 增强功能测试', () => {
  describe('标准错误', () => {
    it('应该创建标准错误', () => {
      const error = createStandardError(
        'TEST_001',
        '测试错误',
        ErrorCategory.SYSTEM,
        ErrorSeverity.HIGH,
        { detail: '测试详情' }
      );

      expect(error.code).toBe('TEST_001');
      expect(error.message).toBe('测试错误');
      expect(error.category).toBe(ErrorCategory.SYSTEM);
      expect(error.severity).toBe(ErrorSeverity.HIGH);
      expect(error.details).toEqual({ detail: '测试详情' });
      expect(error.timestamp).toBeDefined();
      expect(error.traceId).toBeDefined();
    });

    it('应该格式化错误', () => {
      const error = createStandardError(
        'TEST_001',
        '测试错误',
        ErrorCategory.SYSTEM,
        ErrorSeverity.HIGH
      );

      const formatted = formatError(error);

      expect(formatted).toBe('[TEST_001] 测试错误 (SYSTEM/HIGH)');
    });

    it('应该使用自定义追踪ID', () => {
      const customTraceId = 'custom_trace_123';
      const error = createStandardError(
        'TEST_001',
        '测试错误',
        ErrorCategory.SYSTEM,
        ErrorSeverity.HIGH,
        undefined,
        customTraceId
      );

      expect(error.traceId).toBe(customTraceId);
    });
  });

  describe('日志条目', () => {
    it('应该创建日志条目', () => {
      const entry = createLogEntry(
        LogLevel.INFO,
        '测试日志',
        'TestModule',
        'trace_123',
        { key: 'value' }
      );

      expect(entry.level).toBe(LogLevel.INFO);
      expect(entry.message).toBe('测试日志');
      expect(entry.module).toBe('TestModule');
      expect(entry.traceId).toBe('trace_123');
      expect(entry.metadata).toEqual({ key: 'value' });
      expect(entry.timestamp).toBeDefined();
    });

    it('应该格式化日志条目', () => {
      const entry = createLogEntry(
        LogLevel.INFO,
        '测试日志',
        'TestModule',
        'trace_123',
        { key: 'value' }
      );

      const formatted = formatLogEntry(entry);

      expect(formatted).toContain('[INFO]');
      expect(formatted).toContain('[TestModule]');
      expect(formatted).toContain('[trace_123]');
      expect(formatted).toContain('测试日志');
    });

    it('应该格式化没有追踪ID的日志条目', () => {
      const entry = createLogEntry(LogLevel.INFO, '测试日志', 'TestModule');

      const formatted = formatLogEntry(entry);

      expect(formatted).toContain('[INFO]');
      expect(formatted).toContain('[TestModule]');
      expect(formatted).toContain('测试日志');
    });
  });

  describe('监控指标', () => {
    it('应该创建监控指标', () => {
      const metric = createMetric('test_metric', 42, {
        label1: 'value1',
        label2: 'value2',
      });

      expect(metric.name).toBe('test_metric');
      expect(metric.value).toBe(42);
      expect(metric.labels).toEqual({ label1: 'value1', label2: 'value2' });
      expect(metric.timestamp).toBeDefined();
    });

    it('应该格式化监控指标', () => {
      const metric = createMetric('test_metric', 42, {
        label1: 'value1',
        label2: 'value2',
      });

      const formatted = formatMetric(metric);

      expect(formatted).toContain('test_metric');
      expect(formatted).toContain('label1="value1"');
      expect(formatted).toContain('label2="value2"');
      expect(formatted).toContain('42');
    });

    it('应该格式化没有标签的监控指标', () => {
      const metric = createMetric('test_metric', 42);

      const formatted = formatMetric(metric);

      expect(formatted).toContain('test_metric');
      expect(formatted).toContain('42');
    });
  });

  describe('配置验证', () => {
    it('应该验证有效配置', () => {
      const schema: ConfigSchema = {
        port: {
          value: 3000,
          type: 'number',
          required: true,
          validator: (v) => typeof v === 'number' && v > 0 && v < 65536,
        },
        host: {
          value: 'localhost',
          type: 'string',
          required: true,
        },
      };

      const config = {
        port: 3000,
        host: 'localhost',
      };

      const result = validateConfig(schema, config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该验证缺少必需配置', () => {
      const schema: ConfigSchema = {
        port: {
          value: 3000,
          type: 'number',
          required: true,
        },
        host: {
          value: 'localhost',
          type: 'string',
          required: true,
        },
      };

      const config = {
        port: 3000,
      };

      const result = validateConfig(schema, config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('配置项 "host" 是必需的');
    });

    it('应该验证自定义验证器', () => {
      const schema: ConfigSchema = {
        port: {
          value: 3000,
          type: 'number',
          required: true,
          validator: (v) => typeof v === 'number' && v > 0 && v < 65536,
        },
      };

      const config = {
        port: 70000,
      };

      const result = validateConfig(schema, config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('配置项 "port" 验证失败');
    });
  });

  describe('追踪ID生成', () => {
    it('应该生成唯一的追踪ID', () => {
      const id1 = generateTraceId();
      const id2 = generateTraceId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^trace_\d+_[a-z0-9]+$/);
    });

    it('应该生成有效的追踪ID格式', () => {
      const id = generateTraceId();

      expect(id).toMatch(/^trace_\d+_[a-z0-9]{9}$/);
    });
  });

  describe('错误类别和严重性', () => {
    it('应该支持所有错误类别', () => {
      const categories = [
        ErrorCategory.SYSTEM,
        ErrorCategory.NETWORK,
        ErrorCategory.DATABASE,
        ErrorCategory.VALIDATION,
        ErrorCategory.AUTHENTICATION,
        ErrorCategory.AUTHORIZATION,
        ErrorCategory.BUSINESS,
        ErrorCategory.EXTERNAL,
      ];

      categories.forEach((category) => {
        const error = createStandardError(
          'TEST_001',
          '测试错误',
          category,
          ErrorSeverity.MEDIUM
        );

        expect(error.category).toBe(category);
      });
    });

    it('应该支持所有错误严重性', () => {
      const severities = [
        ErrorSeverity.LOW,
        ErrorSeverity.MEDIUM,
        ErrorSeverity.HIGH,
        ErrorSeverity.CRITICAL,
      ];

      severities.forEach((severity) => {
        const error = createStandardError(
          'TEST_001',
          '测试错误',
          ErrorCategory.SYSTEM,
          severity
        );

        expect(error.severity).toBe(severity);
      });
    });
  });

  describe('日志级别', () => {
    it('应该支持所有日志级别', () => {
      const levels = [
        LogLevel.DEBUG,
        LogLevel.INFO,
        LogLevel.WARN,
        LogLevel.ERROR,
      ];

      levels.forEach((level) => {
        const entry = createLogEntry(level, '测试日志', 'TestModule');

        expect(entry.level).toBe(level);
      });
    });
  });
});
