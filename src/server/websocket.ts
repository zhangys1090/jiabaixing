/**
 * WebSocket 连接处理与输入处理
 */

import * as WebSocket from 'ws';

import { JiabaixingCore, ProcessInputResult } from '../core/JiabaixingCore';
import { Logger } from '../utils/Logger';

type WSServer = WebSocket.Server;

// WebSocket去重处理
const processedResponses = new Set<string>();
function checkAndMarkResponse(traceId: string): boolean {
  if (processedResponses.has(traceId)) {
    return true;
  }
  processedResponses.add(traceId);

  setTimeout(
    () => {
      processedResponses.delete(traceId);
    },
    5 * 60 * 1000
  );

  return false;
}

export function setupWebSocket(
  wss: WSServer | null,
  core: JiabaixingCore | null
): void {
  wss?.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    Logger.info(`💖 新客户端连接: ${clientIp}`, 'WebSocket');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'user_input' || data.type === 'command') {
          const input =
            data.payload?.input ||
            data.payload?.text ||
            data.payload?.message ||
            data.data?.input ||
            data.data?.text ||
            data.data?.message ||
            data.input ||
            data.text ||
            data.message ||
            '';
          const userId =
            data.payload?.userId ||
            data.payload?.userid ||
            data.data?.userId ||
            data.userId ||
            'anonymous';

          if (!input) {
            ws.send(
              JSON.stringify({
                type: 'error',
                data: { message: '缺少输入内容' },
              })
            );
            return;
          }

          const MAX_BACKEND_INPUT_LENGTH = 2000;
          if (input.length > MAX_BACKEND_INPUT_LENGTH) {
            ws.send(
              JSON.stringify({
                type: 'error',
                data: {
                  message: `消息过长（${input.length}字），请控制在${MAX_BACKEND_INPUT_LENGTH}字以内`,
                },
              })
            );
            return;
          }

          const traceId = Logger.generateTraceId();
          Logger.info(
            `📩 WebSocket收到: ${String(input).substring(0, 50)}${String(input).length > 50 ? '...' : ''}`,
            'WebSocket'
          );

          processInputWithCore(input as string, userId, traceId, ws, core).catch(
            (err: Error) => {
              Logger.error('❌ 处理输入失败', err, 'WebSocket');
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    data: { message: err.message, traceId },
                  })
                );
              }
            }
          );
        } else if (data.type === 'get_status') {
          ws.send(
            JSON.stringify({
              type: 'status',
              data: {
                status: 'running',
                model: process.env.MODEL_NAME || 'qwen2.5:3b',
                uptime: process.uptime(),
                clients: wss?.clients.size || 0,
              },
            })
          );
        } else if (data.type === 'clarification_response') {
          Logger.info(`💬 收到澄清回答: ${data.response}`, 'WebSocket');
        } else if (data.type === 'execution_confirm') {
          Logger.info(
            `✅ 收到执行确认: ${data.confirmed ? '确认' : '取消'}`,
            'WebSocket'
          );
        } else if (data.type === 'automation_task_toggle') {
          Logger.info(
            `⚡ 自动化任务切换: ${data.taskId} -> ${data.enabled ? '启用' : '禁用'}`,
            'WebSocket'
          );
        } else if (data.type === 'automation_task_create') {
          Logger.info(
            `⚡ 自动化任务创建: ${JSON.stringify(data.task)}`,
            'WebSocket'
          );
        } else if (data.type === 'automation_trigger_execute') {
          Logger.info(
            `⚡ 自动化触发执行: ${JSON.stringify(data.trigger)}`,
            'WebSocket'
          );
        } else {
          Logger.info(`📨 WebSocket收到未知类型: ${data.type}`, 'WebSocket');
        }
      } catch (error) {
        Logger.error('❌ 解析WebSocket消息失败', error as Error, 'WebSocket');
      }
    });

    ws.on('close', () => {
      Logger.info(`👋 客户端断开: ${clientIp}`, 'WebSocket');
    });

    ws.send(
      JSON.stringify({
        type: 'connected',
        data: {
          message: '💖 已连接到家百星智能助手',
          model: process.env.MODEL_NAME || 'qwen2.5:3b',
          status: 'running',
          timestamp: new Date().toISOString(),
        },
      })
    );
  });
}

async function processInputWithCore(
  input: string,
  userId: string,
  traceId: string,
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null
): Promise<void> {
  if (checkAndMarkResponse(traceId)) {
    Logger.info(`⚠️ traceId ${traceId} 已处理，跳过重复请求`, 'WebSocket');
    return;
  }

  const timeoutHandle = setTimeout(() => {
    if (ws.readyState === 1 && !checkAndMarkResponse(traceId + '_fallback')) {
      Logger.info(
        `⏰ 响应超时，发送温柔提示, traceId: ${traceId}`,
        'WebSocket'
      );
      ws.send(
        JSON.stringify({
          type: 'response',
          data: {
            response: `收到消息，正在处理中...`,
            traceId,
            intent: 'pending',
          },
        })
      );
    }
  }, 8000);

  try {
    if (!core) {
      throw new Error('核心系统未初始化');
    }

    const result: ProcessInputResult = await core.processInput(
      input,
      userId,
      traceId
    );

    clearTimeout(timeoutHandle);

    if (ws.readyState === 1) {
      Logger.info(
        `✅ 处理完成, traceId: ${result.traceId}（响应由 EventBus → eventBusSetup 统一广播）`,
        'WebSocket'
      );
    }
  } catch (error) {
    clearTimeout(timeoutHandle);
    Logger.error('❌ 处理输入失败', error as Error, 'WebSocket');
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'error',
          data: {
            message: (error as Error).message,
            traceId,
          },
        })
      );
    }
  }
}
