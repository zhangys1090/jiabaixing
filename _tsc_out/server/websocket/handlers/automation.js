"use strict";
/**
 * WebSocket 自动化任务处理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAutomationTaskToggle = handleAutomationTaskToggle;
exports.handleAutomationTaskCreate = handleAutomationTaskCreate;
exports.handleAutomationTriggerExecute = handleAutomationTriggerExecute;
const EventBus_1 = require("../../../shared/EventBus");
const Logger_1 = require("../../../utils/Logger");
/**
 * 处理自动化任务切换
 */
function handleAutomationTaskToggle(data, _ws, core) {
    if (!data.taskId || data.taskId.length > 256) {
        Logger_1.Logger.warn('⚡ 自动化任务切换: taskId 无效', 'WsHandler');
        return;
    }
    Logger_1.Logger.info(`⚡ 自动化任务切换: ${data.taskId} -> ${data.enabled ? '启用' : '禁用'}`, 'WsHandler');
    if (core?.getScenarioScheduler()) {
        const scheduler = core.getScenarioScheduler();
        if (data.enabled) {
            scheduler.toggleTask?.(data.taskId, true);
        }
        else {
            scheduler.toggleTask?.(data.taskId, false);
        }
    }
    EventBus_1.EventBus.emit('automation_task_toggle', {
        taskId: data.taskId,
        enabled: data.enabled,
        timestamp: data.timestamp || new Date().toISOString(),
    });
}
/**
 * 处理自动化任务创建
 */
function handleAutomationTaskCreate(data, core) {
    const task = data.task;
    if (!task || typeof task !== 'object') {
        Logger_1.Logger.warn('⚡ 自动化任务创建: 无效的任务数据', 'WsHandler');
        return;
    }
    const taskName = typeof task.name === 'string' ? task.name.trim() : '';
    if (taskName.length === 0 || taskName.length > 200) {
        Logger_1.Logger.warn('⚡ 自动化任务创建: 任务名称无效', 'WsHandler');
        return;
    }
    Logger_1.Logger.info(`⚡ 自动化任务创建: ${taskName}`, 'WsHandler');
    if (core?.getScenarioScheduler()) {
        const schedule = typeof task.schedule === 'string' ? task.schedule : '0 9 * * *';
        const priority = typeof task.priority === 'number'
            ? Math.min(Math.max(task.priority, 1), 10)
            : 5;
        core.getScenarioScheduler().addTask({
            id: `task_${Date.now()}`,
            name: taskName,
            description: typeof task.description === 'string'
                ? task.description.substring(0, 1000)
                : '',
            schedule,
            priority,
            enabled: true,
            executionCount: 0,
            successCount: 0,
            averageExecutionTime: 0,
        });
    }
    EventBus_1.EventBus.emit('automation_task_create', {
        task: data.task,
        timestamp: data.timestamp || new Date().toISOString(),
    });
}
/**
 * 处理自动化触发执行
 */
function handleAutomationTriggerExecute(data) {
    if (!data.trigger || typeof data.trigger !== 'object') {
        Logger_1.Logger.warn('⚡ 自动化触发执行: 无效的触发数据', 'WsHandler');
        return;
    }
    const triggerName = typeof data.trigger.name === 'string'
        ? data.trigger.name.trim()
        : '';
    if (triggerName.length === 0 || triggerName.length > 200) {
        Logger_1.Logger.warn('⚡ 自动化触发执行: 触发器名称无效', 'WsHandler');
        return;
    }
    Logger_1.Logger.info(`⚡ 自动化触发执行: ${triggerName}`, 'WsHandler');
    EventBus_1.EventBus.emit('automation_trigger_execute', {
        trigger: data.trigger,
        timestamp: data.timestamp || new Date().toISOString(),
    });
}
