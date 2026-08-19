/**
 * 安全路由 - security logs / events / report / validate / audit
 */

import express from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

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

export function registerSecurityRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  const securityAuditor = {
    queryLogs: (filter: {
      level?: string;
      category?: string;
      limit?: number;
    }) => {
      return { logs: [], total: 0, filter };
    },
    queryEvents: (filter: {
      eventType?: string;
      severity?: string;
      limit?: number;
    }) => {
      return { events: [], total: 0, filter };
    },
    generateReport: (timeWindowHours: number) => {
      return {
        timeWindow: `${timeWindowHours}h`,
        summary: { totalEvents: 0, criticalCount: 0, highCount: 0 },
        recommendations: [],
      };
    },
  };

  app.get('/api/security/logs', (req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }
      const level = req.query.level as
        | 'info'
        | 'warning'
        | 'error'
        | 'critical'
        | undefined;
      const category = req.query.category as
        | 'authentication'
        | 'authorization'
        | 'data_access'
        | 'system'
        | 'security_event'
        | 'user_action'
        | undefined;
      const limit = parseInt(req.query.limit as string) || 100;
      const result = securityAuditor.queryLogs({ level, category, limit });
      res.json({ success: true, data: result.logs });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/security/events', (req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }

      const eventType = req.query.eventType as
        | 'login_failed'
        | 'access_denied'
        | 'suspicious_activity'
        | 'data_breach_attempt'
        | 'rate_limit_exceeded'
        | 'malicious_input'
        | undefined;
      const severity = req.query.severity as
        | 'low'
        | 'medium'
        | 'high'
        | 'critical'
        | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const events = securityAuditor.queryEvents({
        eventType,
        severity,
        limit,
      });
      res.json({ success: true, data: events });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/security/report', (req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心系统未初始化' });
        return;
      }

      const timeWindowHours =
        parseInt(req.query.timeWindowHours as string) || 24;
      const report = securityAuditor.generateReport(timeWindowHours);
      res.json({ success: true, data: report });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/security/validate',
    express.json({ limit: '10mb' }),
    async (req, res) => {
      try {
        const { input } = req.body as { input?: string };

        if (!input) {
          return res
            .status(400)
            .json({ success: false, error: '缺少input参数' });
        }

        const SecurityGuard = (await import('../../security/SecurityGuard'))
          .SecurityGuard;
        const securityGuard = new SecurityGuard();

        const validationResult = securityGuard.validateInput(input);

        res.json({
          success: true,
          data: {
            valid: validationResult.valid,
            errors: validationResult.errors,
            warnings: validationResult.warnings,
            riskLevel: validationResult.valid ? 'low' : 'high',
          },
        });
      } catch (error) {
        Logger.error('❌ 安全验证失败', error as Error, 'SecurityAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.get('/api/security/audit', async (req, res) => {
    try {
      const { limit = 20, type } = req.query as {
        limit?: string;
        type?: string;
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

      const auditResult = (await traeIntegrator.executeOptimizedSkill?.(
        'SecurityAuditSkill',
        {
          target: 'src',
          auditType: type || 'comprehensive',
          limit: parseInt(limit as string) || 20,
        }
      )) as { success?: boolean; output?: unknown };

      res.json({
        success: auditResult.success,
        data: auditResult.output,
      });
    } catch (error) {
      Logger.error('❌ 获取安全审计日志失败', error as Error, 'SecurityAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/security/apikeys', async (_req, res) => {
    try {
      const { ApiKeyManager } = await import('../../security/ApiKeyManager');
      const manager = ApiKeyManager.getInstance();
      const keys = manager.listKeys();
      res.json({
        success: true,
        data: keys.map((k) => ({
          id: k.id,
          name: k.name,
          provider: k.provider,
          status: k.status,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt,
          lastUsedAt: k.lastUsedAt,
          usageCount: k.usageCount,
        })),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/security/apikeys/rotate', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { name, newKey } = req.body as { name?: string; newKey?: string };
      if (!name) {
        return res.status(400).json({ success: false, error: '缺少 name 参数' });
      }
      const { ApiKeyManager } = await import('../../security/ApiKeyManager');
      const manager = ApiKeyManager.getInstance();
      const entry = await manager.rotateKey(name, newKey);
      res.json({ success: true, data: { id: entry.id, name: entry.name, status: entry.status } });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/security/apikeys/revoke', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name) {
        return res.status(400).json({ success: false, error: '缺少 name 参数' });
      }
      const { ApiKeyManager } = await import('../../security/ApiKeyManager');
      const manager = ApiKeyManager.getInstance();
      const revoked = manager.revokeKey(name);
      res.json({ success: true, data: { name, revoked } });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
