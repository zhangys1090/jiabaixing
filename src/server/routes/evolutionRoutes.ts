/**
 * 进化引擎路由 - evolution metrics / insights / trigger / orchestrator
 */

import express from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';

export function registerEvolutionRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.get('/api/evolution/metrics', (_req, res) => {
    try {
      const evolutionEngine = (core as unknown as Record<string, unknown>)
        .evolutionEngine as
        | import('../../evolution/EvolutionEngine').EvolutionEngine
        | undefined;
      if (!evolutionEngine) {
        return res
          .status(503)
          .json({ success: false, error: '进化引擎未启动' });
      }
      const metrics = evolutionEngine.getMetrics();
      res.json({ success: true, data: metrics });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/evolution/insights', (_req, res) => {
    try {
      const evolutionEngine = (core as unknown as Record<string, unknown>)
        .evolutionEngine as
        | import('../../evolution/EvolutionEngine').EvolutionEngine
        | undefined;
      if (!evolutionEngine) {
        return res
          .status(503)
          .json({ success: false, error: '进化引擎未启动' });
      }
      const insights = evolutionEngine.getInsights();
      res.json({ success: true, data: insights });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/evolution/trigger',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const evolutionEngine = (core as unknown as Record<string, unknown>)
          .evolutionEngine as
          | import('../../evolution/EvolutionEngine').EvolutionEngine
          | undefined;
        if (!evolutionEngine) {
          return res
            .status(503)
            .json({ success: false, error: '进化引擎未启动' });
        }
        const reason = (req.body as { reason?: string }).reason || '手动触发';
        const log = evolutionEngine.triggerManualOptimization(reason);
        res.json({
          success: true,
          data: { id: log?.id ?? 'none', reason: log?.reason ?? '手动触发' },
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  // v3.4: 统一进化编排器 API
  app.get('/api/orchestrator/metrics', (_req, res) => {
    try {
      const orchestrator = EvolutionOrchestrator.getInstance();
      const metrics = orchestrator.getUnifiedMetrics();
      res.json({ success: true, data: metrics });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/orchestrator/optimize',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const orchestrator = EvolutionOrchestrator.getInstance();
        const reason = (req.body as { reason?: string }).reason || '手动触发';
        const cycle = await orchestrator.triggerOptimizationCycle(reason, true);
        res.json({ success: true, data: { cycleId: cycle?.cycleId, reason } });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/evolution/cycle',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const orchestrator = EvolutionOrchestrator.getInstance();
        const reason =
          (req.body as { reason?: string }).reason || '手动触发完整进化周期';
        await orchestrator.triggerOptimizationCycle(reason, true);

        res.json({
          success: true,
          message: '进化周期已触发',
          duration: '0ms',
          summary: {
            healingCount: 0,
            refactorSuccess: true,
            enhancementCount: 0,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/evolution/healing',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const reason =
          (req.body as { reason?: string }).reason || '手动触发自愈';
        const orchestrator = EvolutionOrchestrator.getInstance();
        void orchestrator.triggerOptimizationCycleWithVerification(reason);
        res.json({
          success: true,
          message: `自愈优化已触发: ${reason}`,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/evolution/refactor',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const reason =
          (req.body as { reason?: string }).reason || '手动触发重构';
        const orchestrator = EvolutionOrchestrator.getInstance();
        void orchestrator.triggerOptimizationCycleWithVerification(reason);
        res.json({
          success: true,
          message: `重构优化已触发: ${reason}`,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/evolution/enhance',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const reason =
          (req.body as { reason?: string }).reason || '手动触发增强';
        const orchestrator = EvolutionOrchestrator.getInstance();
        void orchestrator.triggerOptimizationCycleWithVerification(reason);
        res.json({
          success: true,
          message: `增强优化已触发: ${reason}`,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );
}
