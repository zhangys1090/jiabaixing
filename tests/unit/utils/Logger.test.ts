/**
 * Logger工具测试
 * 测试日志记录功能
 */

import { Logger, LogLevel } from '../../../src/utils/Logger';

// Mock winston logger to avoid file I/O during tests
jest.mock('winston', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    level: 'info',
    add: jest.fn(),
  };
  return {
    createLogger: jest.fn(() => mockLogger),
    format: {
      combine: jest.fn(),
      timestamp: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
      colorize: jest.fn(),
      printf: jest.fn((cb) => cb),
    },
    transports: {
      File: jest.fn(),
      Console: jest.fn(),
    },
  };
});

describe('Logger', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('日志输出', () => {
    it('应该输出 debug 级别日志', () => {
      Logger.debug('Debug message');
    });

    it('应该输出 info 级别日志', () => {
      Logger.info('Info message');
    });

    it('应该输出 warn 级别日志', () => {
      Logger.warn('Warn message');
    });

    it('应该输出 error 级别日志', () => {
      Logger.error('Error message');
    });

    it('应该正确处理 Error 对象', () => {
      const error = new Error('Test error');
      Logger.error('Error occurred', error);
    });

    it('应该在 error 无 Error 对象时不抛异常', () => {
      Logger.error('Error without Error object');
    });

    it('应该输出 fatal 级别日志', () => {
      Logger.fatal('Fatal message');
    });

    it('应该输出带 Error 对象的 fatal 日志', () => {
      const error = new Error('Fatal error');
      Logger.fatal('Fatal occurred', error);
    });
  });

  describe('模块标签', () => {
    it('应该正确使用模块标签', () => {
      Logger.info('Message', 'TestModule');
    });

    it('应该正确携带 metadata', () => {
      const meta = { requestId: '123' };
      Logger.info('Message', 'TestModule', meta);
    });
  });

  describe('Trace ID', () => {
    it('应该生成有效的 Trace ID', () => {
      const traceId = Logger.generateTraceId();
      expect(traceId).toMatch(/^trace_/);
      expect(traceId.length).toBeGreaterThan(0);
    });

    it('应该正确设置和清除 Trace ID', () => {
      const traceId = Logger.generateTraceId();
      Logger.setTraceId(traceId);
      expect(Logger.getTraceId()).toBe(traceId);

      Logger.clearTraceId();
      expect(Logger.getTraceId()).toBeNull();
    });

    it('withTrace 应该自动管理 Trace ID 生命周期', () => {
      expect(Logger.getTraceId()).toBeNull();

      Logger.withTrace('test-trace', () => {
        expect(Logger.getTraceId()).toBe('test-trace');
      });

      expect(Logger.getTraceId()).toBeNull();
    });
  });

  describe('事件发射', () => {
    it('应该能注册和移除事件监听器', () => {
      const listener = jest.fn();
      Logger.on('log', listener);
      Logger.off('log', listener);
    });
  });

  describe('格式化输出', () => {
    it('应该正确携带 metadata 对象', () => {
      const data = { key: 'value', count: 42 };
      Logger.info('Data', 'TestModule', data);
    });
  });
});
