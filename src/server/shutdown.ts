/**
 * 优雅关闭处理
 */

import * as http from 'http';
import * as WebSocket from 'ws';

import { JiabaixingCore } from '../core/JiabaixingCore';
import { getActivePythonBridge } from '../ide/bridgeRegistry';
import { Logger } from '../utils/Logger';
import { stopIpcServer } from './bootstrap';

type WSServer = WebSocket.Server;

let isShuttingDown = false;

export async function gracefulShutdown(
  signal: string,
  core: JiabaixingCore | null,
  wss: WSServer | null,
  server: http.Server
): Promise<void> {
  if (isShuttingDown) {
    Logger.info(`已在关闭流程中，忽略重复 ${signal} 信号`, 'Main');
    return;
  }
  isShuttingDown = true;

  Logger.info(`🔄 收到 ${signal} 信号，准备优雅关闭...`, 'Main');

  if (core) {
    const scheduler = core.getScenarioScheduler?.();
    if (scheduler && typeof scheduler.stop === 'function') {
      scheduler.stop();
      Logger.info('✅ 场景感知调度器已停止', 'Main');
    }
  }

  try {
    const bridge = getActivePythonBridge();
    if (bridge) {
      await bridge.stopAllMcpServers();
      Logger.info('✅ MCP服务器已停止', 'Main');
    } else {
      Logger.info('⏭️ MCP服务器跳过停止（Python 后端未连接）', 'Main');
    }
  } catch (err) {
    Logger.warn(`MCP 服务器清理失败（不影响关闭）: ${err}`, 'Main');
  }

  // 关闭 IPC 服务器
  try {
    await stopIpcServer();
  } catch (err) {
    Logger.warn(`IPC 关闭失败（不影响主流程）: ${err}`, 'Main');
  }

  if (wss) {
    wss.clients.forEach((client) => {
      (client as WebSocket.WebSocket).close(1001, '系统维护中');
    });
    wss.close();
  }

  // 尝试使用 closeAllConnections (Node.js 18.2+) 确保残留连接被关闭
  if (typeof (server as any).closeAllConnections === 'function') {
    (server as any).closeAllConnections();
  }

  server.close(() => {
    Logger.info('✅ 服务已安全关闭', 'Main');
    process.exit(0);
  });

  setTimeout(() => {
    Logger.info('⚠️ 优雅关闭超时，强制退出', 'Main');
    // P1-6 修复: 优雅关闭超时仍属正常退出（非异常），使用 exit code 0
    // 避免监控系统（systemd/K8s/PM2）误判为异常崩溃而触发不必要的重启告警
    process.exit(0);
  }, 10000);
}
