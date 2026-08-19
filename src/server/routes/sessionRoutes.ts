import express from 'express';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';
import { Logger } from '../../utils/Logger';

export function registerSessionRoutes(app: express.Application): void {
  app.post('/api/sessions', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', '/v1/sessions', req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('创建会话失败', error as Error, 'SessionRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('GET', `/v1/sessions/${req.params.id}`);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('获取会话失败', error as Error, 'SessionRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('DELETE', `/v1/sessions/${req.params.id}`);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('删除会话失败', error as Error, 'SessionRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/sessions/:id/checkpoint', express.json(), async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', `/v1/sessions/${req.params.id}/checkpoint`, req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('创建检查点失败', error as Error, 'SessionRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/sessions/:id/resume', express.json(), async (req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(503).json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', `/v1/sessions/${req.params.id}/resume`, req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('恢复会话失败', error as Error, 'SessionRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
