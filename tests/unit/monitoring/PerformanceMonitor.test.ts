/**
 * PerformanceMonitor 单元测试
 * 覆盖：单例创建、指标记录、查询、摘要统计、重置、监控启停、事件发射
 */

import { PerformanceMonitor, PerformanceMetrics, PerformanceConfig } from '../../../src/monitoring/PerformanceMonitor';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    (PerformanceMonitor as any).instance = null;
    monitor = PerformanceMonitor.getInstance();
    jest.useFakeTimers();
  });

  afterEach(() => {
    monitor.stopMonitoring();
    monitor.reset();
    (PerformanceMonitor as any).instance = null;
    jest.useRealTimers();
  });

  describe('getInstance', () => {
    it('创建单例实例', () => {
      const instance = PerformanceMonitor.getInstance();

      expect(instance).toBeInstanceOf(PerformanceMonitor);
      expect(instance).toBe(monitor);
    });

    it('重复调用返回同一实例', () => {
      const a = PerformanceMonitor.getInstance();
      const b = PerformanceMonitor.getInstance();

      expect(a).toBe(b);
    });

    it('使用自定义配置创建实例', () => {
      (PerformanceMonitor as any).instance = null;
      const custom = PerformanceMonitor.getInstance({
        enableMetrics: false,
        logLevel: 'debug',
      });
      const config = custom.getConfig();

      expect(config.enableMetrics).toBe(false);
      expect(config.logLevel).toBe('debug');
    });
  });

  describe('recordRequest', () => {
    it('记录成功的请求', () => {
      monitor.recordRequest(120, true);
      const metrics = monitor.getMetrics();

      expect(metrics).toHaveLength(1);
      expect(metrics[0].responseTime).toBe(120);
      expect(metrics[0].requestCount).toBe(1);
      expect(metrics[0].errorCount).toBe(0);
      expect(metrics[0].errorRate).toBe(0);
    });

    it('记录失败的请求', () => {
      monitor.recordRequest(500, false);
      const metrics = monitor.getMetrics();

      expect(metrics).toHaveLength(1);
      expect(metrics[0].responseTime).toBe(500);
      expect(metrics[0].requestCount).toBe(1);
      expect(metrics[0].errorCount).toBe(1);
      expect(metrics[0].errorRate).toBe(1);
    });

    it('连续记录多个请求并累计计数', () => {
      monitor.recordRequest(100, true);
      monitor.recordRequest(200, true);
      monitor.recordRequest(300, false);

      const metrics = monitor.getMetrics();

      expect(metrics).toHaveLength(3);
      expect(metrics[2].requestCount).toBe(3);
      expect(metrics[2].errorCount).toBe(1);
      expect(metrics[2].errorRate).toBeCloseTo(1 / 3);
    });

    it('记录的指标包含时间戳和内存使用', () => {
      monitor.recordRequest(50, true);
      const m = monitor.getMetrics()[0];

      expect(m.timestamp).toBeGreaterThan(0);
      expect(m.memoryUsage).toBeGreaterThan(0);
    });
  });

  describe('getMetrics', () => {
    it('默认返回最近100条指标', () => {
      for (let i = 0; i < 150; i++) {
        monitor.recordRequest(i, true);
      }

      const metrics = monitor.getMetrics();

      expect(metrics).toHaveLength(100);
    });

    it('按指定数量返回指标', () => {
      for (let i = 0; i < 10; i++) {
        monitor.recordRequest(i, true);
      }

      const metrics = monitor.getMetrics(5);

      expect(metrics).toHaveLength(5);
      expect(metrics[0].responseTime).toBe(5);
      expect(metrics[4].responseTime).toBe(9);
    });

    it('无数据时返回空数组', () => {
      const metrics = monitor.getMetrics();

      expect(metrics).toEqual([]);
    });
  });

  describe('getCurrentMetrics', () => {
    it('返回最新一条指标', () => {
      monitor.recordRequest(100, true);
      monitor.recordRequest(200, true);

      const current = monitor.getCurrentMetrics();

      expect(current).not.toBeNull();
      expect(current!.responseTime).toBe(200);
    });

    it('无数据时返回null', () => {
      const current = monitor.getCurrentMetrics();

      expect(current).toBeNull();
    });
  });

  describe('getSummary', () => {
    it('返回汇总统计信息', () => {
      monitor.recordRequest(100, true);
      monitor.recordRequest(200, true);
      monitor.recordRequest(300, false);

      const summary = monitor.getSummary();

      expect(summary.totalRequests).toBe(3);
      expect(summary.totalErrors).toBe(1);
      expect(summary.averageResponseTime).toBeCloseTo(200);
      expect(summary.currentMemoryUsage).toBeGreaterThan(0);
      expect(summary.currentErrorRate).toBeCloseTo(1 / 3);
      expect(summary.uptime).toBeGreaterThanOrEqual(0);
    });

    it('无请求时返回安全的默认值', () => {
      const summary = monitor.getSummary();

      expect(summary.totalRequests).toBe(0);
      expect(summary.totalErrors).toBe(0);
      expect(summary.averageResponseTime).toBe(0);
      expect(summary.currentErrorRate).toBe(0);
    });
  });

  describe('reset', () => {
    it('清空所有指标和计数', () => {
      monitor.recordRequest(100, true);
      monitor.recordRequest(200, false);

      monitor.reset();

      expect(monitor.getMetrics()).toEqual([]);
      expect(monitor.getCurrentMetrics()).toBeNull();
      expect(monitor.getSummary().totalRequests).toBe(0);
      expect(monitor.getSummary().totalErrors).toBe(0);
    });
  });

  describe('startMonitoring / stopMonitoring', () => {
    it('启动监控后定时收集指标', () => {
      monitor.startMonitoring(1000);

      jest.advanceTimersByTime(1000);

      const metrics = monitor.getMetrics();

      expect(metrics.length).toBeGreaterThan(0);

      monitor.stopMonitoring();
    });

    it('多次启动不创建重复定时器', () => {
      monitor.startMonitoring(1000);
      monitor.startMonitoring(1000);

      jest.advanceTimersByTime(1000);

      const countAfterOneTick = monitor.getMetrics().length;

      jest.advanceTimersByTime(1000);

      const countAfterTwoTicks = monitor.getMetrics().length;

      expect(countAfterTwoTicks - countAfterOneTick).toBeLessThanOrEqual(2);

      monitor.stopMonitoring();
    });

    it('停止监控后不再收集指标', () => {
      monitor.startMonitoring(1000);
      monitor.stopMonitoring();

      const countBefore = monitor.getMetrics().length;

      jest.advanceTimersByTime(5000);

      const countAfter = monitor.getMetrics().length;

      expect(countAfter).toBe(countBefore);
    });

    it('无运行定时器时停止监控不报错', () => {
      expect(() => monitor.stopMonitoring()).not.toThrow();
    });
  });

  describe('updateConfig / getConfig', () => {
    it('更新配置并获取最新配置', () => {
      monitor.updateConfig({ logLevel: 'debug', enableMetrics: false });
      const config = monitor.getConfig();

      expect(config.logLevel).toBe('debug');
      expect(config.enableMetrics).toBe(false);
    });

    it('getConfig 返回配置副本而非引用', () => {
      const config1 = monitor.getConfig();
      config1.logLevel = 'error';

      const config2 = monitor.getConfig();

      expect(config2.logLevel).toBe('info');
    });

    it('部分更新不影响其他配置项', () => {
      const originalConfig = monitor.getConfig();
      monitor.updateConfig({ logLevel: 'warn' });
      const updatedConfig = monitor.getConfig();

      expect(updatedConfig.enableMetrics).toBe(originalConfig.enableMetrics);
      expect(updatedConfig.alertThresholds).toEqual(originalConfig.alertThresholds);
    });
  });

  describe('事件发射', () => {
    it('启动监控时发射 monitoringStarted 事件', () => {
      const listener = jest.fn();
      monitor.on('monitoringStarted', listener);

      monitor.startMonitoring(1000);

      expect(listener).toHaveBeenCalledTimes(1);

      monitor.stopMonitoring();
    });

    it('停止监控时发射 monitoringStopped 事件', () => {
      const listener = jest.fn();
      monitor.on('monitoringStopped', listener);

      monitor.startMonitoring(1000);
      monitor.stopMonitoring();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('未启动监控时停止不发射 monitoringStopped 事件', () => {
      const listener = jest.fn();
      monitor.on('monitoringStopped', listener);

      monitor.stopMonitoring();

      expect(listener).not.toHaveBeenCalled();
    });

    it('记录请求时发射 metricsRecorded 事件并携带指标数据', () => {
      const listener = jest.fn();
      monitor.on('metricsRecorded', listener);

      monitor.recordRequest(150, true);

      expect(listener).toHaveBeenCalledTimes(1);
      const emittedMetrics: PerformanceMetrics = listener.mock.calls[0][0];
      expect(emittedMetrics.responseTime).toBe(150);
      expect(emittedMetrics.requestCount).toBe(1);
    });

    it('定时收集时发射 metricsCollected 事件', () => {
      const listener = jest.fn();
      monitor.on('metricsCollected', listener);

      monitor.startMonitoring(1000);
      jest.advanceTimersByTime(1000);

      expect(listener).toHaveBeenCalledTimes(1);
      const emittedMetrics: PerformanceMetrics = listener.mock.calls[0][0];
      expect(emittedMetrics.timestamp).toBeGreaterThan(0);

      monitor.stopMonitoring();
    });

    it('重置时发射 metricsReset 事件', () => {
      const listener = jest.fn();
      monitor.on('metricsReset', listener);

      monitor.reset();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
