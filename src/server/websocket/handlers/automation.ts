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
  Logger.info(`⚡ 自动化任务创建: ${JSON.stringify(data.task)}`, 'WsHandler');

  if (core?.getScenarioScheduler()) {
    // 使用类型断言，因为客户端传入的数据是动态的
    core
      .getScenarioScheduler()!
      .addTask(
        data.task as unknown as import('../../../core/ScenarioAwareScheduler').ScheduledTask
      );
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
  Logger.info(
    `⚡ 自动化触发执行: ${JSON.stringify(data.trigger)}`,
    'WsHandler'
  );
  EventBus.emit('automation_trigger_execute', {
    trigger: data.trigger,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}
