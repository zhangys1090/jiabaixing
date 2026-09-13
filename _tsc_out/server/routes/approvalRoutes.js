"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = __importDefault(require("crypto"));
const express_1 = __importDefault(require("express"));
const ApprovalEngine_1 = require("../../security/ApprovalEngine");
const Logger_1 = require("../../utils/Logger");
const router = express_1.default.Router();
const APPROVAL_ADMIN_TOKEN = process.env.JBX_APPROVAL_ADMIN_TOKEN || '';
function requireApprovalAuth(req) {
    if (!APPROVAL_ADMIN_TOKEN)
        return true;
    const token = req.headers['x-admin-token'];
    if (!token)
        return false;
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(token), Buffer.from(APPROVAL_ADMIN_TOKEN));
    }
    catch {
        return false;
    }
}
/** 获取待审批请求列表 */
router.get('/pending', (_req, res) => {
    try {
        const pending = (0, ApprovalEngine_1.getApprovalEngine)().getPendingApprovals();
        res.json({ data: pending, count: pending.length });
    }
    catch (err) {
        Logger_1.Logger.error('获取待审批列表失败', err, 'ApprovalRoutes');
        res.status(500).json({ error: err.message });
    }
});
/** 响应审批请求 */
router.post('/:id/respond', (req, res) => {
    try {
        if (!requireApprovalAuth(req)) {
            return res.status(403).json({ error: '无效的管理令牌' });
        }
        const { approved, batchApprove } = req.body;
        if (typeof approved !== 'boolean') {
            return res.status(400).json({ error: 'approved 必须为布尔值' });
        }
        const success = (0, ApprovalEngine_1.getApprovalEngine)().respondToApproval(req.params.id, Boolean(approved), Boolean(batchApprove));
        if (!success) {
            return res.status(404).json({ error: '审批请求不存在或已过期' });
        }
        res.json({ success: true });
    }
    catch (err) {
        Logger_1.Logger.error('响应审批失败', err, 'ApprovalRoutes');
        res.status(500).json({ error: err.message });
    }
});
/** 获取审批历史 */
router.get('/history', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const history = (0, ApprovalEngine_1.getApprovalEngine)().getDecisionLog(limit);
        res.json({ data: history, count: history.length });
    }
    catch (err) {
        Logger_1.Logger.error('获取审批历史失败', err, 'ApprovalRoutes');
        res.status(500).json({ error: err.message });
    }
});
/** 获取审批统计 */
router.get('/stats', (_req, res) => {
    try {
        const stats = (0, ApprovalEngine_1.getApprovalEngine)().getStats();
        res.json({ data: stats });
    }
    catch (err) {
        Logger_1.Logger.error('获取审批统计失败', err, 'ApprovalRoutes');
        res.status(500).json({ error: err.message });
    }
});
/** 获取审批策略（简化版，不返回敏感的 dangerousCommands 完整列表） */
router.get('/policy', (_req, res) => {
    try {
        const engine = (0, ApprovalEngine_1.getApprovalEngine)();
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
    }
    catch (err) {
        Logger_1.Logger.error('获取审批策略失败', err, 'ApprovalRoutes');
        res.status(500).json({ error: err.message });
    }
});
/** 更新审批策略 */
router.put('/policy', (req, res) => {
    try {
        if (!requireApprovalAuth(req)) {
            return res.status(403).json({ error: '无效的管理令牌' });
        }
        const updates = req.body;
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: '无效的策略更新' });
        }
        (0, ApprovalEngine_1.getApprovalEngine)().updatePolicy(updates);
        res.json({ success: true });
    }
    catch (err) {
        Logger_1.Logger.error('更新审批策略失败', err, 'ApprovalRoutes');
        res.status(500).json({ error: err.message });
    }
});
exports.default = router;
