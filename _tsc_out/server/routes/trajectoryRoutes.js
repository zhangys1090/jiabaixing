"use strict";
/**
 * RL 训练轨迹路由 - Hermes Task 19 前端入口
 *
 * POST /api/trajectory/export - 导出累积的轨迹（ShareGPT / JSONL / OpenAI Fine-tune）
 * GET  /api/trajectory/stats  - 获取轨迹统计信息
 *
 * 复用 JiabaixingCore.exportTrajectories() / getTrajectoryStats()
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTrajectoryRoutes = registerTrajectoryRoutes;
const express_1 = __importDefault(require("express"));
const Logger_1 = require("../../utils/Logger");
function registerTrajectoryRoutes(app, core) {
    app.post('/api/trajectory/export', express_1.default.json(), async (req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心未初始化' });
                return;
            }
            const { format } = (req.body || {});
            const fmt = (['sharegpt', 'jsonl', 'openai_finetune'].includes(format || '')
                ? format
                : 'sharegpt');
            const data = core.exportTrajectories(fmt);
            Logger_1.Logger.info(`📤 轨迹导出完成 (format=${fmt})`, 'TrajectoryRoutes');
            res.json({ success: true, format: fmt, data });
        }
        catch (error) {
            Logger_1.Logger.error('轨迹导出失败', error, 'TrajectoryRoutes');
            res.status(500).json({ success: false, error: error.message });
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
        }
        catch (error) {
            Logger_1.Logger.error('轨迹统计失败', error, 'TrajectoryRoutes');
            res.status(500).json({ success: false, error: error.message });
        }
    });
}
