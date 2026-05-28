/**
 * Performance Monitor - 性能监控系统
 * 提供细粒度的性能指标收集、统计和报告功能
 */

import { Logger } from './Logger';

export interface PerformanceMetric {
  id: string;
  name: string;
  category: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  success: boolean;
  metadata?: Record<string, unknown>;
}

export interface PerformanceStats {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  recentMetrics: PerformanceMetric[];
  errorRate: number;
  throughput: number; // calls per second
}

export interface PerformanceReport {
  timestamp: number;
  totalMetrics: number;
  categories: Record<string, PerformanceStats>;
  topSlowest: Array<{ name: string; avgDuration: number; calls: number }>;
  topErrors: Array<{ name: string; errorRate: number; failures: number }>;
  systemLoad: {
    memoryUsage: NodeJS.MemoryUsage;
    uptime: number;
  };
}

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private metrics: Map<string, PerformanceMetric[]>;
  private activeSpans: Map<string, PerformanceMetric>;
  private maxMetricsPerCategory: number = 1000;
  private startTime: number;

  private constructor() {
    this.metrics = new Map();
    this.activeSpans = new Map();
    this.startTime = Date.now();
    Logger.info('📊 性能监控系统已启动', 'PerformanceMonitor');
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  /**
   * 开始性能追踪
   */
  public startSpan(
    name: string,
    category: string = 'default',
    metadata?: Record<string, unknown>
  ): string {
    const id = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const span: PerformanceMetric = {
      id,
      name,
      category,
      startTime: Date.now(),
      success: true,
      metadata,
    };
    this.activeSpans.set(id, span);
    Logger.debug(`⏱️ 开始追踪: ${name} (${id})`, 'PerformanceMonitor');
    return id;
  }

  /**
   * 结束性能追踪
   */
  public endSpan(
    id: string,
    success: boolean = true,
    metadata?: Record<string, unknown>
  ): PerformanceMetric | null {
    const span = this.activeSpans.get(id);
    if (!span) {
      Logger.warn(`⚠️ 未找到活跃的追踪span: ${id}`, 'PerformanceMonitor');
      return null;
    }

    const endTime = Date.now();
    const duration = endTime - span.startTime;

    const completedSpan: PerformanceMetric = {
      ...span,
      endTime,
      duration,
      success,
      metadata: { ...span.metadata, ...metadata },
    };

    this.activeSpans.delete(id);
    this.recordMetric(completedSpan);

    Logger.debug(
      `⏱️ 完成追踪: ${span.name} - ${duration}ms ${success ? '✅' : '❌'}`,
      'PerformanceMonitor'
    );
    return completedSpan;
  }

  /**
   * 记录性能指标（手动方式）
   */
  public recordMetric(metric: PerformanceMetric): void {
    const category = metric.category || 'default';
    if (!this.metrics.has(category)) {
      this.metrics.set(category, []);
    }

    const categoryMetrics = this.metrics.get(category)!;
    categoryMetrics.push(metric);

    // 限制每个类别的指标数量
    if (categoryMetrics.length > this.maxMetricsPerCategory) {
      categoryMetrics.shift();
    }
  }

  /**
   * 执行并计时一个函数
   */
  public async measure<T>(
    name: string,
    fn: () => Promise<T>,
    category: string = 'default',
    metadata?: Record<string, unknown>
  ): Promise<T> {
    const id = this.startSpan(name, category, metadata);
    try {
      const result = await fn();
      this.endSpan(id, true);
      return result;
    } catch (error) {
      this.endSpan(id, false, { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 同步执行并计时
   */
  public measureSync<T>(
    name: string,
    fn: () => T,
    category: string = 'default',
    metadata?: Record<string, unknown>
  ): T {
    const id = this.startSpan(name, category, metadata);
    try {
      const result = fn();
      this.endSpan(id, true);
      return result;
    } catch (error) {
      this.endSpan(id, false, { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 获取分类统计
   */
  public getCategoryStats(category: string): PerformanceStats {
    const metrics = this.metrics.get(category) || [];
    return this.calculateStats(metrics);
  }

  /**
   * 计算统计数据
   */
  private calculateStats(metrics: PerformanceMetric[]): PerformanceStats {
    if (metrics.length === 0) {
      return {
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        avgDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        p50Duration: 0,
        p95Duration: 0,
        p99Duration: 0,
        recentMetrics: [],
        errorRate: 0,
        throughput: 0,
      };
    }

    const durations = metrics
      .filter((m) => m.duration !== undefined)
      .map((m) => m.duration!)
      .sort((a, b) => a - b);

    const totalCalls = metrics.length;
    const successCount = metrics.filter((m) => m.success).length;
    const failureCount = totalCalls - successCount;
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);
    const avgDuration = totalDuration / durations.length;

    const uptimeSeconds = (Date.now() - this.startTime) / 1000;
    const throughput = totalCalls / uptimeSeconds;

    return {
      totalCalls,
      successCount,
      failureCount,
      avgDuration,
      minDuration: durations[0],
      maxDuration: durations[durations.length - 1],
      p50Duration: this.getPercentile(durations, 50),
      p95Duration: this.getPercentile(durations, 95),
      p99Duration: this.getPercentile(durations, 99),
      recentMetrics: metrics.slice(-50),
      errorRate: totalCalls > 0 ? failureCount / totalCalls : 0,
      throughput,
    };
  }

  /**
   * 计算百分位数
   */
  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, Math.min(index, sortedArray.length - 1))];
  }

  /**
   * 获取完整性能报告
   */
  public getReport(): PerformanceReport {
    const categories: Record<string, PerformanceStats> = {};

    for (const [category, metrics] of this.metrics.entries()) {
      categories[category] = this.calculateStats(metrics);
    }

    // 找出最慢的操作
    const allMetricNames = new Set<string>();
    for (const metrics of this.metrics.values()) {
      for (const metric of metrics) {
        allMetricNames.add(metric.name);
      }
    }

    const topSlowest: Array<{
      name: string;
      avgDuration: number;
      calls: number;
    }> = [];
    for (const name of allMetricNames) {
      const nameMetrics = [...this.metrics.values()]
        .flat()
        .filter((m) => m.name === name && m.duration !== undefined);

      if (nameMetrics.length > 0) {
        const avgDuration =
          nameMetrics.reduce((sum, m) => sum + m.duration!, 0) /
          nameMetrics.length;
        topSlowest.push({ name, avgDuration, calls: nameMetrics.length });
      }
    }
    topSlowest.sort((a, b) => b.avgDuration - a.avgDuration);

    // 找出错误率最高的操作
    const topErrors: Array<{
      name: string;
      errorRate: number;
      failures: number;
    }> = [];
    for (const name of allMetricNames) {
      const nameMetrics = [...this.metrics.values()]
        .flat()
        .filter((m) => m.name === name);
      const failures = nameMetrics.filter((m) => !m.success).length;
      const errorRate =
        nameMetrics.length > 0 ? failures / nameMetrics.length : 0;
      if (failures > 0) {
        topErrors.push({ name, errorRate, failures });
      }
    }
    topErrors.sort((a, b) => b.errorRate - a.errorRate);

    return {
      timestamp: Date.now(),
      totalMetrics: [...this.metrics.values()].flat().length,
      categories,
      topSlowest: topSlowest.slice(0, 10),
      topErrors: topErrors.slice(0, 10),
      systemLoad: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
      },
    };
  }

  /**
   * 打印性能报告
   */
  public printReport(): void {
    const report = this.getReport();

    Logger.info('='.repeat(60), 'PerformanceMonitor');
    Logger.info('📊 性能监控报告', 'PerformanceMonitor');
    Logger.info(
      `🕐 生成时间: ${new Date(report.timestamp).toISOString()}`,
      'PerformanceMonitor'
    );
    Logger.info(`📈 总指标数: ${report.totalMetrics}`, 'PerformanceMonitor');
    Logger.info('', 'PerformanceMonitor');

    // 分类统计
    for (const [category, stats] of Object.entries(report.categories)) {
      Logger.info(`📁 ${category}:`, 'PerformanceMonitor');
      Logger.info(`   调用次数: ${stats.totalCalls}`, 'PerformanceMonitor');
      Logger.info(
        `   成功率: ${((stats.successCount / stats.totalCalls) * 100).toFixed(1)}%`,
        'PerformanceMonitor'
      );
      Logger.info(
        `   平均耗时: ${stats.avgDuration.toFixed(2)}ms`,
        'PerformanceMonitor'
      );
      Logger.info(
        `   P50/P95/P99: ${stats.p50Duration.toFixed(2)}/${stats.p95Duration.toFixed(2)}/${stats.p99Duration.toFixed(2)}ms`,
        'PerformanceMonitor'
      );
    }

    // 最慢操作
    if (report.topSlowest.length > 0) {
      Logger.info('', 'PerformanceMonitor');
      Logger.info('🐢 最慢操作 TOP 10:', 'PerformanceMonitor');
      for (let i = 0; i < Math.min(10, report.topSlowest.length); i++) {
        const item = report.topSlowest[i];
        Logger.info(
          `   ${i + 1}. ${item.name}: ${item.avgDuration.toFixed(2)}ms (${item.calls} calls)`,
          'PerformanceMonitor'
        );
      }
    }

    // 错误统计
    if (report.topErrors.length > 0) {
      Logger.info('', 'PerformanceMonitor');
      Logger.info('⚠️ 错误率最高的操作:', 'PerformanceMonitor');
      for (let i = 0; i < Math.min(10, report.topErrors.length); i++) {
        const item = report.topErrors[i];
        Logger.info(
          `   ${i + 1}. ${item.name}: ${(item.errorRate * 100).toFixed(1)}% (${item.failures} failures)`,
          'PerformanceMonitor'
        );
      }
    }

    // 系统负载
    Logger.info('', 'PerformanceMonitor');
    Logger.info('💻 系统负载:', 'PerformanceMonitor');
    Logger.info(
      `   RSS: ${(report.systemLoad.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
      'PerformanceMonitor'
    );
    Logger.info(
      `   Heap Total: ${(report.systemLoad.memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      'PerformanceMonitor'
    );
    Logger.info(
      `   Heap Used: ${(report.systemLoad.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      'PerformanceMonitor'
    );
    Logger.info(
      `   Uptime: ${report.systemLoad.uptime.toFixed(1)}s`,
      'PerformanceMonitor'
    );
    Logger.info('='.repeat(60), 'PerformanceMonitor');
  }

  /**
   * 清空指标数据
   */
  public clear(): void {
    this.metrics.clear();
    this.activeSpans.clear();
    Logger.info('🧹 性能监控数据已清空', 'PerformanceMonitor');
  }

  /**
   * 获取特定指标的统计
   */
  public getMetricStats(name: string): PerformanceStats {
    const metrics = [...this.metrics.values()]
      .flat()
      .filter((m) => m.name === name);
    return this.calculateStats(metrics);
  }
}

// 导出便捷函数
export const perf = PerformanceMonitor.getInstance();
export const measure = perf.measure.bind(perf);
export const measureSync = perf.measureSync.bind(perf);
export const startSpan = perf.startSpan.bind(perf);
export const endSpan = perf.endSpan.bind(perf);
