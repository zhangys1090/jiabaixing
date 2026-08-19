"use strict";
/**
 * 记忆存储抽象基类
 * 提供统一的异步操作模板和错误处理机制
 * 所有记忆存储类应继承此基类
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseMemoryStore = void 0;
const Logger_1 = require("../utils/Logger");
/**
 * 记忆存储抽象基类
 * 提供统一的异步操作模板方法
 */
class BaseMemoryStore {
    constructor(options = {}) {
        this.initialized = false;
        this.options = {
            enableOperationLogging: true,
            enableErrorRetry: false,
            maxRetryAttempts: options.maxRetryAttempts ?? 3,
            retryDelayMs: options.retryDelayMs ?? 1000,
            ...options,
        };
    }
    /**
     * 确保存储已初始化
     * @throws Error 如果存储未初始化
     */
    ensureInitialized() {
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
    async executeTransaction(operationName, callback) {
        const startTime = Date.now();
        const attemptCount = this.options.enableErrorRetry
            ? this.options.maxRetryAttempts
            : 1;
        for (let attempt = 1; attempt <= attemptCount; attempt++) {
            try {
                if (this.options.enableOperationLogging) {
                    Logger_1.Logger.debug(`🔄 [${this.constructor.name}] 开始操作: ${operationName} (尝试 ${attempt}/${attemptCount})`);
                }
                const result = await callback();
                const duration = Date.now() - startTime;
                if (this.options.enableOperationLogging) {
                    Logger_1.Logger.debug(`✅ [${this.constructor.name}] 操作完成: ${operationName} (耗时 ${duration}ms)`);
                }
                return result;
            }
            catch (error) {
                const duration = Date.now() - startTime;
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (attempt < attemptCount) {
                    Logger_1.Logger.warn(`⚠️ [${this.constructor.name}] 操作失败: ${operationName} (尝试 ${attempt}/${attemptCount}), 错误: ${errorMessage}, ${this.options.retryDelayMs}ms后重试...`);
                    await this.delay(this.options.retryDelayMs);
                }
                else {
                    Logger_1.Logger.error(`❌ [${this.constructor.name}] 操作失败: ${operationName} (耗时 ${duration}ms)`, error);
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
    executeSync(operationName, callback) {
        try {
            if (this.options.enableOperationLogging) {
                Logger_1.Logger.debug(`🔄 [${this.constructor.name}] 开始同步操作: ${operationName}`);
            }
            const result = callback();
            if (this.options.enableOperationLogging) {
                Logger_1.Logger.debug(`✅ [${this.constructor.name}] 同步操作完成: ${operationName}`);
            }
            return result;
        }
        catch (error) {
            Logger_1.Logger.error(`❌ [${this.constructor.name}] 同步操作失败: ${operationName}`, error);
            throw error;
        }
    }
    /**
     * 延迟执行（用于重试机制）
     * @param ms 延迟时间（毫秒）
     */
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * 获取存储状态
     */
    isInitialized() {
        return this.initialized;
    }
}
exports.BaseMemoryStore = BaseMemoryStore;
