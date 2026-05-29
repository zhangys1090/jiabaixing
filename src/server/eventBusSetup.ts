/**
 * EventBus 事件监听注册
 * 将 EventBus 事件桥接到 WebSocket 广播
 */

import * as WebSocket from 'ws';

import { JiabaixingCore } from '../core/JiabaixingCore';
import { EventBus } from '../shared/EventBus';
import type { EventName } from '../shared/EventBus';
import { Logger } from '../utils/Logger';

type WSServer = WebSocket.Server;
type BroadcastFn = (data: Record<string, unknown>) => void;

export function setupEventBus(
  wss: WSServer | null,
  core: JiabaixingCore | null
): BroadcastFn {
  const broadcast: BroadcastFn = (data: Record<string, unknown>): void => {
    if (!wss) return;
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if ((client as WebSocket.WebSocket).readyState === 1) {
        (client as WebSocket.WebSocket).send(message);
      }
    });
  };

  const registeredEvents = new Set<string>();

  const registerOnce = (
    event: string,
    handler: (...args: unknown[]) => void
  ) => {
    if (registeredEvents.has(event)) return;
    registeredEvents.add(event);
    EventBus.on(event as EventName, handler as (...args: unknown[]) => void);
  };

  registerOnce('weight_update', (data: unknown) => {
    const payload = data as { weights?: Record<string, number> };
    broadcast({
      type: 'weight_update',
      data: { weights: payload.weights || {} },
    });
  });

  registerOnce('agent_execution_update', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      phase?: string;
      status?: string;
      result?: unknown;
      timestamp?: string;
    };
    broadcast({
      type: 'agent_execution_update',
      data: {
        traceId: payload.traceId || 'unknown',
        phase: payload.phase || 'unknown',
        status: payload.status || 'unknown',
        result: payload.result,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('proactive_interaction', async (data: unknown) => {
    const payload = data as {
      reason: string;
      context?: string;
      scene?: string;
      isEmotionBased?: boolean;
      priority?: string;
    };

    Logger.info(
      `🔔 收到主动交互信号: 原因=${payload.reason}, 场景=${payload.scene}, 优先级=${payload.priority}`,
      'Main'
    );

    try {
      if (!core) {
        Logger.warn('核心系统未初始化，无法生成主动消息', 'Main');
        return;
      }

      const message = await core.generateProactiveMessage({
        reason: payload.reason || 'scheduled',
        context: payload.context || '',
        scene: payload.scene || '休闲',
        isEmotionBased: payload.isEmotionBased || false,
      });

      if (message) {
        broadcast({
          type: 'proactive_message',
          data: {
            message,
            reason: payload.reason,
            scene: payload.scene,
            timestamp: Date.now(),
          },
        });
        Logger.info(
          `📤 主动消息已推送: "${message.substring(0, 50)}..."`,
          'Main'
        );
      }
    } catch (error) {
      Logger.warn(`⚠️ 生成主动消息失败: ${(error as Error).message}`, 'Main');
    }
  });

  registerOnce('weight_changed', (data: unknown) => {
    const payload = data as {
      toolId?: string;
      oldWeight?: number;
      newWeight?: number;
      reason?: string;
      timestamp?: number;
    };
    broadcast({
      type: 'weight_update',
      data: {
        toolId: payload.toolId || '',
        oldWeight: payload.oldWeight,
        newWeight: payload.newWeight,
        reason: payload.reason || '',
        timestamp: payload.timestamp || Date.now(),
        updateType: 'single',
      },
    });
  });

  registerOnce('user_correction', (data: unknown) => {
    broadcast({ type: 'user_correction', data });
  });

  registerOnce('perception_update', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      modality?: string;
      status?: string;
      progress?: number;
      result?: unknown;
      confidence?: number;
      error?: string;
      timestamp?: string;
    };
    broadcast({
      type: 'perception_update',
      data: {
        traceId: payload.traceId || 'unknown',
        modality: payload.modality || 'text',
        status: payload.status || 'unknown',
        progress: payload.progress,
        result: payload.result,
        confidence: payload.confidence,
        error: payload.error,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('brain_stage_update', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      stage?: string;
      status?: string;
      duration?: number;
      result?: unknown;
      timestamp?: string;
    };
    broadcast({
      type: 'brain_stage_update',
      data: {
        traceId: payload.traceId || 'unknown',
        stage: payload.stage || 'unknown',
        status: payload.status || 'unknown',
        duration: payload.duration,
        result: payload.result,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('skill_execution_update', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      skillName?: string;
      step?: string;
      attempt?: number;
      maxRetries?: number;
      duration?: number;
      error?: string;
      timestamp?: string;
    };
    broadcast({
      type: 'skill_execution_update',
      data: {
        traceId: payload.traceId || 'unknown',
        skillName: payload.skillName || 'unknown',
        step: payload.step || 'started',
        attempt: payload.attempt,
        maxRetries: payload.maxRetries,
        duration: payload.duration,
        error: payload.error,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('evolution_event', (data: unknown) => {
    const payload = data as {
      type?: string;
      traceId?: string;
      score?: number;
      description?: string;
      metrics?: Record<string, number>;
      timestamp?: string;
    };
    broadcast({
      type: 'evolution_event',
      data: {
        type: payload.type || 'quality_assessed',
        traceId: payload.traceId,
        score: payload.score,
        description: payload.description || '',
        metrics: payload.metrics,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('clarification_request', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      question?: string;
      options?: string[];
      context?: string;
      timestamp?: string;
    };
    broadcast({
      type: 'clarification_request',
      data: {
        traceId: payload.traceId || 'unknown',
        question: payload.question || '',
        options: payload.options || [],
        context: payload.context || '',
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('execution_preview', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      summary?: string;
      changes?: unknown[];
      estimatedTime?: number;
      timestamp?: string;
    };
    broadcast({
      type: 'execution_preview',
      data: {
        traceId: payload.traceId || 'unknown',
        summary: payload.summary || '',
        changes: payload.changes || [],
        estimatedTime: payload.estimatedTime,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('file_modified', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      filePath?: string;
      changeType?: string;
      edits?: unknown[];
      timestamp?: string;
    };
    broadcast({
      type: 'file_modified',
      data: {
        traceId: payload.traceId || 'unknown',
        filePath: payload.filePath || '',
        changeType: payload.changeType || 'modified',
        edits: payload.edits,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('file_rollback', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      filePath?: string;
      success?: boolean;
      timestamp?: string;
    };
    broadcast({
      type: 'file_rollback',
      data: {
        traceId: payload.traceId || 'unknown',
        filePath: payload.filePath || '',
        success: payload.success ?? true,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('multi_file_modified', (data: unknown) => {
    const payload = data as {
      traceId?: string;
      files?: Array<{ path: string; changeType: string }>;
      timestamp?: string;
    };
    broadcast({
      type: 'multi_file_modified',
      data: {
        traceId: payload.traceId || 'unknown',
        files: payload.files || [],
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('tool_trace', (data: unknown) => {
    const payload = data as {
      timestamp?: string;
      traceId?: string;
      toolCallId?: string;
      toolName?: string;
      status?: string;
      duration?: number;
      success?: boolean | null;
      errorMessage?: string | null;
    };
    broadcast({
      type: 'tool_trace',
      data: {
        timestamp: payload.timestamp || new Date().toISOString(),
        traceId: payload.traceId || 'unknown',
        toolCallId: payload.toolCallId || '',
        toolName: payload.toolName || '',
        status: payload.status || 'started',
        duration: payload.duration || 0,
        success: payload.success ?? null,
        errorMessage: payload.errorMessage ?? null,
      },
    });
  });

  registerOnce('response_ready', (data: unknown) => {
    const payload = data as {
      response?: string;
      traceId?: string;
      success?: boolean;
    };
    Logger.info(
      `📡 EventBus广播 response_ready: traceId=${payload.traceId}, success=${payload.success}, 响应长度=${payload.response?.length || 0}`,
      'EventBus'
    );
    broadcast({
      type: 'response_ready',
      data: {
        response: payload.response || '',
        traceId: payload.traceId || '',
      },
    });
  });

  registerOnce('proactive_message', (data: unknown) => {
    const payload = data as { message?: string; reason?: string };
    broadcast({
      type: 'proactive_message',
      data: {
        message: payload.message || payload.reason || '',
        timestamp: new Date().toISOString(),
      },
    });
  });

  registerOnce('environment_update', (data: unknown) => {
    const payload = data as {
      timestamp?: string;
      activeEnv?: string;
      foregroundWindow?: { title: string; process: string };
    };
    broadcast({
      type: 'environment_update',
      data: {
        timestamp: payload.timestamp || new Date().toISOString(),
        activeEnv: payload.activeEnv || 'unknown',
        foregroundWindow: payload.foregroundWindow || null,
      },
    });
  });

  registerOnce('project_change', (data: unknown) => {
    const payload = data as {
      type: string;
      repo: string;
      detail: string;
      timestamp: string;
    };
    broadcast({
      type: 'project_change',
      data: {
        type: payload.type,
        repo: payload.repo,
        detail: payload.detail,
        timestamp: payload.timestamp || new Date().toISOString(),
      },
    });
  });

  registerOnce('git_status', (data: unknown) => {
    const payload = data as {
      timestamp: string;
      repos: Array<Record<string, unknown>>;
    };
    broadcast({
      type: 'git_status',
      data: {
        timestamp: payload.timestamp || new Date().toISOString(),
        repos: payload.repos || [],
      },
    });
  });

  Logger.on('log', (entry) => {
    if (entry.level === 'error' || entry.level === 'fatal') {
      broadcast({
        type: 'server_log',
        data: entry,
      });
    }
  });

  Logger.info(
    `✅ EventBus 监听器已注册（防重复机制已启用，共 ${registeredEvents.size} 个事件）`,
    'EventBus'
  );

  return broadcast;
}
