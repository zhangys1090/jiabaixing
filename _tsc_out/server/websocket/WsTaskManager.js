"use strict";
/**
 * WebSocket 任务管理模块
 * 从 websocket.ts 提取，专门处理活跃任务追踪
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeTasks = exports.WsTaskManager = void 0;
const Logger_1 = require("../../utils/Logger");
const contracts_1 = require("../../shared/contracts");
/**
 * WebSocket 任务管理器
 */
class WsTaskManager {
    tasks = new Map();
    cleanupInterval = null;
    timeoutMs;
    cleanupIntervalMs;
    constructor(timeoutMs, cleanupIntervalMs) {
        this.timeoutMs = timeoutMs ?? contracts_1.SYSTEM_CONSTANTS.ACTIVE_TASK_TIMEOUT_MS;
        this.cleanupIntervalMs = cleanupIntervalMs ?? 60 * 1000;
    }
    /**
     * 注册新任务
     */
    register(traceId, task) {
        this.tasks.set(traceId, task);
    }
    /**
     * 获取任务
     */
    get(traceId) {
        return this.tasks.get(traceId);
    }
    /**
     * 取消任务
     */
    cancel(traceId) {
        const task = this.tasks.get(traceId);
        if (!task)
            return false;
        task.aborted = true;
        if (task.loopController) {
            try {
                task.loopController.abort();
            }
            catch {
                // 忽略
            }
        }
        this.tasks.delete(traceId);
        return true;
    }
    /**
     * 删除任务
     */
    delete(traceId) {
        return this.tasks.delete(traceId);
    }
    /**
     * 检查任务是否存在
     */
    has(traceId) {
        return this.tasks.has(traceId);
    }
    /**
     * 获取任务数量
     */
    get size() {
        return this.tasks.size;
    }
    /**
     * 按客户端 IP 获取所有任务
     */
    getByClientIp(clientIp) {
        const result = [];
        for (const task of this.tasks.values()) {
            if (task.clientIp === clientIp) {
                result.push(task);
            }
        }
        return result;
    }
    /**
     * 清理超时任务
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [traceId, task] of this.tasks.entries()) {
            if (now - task.createdAt > this.timeoutMs) {
                if (!task.aborted && task.loopController) {
                    try {
                        task.loopController.abort();
                    }
                    catch {
                        // 忽略
                    }
                }
                this.tasks.delete(traceId);
                cleaned++;
                Logger_1.Logger.debug(`🗑️ 自动清理超时活跃任务: traceId=${traceId}`, 'WsTaskManager');
            }
        }
        return cleaned;
    }
    /**
     * 按客户端 IP 清理所有任务
     */
    cleanupByClientIp(clientIp) {
        let cleaned = 0;
        for (const [traceId, task] of this.tasks.entries()) {
            if (task.clientIp === clientIp) {
                if (!task.aborted && task.loopController) {
                    try {
                        task.loopController.abort();
                    }
                    catch {
                        // 忽略
                    }
                }
                this.tasks.delete(traceId);
                cleaned++;
                Logger_1.Logger.debug(`🗑️ 清理客户端断开关联任务: traceId=${traceId}`, 'WsTaskManager');
            }
        }
        return cleaned;
    }
    /**
     * 启动定时清理
     */
    startCleanup() {
        if (this.cleanupInterval === null) {
            this.cleanupInterval = setInterval(() => {
                this.cleanup();
            }, this.cleanupIntervalMs);
        }
    }
    /**
     * 停止定时清理
     */
    stopCleanup() {
        if (this.cleanupInterval !== null) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
    /**
     * 创建任务元数据
     */
    createTaskMeta(clientIp, loopController) {
        return {
            aborted: false,
            loopController,
            clientIp,
            createdAt: Date.now(),
        };
    }
}
exports.WsTaskManager = WsTaskManager;
/**
 * 全局任务管理器实例
 */
exports.activeTasks = new WsTaskManager();
