import express from 'express';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';
import { Logger } from '../../utils/Logger';

const MAX_TASK_LENGTH = 10000;
const MAX_SESSION_ID_LENGTH = 128;

function validatePlanRequest(body: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: '请求体不能为空' };
  }
  const req = body as Record<string, unknown>;
  if (
    !req.task ||
    typeof req.task !== 'string' ||
    req.task.trim().length === 0
  ) {
    return { valid: false, error: '任务描述不能为空' };
  }
  if (req.task.length > MAX_TASK_LENGTH) {
    return { valid: false, error: `任务描述不能超过${MAX_TASK_LENGTH}字` };
  }
  if (
    req.session_id &&
    typeof req.session_id === 'string' &&
    req.session_id.length > MAX_SESSION_ID_LENGTH
  ) {
    return { valid: false, error: 'session_id过长' };
  }
  return { valid: true };
}

export function registerPlanRoutes(app: express.Application): void {
  app.post('/api/plan', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const validation = validatePlanRequest(req.body);
      if (!validation.valid) {
        return res
          .status(400)
          .json({ success: false, error: validation.error });
      }
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.request('POST', '/v1/plan', req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('任务规划失败', error as Error, 'PlanRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/plan/execute',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        if (!body || !Array.isArray(body.steps) || body.steps.length === 0) {
          return res
            .status(400)
            .json({ success: false, error: '执行步骤列表不能为空' });
        }
        if (body.steps.length > 50) {
          return res
            .status(400)
            .json({ success: false, error: '执行步骤不能超过50条' });
        }
        const bridge = getActivePythonBridge();
        if (!bridge) {
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        }
        const result = await bridge.request(
          'POST',
          '/v1/plan/execute',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('执行计划失败', error as Error, 'PlanRoutes');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/plan/evaluate',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        if (!body || !body.task || typeof body.task !== 'string') {
          return res
            .status(400)
            .json({ success: false, error: '任务描述不能为空' });
        }
        const bridge = getActivePythonBridge();
        if (!bridge) {
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        }
        const result = await bridge.request(
          'POST',
          '/v1/plan/evaluate',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('评估计划失败', error as Error, 'PlanRoutes');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/plan/reflect',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        if (!body || !body.task || typeof body.task !== 'string') {
          return res
            .status(400)
            .json({ success: false, error: '任务描述不能为空' });
        }
        const bridge = getActivePythonBridge();
        if (!bridge) {
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        }
        const result = await bridge.request(
          'POST',
          '/v1/plan/reflect',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('反思计划失败', error as Error, 'PlanRoutes');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );
}
