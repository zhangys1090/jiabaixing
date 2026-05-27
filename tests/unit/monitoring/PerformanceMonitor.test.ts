/**
 * PerformanceMonitor 单元测试
 * 覆盖：指标记录、查询、聚合统计、快照、自动快照、监听器
 */

import { PerformanceMonitor, PerformanceMetric } from '../../../src/monitoring/PerformanceMonitor';

describe.skip('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    jest.useFakeTimers();
    monitor = new PerformanceMonitor(5000);
  });

  afterEach(() => {
    monitor.stopAutoSnapshot();
    monitor.clearMetrics();
    jest.useRealTimers();
  });

  describe('recordMetric', () => {
    it('成功记录一个指标', () => {
      const metric = monitor.recordMetric({
        category: 'memory',
        name: 'heap.used',
        value: 1024,
        unit: 'bytes',
      });

      expect(metric).toBeDefined();
      expect(metric.id).toBeDefined();
      expect(metric.timestamp).toBeInstanceOf(Date);
      expect(metric.category).toBe('memory');
      expect(metric.value).toBe(1024);
    });

    it('记录多个指标并限制数量', () => {
      const smallMonitor = new PerformanceMonitor(100);
      (smallMonitor as any).maxMetrics = 5;

      for (let i = 0; i < 10; i++) {
        smallMonitor.recordMetric({
          category: 'custom',
          name: 'test.metric',
          value: i,
          unit: 'count',
        });
      }

      expect(smallMonitor.getMetricCount()).toBeLessThanOrEqual(5);
    });
  });

  describe('recordResponseTime', () => {
    it('记录API响应时间', () => {
      const metric = monitor.recordResponseTime('/api/test', 150);

      expect(metric.category).toBe('response_time');
      expect(metric.name).toBe('response_time./api/test');
      expect(metric.value).toBe(150);
      expect(metric.unit).toBe('ms');
    });
  });

  describe('recordError', () => {
    it('记录错误事件', () => {
      const metric = monitor.recordError('TypeError', { stack: 'error stack' });

      expect(metric.category).toBe('error_rate');
      expect(metric.name).toBe('error.TypeError');
      expect(metric.value).toBe(1);
      expect(metric.metadata?.errorType).toBe('TypeError');
    });
  });

  describe('recordThroughput', () => {
    it('记录吞吐量', () => {
      const metric = monitor.recordThroughput('requests', 500);

      expect(metric.category).toBe('throughput');
      expect(metric.name).toBe('throughput.requests');
      expect(metric.value).toBe(500);
      expect(metric.unit).toBe('ops');
    });
  });

  describe('getSnapshot', () => {
    it('获取系统性能快照', () => {
      const snapshot = monitor.getSnapshot();

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeInstanceOf(Date);
      expect(snapshot.memory).toBeDefined();
      expect(snapshot.memory.heapUsed).toBeGreaterThan(0);
      expect(snapshot.memory.heapTotal).toBeGreaterThan(0);
      expect(snapshot.memory.rss).toBeGreaterThan(0);
      expect(snapshot.cpu).toBeDefined();
      expect(snapshot.cpu.loadAvg).toHaveLength(3);
      expect(snapshot.cpu.cpuCount).toBeGreaterThan(0);
      expect(snapshot.system).toBeDefined();
      expect(snapshot.system.uptime).toBeGreaterThan(0);
      expect(snapshot.system.platform).toBeDefined();
      expect(snapshot.system.nodeVersion).toBeDefined();
    });
  });

  describe('queryMetrics', () => {
    it('按类别查询指标', () => {
      monitor.recordMetric({
        category: 'memory',
        name: 'heap.used',
        value: 100,
        unit: 'bytes',
      });
      monitor.recordMetric({
        category: 'error_rate',
        name: 'error.test',
        value: 1,
        unit: 'count',
      });
      monitor.recordMetric({
        category: 'memory',
        name: 'rss',
        value: 200,
        unit: 'bytes',
      });

      const memoryMetrics = monitor.queryMetrics('memory');

      expect(memoryMetrics).toHaveLength(2);
      memoryMetrics.forEach((m: PerformanceMetric) => expect(m.category).toBe('memory'));
    });

    it('按时间范围查询指标', () => {
      const now = new Date();
      const past = new Date(now.getTime() - 10000);
      const future = new Date(now.getTime() + 10000);

      monitor.recordMetric({
        category: 'memory',
        name: 'test',
        value: 1,
        unit: 'count',
      });

      const metrics = monitor.queryMetrics('memory', past, future);

      expect(metrics.length).toBeGreaterThanOrEqual(1);
    });

    it('限制返回数量', () => {
      for (let i = 0; i < 10; i++) {
        monitor.recordMetric({
          category: 'memory',
          name: 'test',
          value: i,
          unit: 'count',
        });
      }

      const metrics = monitor.queryMetrics('memory', undefined, undefined, 5);

      expect(metrics).toHaveLength(5);
    });
  });

  describe('getAggregatedStats', () => {
    it('获取聚合统计信息', () => {
      monitor.recordMetric({
        category: 'response_time',
        name: 'response_time./api/test',
        value: 100,
        unit: 'ms',
      });
      monitor.recordMetric({
        category: 'response_time',
        name: 'response_time./api/test',
        value: 200,
        unit: 'ms',
      });
      monitor.recordMetric({
        category: 'response_time',
        name: 'response_time./api/test',
        value: 300,
        unit: 'ms',
      });

      const stats = monitor.getAggregatedStats(
        'response_time',
        'response_time./api/test'
      );

      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(3);
      expect(stats!.avg).toBe(200);
      expect(stats!.min).toBe(100);
      expect(stats!.max).toBe(300);
      expect(stats!.sum).toBe(600);
    });

    it('无数据时返回null', () => {
      const stats = monitor.getAggregatedStats('response_time', 'response_time.nonexistent');

      expect(stats).toBeNull();
    });
  });

  describe('getRecentErrors', () => {
    it('获取最近的错误', () => {
      monitor.recordError('Error1');
      monitor.recordError('Error2');
      monitor.recordError('Error3');

      const errors = monitor.getRecentErrors(2);

      expect(errors).toHaveLength(2);
      expect(errors[0].name).toBe('error.Error3');
      expect(errors[1].name).toBe('error.Error2');
    });

    it('无错误时返回空数组', () => {
      const errors = monitor.getRecentErrors();

      expect(errors).toHaveLength(0);
    });
  });

  describe('listeners', () => {
    it('添加指标监听器并接收通知', () => {
      const callback = jest.fn();

      monitor.onMetric('memory', callback);
      monitor.recordMetric({
        category: 'memory',
        name: 'heap.used',
        value: 100,
        unit: 'bytes',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].category).toBe('memory');
    });

    it('移除指标监听器', () => {
      const callback = jest.fn();

      monitor.onMetric('cpu', callback);
      monitor.offMetric('cpu', callback);
      monitor.recordMetric({
        category: 'cpu',
        name: 'load',
        value: 50,
        unit: '%',
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('监听器抛出异常不影响其他监听器', () => {
      const errorCallback = jest.fn().mockImplementation(() => {
        throw new Error('Listener error');
      });
      const normalCallback = jest.fn();

      monitor.onMetric('memory', errorCallback);
      monitor.onMetric('memory', normalCallback);

      expect(() => {
        monitor.recordMetric({
          category: 'memory',
          name: 'test',
          value: 1,
          unit: 'count',
        });
      }).not.toThrow();

      expect(normalCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('startAutoSnapshot', () => {
    it('启动自动快照并记录指标', () => {
      monitor.startAutoSnapshot();

      jest.advanceTimersByTime(6000);

      expect(monitor.getMetricCount()).toBeGreaterThan(0);
    });

    it('重复启动不创建多个定时器', () => {
      monitor.startAutoSnapshot();
      monitor.startAutoSnapshot();

      jest.advanceTimersByTime(6000);

      const count = monitor.getMetricCount();

      jest.advanceTimersByTime(6000);

      expect(monitor.getMetricCount()).toBe(count + 2);
    });
  });

  describe('stopAutoSnapshot', () => {
    it('停止自动快照', () => {
      monitor.startAutoSnapshot();
      monitor.stopAutoSnapshot();

      jest.advanceTimersByTime(6000);

      expect(monitor.getMetricCount()).toBe(0);
    });
  });

  describe('clearMetrics', () => {
    it('清理所有指标', () => {
      monitor.recordMetric({
        category: 'memory',
        name: 'test',
        value: 1,
        unit: 'count',
      });

      monitor.clearMetrics();

      expect(monitor.getMetricCount()).toBe(0);
    });
  });

  describe('getMetricCount', () => {
    it('获取指标数量', () => {
      expect(monitor.getMetricCount()).toBe(0);

      monitor.recordMetric({
        category: 'memory',
        name: 'test1',
        value: 1,
        unit: 'count',
      });
      monitor.recordMetric({
        category: 'memory',
        name: 'test2',
        value: 2,
        unit: 'count',
      });

      expect(monitor.getMetricCount()).toBe(2);
    });
  });
});
