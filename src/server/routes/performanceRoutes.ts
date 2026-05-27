/**
 * 性能监控路由 - performance snapshot / metrics / errors / llm performance
 */

import express, { Request, Response } from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

export function registerPerformanceRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.get('/api/performance/snapshot', (_req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }

      const snapshot = core.getPerformanceMonitor().getCurrentMetrics();
      res.json({ success: true, data: snapshot });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/performance/metrics', (req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 100;
      const metrics = core.getPerformanceMonitor().getMetrics(limit);
      res.json({ success: true, data: metrics });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/performance/errors', (req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const metrics = core.getPerformanceMonitor().getMetrics(limit);
      const errors = metrics.filter((m) => m.errorRate > 0);
      res.json({ success: true, data: errors });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/llm/performance', async (_req, res) => {
    try {
      const { MultiModelLLMProvider } =
        await import('../../models/MultiModelLLMProvider');
      const provider = MultiModelLLMProvider.getInstance();
      await provider.initialize();

      const models = provider.getAvailableModels();
      const healthStatus = (provider as any).modelHealthStatus || new Map();

      const modelStats = models.map((model) => {
        const health = healthStatus.get(model.id) || {
          successCount: 0,
          failureCount: 0,
          avgLatency: 0,
          lastError: null,
        };

        const totalCalls = health.successCount + health.failureCount;
        const successRate =
          totalCalls > 0 ? health.successCount / totalCalls : 0;

        let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
        if (successRate < 0.5 || health.failureCount >= 5) {
          status = 'unhealthy';
        } else if (successRate < 0.8 || health.failureCount >= 3) {
          status = 'degraded';
        }

        return {
          modelId: model.id,
          modelName: model.name,
          provider: model.id.includes('zhipu') ? '智谱AI' : '本地LLM',
          totalCalls,
          successCalls: health.successCount,
          failedCalls: health.failureCount,
          avgLatency: health.avgLatency || 0,
          totalTokens: Math.floor(totalCalls * 500),
          promptTokens: Math.floor(totalCalls * 300),
          completionTokens: Math.floor(totalCalls * 200),
          lastUsed: health.lastSuccess
            ? new Date(health.lastSuccess).toISOString()
            : '-',
          status,
        };
      });

      const totalTokens = modelStats.reduce((sum, m) => sum + m.totalTokens, 0);
      const totalCalls = modelStats.reduce((sum, m) => sum + m.totalCalls, 0);

      const response = {
        models: modelStats,
        tokenUsage: {
          totalTokens,
          promptTokens: modelStats.reduce((sum, m) => sum + m.promptTokens, 0),
          completionTokens: modelStats.reduce(
            (sum, m) => sum + m.completionTokens,
            0
          ),
          avgTokensPerCall:
            totalCalls > 0 ? Math.floor(totalTokens / totalCalls) : 0,
          tokensByModel: modelStats.map((m) => ({
            model: m.modelName,
            tokens: m.totalTokens,
          })),
          tokensByHour: [],
        },
        systemStatus: {
          circuitBreakerOpen: modelStats.some((m) => m.status === 'unhealthy'),
          lastError: null,
          uptime: process.uptime(),
        },
      };

      res.status(200).json(response);
    } catch (error) {
      Logger.error('获取LLM性能数据失败', error as Error, 'Performance');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
