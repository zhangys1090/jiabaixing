"use strict";
/**
 * 桌面Agent事件流系统
 * 参考 UI-TARS Event Stream 设计
 * 实时推送Agent状态、操作、观察结果，支持前端可视化
 *
 * 事件类型：
 * - task_start: 任务开始
 * - task_end: 任务结束
 * - observation: 观察结果（截图）
 * - planning: 规划中
 * - action_start: 动作开始执行
 * - action_end: 动作执行完成
 * - action_error: 动作执行错误
 * - retry: 重试
 * - checkpoint: 检查点
 * - status_change: 状态变化
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventStream = exports.DesktopEventStream = void 0;
const events_1 = require("events");
const Logger_1 = require("../utils/Logger");
class DesktopEventStream extends events_1.EventEmitter {
    static instance = null;
    eventBuffer = [];
    maxBufferSize = 1000;
    sequenceCounter = 0;
    currentTaskId = '';
    subscribers = new Set();
    constructor(options) {
        super();
        this.maxBufferSize = options?.maxBufferSize || 1000;
    }
    static getInstance(options) {
        if (!DesktopEventStream.instance) {
            DesktopEventStream.instance = new DesktopEventStream(options);
        }
        return DesktopEventStream.instance;
    }
    /**
     * 开始一个新任务
     */
    startTask(taskDescription) {
        this.currentTaskId = this.generateId();
        this.sequenceCounter = 0;
        this.emitEvent('task_start', {
            description: taskDescription,
            startTime: Date.now(),
        });
        Logger_1.Logger.info(`📋 任务开始: ${taskDescription}`, 'EventStream');
        return this.currentTaskId;
    }
    /**
     * 结束任务
     */
    endTask(success, result, details) {
        const safeResult = result ?? (success ? '任务完成' : '任务失败');
        this.emitEvent('task_end', {
            success,
            result: safeResult,
            endTime: Date.now(),
            ...details,
        });
        Logger_1.Logger.info(`🏁 任务结束: ${success ? '成功' : '失败'} - ${safeResult.substring(0, 50)}`, 'EventStream');
    }
    /**
     * 发送观察事件
     */
    emitObservation(screenshotBase64, screenWidth, screenHeight, uiElements) {
        this.emitEvent('observation', {
            screenshot: screenshotBase64,
            screenWidth,
            screenHeight,
            uiElements: uiElements || [],
            timestamp: Date.now(),
        });
    }
    /**
     * 发送规划事件
     */
    emitPlanning(plan, reasoning) {
        this.emitEvent('planning', {
            plan,
            reasoning: reasoning || '',
            stepCount: Array.isArray(plan) ? plan.length : 0,
        });
        Logger_1.Logger.debug(`🧠 规划完成，共 ${Array.isArray(plan) ? plan.length : 0} 步`, 'EventStream');
    }
    /**
     * 发送动作开始事件
     */
    emitActionStart(actionType, description, params) {
        this.emitEvent('action_start', {
            actionType,
            description,
            params,
            startTime: Date.now(),
        });
        Logger_1.Logger.debug(`▶️ 动作开始: ${description}`, 'EventStream');
    }
    /**
     * 发送动作完成事件
     */
    emitActionEnd(actionType, description, success, result) {
        this.emitEvent('action_end', {
            actionType,
            description,
            success,
            result,
            endTime: Date.now(),
        });
        Logger_1.Logger.debug(`✅ 动作完成: ${description} (${success ? '成功' : '失败'})`, 'EventStream');
    }
    /**
     * 发送动作错误事件
     */
    emitActionError(actionType, description, error, willRetry = false) {
        this.emitEvent('action_error', {
            actionType,
            description,
            error,
            willRetry,
            timestamp: Date.now(),
        });
        Logger_1.Logger.warn(`❌ 动作错误: ${description} - ${error}`, 'EventStream');
    }
    /**
     * 发送重试事件
     */
    emitRetry(retryCount, maxRetries, reason) {
        this.emitEvent('retry', {
            retryCount,
            maxRetries,
            reason,
            timestamp: Date.now(),
        });
        Logger_1.Logger.warn(`🔄 重试 ${retryCount}/${maxRetries}: ${reason}`, 'EventStream');
    }
    /**
     * 发送检查点事件
     */
    emitCheckpoint(checkpointId, description) {
        this.emitEvent('checkpoint', {
            checkpointId,
            description,
            timestamp: Date.now(),
        });
        Logger_1.Logger.info(`💾 检查点: ${description}`, 'EventStream');
    }
    /**
     * 发送状态变化事件
     */
    emitStatusChange(status, details) {
        this.emitEvent('status_change', {
            status,
            details: details || '',
            timestamp: Date.now(),
        });
        Logger_1.Logger.info(`📊 状态变化: ${status}`, 'EventStream');
    }
    /**
     * 发送安全警告事件
     */
    emitSafetyWarning(warningType, message, severity = 'medium') {
        this.emitEvent('safety_warning', {
            warningType,
            message,
            severity,
            timestamp: Date.now(),
        });
        Logger_1.Logger.warn(`⚠️ 安全警告 [${severity}]: ${message}`, 'EventStream');
    }
    /**
     * 发送需要用户干预事件
     */
    emitUserInterventionRequired(reason, options = ['继续', '取消', '重试']) {
        this.emitEvent('user_intervention_required', {
            reason,
            options,
            timestamp: Date.now(),
        });
        Logger_1.Logger.info(`👤 需要用户干预: ${reason}`, 'EventStream');
    }
    /**
     * 订阅事件流
     */
    subscribe(callback) {
        this.subscribers.add(callback);
        // 返回取消订阅函数
        return () => {
            this.subscribers.delete(callback);
        };
    }
    /**
     * 获取历史事件
     */
    getHistory(limit) {
        const events = [...this.eventBuffer];
        if (limit) {
            return events.slice(-limit);
        }
        return events;
    }
    /**
     * 获取当前任务的事件
     */
    getCurrentTaskEvents() {
        return this.eventBuffer.filter((e) => e.taskId === this.currentTaskId);
    }
    /**
     * 清空事件缓冲区
     */
    clearBuffer() {
        this.eventBuffer = [];
        this.sequenceCounter = 0;
        Logger_1.Logger.debug('🧹 事件缓冲区已清空', 'EventStream');
    }
    /**
     * 导出事件为JSON
     */
    exportEvents(taskId) {
        const events = taskId
            ? this.eventBuffer.filter((e) => e.taskId === taskId)
            : this.eventBuffer;
        return JSON.stringify(events, null, 2);
    }
    /**
     * 发送事件（内部方法）
     */
    emitEvent(type, data) {
        const event = {
            id: this.generateId(),
            type,
            timestamp: Date.now(),
            taskId: this.currentTaskId,
            data,
            sequence: this.sequenceCounter++,
        };
        // 添加到缓冲区
        this.eventBuffer.push(event);
        if (this.eventBuffer.length > this.maxBufferSize) {
            this.eventBuffer.shift();
        }
        // 通知订阅者
        this.subscribers.forEach((callback) => {
            try {
                callback(event);
            }
            catch (err) {
                Logger_1.Logger.error(`事件订阅者错误: ${err.message}`, err, 'EventStream');
            }
        });
        // 触发EventEmitter事件
        this.emit(type, event);
        this.emit('*', event);
    }
    generateId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}
exports.DesktopEventStream = DesktopEventStream;
// 便捷导出
exports.eventStream = DesktopEventStream.getInstance();
