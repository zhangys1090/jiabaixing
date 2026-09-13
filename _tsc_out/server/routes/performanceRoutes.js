"use strict";
/**
 * 性能监控路由 - performance snapshot / metrics / errors / llm performance
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPerformanceRoutes = registerPerformanceRoutes;
const express_1 = __importDefault(require("express"));
const Logger_1 = require("../../utils/Logger");
function registerPerformanceRoutes(app, core) {
    app.get('/api/performance/snapshot', (_req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心系统未初始化' });
                return;
            }
            const snapshot = core.getPerformanceMonitor().getCurrentMetrics();
            res.json({ success: true, data: snapshot });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/performance/metrics', (req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心系统未初始化' });
                return;
            }
            const limit = parseInt(req.query.limit) || 100;
            const metrics = core.getPerformanceMonitor().getMetrics(limit);
            res.json({ success: true, data: metrics });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/performance/errors', (req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心系统未初始化' });
                return;
            }
            const limit = parseInt(req.query.limit) || 50;
            const metrics = core.getPerformanceMonitor().getMetrics(limit);
            const errors = metrics.filter((m) => m.errorRate > 0);
            res.json({ success: true, data: errors });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/llm/performance', async (_req, res) => {
        try {
            const { MultiModelLLMProvider } = await Promise.resolve().then(() => __importStar(require('../../models/MultiModelLLMProvider')));
            const provider = MultiModelLLMProvider.getInstance();
            await provider.initialize();
            const models = provider.getAvailableModels();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const healthStatus = provider.modelHealthStatus || new Map();
            const modelStats = models.map((model) => {
                const health = healthStatus.get(model.id) || {
                    successCount: 0,
                    failureCount: 0,
                    avgLatency: 0,
                    lastError: null,
                };
                const totalCalls = health.successCount + health.failureCount;
                const successRate = totalCalls > 0 ? health.successCount / totalCalls : 0;
                let status = 'healthy';
                if (successRate < 0.5 || health.failureCount >= 5) {
                    status = 'unhealthy';
                }
                else if (successRate < 0.8 || health.failureCount >= 3) {
                    status = 'degraded';
                }
                return {
                    modelId: model.id,
                    modelName: model.name,
                    provider: model.id.includes('zhipu') ? '智谱AI' : '本地LLM',
                    totalCalls,
                    successCalls: health.successCount,
                    failedCalls: health.failureCount,
                    avgLatency: health.avgLatency || 0,
                    totalTokens: Math.floor(totalCalls * 500),
                    promptTokens: Math.floor(totalCalls * 300),
                    completionTokens: Math.floor(totalCalls * 200),
                    lastUsed: health.lastSuccess
                        ? new Date(health.lastSuccess).toISOString()
                        : '-',
                    status,
                };
            });
            const totalTokens = modelStats.reduce((sum, m) => sum + m.totalTokens, 0);
            const totalCalls = modelStats.reduce((sum, m) => sum + m.totalCalls, 0);
            const response = {
                models: modelStats,
                tokenUsage: {
                    totalTokens,
                    promptTokens: modelStats.reduce((sum, m) => sum + m.promptTokens, 0),
                    completionTokens: modelStats.reduce((sum, m) => sum + m.completionTokens, 0),
                    avgTokensPerCall: totalCalls > 0 ? Math.floor(totalTokens / totalCalls) : 0,
                    tokensByModel: modelStats.map((m) => ({
                        model: m.modelName,
                        tokens: m.totalTokens,
                    })),
                    tokensByHour: [],
                },
                systemStatus: {
                    circuitBreakerOpen: modelStats.some((m) => m.status === 'unhealthy'),
                    lastError: null,
                    uptime: process.uptime(),
                },
            };
            res.status(200).json(response);
        }
        catch (error) {
            Logger_1.Logger.error('获取LLM性能数据失败', error, 'Performance');
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    app.post('/api/performance/metrics', express_1.default.json({ limit: '1mb' }), (req, res) => {
        try {
            const metrics = req.body;
            Logger_1.Logger.debug('收到性能指标数据', 'Performance', metrics);
            res.json({
                success: true,
                status: 'received',
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            res.status(500).json({
                success: false,
                error: error.message,
            });
        }
    });
}
