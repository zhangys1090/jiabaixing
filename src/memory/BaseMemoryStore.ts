/**
 * 记忆存储抽象基类
 * 提供统一的异步操作模板和错误处理机制
 * 所有记忆存储类应继承此基类
 */

import { Logger } from '../utils/Logger';

/**
 * 记忆存储操作结果
 */
export interface MemoryOperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: Error;
  operationName: string;
  timestamp: Date;
}

/**
 * 记忆存储配置选项
 */
export interface BaseMemoryStoreOptions {
  /** 是否启用操作日志 */
  enableOperationLogging?: boolean;
  /** 是否启用错误重试 */
  enableErrorRetry?: boolean;
  /** 最大重试次数 */
  maxRetryAttempts?: number;
  /** 重试延迟（毫秒） */
  retryDelayMs?: number;
}

/**
 * 记忆存储抽象基类
 * 提供统一的异步操作模板方法
 */
export abstract class BaseMemoryStore {
  protected initialized: boolean = false;
  protected options: Required<BaseMemoryStoreOptions>;

  constructor(options: BaseMemoryStoreOptions = {}) {
    this.options = {
      enableOperationLogging: true,
      enableErrorRetry: false,
      maxRetryAttempts: options.maxRetryAttempts ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1000,
      ...options,
    };
  }

  /**
   * 初始化存储
   * 子类必须实现此方法
   */
  abstract initialize(): Promise<void>;

  /**
   * 关闭存储
   * 子类必须实现此方法
   */
  abstract shutdown(): Promise<void>;

  /**
   * 确保存储已初始化
   * @throws Error 如果存储未初始化
   */
  protected ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`${this.constructor.name} 尚未初始化`);
    }
  }

  /**
   * 执行受保护的异步操作（统一事务模板）
   * 提供统一的错误处理、重试机制和日志记录
   * @param operationName 操作名称（用于日志）
   * @param callback 要执行的操作
   * @returns 操作结果
   */
  protected async executeTransaction<T>(
    operationName: string,
    callback: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    const attemptCount = this.options.enableErrorRetry
      ? this.options.maxRetryAttempts
      : 1;

    for (let attempt = 1; attempt <= attemptCount; attempt++) {
      try {
        if (this.options.enableOperationLogging) {
          Logger.debug(
            `🔄 [${this.constructor.name}] 开始操作: ${operationName} (尝试 ${attempt}/${attemptCount})`
          );
        }

        const result = await callback();

        const duration = Date.now() - startTime;
        if (this.options.enableOperationLogging) {
          Logger.debug(
            `✅ [${this.constructor.name}] 操作完成: ${operationName} (耗时 ${duration}ms)`
          );
        }

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        if (attempt < attemptCount) {
          Logger.warn(
            `⚠️ [${this.constructor.name}] 操作失败: ${operationName} (尝试 ${attempt}/${attemptCount}), 错误: ${errorMessage}, ${this.options.retryDelayMs}ms后重试...`
          );
          await this.delay(this.options.retryDelayMs);
        } else {
          Logger.error(
            `❌ [${this.constructor.name}] 操作失败: ${operationName} (耗时 ${duration}ms)`,
            error as Error
          );

          if (error instanceof Error) {
            throw error;
          }
          throw new Error(`操作 ${operationName} 失败: ${errorMessage}`);
        }
      }
    }

    throw new Error(`操作 ${operationName} 在 ${attemptCount} 次尝试后失败`);
  }

  /**
   * 执行同步操作（统一错误处理模板）
   * @param operationName 操作名称
   * @param callback 要执行的操作
   */
  protected executeSync<T>(operationName: string, callback: () => T): T {
    try {
      if (this.options.enableOperationLogging) {
        Logger.debug(
          `🔄 [${this.constructor.name}] 开始同步操作: ${operationName}`
        );
      }

      const result = callback();

      if (this.options.enableOperationLogging) {
        Logger.debug(
          `✅ [${this.constructor.name}] 同步操作完成: ${operationName}`
        );
      }

      return result;
    } catch (error) {
      Logger.error(
        `❌ [${this.constructor.name}] 同步操作失败: ${operationName}`,
        error as Error
      );
      throw error;
    }
  }

  /**
   * 延迟执行（用于重试机制）
   * @param ms 延迟时间（毫秒）
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 获取存储状态
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取存储名称（用于日志）
   */
  protected abstract getStoreName(): string;
}
