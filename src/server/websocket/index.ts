/**
 * WebSocket 模块化入口
 *
 * 模块结构：
 * - WsAuth.ts       # 认证逻辑
 * - WsRateLimit.ts  # 限流+熔断
 * - WsDedup.ts      # 去重缓存
 * - WsTaskManager.ts # 任务管理
 * - WsRetry.ts      # 重试逻辑
 * - WsProcessor.ts  # 输入处理核心（重试+熔断+超时+错误友好化）
 * - handlers/       # 消息处理器
 *
 * 使用方法：
 * import { setupWebSocket } from './websocket';
 * setupWebSocket(wss, core);
 */

import * as WebSocket from 'ws';
import { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';
import { SystemInitState } from '../SystemInitState';

// 模块导入
import { WsAuthenticator } from './WsAuth';
import { WsTaskManager } from './WsTaskManager';

// 处理器导入
import {
  extractUserId,
  handleAutomationTaskCreate,
  handleAutomationTaskToggle,
  handleAutomationTriggerExecute,
  handleCancelTask,
  handleClarificationResponse,
  handleConnection,
  handleDisconnect,
  handleExecutionConfirm,
  handleGetStatus,
  handleUnknownMessage,
  handleUserInput,
  sendConnectedMessage,
} from './handlers';

type WSServer = WebSocket.Server;

// ==================== 单例实例 ====================

const taskManager = new WsTaskManager();
taskManager.startCleanup();

const authenticator = new WsAuthenticator();

const clientConnectTimes = new Map<string, number[]>();
const CONNECT_RATE_LIMIT_MS = 2000;
const MAX_CONNECTS_PER_MINUTE = 30;

function checkConnectRate(clientIp: string): boolean {
  const now = Date.now();
  const times = clientConnectTimes.get(clientIp) || [];
  const recent = times.filter((t) => now - t < 60_000);
  if (recent.length >= MAX_CONNECTS_PER_MINUTE) {
    return false;
  }
  const lastConnect = recent.length > 0 ? recent[recent.length - 1] : 0;
  if (now - lastConnect < CONNECT_RATE_LIMIT_MS) {
    return false;
  }
  recent.push(now);
  clientConnectTimes.set(clientIp, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of clientConnectTimes) {
    const recent = times.filter((t) => now - t < 60_000);
    if (recent.length === 0) {
      clientConnectTimes.delete(ip);
    } else {
      clientConnectTimes.set(ip, recent);
    }
  }
}, 60_000).unref();

// ==================== 导出 ====================

export type { ProcessInputResult } from '../../core/JiabaixingCore';
export { processInputOnce, processInputWithRetry } from './WsProcessor';

// ==================== 组装入口 ====================

/**
 * 向单个 WebSocket 客户端发送当前系统初始化状态
 */
function sendInitStatus(ws: WebSocket.WebSocket): void {
  try {
    const initState = SystemInitState.getInstance();
    ws.send(
      JSON.stringify({
        type: 'system_init_progress',
        data: initState.getSnapshot(),
      })
    );
  } catch (err) {
    Logger.warn('推送初始化状态失败', 'WsHandler', {
      error: (err as Error).message,
    });
  }
}

/**
 * 检查核心系统是否就绪；未就绪时向客户端推送 system_not_ready 消息
 * @returns true 表示已就绪，可以继续处理
 */
function ensureCoreReady(
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null
): boolean {
  if (core && SystemInitState.getInstance().isReady()) return true;
  try {
    ws.send(
      JSON.stringify({
        type: 'system_not_ready',
        data: SystemInitState.getInstance().getSnapshot(),
      })
    );
  } catch (err) {
    Logger.warn('无法推送 system_not_ready', 'WsHandler', {
      error: (err as Error).message,
    });
  }
  return false;
}

/**
 * 设置 WebSocket 服务器
 *
 * 统一入口：前端、CLI、网关都通过此通道通信。
 * 消息格式中可携带 source 字段：'frontend' | 'cli' | 'gateway'
 * 未就绪时对 user_input/command 返回 system_not_ready，不会阻塞核心。
 */
export function setupWebSocket(
  wss: WSServer | null,
  core: JiabaixingCore | null
): void {
  wss?.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || 'unknown';

    if (!checkConnectRate(clientIp)) {
      Logger.warn(`⚠️ WebSocket连接频率过高，拒绝: ${clientIp}`, 'WsHandler');
      ws.close(1013, '连接频率过高');
      return;
    }

    ws.on('error', (err) => {
      const errMsg = (err as Error).message || '';
      if (errMsg.includes('Invalid WebSocket frame')) {
        Logger.warn(
          `⚠️ WebSocket帧错误(静默关闭): ${errMsg.substring(0, 100)}`,
          'WsHandler'
        );
      } else {
        Logger.warn(`⚠️ WebSocket客户端错误: ${errMsg}`, 'WsHandler');
      }
      try {
        ws.close(1011, '内部错误');
      } catch {
        /* 连接已断开 */
      }
    });

    // 连接数限制
    const MAX_CONNECTIONS = 100;
    if (wss?.clients && wss.clients.size >= MAX_CONNECTIONS) {
      Logger.warn(
        `⚠️ WebSocket连接数已达上限 ${MAX_CONNECTIONS}，拒绝新连接`,
        'WsHandler'
      );
      ws.close(1013, '连接数已达上限');
      return;
    }

    // 生产环境验证 WebSocket 认证令牌
    if (process.env.NODE_ENV === 'production') {
      const token = authenticator.extractTokenFromUrl(req.url || '/');
      const authResult = authenticator.verifyToken(token);

      if (!authResult.valid) {
        Logger.warn(`⚠️ WebSocket认证失败: ${authResult.error}`, 'WsHandler');
        ws.close(4001, authResult.error);
        return;
      }
    }

    handleConnection(clientIp);

    // 连接建立后，立即推送当前初始化进度
    sendInitStatus(ws);

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString()) as Record<string, unknown>;
        const msgType = data.type as string;
        const traceId = (data.traceId as string) || Logger.generateTraceId();

        switch (msgType) {
          case 'user_input':
          case 'command': {
            // 核心系统未就绪时，返回 system_not_ready 消息，不调用 handleUserInput
            if (!ensureCoreReady(ws, core)) return;
            const userId = extractUserId(data);
            void handleUserInput(
              data,
              userId,
              clientIp,
              ws,
              core,
              taskManager,
              traceId
            );
            break;
          }
          case 'cancel_task':
            handleCancelTask(data.traceId as string, ws, taskManager);
            break;
          case 'get_status':
            handleGetStatus(ws, wss?.clients.size || 0);
            // 额外推送一次初始化进度快照，前端可合并展示
            sendInitStatus(ws);
            break;
          case 'get_init_status':
            sendInitStatus(ws);
            break;
          case 'clarification_response':
            handleClarificationResponse(data as { response: string });
            break;
          case 'execution_confirm':
            handleExecutionConfirm(data as { confirmed: boolean });
            break;
          case 'automation_task_toggle':
            if (!ensureCoreReady(ws, core)) return;
            handleAutomationTaskToggle(
              data as { taskId: string; enabled: boolean },
              ws,
              core
            );
            break;
          case 'automation_task_create':
            if (!ensureCoreReady(ws, core)) return;
            handleAutomationTaskCreate(
              data as { task: Record<string, unknown> },
              core
            );
            break;
          case 'automation_trigger_execute':
            if (!ensureCoreReady(ws, core)) return;
            handleAutomationTriggerExecute(
              data as { trigger: Record<string, unknown> }
            );
            break;
          default:
            handleUnknownMessage(data as { type: string });
        }
      } catch (error) {
        Logger.error('❌ 解析WebSocket消息失败', error as Error, 'WsHandler');
      }
    });

    ws.on('close', () => {
      handleDisconnect(clientIp, (ip) => taskManager.cleanupByClientIp(ip));
    });

    sendConnectedMessage(ws);
  });
}
