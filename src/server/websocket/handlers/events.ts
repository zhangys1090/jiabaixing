/**
 * WebSocket 事件处理
 * 处理 clarification_response、execution_confirm 等事件
 */

import { WebSocket } from 'ws';
import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';

/**
 * 处理澄清响应
 */
export function handleClarificationResponse(data: {
  response: string;
  traceId?: string;
  timestamp?: string;
}): void {
  Logger.info(`💬 收到澄清回答: ${data.response}`, 'WsHandler');
  EventBus.emit('clarification_response', {
    traceId: data.traceId || 'unknown',
    response: data.response,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}

/**
 * 处理执行确认
 */
export function handleExecutionConfirm(data: {
  confirmed: boolean;
  traceId?: string;
  timestamp?: string;
}): void {
  Logger.info(
    `✅ 收到执行确认: ${data.confirmed ? '确认' : '取消'}`,
    'WsHandler'
  );
  EventBus.emit('execution_confirm', {
    traceId: data.traceId || 'unknown',
    confirmed: data.confirmed,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}

/**
 * 处理 WebSocket 连接
 */
export function handleConnection(clientIp: string): void {
  Logger.info(`💖 新客户端连接: ${clientIp}`, 'WsHandler');
}

/**
 * 处理 WebSocket 断开
 */
export function handleDisconnect(
  clientIp: string,
  cleanupTasksFn: (clientIp: string) => void
): void {
  Logger.info(`👋 客户端断开: ${clientIp}`, 'WsHandler');
  cleanupTasksFn(clientIp);
}

/**
 * 发送连接成功消息
 */
export function sendConnectedMessage(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'connected',
        data: {
          message: '💖 已连接到家百星智能助手',
          model: process.env.LLM_MODEL || 'deepseek-v4-flash',
          status: 'running',
          timestamp: new Date().toISOString(),
        },
      })
    );
  }
}

/**
 * 发送错误消息
 */
export function sendError(
  ws: WebSocket,
  message: string,
  traceId?: string
): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'error',
        data: { message, traceId },
      })
    );
  }
}

/**
 * 处理未知消息类型
 */
export function handleUnknownMessage(data: { type: string }): void {
  Logger.info(`📨 WebSocket收到未知类型: ${data.type}`, 'WsHandler');
}
