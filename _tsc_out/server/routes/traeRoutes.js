"use strict";
/**
 * TRAE优化系统路由 - health / performance / mcp status / skills status / execute / security audit / testing generate
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTraeRoutes = registerTraeRoutes;
const express_1 = __importDefault(require("express"));
function registerTraeRoutes(app, core) {
    app.get('/api/trae/health', (_req, res) => {
        try {
            if (!core) {
                return res
                    .status(503)
                    .json({ success: false, error: '核心系统未初始化' });
            }
            const traeIntegrator = core.getTRAEOptimizationIntegrator();
            if (!traeIntegrator) {
                return res
                    .status(503)
                    .json({ success: false, error: 'TRAE优化系统未启动' });
            }
            const healthStatus = traeIntegrator.getSystemHealth?.();
            res.json({ success: true, data: healthStatus });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/trae/performance', (_req, res) => {
        try {
            if (!core) {
                return res
                    .status(503)
                    .json({ success: false, error: '核心系统未初始化' });
            }
            const traeIntegrator = core.getTRAEOptimizationIntegrator();
            if (!traeIntegrator) {
                return res
                    .status(503)
                    .json({ success: false, error: 'TRAE优化系统未启动' });
            }
            const metrics = traeIntegrator.getPerformanceMetrics?.();
            res.json({ success: true, data: metrics });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/trae/mcp/status', (_req, res) => {
        try {
            if (!core) {
                return res
                    .status(503)
                    .json({ success: false, error: '核心系统未初始化' });
            }
            const traeIntegrator = core.getTRAEOptimizationIntegrator();
            if (!traeIntegrator) {
                return res
                    .status(503)
                    .json({ success: false, error: 'TRAE优化系统未启动' });
            }
            const mcpStatus = traeIntegrator.getMCPStatus?.();
            res.json({ success: true, data: mcpStatus });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/trae/skills/status', (_req, res) => {
        try {
            if (!core) {
                return res
                    .status(503)
                    .json({ success: false, error: '核心系统未初始化' });
            }
            const traeIntegrator = core.getTRAEOptimizationIntegrator();
            if (!traeIntegrator) {
                return res
                    .status(503)
                    .json({ success: false, error: 'TRAE优化系统未启动' });
            }
            const skillStatus = traeIntegrator.getSkillStatus?.();
            res.json({ success: true, data: skillStatus });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/trae/skills/execute', express_1.default.json({ limit: '10mb' }), async (req, res) => {
        try {
            const { skillName, params } = req.body;
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
            const traeIntegrator = core.getTRAEOptimizationIntegrator();
            if (!traeIntegrator) {
                return res
                    .status(503)
                    .json({ success: false, error: 'TRAE优化系统未启动' });
            }
            const result = (await traeIntegrator.executeOptimizedSkill?.(skillName, params || {}));
            res.json({
                success: result.success,
                data: result.data,
                error: result.error,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.post('/api/trae/security/audit', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const { target, auditType } = req.body;
            if (!core) {
                return res
                    .status(503)
                    .json({ success: false, error: '核心系统未初始化' });
            }
            const traeIntegrator = core.getTRAEOptimizationIntegrator();
            if (!traeIntegrator) {
                return res
                    .status(503)
                    .json({ success: false, error: 'TRAE优化系统未启动' });
            }
            const result = (await traeIntegrator.executeOptimizedSkill?.('SecurityAuditSkill', {
                target: target || './src',
                auditType: auditType || 'all',
            }));
            res.json({
                success: result.success,
                data: result.data,
                error: result.error,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.post('/api/trae/testing/generate', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const { targetFile, testType, framework } = req.body;
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
            const traeIntegrator = core.getTRAEOptimizationIntegrator();
            if (!traeIntegrator) {
                return res
                    .status(503)
                    .json({ success: false, error: 'TRAE优化系统未启动' });
            }
            const result = (await traeIntegrator.executeOptimizedSkill?.('test_generator', {
                targetFile,
                testType: testType || 'unit',
                framework: framework || 'jest',
            }));
            res.json({
                success: result.success,
                data: result.data,
                error: result.error,
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
