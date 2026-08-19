import { EventBus } from '../shared/EventBus';
import { Logger } from './Logger';
import { TimerManager } from './TimerManager';

interface MemoryStats {
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  rssMB: number;
}

interface BufferConfig {
  maxSize: number;
  warningThreshold: number;
  cleanupInterval: number;
}

interface GuardedBuffer<T> {
  data: T[];
  config: BufferConfig;
  name: string;
  lastCleanupTime: number;
  cleanupCount: number;
}

export class MemoryLeakGuard {
  private static instance: MemoryLeakGuard | null = null;
  private buffers: Map<string, GuardedBuffer<unknown>> = new Map();
  private timerManager: TimerManager;
  private memoryCheckIntervalId: string | null = null;
  private lastMemoryWarningTime = 0;
  private readonly MEMORY_WARNING_COOLDOWN_MS = 60000;

  static create(timerManager?: TimerManager): MemoryLeakGuard {
    return new MemoryLeakGuard(timerManager);
  }

  static getInstance(): MemoryLeakGuard {
    if (!MemoryLeakGuard.instance) {
      MemoryLeakGuard.instance = new MemoryLeakGuard();
    }
    return MemoryLeakGuard.instance;
  }

  private constructor(timerManager?: TimerManager) {
    this.timerManager = timerManager ?? TimerManager.getInstance();
    this.startPeriodicMemoryCheck();
  }

  registerBuffer<T>(
    name: string,
    initialData: T[] = [],
    config: Partial<BufferConfig> = {}
  ): GuardedBuffer<T> {
    const defaultConfig: BufferConfig = {
      maxSize: 1000,
      warningThreshold: 0.8,
      cleanupInterval: 300000,
    };

    const fullConfig = { ...defaultConfig, ...config };
    const buffer: GuardedBuffer<T> = {
      data: initialData,
      config: fullConfig,
      name,
      lastCleanupTime: Date.now(),
      cleanupCount: 0,
    };

    this.buffers.set(name, buffer as GuardedBuffer<unknown>);
    Logger.debug(
      `🛡️ 内存缓冲区注册: ${name} (maxSize=${fullConfig.maxSize})`,
      'MemoryLeakGuard'
    );
    return buffer;
  }

  pushToBuffer<T>(bufferName: string, item: T): boolean {
    const buffer = this.buffers.get(bufferName) as GuardedBuffer<T> | undefined;
    if (!buffer) {
      Logger.warn(`⚠️ 未注册的缓冲区: ${bufferName}`, 'MemoryLeakGuard');
      return false;
    }

    buffer.data.push(item);

    if (buffer.data.length > buffer.config.maxSize) {
      const overflow = buffer.data.length - buffer.config.maxSize;
      buffer.data.splice(0, overflow);
      buffer.cleanupCount++;

      Logger.debug(
        `🧹 缓冲区 ${bufferName} 自动清理 ${overflow} 条记录 (当前: ${buffer.data.length}/${buffer.config.maxSize})`,
        'MemoryLeakGuard'
      );
    }

    const usageRatio = buffer.data.length / buffer.config.maxSize;
    if (usageRatio > buffer.config.warningThreshold) {
      Logger.warn(
        `⚠️ 缓冲区 ${bufferName} 使用率过高: ${(usageRatio * 100).toFixed(1)}% (${buffer.data.length}/${buffer.config.maxSize})`,
        'MemoryLeakGuard'
      );
    }

    return true;
  }

  getBufferSize(bufferName: string): number {
    const buffer = this.buffers.get(bufferName);
    return buffer ? buffer.data.length : 0;
  }

  getBufferStats(): Array<{
    name: string;
    size: number;
    maxSize: number;
    usagePercent: number;
    cleanupCount: number;
  }> {
    const stats = [];
    for (const [name, buffer] of this.buffers) {
      stats.push({
        name,
        size: buffer.data.length,
        maxSize: buffer.config.maxSize,
        usagePercent: parseFloat(
          ((buffer.data.length / buffer.config.maxSize) * 100).toFixed(1)
        ),
        cleanupCount: buffer.cleanupCount,
      });
    }
    return stats;
  }

  forceCleanup(bufferName?: string): void {
    if (bufferName) {
      const buffer = this.buffers.get(bufferName);
      if (buffer) {
        const previousSize = buffer.data.length;
        buffer.data = [];
        buffer.cleanupCount++;
        Logger.info(
          `🧹 强制清理缓冲区 ${bufferName}: ${previousSize} → 0 条`,
          'MemoryLeakGuard'
        );
      }
    } else {
      for (const [name, buffer] of this.buffers) {
        const previousSize = buffer.data.length;
        buffer.data = [];
        buffer.cleanupCount++;
        Logger.info(
          `🧹 强制清理缓冲区 ${name}: ${previousSize} → 0 条`,
          'MemoryLeakGuard'
        );
      }
    }
  }

  getMemoryUsage(): MemoryStats {
    const usage = process.memoryUsage();
    return {
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
      externalMB: Math.round(usage.external / 1024 / 1024),
      rssMB: Math.round(usage.rss / 1024 / 1024),
    };
  }

  checkMemoryHealth(): {
    healthy: boolean;
    warnings: string[];
    stats: MemoryStats;
  } {
    const stats = this.getMemoryUsage();
    const warnings: string[] = [];
    let healthy = true;

    if (stats.heapUsedMB > 500) {
      warnings.push(`堆内存使用过高: ${stats.heapUsedMB}MB (>500MB)`);
      healthy = false;
    }

    if (stats.heapUsedMB / stats.heapTotalMB > 0.9) {
      warnings.push(
        `堆内存使用率过高: ${((stats.heapUsedMB / stats.heapTotalMB) * 100).toFixed(1)}%`
      );
      healthy = false;
    }

    for (const [name, buffer] of this.buffers) {
      const usage = buffer.data.length / buffer.config.maxSize;
      if (usage > 0.9) {
        warnings.push(
          `缓冲区 ${name} 接近上限: ${buffer.data.length}/${buffer.config.maxSize}`
        );
        healthy = false;
      }
    }

    return { healthy, warnings, stats };
  }

  private startPeriodicMemoryCheck(): void {
    this.memoryCheckIntervalId = this.timerManager.setInterval(
      () => this.performPeriodicCheck(),
      60000,
      'memory-leak-guard',
      '定期内存健康检查'
    );

    Logger.info(
      '🛡️ MemoryLeakGuard 已启动 (每60秒检查一次)',
      'MemoryLeakGuard'
    );
  }

  private performPeriodicCheck(): void {
    try {
      const { healthy, warnings, stats } = this.checkMemoryHealth();

      if (
        !healthy &&
        Date.now() - this.lastMemoryWarningTime >
          this.MEMORY_WARNING_COOLDOWN_MS
      ) {
        Logger.warn(
          `⚠️ 内存健康检查异常:\n${warnings.join('\n')}\n` +
            `统计: 堆=${stats.heapUsedMB}MB/${stats.heapTotalMB}MB, RSS=${stats.rssMB}MB`,
          'MemoryLeakGuard'
        );
        this.lastMemoryWarningTime = Date.now();

        EventBus.emit('memory_warning', {
          warnings,
          stats,
          timestamp: new Date().toISOString(),
        });
      }

      const bufferStats = this.getBufferStats();
      for (const stat of bufferStats) {
        if (stat.usagePercent > 80) {
          Logger.debug(
            `📊 缓冲区状态: ${stat.name}=${stat.size}/${stat.maxSize} (${stat.usagePercent}%, 清理${stat.cleanupCount}次)`,
            'MemoryLeakGuard'
          );
        }
      }
    } catch (error) {
      Logger.error(
        'MemoryLeakGuard 定期检查失败:',
        error as Error,
        'MemoryLeakGuard'
      );
    }
  }

  shutdown(): void {
    if (this.memoryCheckIntervalId) {
      this.timerManager.clear(this.memoryCheckIntervalId);
      this.memoryCheckIntervalId = null;
    }

    this.forceCleanup();
    this.buffers.clear();

    Logger.info('🛡️ MemoryLeakGuard 已关闭', 'MemoryLeakGuard');
  }

  static resetInstance(): void {
    if (MemoryLeakGuard.instance) {
      MemoryLeakGuard.instance.shutdown();
      MemoryLeakGuard.instance = null;
    }
  }
}
