/**
 * WebSocket 取消任务处理
 */

import WebSocket from 'ws';
import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import { WsTaskManager } from '../WsTaskManager';

/**
 * 处理取消任务
 */
export function handleCancelTask(
  traceId: string | undefined,
  ws: WebSocket.WebSocket,
  taskManager: WsTaskManager
): void {
  if (!traceId) {
    Logger.info('🛑 取消任务缺少 traceId', 'WsHandler');
    return;
  }

  if (traceId.length > 256) {
    Logger.info('🛑 取消任务 traceId 过长', 'WsHandler');
    return;
  }

  if (!taskManager.has(traceId)) {
    Logger.info(`🛑 取消任务未找到: traceId=${traceId}`, 'WsHandler');
    return;
  }

  const cancelled = taskManager.cancel(traceId);
  if (cancelled) {
    Logger.info(`🛑 用户取消任务: traceId=${traceId}`, 'WsHandler');
    EventBus.emit('agent_execution_update', {
      traceId,
      phase: 'cancelled',
      status: 'aborted',
      message: '用户已取消任务',
      timestamp: new Date().toISOString(),
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'task_cancelled',
          data: { traceId, message: '任务已取消' },
        })
      );
    }
  }
}
