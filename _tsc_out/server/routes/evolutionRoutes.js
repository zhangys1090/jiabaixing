"use strict";
/**
 * 进化引擎路由 - evolution metrics / insights / trigger / orchestrator
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEvolutionRoutes = registerEvolutionRoutes;
const express_1 = __importDefault(require("express"));
const EvolutionOrchestrator_1 = require("../../evolution/EvolutionOrchestrator");
/** 从 core 注入的解析器获取 Python 后端桥接实例（未桥接时返回 null） */
function getBridge(core) {
    return core?.getPythonBridgeResolver()?.() ?? null;
}
function registerEvolutionRoutes(app, core) {
    app.get('/api/evolution/metrics', async (_req, res) => {
        try {
            const bridge = getBridge(core);
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const data = await bridge.getEvolutionMetrics();
            res.json({ success: true, data });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/evolution/insights', async (_req, res) => {
        try {
            const bridge = getBridge(core);
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const data = await bridge.getInsights();
            res.json({ success: true, data });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/evolution/trigger', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const bridge = getBridge(core);
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const reason = req.body.reason || '手动触发';
            const result = (await bridge.triggerEvolution());
            res.json({
                success: true,
                data: {
                    triggered: result?.triggered ?? false,
                    details: result?.details ?? '',
                    reason,
                },
            });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    // v3.4: 统一进化编排器 API
    app.get('/api/orchestrator/metrics', async (_req, res) => {
        try {
            const bridge = getBridge(core);
            if (bridge) {
                const data = await bridge.getEvolutionMetrics();
                return res.json({ success: true, data });
            }
            const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
            const metrics = orchestrator.getUnifiedMetrics();
            res.json({ success: true, data: metrics });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/orchestrator/optimize', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const bridge = getBridge(core);
            const reason = req.body.reason || '手动触发';
            if (bridge) {
                await bridge.triggerEvolution();
                return res.json({ success: true, data: { reason } });
            }
            const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
            const cycle = await orchestrator.triggerOptimizationCycle(reason, true);
            res.json({ success: true, data: { cycleId: cycle?.cycleId, reason } });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.post('/api/evolution/cycle', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const bridge = getBridge(core);
            const reason = req.body.reason || '手动触发完整进化周期';
            if (bridge) {
                await bridge.triggerEvolution();
                return res.json({
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
            }
            const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
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
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.post('/api/evolution/healing', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const bridge = getBridge(core);
            const reason = req.body.reason || '手动触发自愈';
            if (bridge) {
                await bridge.triggerEvolution();
                return res.json({
                    success: true,
                    message: `自愈优化已触发: ${reason}`,
                    timestamp: new Date().toISOString(),
                });
            }
            const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
            void orchestrator.triggerOptimizationCycleWithVerification(reason);
            res.json({
                success: true,
                message: `自愈优化已触发: ${reason}`,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.post('/api/evolution/refactor', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const bridge = getBridge(core);
            const reason = req.body.reason || '手动触发重构';
            if (bridge) {
                await bridge.triggerEvolution();
                return res.json({
                    success: true,
                    message: `重构优化已触发: ${reason}`,
                    timestamp: new Date().toISOString(),
                });
            }
            const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
            void orchestrator.triggerOptimizationCycleWithVerification(reason);
            res.json({
                success: true,
                message: `重构优化已触发: ${reason}`,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.post('/api/evolution/enhance', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const bridge = getBridge(core);
            const reason = req.body.reason || '手动触发增强';
            if (bridge) {
                await bridge.triggerEvolution();
                return res.json({
                    success: true,
                    message: `增强优化已触发: ${reason}`,
                    timestamp: new Date().toISOString(),
                });
            }
            const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
            void orchestrator.triggerOptimizationCycleWithVerification(reason);
            res.json({
                success: true,
                message: `增强优化已触发: ${reason}`,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
}
