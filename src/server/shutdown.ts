/**
 * 优雅关闭处理
 */

import * as http from 'http';
import * as WebSocket from 'ws';

import { JiabaixingCore } from '../core/JiabaixingCore';
import { Logger } from '../utils/Logger';
import { MCPServerManager } from '../mcp/MCPServerManager';
import { stopIpcServer } from './bootstrap';

type WSServer = WebSocket.Server;

export async function gracefulShutdown(
  signal: string,
  core: JiabaixingCore | null,
  wss: WSServer | null,
  server: http.Server
): Promise<void> {
  Logger.info(`🔄 收到 ${signal} 信号，准备优雅关闭...`, 'Main');

  if (core) {
    const scheduler = core.getScenarioScheduler?.();
    if (scheduler && typeof scheduler.stop === 'function') {
      scheduler.stop();
      Logger.info('✅ 场景感知调度器已停止', 'Main');
    }
  }

  try {
    const mcpManager = MCPServerManager.getInstance();
    mcpManager.stopAllServers();
    Logger.info('✅ MCP服务器已停止', 'Main');
  } catch {
    // MCP 清理失败不影响关闭流程
  }

  // 关闭 IPC 服务器
  try {
    await stopIpcServer();
  } catch {
    // IPC 关闭失败不影响主流程
  }

  if (wss) {
    wss.clients.forEach((client) => {
      (client as WebSocket.WebSocket).close(1001, '系统维护中');
    });
    wss.close();
  }

  server.close(() => {
    Logger.info('✅ 服务已安全关闭', 'Main');
    process.exit(0);
  });

  setTimeout(() => {
    Logger.info('⚠️ 强制退出', 'Main');
    process.exit(1);
  }, 10000);
}
