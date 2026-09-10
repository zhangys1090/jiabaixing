/**
 * WebSocket 自动化任务处理
 */

import { JiabaixingCore } from '../../../core/JiabaixingCore';
import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';

// 导入 WebSocket 类型
type WebSocket = import('ws').WebSocket;

/**
 * 处理自动化任务切换
 */
export function handleAutomationTaskToggle(
  data: { taskId: string; enabled: boolean; timestamp?: string },
  _ws: WebSocket,
  core: JiabaixingCore | null
): void {
  if (!data.taskId || data.taskId.length > 256) {
    Logger.warn('⚡ 自动化任务切换: taskId 无效', 'WsHandler');
    return;
  }
  Logger.info(
    `⚡ 自动化任务切换: ${data.taskId} -> ${data.enabled ? '启用' : '禁用'}`,
    'WsHandler'
  );

  if (core?.getScenarioScheduler()) {
    const scheduler = core.getScenarioScheduler()!;
    if (data.enabled) {
      scheduler.toggleTask?.(data.taskId, true);
    } else {
      scheduler.toggleTask?.(data.taskId, false);
    }
  }

  EventBus.emit('automation_task_toggle', {
    taskId: data.taskId,
    enabled: data.enabled,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}

/**
 * 处理自动化任务创建
 */
export function handleAutomationTaskCreate(
  data: { task: Record<string, unknown>; timestamp?: string },
  core: JiabaixingCore | null
): void {
  const task = data.task;
  if (!task || typeof task !== 'object') {
    Logger.warn('⚡ 自动化任务创建: 无效的任务数据', 'WsHandler');
    return;
  }
  const taskName =
    typeof task.name === 'string' ? (task.name as string).trim() : '';
  if (taskName.length === 0 || taskName.length > 200) {
    Logger.warn('⚡ 自动化任务创建: 任务名称无效', 'WsHandler');
    return;
  }
  Logger.info(`⚡ 自动化任务创建: ${taskName}`, 'WsHandler');

  if (core?.getScenarioScheduler()) {
    const schedule =
      typeof task.schedule === 'string' ? task.schedule : '0 9 * * *';
    const priority =
      typeof task.priority === 'number'
        ? Math.min(Math.max(task.priority as number, 1), 10)
        : 5;
    core.getScenarioScheduler()!.addTask({
      id: `task_${Date.now()}`,
      name: taskName,
      description:
        typeof task.description === 'string'
          ? (task.description as string).substring(0, 1000)
          : '',
      schedule,
      priority,
      enabled: true,
      executionCount: 0,
      successCount: 0,
      averageExecutionTime: 0,
    } as unknown as import('../../../core/ScenarioAwareScheduler').ScheduledTask);
  }

  EventBus.emit('automation_task_create', {
    task: data.task,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}

/**
 * 处理自动化触发执行
 */
export function handleAutomationTriggerExecute(data: {
  trigger: Record<string, unknown>;
  timestamp?: string;
}): void {
  if (!data.trigger || typeof data.trigger !== 'object') {
    Logger.warn('⚡ 自动化触发执行: 无效的触发数据', 'WsHandler');
    return;
  }
  const triggerName =
    typeof data.trigger.name === 'string'
      ? (data.trigger.name as string).trim()
      : '';
  if (triggerName.length === 0 || triggerName.length > 200) {
    Logger.warn('⚡ 自动化触发执行: 触发器名称无效', 'WsHandler');
    return;
  }
  Logger.info(`⚡ 自动化触发执行: ${triggerName}`, 'WsHandler');
  EventBus.emit('automation_trigger_execute', {
    trigger: data.trigger,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}
