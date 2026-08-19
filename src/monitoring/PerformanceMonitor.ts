/**
 * 性能监控模块（统一实现）
 *
 * 合并了原 monitoring/PerformanceMonitor（系统级监控+告警）
 * 与原 utils/PerformanceMonitor（细粒度 span 追踪+统计）
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';

export interface PerformanceMetrics {
  responseTime: number;
  memoryUsage: number;
  errorRate: number;
  requestCount: number;
  errorCount: number;
  timestamp: number;
}

export interface PerformanceAlert {
  type: 'response_time' | 'memory_usage' | 'error_rate';
  current: number;
  threshold: number;
  timestamp: number;
  message: string;
}

export interface PerformanceConfig {
  enableMetrics: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  alertThresholds: {
    responseTime: number;
    memoryUsage: number;
    errorRate: number;
  };
  performanceTracking: boolean;
  metricsRetentionTime: number;
}

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
  throughput: number;
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

export class PerformanceMonitor extends EventEmitter {
  private static instance: PerformanceMonitor | null = null;
  private config: PerformanceConfig;
  private metrics: PerformanceMetrics[] = [];
  private requestCount: number = 0;
  private errorCount: number = 0;
  private startTime: number = Date.now();
  private monitoringInterval: NodeJS.Timeout | null = null;

  private spanMetrics: Map<string, PerformanceMetric[]> = new Map();
  private activeSpans: Map<string, PerformanceMetric> = new Map();
  private readonly maxMetricsPerCategory: number = 1000;

  private tokenUsage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    sessionCount: number;
    lastReset: number;
  } = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    sessionCount: 0,
    lastReset: Date.now(),
  };

  private constructor(config?: Partial<PerformanceConfig>) {
    super();
    this.config = {
      enableMetrics: true,
      logLevel: 'info',
      alertThresholds: {
        responseTime: 10000,
        memoryUsage: 1024,
        errorRate: 0.1,
      },
      performanceTracking: true,
      metricsRetentionTime: 3600000,
      ...config,
    };
  }

  public static getInstance(
    config?: Partial<PerformanceConfig>
  ): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor(config);
    }
    return PerformanceMonitor.instance;
  }

  public startMonitoring(intervalMs: number = 60000): void {
    if (this.monitoringInterval) {
      Logger.debug('性能监控已在运行，跳过重复启动', 'PerformanceMonitor');
      return;
    }

    Logger.info('📊 启动性能监控', 'PerformanceMonitor');

    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
      this.checkAlerts();
      this.cleanupOldMetrics();
    }, intervalMs);

    this.emit('monitoringStarted');
  }

  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      Logger.info('📊 性能监控已停止', 'PerformanceMonitor');
      this.emit('monitoringStopped');
    }
  }

  public recordRequest(responseTime: number, success: boolean): void {
    this.requestCount++;
    if (!success) {
      this.errorCount++;
    }

    const metrics: PerformanceMetrics = {
      responseTime,
      memoryUsage: this.getCurrentMemoryUsage(),
      errorRate: this.errorCount / this.requestCount,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      timestamp: Date.now(),
    };

    this.metrics.push(metrics);

    if (this.config.performanceTracking) {
      Logger.debug(
        `📈 请求记录: 响应时间=${responseTime}ms, 成功=${success}`,
        'PerformanceMonitor'
      );
    }

    this.emit('metricsRecorded', metrics);
  }

  private collectMetrics(): void {
    const currentMetrics: PerformanceMetrics = {
      responseTime: this.getAverageResponseTime(),
      memoryUsage: this.getCurrentMemoryUsage(),
      errorRate: this.errorCount / Math.max(1, this.requestCount),
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      timestamp: Date.now(),
    };

    this.metrics.push(currentMetrics);

    if (
      currentMetrics.responseTime > 100 ||
      currentMetrics.errorRate > 0 ||
      currentMetrics.memoryUsage > 500
    ) {
      Logger.info(
        `性能告警: 响应=${currentMetrics.responseTime.toFixed(0)}ms, 内存=${currentMetrics.memoryUsage.toFixed(0)}MB, 错误率=${(currentMetrics.errorRate * 100).toFixed(1)}%`,
        'PerformanceMonitor'
      );
    }

    this.emit('metricsCollected', currentMetrics);
  }

  private checkAlerts(): void {
    const latestMetrics = this.metrics[this.metrics.length - 1];
    if (!latestMetrics) return;

    const alerts: PerformanceAlert[] = [];

    if (latestMetrics.responseTime > this.config.alertThresholds.responseTime) {
      alerts.push({
        type: 'response_time',
        current: latestMetrics.responseTime,
        threshold: this.config.alertThresholds.responseTime,
        timestamp: Date.now(),
        message: `响应时间超过阈值: ${latestMetrics.responseTime.toFixed(2)}ms > ${this.config.alertThresholds.responseTime}ms`,
      });
    }

    if (latestMetrics.memoryUsage > this.config.alertThresholds.memoryUsage) {
      alerts.push({
        type: 'memory_usage',
        current: latestMetrics.memoryUsage,
        threshold: this.config.alertThresholds.memoryUsage,
        timestamp: Date.now(),
        message: `内存使用超过阈值: ${latestMetrics.memoryUsage.toFixed(2)}MB > ${this.config.alertThresholds.memoryUsage}MB`,
      });
    }

    if (latestMetrics.errorRate > this.config.alertThresholds.errorRate) {
      alerts.push({
        type: 'error_rate',
        current: latestMetrics.errorRate,
        threshold: this.config.alertThresholds.errorRate,
        timestamp: Date.now(),
        message: `错误率超过阈值: ${(latestMetrics.errorRate * 100).toFixed(2)}% > ${(this.config.alertThresholds.errorRate * 100).toFixed(2)}%`,
      });
    }

    alerts.forEach((alert) => {
      Logger.warn(`⚠️ 性能告警: ${alert.message}`, 'PerformanceMonitor');
      this.emit('performanceAlert', alert);
    });
  }

  private cleanupOldMetrics(): void {
    const cutoffTime = Date.now() - this.config.metricsRetentionTime;
    const beforeCount = this.metrics.length;
    this.metrics = this.metrics.filter((m) => m.timestamp > cutoffTime);
    const afterCount = this.metrics.length;

    if (beforeCount > afterCount) {
      Logger.debug(
        `🧹 清理旧指标: ${beforeCount - afterCount} 条记录已删除`,
        'PerformanceMonitor'
      );
    }
  }

  private getAverageResponseTime(): number {
    if (this.metrics.length === 0) return 0;

    const recentMetrics = this.metrics.slice(-100);
    const totalTime = recentMetrics.reduce((sum, m) => sum + m.responseTime, 0);
    return totalTime / recentMetrics.length;
  }

  private getCurrentMemoryUsage(): number {
    const usage = process.memoryUsage();
    return usage.heapUsed / 1024 / 1024;
  }

  public getMetrics(count: number = 100): PerformanceMetrics[] {
    return this.metrics.slice(-count);
  }

  public getCurrentMetrics(): PerformanceMetrics | null {
    return this.metrics[this.metrics.length - 1] || null;
  }

  public getSummary(): {
    uptime: number;
    totalRequests: number;
    totalErrors: number;
    averageResponseTime: number;
    currentMemoryUsage: number;
    currentErrorRate: number;
  } {
    return {
      uptime: Date.now() - this.startTime,
      totalRequests: this.requestCount,
      totalErrors: this.errorCount,
      averageResponseTime: this.getAverageResponseTime(),
      currentMemoryUsage: this.getCurrentMemoryUsage(),
      currentErrorRate: this.errorCount / Math.max(1, this.requestCount),
    };
  }

  public reset(): void {
    this.metrics = [];
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    Logger.info('📊 性能监控数据已重置', 'PerformanceMonitor');
    this.emit('metricsReset');
  }

  public updateConfig(config: Partial<PerformanceConfig>): void {
    this.config = { ...this.config, ...config };
    Logger.info('📊 性能监控配置已更新', 'PerformanceMonitor');
  }

  public getConfig(): PerformanceConfig {
    return { ...this.config };
  }

  // ═══════════════════════════════════════════════════════════
  // 细粒度 Span 追踪（原 utils/PerformanceMonitor）
  // ═══════════════════════════════════════════════════════════

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
    this.recordSpanMetric(completedSpan);

    Logger.debug(
      `⏱️ 完成追踪: ${span.name} - ${duration}ms ${success ? '✅' : '❌'}`,
      'PerformanceMonitor'
    );
    return completedSpan;
  }

  public recordSpanMetric(metric: PerformanceMetric): void {
    const category = metric.category || 'default';
    if (!this.spanMetrics.has(category)) {
      this.spanMetrics.set(category, []);
    }

    const categoryMetrics = this.spanMetrics.get(category)!;
    categoryMetrics.push(metric);

    if (categoryMetrics.length > this.maxMetricsPerCategory) {
      categoryMetrics.shift();
    }
  }

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

  public getCategoryStats(category: string): PerformanceStats {
    const metrics = this.spanMetrics.get(category) || [];
    return this.calculateSpanStats(metrics);
  }

  private calculateSpanStats(metrics: PerformanceMetric[]): PerformanceStats {
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
    const avgDuration =
      durations.length > 0 ? totalDuration / durations.length : 0;

    const uptimeSeconds = (Date.now() - this.startTime) / 1000;
    const throughput = uptimeSeconds > 0 ? totalCalls / uptimeSeconds : 0;

    return {
      totalCalls,
      successCount,
      failureCount,
      avgDuration,
      minDuration: durations[0] || 0,
      maxDuration: durations[durations.length - 1] || 0,
      p50Duration: this.getPercentile(durations, 50),
      p95Duration: this.getPercentile(durations, 95),
      p99Duration: this.getPercentile(durations, 99),
      recentMetrics: metrics.slice(-50),
      errorRate: totalCalls > 0 ? failureCount / totalCalls : 0,
      throughput,
    };
  }

  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, Math.min(index, sortedArray.length - 1))];
  }

  public getReport(): PerformanceReport {
    const categories: Record<string, PerformanceStats> = {};

    for (const [category, metrics] of this.spanMetrics.entries()) {
      categories[category] = this.calculateSpanStats(metrics);
    }

    const allMetricNames = new Set<string>();
    for (const metrics of this.spanMetrics.values()) {
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
      const nameMetrics = [...this.spanMetrics.values()]
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

    const topErrors: Array<{
      name: string;
      errorRate: number;
      failures: number;
    }> = [];
    for (const name of allMetricNames) {
      const nameMetrics = [...this.spanMetrics.values()]
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
      totalMetrics: [...this.spanMetrics.values()].flat().length,
      categories,
      topSlowest: topSlowest.slice(0, 10),
      topErrors: topErrors.slice(0, 10),
      systemLoad: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
      },
    };
  }

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

  public clear(): void {
    this.spanMetrics.clear();
    this.activeSpans.clear();
    Logger.info('🧹 性能监控数据已清空', 'PerformanceMonitor');
  }

  public getMetricStats(name: string): PerformanceStats {
    const metrics = [...this.spanMetrics.values()]
      .flat()
      .filter((m) => m.name === name);
    return this.calculateSpanStats(metrics);
  }

  public recordTokenUsage(inputTokens: number, outputTokens: number): void {
    this.tokenUsage.totalInputTokens += inputTokens;
    this.tokenUsage.totalOutputTokens += outputTokens;
    this.tokenUsage.totalTokens += inputTokens + outputTokens;
    this.tokenUsage.sessionCount++;
  }

  public getTokenUsage(): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    sessionCount: number;
    avgTokensPerSession: number;
    estimatedCostUSD: number;
    uptime: number;
  } {
    const uptime = (Date.now() - this.tokenUsage.lastReset) / 1000;
    const avgPerSession =
      this.tokenUsage.sessionCount > 0
        ? this.tokenUsage.totalTokens / this.tokenUsage.sessionCount
        : 0;
    const estimatedCost =
      this.tokenUsage.totalInputTokens * 0.00000014 +
      this.tokenUsage.totalOutputTokens * 0.00000028;
    return {
      totalInputTokens: this.tokenUsage.totalInputTokens,
      totalOutputTokens: this.tokenUsage.totalOutputTokens,
      totalTokens: this.tokenUsage.totalTokens,
      sessionCount: this.tokenUsage.sessionCount,
      avgTokensPerSession: Math.round(avgPerSession),
      estimatedCostUSD: Math.round(estimatedCost * 10000) / 10000,
      uptime,
    };
  }

  public resetTokenUsage(): void {
    this.tokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      sessionCount: 0,
      lastReset: Date.now(),
    };
  }
}

export const perf = PerformanceMonitor.getInstance();
export const measure = perf.measure.bind(perf);
export const measureSync = perf.measureSync.bind(perf);
export const startSpan = perf.startSpan.bind(perf);
export const endSpan = perf.endSpan.bind(perf);

// ═══════════════════════════════════════════════════════════
// OpenTelemetry 集成 — 可观测性标准追踪
// ═══════════════════════════════════════════════════════════

import * as opentelemetry from '@opentelemetry/api';

export interface OTelConfig {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint?: string;
  prometheusPort?: number;
}

let tracer: opentelemetry.Tracer | null = null;
let meter: opentelemetry.Meter | null = null;

const requestCounter = { value: 0 };
const errorCounter = { value: 0 };
const latencyHistogram = new Map<string, number[]>();

/**
 * 获取 OTel Tracer
 */
export function getTracer(): opentelemetry.Tracer | null {
  return tracer;
}

/**
 * 获取 OTel Meter
 */
export function getMeter(): opentelemetry.Meter | null {
  return meter;
}

/**
 * 创建 OTel Span — 与 PerformanceMonitor.startSpan 桥接
 */
export function startOTelSpan(
  name: string,
  options?: opentelemetry.SpanOptions
): opentelemetry.Span | undefined {
  if (!tracer) return undefined;
  return tracer.startSpan(name, options);
}

/**
 * 记录请求指标到 Prometheus
 */
export function recordOTelRequest(
  operation: string,
  durationMs: number,
  success: boolean
): void {
  requestCounter.value++;
  if (!success) errorCounter.value++;

  const key = operation;
  if (!latencyHistogram.has(key)) latencyHistogram.set(key, []);
  latencyHistogram.get(key)!.push(durationMs);

  if (meter) {
    try {
      const counter = meter.createCounter('jiabaixing_requests_total', {
        description: 'Total requests',
      });
      counter.add(1, { operation, success: String(success) });
    } catch {
      // 降级处理
    }
  }
}

/**
 * 关闭 OTel 透传句柄（TS 侧不持有 SDK，仅需清理本地引用）
 */
export async function shutdownOTel(): Promise<void> {
  tracer = null;
  meter = null;
  Logger.info('📡 OpenTelemetry 透传句柄已清理（SDK 由 Python 后端管理）', 'OTel');
}

export default PerformanceMonitor;
