/**
 * WebSocket 状态查询处理
 */

import WebSocket from 'ws';

/**
 * 处理状态查询
 */
export function handleGetStatus(
  ws: WebSocket.WebSocket,
  clientCount: number
): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'status',
        data: {
          status: 'running',
          model: process.env.MODEL_NAME || 'qwen2.5:3b',
          uptime: process.uptime(),
          clients: clientCount,
        },
      })
    );
  }
}
