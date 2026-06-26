/**
 * CLI WebSocket 客户端
 *
 * 连接后端 WebSocket 服务器，接收实时事件：
 *   - 工具执行追踪（tool_start / tool_complete / tool_error）
 *   - Agent 执行状态（plan / execute / evaluate / report）
 *   - 进化事件（evolution_cycle / strategy_adjust）
 *   - 会话事件（session_switch / message_stream）
 *
 * 使得 CLI 从"请求-响应"模式升级为"实时事件驱动"模式，
 * 用户可以在终端中实时看到 Agent 的每一步执行过程。
 */

import WebSocket from 'ws';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { backendPort } from './constants';

const WS_URL = `ws://localhost:${backendPort}`;

/** WebSocket 事件类型映射 */
export interface CLIWSEventMap {
  tool_start: {
    toolName: string;
    toolId: string;
    input?: Record<string, unknown>;
    timestamp: number;
  };
  tool_complete: {
    toolName: string;
    toolId: string;
    output?: unknown;
    duration: number;
    timestamp: number;
  };
  tool_error: {
    toolName: string;
    toolId: string;
    error: string;
    timestamp: number;
  };
  agent_plan: {
    planId: string;
    steps: Array<{ description: string; tool?: string }>;
    timestamp: number;
  };
  agent_execute: {
    planId: string;
    stepIndex: number;
    status: 'running' | 'completed' | 'failed';
    timestamp: number;
  };
  agent_evaluate: {
    planId: string;
    qualityScore: number;
    feedback?: string;
    timestamp: number;
  };
  stream_start: {
    traceId: string;
    totalLength: number;
    timestamp: number;
  };
  stream_chunk: {
    traceId: string;
    chunk: string;
    offset: number;
    timestamp: number;
  };
  stream_done: {
    traceId: string;
    fullText: string;
    timestamp: number;
  };
  evolution_cycle: {
    cycleId: string;
    reason: string;
    adjustments: Array<{ type: string; target: string; change: string }>;
    timestamp: number;
  };
  integration_message: {
    platform: string;
    from?: string;
    fromName?: string;
    content: string;
  };
}

export class CLIWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectInterval = 3000;
  private isConnecting = false;
  private sessionId: string | null = null;

  /** 连接状态 */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 设置当前会话 ID
   * WebSocket 连接后发送此 ID，后端据此推送对应会话的事件
   */
  setSessionId(id: string): void {
    this.sessionId = id;
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify({ type: 'session_switch', sessionId: id }));
    }
  }

  /**
   * 连接到后端 WebSocket 服务器
   */
  connect(): void {
    if (this.isConnecting || this.connected) return;
    this.isConnecting = true;

    Logger.debug(`连接 WebSocket: ${WS_URL}`, 'CLIWS');

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        Logger.debug('WebSocket 已连接', 'CLIWS');

        // 发送会话 ID（如果已有）
        if (this.sessionId) {
          this.ws!.send(
            JSON.stringify({
              type: 'session_switch',
              sessionId: this.sessionId,
            })
          );
        }

        EventBus.emit('ws_connected', { url: WS_URL });
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString()) as {
            type: string;
            [key: string]: unknown;
          };

          // 将所有事件转发到 EventBus
          if (event.type) {
            EventBus.emit(event.type, event);
          }
        } catch (err) {
          Logger.debug('WebSocket 消息解析失败', 'CLIWS', err);
        }
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        Logger.debug('WebSocket 已断开', 'CLIWS');
        EventBus.emit('ws_disconnected' as any, {});
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        this.isConnecting = false;
        Logger.warn('WebSocket 错误', 'CLIWS', err);
        this.scheduleReconnect();
      });
    } catch (err) {
      this.isConnecting = false;
      Logger.warn('WebSocket 连接失败', 'CLIWS', err);
      this.scheduleReconnect();
    }
  }

  /**
   * 断开 WebSocket 连接
   */
  disconnect(): void {
    this.maxReconnectAttempts = 0; // 阻止重连
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 发送消息到 WebSocket 服务器
   */
  send(message: Record<string, unknown>): void {
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 自动重连调度
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.debug('WebSocket 重连次数超限，停止重连', 'CLIWS');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectInterval * this.reconnectAttempts,
      30000
    );

    Logger.debug(
      `WebSocket ${delay}ms 后尝试第 ${this.reconnectAttempts} 次重连`,
      'CLIWS'
    );

    setTimeout(() => {
      this.connect();
    }, delay);
  }
}

/** 全局单例 */
let wsClient: CLIWebSocketClient | null = null;

export function getWSClient(): CLIWebSocketClient {
  if (!wsClient) {
    wsClient = new CLIWebSocketClient();
  }
  return wsClient;
}

/**
 * 初始化 WebSocket 客户端并注册 CLI 事件显示
 * 在 REPL mainLoop 中调用
 */
export function initCLIWebSocket(): CLIWebSocketClient {
  const client = getWSClient();

  // 注册工具追踪事件 → 在终端显示
  EventBus.on('tool_start', (payload: CLIWSEventMap['tool_start']) => {
    Logger.info(`  🔧 执行工具: ${payload.toolName}`, 'CLIWS');
  });

  EventBus.on('tool_complete', (payload: CLIWSEventMap['tool_complete']) => {
    const dur = payload.duration ? ` (${payload.duration}ms)` : '';
    Logger.info(`  ✅ 工具完成: ${payload.toolName}${dur}`, 'CLIWS');
  });

  EventBus.on('tool_error', (payload: CLIWSEventMap['tool_error']) => {
    Logger.info(
      `  ❌ 工具错误: ${payload.toolName} — ${payload.error}`,
      'CLIWS'
    );
  });

  // 注册 Agent 执行状态事件
  EventBus.on('agent_plan', (payload: CLIWSEventMap['agent_plan']) => {
    Logger.info(
      `  📋 规划 ${payload.steps.length} 步: ${payload.steps[0]?.description}`,
      'CLIWS'
    );
  });

  EventBus.on('agent_execute', (payload: CLIWSEventMap['agent_execute']) => {
    const icon =
      payload.status === 'running'
        ? '⏳'
        : payload.status === 'completed'
          ? '✅'
          : '❌';
    Logger.info(
      `  ${icon} 步骤 ${payload.stepIndex}: ${payload.status}`,
      'CLIWS'
    );
  });

  EventBus.on('agent_evaluate', (payload: CLIWSEventMap['agent_evaluate']) => {
    Logger.info(
      `  🔍 评估: 质量 ${(payload.qualityScore * 100).toFixed(0)}%`,
      'CLIWS'
    );
  });

  // 注册进化事件
  EventBus.on(
    'evolution_cycle',
    (payload: CLIWSEventMap['evolution_cycle']) => {
      Logger.info(`  🧬 进化周期: ${payload.reason}`, 'CLIWS');
    }
  );

  // 注册审批请求事件 — 在 CLI 中显示确认提示
  EventBus.on(
    'approval_request' as any,
    async (request: {
      id: string;
      type: string;
      description: string;
      target: string;
      risk: string;
    }) => {
      const riskIcon =
        request.risk === 'critical'
          ? '🚨'
          : request.risk === 'high'
            ? '⚠️'
            : 'ℹ️';
      Logger.info(
        `\n  ${riskIcon} 审批请求 [${request.type}] 风险: ${request.risk}`,
        'Approval'
      );
      Logger.info(`  ${request.description}`, 'Approval');
      Logger.info(`  目标: ${request.target}`, 'Approval');
      Logger.info(
        `  输入 y 批准 / n 拒绝 / b 批量批准（10分钟内同类操作自动批准）`,
        'Approval'
      );

      // 通过 stdin 等待用户输入
      process.stdout.write('  批准? [y/N/b]: ');
      const answer = await new Promise<string>((resolve) => {
        const handler = (data: Buffer) => {
          process.stdin.removeListener('data', handler);
          resolve(data.toString().trim().toLowerCase());
        };
        process.stdin.once('data', handler);
        // 60 秒超时
        setTimeout(() => {
          process.stdin.removeListener('data', handler);
          resolve('');
        }, 60000);
      });

      const approved = answer === 'y' || answer === 'yes';
      const batchApprove = answer === 'b' || answer === 'batch';

      // 通过 HTTP 响应审批
      try {
        const { backendUrl } = require('./constants');
        await fetch(`${backendUrl}/api/approvals/${request.id}/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            approved: approved || batchApprove,
            batchApprove,
          }),
        });
        Logger.info(
          approved || batchApprove ? '  ✅ 已批准' : '  ❌ 已拒绝',
          'Approval'
        );
      } catch (err) {
        Logger.warn(
          `  审批响应发送失败: ${(err as Error).message}`,
          'Approval'
        );
      }
    }
  );

  client.connect();
  return client;
}
