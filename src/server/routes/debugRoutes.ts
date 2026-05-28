/**
 * 调试路由 - debug weights / recentHistory / simulate_task
 */

import express from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../utils/Logger';

type BroadcastFn = (data: Record<string, unknown>) => void;

export function registerDebugRoutes(
  app: express.Application,
  core: JiabaixingCore | null,
  broadcast: BroadcastFn
): void {
  app.get('/api/debug/weights', (_req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }

      const snapshot: Array<{ toolName: string; weight: number }> = [];
      const weights: Record<string, number> = {};
      res.json({ weights, snapshot, timestamp: new Date().toISOString() });
    } catch {
      res.json({ error: '无法获取权重信息' });
    }
  });

  app.get('/api/debug/recentHistory', (_req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }

      const history: Array<Record<string, unknown>> = [];
      res.json({ history, timestamp: new Date().toISOString() });
    } catch {
      res.json({ history: [], timestamp: new Date().toISOString() });
    }
  });

  app.get('/api/debug/tool-usage', (_req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }

      const toolExecutor = (
        core as unknown as {
          toolExecutor?: {
            getExecutionStats?: () => unknown;
            getToolCallLogs?: () => unknown;
            getTools?: () => unknown;
          };
        }
      ).toolExecutor;

      if (!toolExecutor) {
        res.json({ success: false, error: '工具执行器未初始化' });
        return;
      }

      const stats = toolExecutor.getExecutionStats
        ? toolExecutor.getExecutionStats()
        : {};
      const logs = toolExecutor.getToolCallLogs
        ? toolExecutor.getToolCallLogs()
        : [];
      const tools = toolExecutor.getTools ? toolExecutor.getTools() : [];

      res.json({
        success: true,
        data: {
          totalTools: Array.isArray(tools) ? tools.length : 0,
          tools: Array.isArray(tools)
            ? tools.map((t: { name: string; description: string }) => ({
                name: t.name,
                description: t.description,
              }))
            : [],
          stats: stats instanceof Map ? Object.fromEntries(stats) : stats,
          recentLogs: Array.isArray(logs) ? logs.slice(-20) : [],
          totalLogs: Array.isArray(logs) ? logs.length : 0,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/simulate_task', express.json({ limit: '1mb' }), (req, res) => {
    try {
      const { taskId = 'sim_task', prompt = '' } = req.body || {};
      const traceId = Logger.generateTraceId();

      const emitPhase = (phase: string, status: string, result?: unknown) => {
        const payload = {
          traceId,
          phase,
          status,
          result,
          timestamp: new Date().toISOString(),
          taskId,
        };
        try {
          void EventBus.emit('agent_execution_update', payload);
        } catch {
          broadcast({ type: 'agent_execution_update', data: payload });
        }
      };

      emitPhase('perceive', 'in-progress');
      setTimeout(() => emitPhase('perceive', 'completed'), 200);
      setTimeout(() => emitPhase('plan', 'in-progress'), 400);
      setTimeout(() => emitPhase('plan', 'completed'), 800);
      setTimeout(() => emitPhase('execute', 'in-progress'), 900);
      setTimeout(
        () => emitPhase('execute', 'completed', { message: '执行完成' }),
        1800
      );
      setTimeout(() => emitPhase('verify', 'in-progress'), 1850);
      setTimeout(() => emitPhase('verify', 'completed', { ok: true }), 2100);
      setTimeout(() => emitPhase('output', 'in-progress'), 2150);
      setTimeout(
        () =>
          emitPhase('output', 'completed', {
            response: `模拟结果：${String(prompt).substring(0, 200)}`,
          }),
        2600
      );
      setTimeout(() => emitPhase('learn', 'in-progress'), 2650);
      setTimeout(() => emitPhase('learn', 'completed'), 3000);

      res.json({ success: true, message: '模拟任务已触发', traceId, taskId });
    } catch (error) {
      Logger.error('❌ /api/simulate_task 触发失败', error as Error, 'Main');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
