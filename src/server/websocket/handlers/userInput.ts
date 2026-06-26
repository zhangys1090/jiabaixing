/**
 * WebSocket 用户输入处理
 * 处理 user_input 和 command 类型消息
 */

import WebSocket from 'ws';
import { Logger } from '../../../utils/Logger';
import { JiabaixingCore } from '../../../core/JiabaixingCore';
import { SYSTEM_CONSTANTS } from '../../../shared/contracts';
import {
  WsRateLimiter,
  WsCircuitBreaker,
  createRateLimitErrorResponse,
  createCircuitOpenResponse,
} from '../WsRateLimit';
import { WsTaskManager } from '../WsTaskManager';
import { checkAndMarkResponse } from '../WsDedup';
import { processInputWithRetry } from '../WsProcessor';

const rateLimiter = new WsRateLimiter();

/**
 * 处理用户输入
 */
export async function handleUserInput(
  data: Record<string, unknown>,
  userId: string,
  clientIp: string,
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null,
  taskManager: WsTaskManager,
  traceId: string
): Promise<void> {
  // 提取输入
  const payload = (data.payload || data.data || {}) as Record<string, unknown>;
  const input = (payload.input ||
    payload.text ||
    payload.message ||
    data.input ||
    data.text ||
    data.message ||
    '') as string;

  if (!input) {
    ws.send(
      JSON.stringify({
        type: 'error',
        data: { message: '缺少输入内容' },
      })
    );
    return;
  }

  if (input.length > SYSTEM_CONSTANTS.MAX_INPUT_LENGTH) {
    ws.send(
      JSON.stringify({
        type: 'error',
        data: {
          message: `消息过长（${input.length}字），请控制在${SYSTEM_CONSTANTS.MAX_INPUT_LENGTH}字以内`,
        },
      })
    );
    return;
  }

  // 限流检查
  const rateLimitKey = `ws:${userId}:${clientIp}`;
  const rateLimitResult = rateLimiter.checkStandard(rateLimitKey);
  if (!rateLimitResult.allowed) {
    Logger.warn(
      `⚠️ WebSocket限流: userId=${userId} ip=${clientIp}`,
      'WsHandler'
    );
    ws.send(
      JSON.stringify(createRateLimitErrorResponse(rateLimitResult.resetIn))
    );
    return;
  }

  // 熔断检查
  const circuitBreaker = new WsCircuitBreaker('llm_processing');
  if (!circuitBreaker.canExecute().canExecute) {
    Logger.warn(`⚠️ LLM熔断器开启，拒绝请求: userId=${userId}`, 'WsHandler');
    ws.send(JSON.stringify(createCircuitOpenResponse()));
    return;
  }

  Logger.info(
    `📩 WebSocket收到: ${String(input).substring(0, 50)}${String(input).length > 50 ? '...' : ''}`,
    'WsHandler'
  );

  // 去重检查
  if (checkAndMarkResponse(traceId)) {
    Logger.info(`⚠️ traceId ${traceId} 已处理，跳过重复请求`, 'WsHandler');
    return;
  }

  // 创建任务元数据
  const taskMeta = taskManager.createTaskMeta(clientIp);
  taskManager.register(traceId, taskMeta);

  // 发送处理中状态
  ws.send(
    JSON.stringify({
      type: 'processing_status',
      data: {
        status: 'processing',
        message: '收到消息，正在处理中...',
        traceId,
      },
    })
  );

  // 连接 loopController
  if (core) {
    const harness = core.getHarness();
    if (harness) {
      taskMeta.loopController = { abort: () => harness.abortCurrentLoop() };
    }
  }

  try {
    await processInputWithRetry(
      input,
      userId,
      traceId,
      ws,
      core,
      clientIp,
      taskMeta
    );
    taskManager.delete(traceId);
  } catch (err) {
    Logger.error('❌ 处理输入失败（重试耗尽）', err as Error, 'WsHandler');
    taskManager.delete(traceId);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'error',
          data: { message: (err as Error).message, traceId },
        })
      );
    }
  }
}

/**
 * 从消息数据提取用户 ID
 */
export function extractUserId(data: Record<string, unknown>): string {
  const payload = (data.payload || data.data || {}) as Record<string, unknown>;
  return (
    (payload.userId as string) ||
    (payload.userid as string) ||
    (data.userId as string) ||
    'anonymous'
  );
}
