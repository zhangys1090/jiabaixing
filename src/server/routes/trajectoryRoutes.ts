/**
 * RL 训练轨迹路由 - Hermes Task 19 前端入口
 *
 * POST /api/trajectory/export - 导出累积的轨迹（ShareGPT / JSONL / OpenAI Fine-tune）
 * GET  /api/trajectory/stats  - 获取轨迹统计信息
 *
 * 复用 JiabaixingCore.exportTrajectories() / getTrajectoryStats()
 */

import express from 'express';
import { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

export function registerTrajectoryRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.post('/api/trajectory/export', express.json(), async (req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心未初始化' });
        return;
      }

      const { format } = (req.body || {}) as { format?: string };
      const fmt = (
        ['sharegpt', 'jsonl', 'openai_finetune'].includes(format || '')
          ? format
          : 'sharegpt'
      ) as 'sharegpt' | 'jsonl' | 'openai_finetune';

      const data = core.exportTrajectories(fmt);
      Logger.info(`📤 轨迹导出完成 (format=${fmt})`, 'TrajectoryRoutes');
      res.json({ success: true, format: fmt, data });
    } catch (error) {
      Logger.error('轨迹导出失败', error as Error, 'TrajectoryRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/trajectory/stats', (_req, res) => {
    try {
      if (!core) {
        res.status(503).json({ success: false, error: '核心未初始化' });
        return;
      }
      const stats = core.getTrajectoryStats();
      res.json({ success: true, data: stats });
    } catch (error) {
      Logger.error('轨迹统计失败', error as Error, 'TrajectoryRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
