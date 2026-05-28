/**
 * TRAE优化系统路由 - health / performance / mcp status / skills status / execute / security audit / testing generate
 */

import express from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';

interface TRAEIntegrator {
  getSystemHealth?: () => unknown;
  getPerformanceMetrics?: () => unknown;
  getMCPStatus?: () => unknown;
  getSkillStatus?: () => unknown;
  executeOptimizedSkill?: (
    skillName: string,
    params: unknown
  ) => Promise<unknown>;
}

export function registerTraeRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.get('/api/trae/health', (_req, res) => {
    try {
      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const traeIntegrator =
        core.getTRAEOptimizationIntegrator() as TRAEIntegrator;
      if (!traeIntegrator) {
        return res
          .status(503)
          .json({ success: false, error: 'TRAE优化系统未启动' });
      }

      const healthStatus = traeIntegrator.getSystemHealth?.();
      res.json({ success: true, data: healthStatus });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/trae/performance', (_req, res) => {
    try {
      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const traeIntegrator =
        core.getTRAEOptimizationIntegrator() as TRAEIntegrator;
      if (!traeIntegrator) {
        return res
          .status(503)
          .json({ success: false, error: 'TRAE优化系统未启动' });
      }

      const metrics = traeIntegrator.getPerformanceMetrics?.();
      res.json({ success: true, data: metrics });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/trae/mcp/status', (_req, res) => {
    try {
      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const traeIntegrator =
        core.getTRAEOptimizationIntegrator() as TRAEIntegrator;
      if (!traeIntegrator) {
        return res
          .status(503)
          .json({ success: false, error: 'TRAE优化系统未启动' });
      }

      const mcpStatus = traeIntegrator.getMCPStatus?.();
      res.json({ success: true, data: mcpStatus });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/trae/skills/status', (_req, res) => {
    try {
      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const traeIntegrator =
        core.getTRAEOptimizationIntegrator() as TRAEIntegrator;
      if (!traeIntegrator) {
        return res
          .status(503)
          .json({ success: false, error: 'TRAE优化系统未启动' });
      }

      const skillStatus = traeIntegrator.getSkillStatus?.();
      res.json({ success: true, data: skillStatus });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/trae/skills/execute',
    express.json({ limit: '10mb' }),
    async (req, res) => {
      try {
        const { skillName, params } = req.body as {
          skillName?: string;
          params?: Record<string, unknown>;
        };

        if (!skillName) {
          return res
            .status(400)
            .json({ success: false, error: '缺少 skillName' });
        }

        if (!core) {
          return res
            .status(503)
            .json({ success: false, error: '核心系统未初始化' });
        }

        const traeIntegrator =
          core.getTRAEOptimizationIntegrator() as TRAEIntegrator;
        if (!traeIntegrator) {
          return res
            .status(503)
            .json({ success: false, error: 'TRAE优化系统未启动' });
        }

        const result = (await traeIntegrator.executeOptimizedSkill?.(
          skillName,
          params || {}
        )) as { success?: boolean; data?: unknown; error?: string };

        res.json({
          success: result.success,
          data: result.data,
          error: result.error,
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
    '/api/trae/security/audit',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { target, auditType } = req.body as {
          target?: string;
          auditType?: string;
        };

        if (!core) {
          return res
            .status(503)
            .json({ success: false, error: '核心系统未初始化' });
        }

        const traeIntegrator =
          core.getTRAEOptimizationIntegrator() as TRAEIntegrator;
        if (!traeIntegrator) {
          return res
            .status(503)
            .json({ success: false, error: 'TRAE优化系统未启动' });
        }

        const result = (await traeIntegrator.executeOptimizedSkill?.(
          'SecurityAuditSkill',
          {
            target: target || './src',
            auditType: auditType || 'all',
          }
        )) as { success?: boolean; data?: unknown; error?: string };

        res.json({
          success: result.success,
          data: result.data,
          error: result.error,
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
    '/api/trae/testing/generate',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { targetFile, testType, framework } = req.body as {
          targetFile?: string;
          testType?: string;
          framework?: string;
        };

        if (!targetFile) {
          return res
            .status(400)
            .json({ success: false, error: '缺少 targetFile' });
        }

        if (!core) {
          return res
            .status(503)
            .json({ success: false, error: '核心系统未初始化' });
        }

        const traeIntegrator =
          core.getTRAEOptimizationIntegrator() as TRAEIntegrator;
        if (!traeIntegrator) {
          return res
            .status(503)
            .json({ success: false, error: 'TRAE优化系统未启动' });
        }

        const result = (await traeIntegrator.executeOptimizedSkill?.(
          'test_generator',
          {
            targetFile,
            testType: testType || 'unit',
            framework: framework || 'jest',
          }
        )) as { success?: boolean; data?: unknown; error?: string };

        res.json({
          success: result.success,
          data: result.data,
          error: result.error,
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
