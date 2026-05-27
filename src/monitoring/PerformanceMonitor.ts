/**
 * 性能监控模块
 * 监控系统性能指标，包括响应时间、内存使用、错误率等
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

export class PerformanceMonitor extends EventEmitter {
  private static instance: PerformanceMonitor | null = null;
  private config: PerformanceConfig;
  private metrics: PerformanceMetrics[] = [];
  private requestCount: number = 0;
  private errorCount: number = 0;
  private startTime: number = Date.now();
  private monitoringInterval: NodeJS.Timeout | null = null;

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
      Logger.warn('性能监控已在运行', 'PerformanceMonitor');
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
}

export default PerformanceMonitor;
