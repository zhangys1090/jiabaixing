/**
 * Approval API 路由 — 审批管理
 *
 * GET    /api/approvals/pending    — 获取待审批请求列表
 * POST   /api/approvals/:id/respond — 响应审批请求（批准/拒绝）
 * GET    /api/approvals/history     — 获取审批历史
 * GET    /api/approvals/stats       — 获取审批统计
 * GET    /api/approvals/policy      — 获取当前审批策略
 * PUT    /api/approvals/policy      — 更新审批策略
 */

import express from 'express';
import {
  ApprovalPolicy,
  getApprovalEngine,
} from '../../security/ApprovalEngine';
import { Logger } from '../../utils/Logger';

const router = express.Router();

/** 获取待审批请求列表 */
router.get('/pending', (_req: express.Request, res: express.Response) => {
  try {
    const pending = getApprovalEngine().getPendingApprovals();
    res.json({ data: pending, count: pending.length });
  } catch (err) {
    Logger.error('获取待审批列表失败', err as Error, 'ApprovalRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 响应审批请求 */
router.post('/:id/respond', (req: express.Request, res: express.Response) => {
  try {
    const { approved, batchApprove } = req.body;
    const success = getApprovalEngine().respondToApproval(
      req.params.id,
      Boolean(approved),
      Boolean(batchApprove)
    );

    if (!success) {
      return res.status(404).json({ error: '审批请求不存在或已过期' });
    }
    res.json({ success: true });
  } catch (err) {
    Logger.error('响应审批失败', err as Error, 'ApprovalRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 获取审批历史 */
router.get('/history', (req: express.Request, res: express.Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const history = getApprovalEngine().getDecisionLog(limit);
    res.json({ data: history, count: history.length });
  } catch (err) {
    Logger.error('获取审批历史失败', err as Error, 'ApprovalRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 获取审批统计 */
router.get('/stats', (_req: express.Request, res: express.Response) => {
  try {
    const stats = getApprovalEngine().getStats();
    res.json({ data: stats });
  } catch (err) {
    Logger.error('获取审批统计失败', err as Error, 'ApprovalRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 获取审批策略（简化版，不返回敏感的 dangerousCommands 完整列表） */
router.get('/policy', (_req: express.Request, res: express.Response) => {
  try {
    const engine = getApprovalEngine();
    const policy = engine.getPolicy();
    res.json({
      data: {
        mode: policy.mode,
        autoApproveLow: policy.autoApproveLow,
        autoApproveMedium: policy.autoApproveMedium,
        requireHumanForHigh: policy.requireHumanForHigh,
        requireHumanForCritical: policy.requireHumanForCritical,
        batchWindowMs: policy.batchWindowMs,
        timeoutMs: policy.timeoutMs,
      },
    });
  } catch (err) {
    Logger.error('获取审批策略失败', err as Error, 'ApprovalRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 更新审批策略 */
router.put('/policy', (req: express.Request, res: express.Response) => {
  try {
    const updates: Partial<ApprovalPolicy> = req.body;
    getApprovalEngine().updatePolicy(updates);
    res.json({ success: true });
  } catch (err) {
    Logger.error('更新审批策略失败', err as Error, 'ApprovalRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
