"use strict";
/**
 * 安全路由 - security logs / events / report / validate / audit
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
exports.registerSecurityRoutes = registerSecurityRoutes;
const crypto_1 = __importDefault(require("crypto"));
const express_1 = __importDefault(require("express"));
const Logger_1 = require("../../utils/Logger");
const SECURITY_ADMIN_TOKEN = process.env.JBX_SECURITY_ADMIN_TOKEN || '';
function validateSecurityAdmin(req) {
    if (!SECURITY_ADMIN_TOKEN)
        return true;
    const token = req.headers['x-admin-token'];
    if (!token)
        return false;
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(token), Buffer.from(SECURITY_ADMIN_TOKEN));
    }
    catch {
        return false;
    }
}
function registerSecurityRoutes(app, core) {
    const securityAuditor = {
        queryLogs: (filter) => {
            return { logs: [], total: 0, filter };
        },
        queryEvents: (filter) => {
            return { events: [], total: 0, filter };
        },
        generateReport: (timeWindowHours) => {
            return {
                timeWindow: `${timeWindowHours}h`,
                summary: { totalEvents: 0, criticalCount: 0, highCount: 0 },
                recommendations: [],
            };
        },
    };
    app.get('/api/security/logs', (req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心系统未初始化' });
                return;
            }
            const level = req.query.level;
            const category = req.query.category;
            const limit = parseInt(req.query.limit) || 100;
            const result = securityAuditor.queryLogs({ level, category, limit });
            res.json({ success: true, data: result.logs });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/security/events', (req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心系统未初始化' });
                return;
            }
            const eventType = req.query.eventType;
            const severity = req.query.severity;
            const limit = parseInt(req.query.limit) || 50;
            const events = securityAuditor.queryEvents({
                eventType,
                severity,
                limit,
            });
            res.json({ success: true, data: events });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/security/report', (req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心系统未初始化' });
                return;
            }
            const timeWindowHours = parseInt(req.query.timeWindowHours) || 24;
            const report = securityAuditor.generateReport(timeWindowHours);
            res.json({ success: true, data: report });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/security/validate', express_1.default.json({ limit: '10mb' }), async (req, res) => {
        try {
            const { input } = req.body;
            if (!input) {
                return res
                    .status(400)
                    .json({ success: false, error: '缺少input参数' });
            }
            const SecurityGuard = (await Promise.resolve().then(() => __importStar(require('../../security/SecurityGuard'))))
                .SecurityGuard;
            const securityGuard = new SecurityGuard();
            const validationResult = securityGuard.validateInput(input);
            res.json({
                success: true,
                data: {
                    valid: validationResult.valid,
                    errors: validationResult.errors,
                    warnings: validationResult.warnings,
                    riskLevel: validationResult.valid ? 'low' : 'high',
                },
            });
        }
        catch (error) {
            Logger_1.Logger.error('❌ 安全验证失败', error, 'SecurityAPI');
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.get('/api/security/audit', async (req, res) => {
        try {
            const { limit = 20, type } = req.query;
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
            const auditResult = (await traeIntegrator.executeOptimizedSkill?.('SecurityAuditSkill', {
                target: 'src',
                auditType: type || 'comprehensive',
                limit: parseInt(limit) || 20,
            }));
            res.json({
                success: auditResult.success,
                data: auditResult.output,
            });
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取安全审计日志失败', error, 'SecurityAPI');
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.get('/api/security/apikeys', async (req, res) => {
        if (!validateSecurityAdmin(req)) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }
        try {
            const { ApiKeyManager } = await Promise.resolve().then(() => __importStar(require('../../security/ApiKeyManager')));
            const manager = ApiKeyManager.getInstance();
            const keys = manager.listKeys();
            res.json({
                success: true,
                data: keys.map((k) => ({
                    id: k.id,
                    name: k.name,
                    provider: k.provider,
                    status: k.status,
                    createdAt: k.createdAt,
                    expiresAt: k.expiresAt,
                    lastUsedAt: k.lastUsedAt,
                    usageCount: k.usageCount,
                })),
            });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/security/apikeys/rotate', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        if (!validateSecurityAdmin(req)) {
            return res
                .status(403)
                .json({ success: false, error: '需要管理员权限' });
        }
        try {
            const { name, newKey } = req.body;
            if (!name) {
                return res
                    .status(400)
                    .json({ success: false, error: '缺少 name 参数' });
            }
            const { ApiKeyManager } = await Promise.resolve().then(() => __importStar(require('../../security/ApiKeyManager')));
            const manager = ApiKeyManager.getInstance();
            const entry = await manager.rotateKey(name, newKey);
            res.json({
                success: true,
                data: { id: entry.id, name: entry.name, status: entry.status },
            });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.post('/api/security/apikeys/revoke', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const { name } = req.body;
            if (!name) {
                return res
                    .status(400)
                    .json({ success: false, error: '缺少 name 参数' });
            }
            const { ApiKeyManager } = await Promise.resolve().then(() => __importStar(require('../../security/ApiKeyManager')));
            const manager = ApiKeyManager.getInstance();
            const revoked = manager.revokeKey(name);
            res.json({ success: true, data: { name, revoked } });
        }
        catch (error) {
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
}
