import express from 'express';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';
import { Logger } from '../../utils/Logger';

export function registerPlanRoutes(app: express.Application): void {
  app.post('/api/plan', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', '/v1/plan', req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('任务规划失败', error as Error, 'PlanRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/plan/execute', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', '/v1/plan/execute', req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('执行计划失败', error as Error, 'PlanRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/plan/evaluate', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', '/v1/plan/evaluate', req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('评估计划失败', error as Error, 'PlanRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/plan/reflect', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', '/v1/plan/reflect', req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('反思计划失败', error as Error, 'PlanRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
