"use strict";
/**
 * 定时器管理器
 * 集中管理所有 setInterval/setTimeout，防止内存泄漏
 * 提供命名空间、自动清理、生命周期管理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimerManager = void 0;
const Logger_1 = require("./Logger");
class TimerManager {
    constructor() {
        this.timers = new Map();
        this.MAX_TIMERS = 10000;
        this.namespaceCounters = new Map();
    }
    static getInstance() {
        if (!TimerManager.instance) {
            TimerManager.instance = new TimerManager();
        }
        return TimerManager.instance;
    }
    /**
     * 注册 setTimeout
     */
    setTimeout(callback, delay, namespace = 'default', description = '') {
        const id = this.generateId(namespace);
        const timerId = setTimeout(() => {
            this.timers.delete(id);
            callback();
        }, delay);
        if (this.timers.size >= this.MAX_TIMERS) {
            const oldestKey = this.timers.keys().next().value;
            const oldest = this.timers.get(oldestKey);
            if (oldest) {
                clearTimeout(oldest.id);
                this.timers.delete(oldestKey);
            }
        }
        this.timers.set(id, {
            id: timerId,
            type: 'timeout',
            namespace,
            description,
            createdAt: Date.now(),
        });
        return id;
    }
    /**
     * 注册 setInterval
     */
    setInterval(callback, interval, namespace = 'default', description = '') {
        const id = this.generateId(namespace);
        const timerId = setInterval(callback, interval);
        if (timerId.unref)
            timerId.unref();
        if (this.timers.size >= this.MAX_TIMERS) {
            const oldestKey = this.timers.keys().next().value;
            const oldest = this.timers.get(oldestKey);
            if (oldest) {
                clearInterval(oldest.id);
                this.timers.delete(oldestKey);
            }
        }
        this.timers.set(id, {
            id: timerId,
            type: 'interval',
            namespace,
            description,
            createdAt: Date.now(),
        });
        return id;
    }
    /**
     * 清除指定定时器
     */
    clear(id) {
        const entry = this.timers.get(id);
        if (!entry)
            return false;
        if (entry.type === 'timeout') {
            clearTimeout(entry.id);
        }
        else {
            clearInterval(entry.id);
        }
        this.timers.delete(id);
        return true;
    }
    /**
     * 清除指定命名空间的所有定时器
     */
    clearNamespace(namespace) {
        let count = 0;
        for (const [id, entry] of this.timers.entries()) {
            if (entry.namespace === namespace) {
                this.clear(id);
                count++;
            }
        }
        Logger_1.Logger.debug(`🧹 清理命名空间 "${namespace}" 的 ${count} 个定时器`, 'TimerManager');
        return count;
    }
    /**
     * 清除所有定时器
     */
    clearAll() {
        const count = this.timers.size;
        for (const [id] of this.timers.entries()) {
            this.clear(id);
        }
        Logger_1.Logger.info(`🧹 清理全部 ${count} 个定时器`, 'TimerManager');
        return count;
    }
    /**
     * 获取定时器统计
     */
    getStats() {
        const namespaces = {};
        let timeouts = 0;
        let intervals = 0;
        for (const [, entry] of this.timers.entries()) {
            namespaces[entry.namespace] = (namespaces[entry.namespace] || 0) + 1;
            if (entry.type === 'timeout')
                timeouts++;
            else
                intervals++;
        }
        return {
            total: this.timers.size,
            timeouts,
            intervals,
            namespaces,
        };
    }
    /**
     * 获取指定命名空间的定时器列表
     */
    getTimersByNamespace(namespace) {
        const result = [];
        const now = Date.now();
        for (const [id, entry] of this.timers.entries()) {
            if (entry.namespace === namespace) {
                result.push({
                    id,
                    type: entry.type,
                    description: entry.description,
                    age: now - entry.createdAt,
                });
            }
        }
        return result;
    }
    /**
     * 清除指定定时器（兼容 clearTimer 别名）
     */
    clearTimer(id) {
        return this.clear(id);
    }
    generateId(namespace) {
        const count = (this.namespaceCounters.get(namespace) || 0) + 1;
        this.namespaceCounters.set(namespace, count);
        return `${namespace}_${count}_${Date.now()}`;
    }
}
exports.TimerManager = TimerManager;
// 便捷导出
