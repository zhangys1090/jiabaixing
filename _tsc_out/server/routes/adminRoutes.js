"use strict";
/**
 * R1 管理面路由（TS 薄网关）。
 *
 * 将 /v1/admin/* 的 HTTP 请求代理转发到 Python FastAPI (:3112) 的真实管理端点
 * （agent.api.admin）。本文件不实现任何业务逻辑，仅做透明转发（符合 AGENTS.md §0.1）。
 *
 * Python 后端不可用时统一返回 503，与 mcpRoutes 行为一致。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdminRoutes = registerAdminRoutes;
const crypto_1 = __importDefault(require("crypto"));
const express_1 = __importDefault(require("express"));
const Logger_1 = require("../../utils/Logger");
const ADMIN_TOKEN = process.env.JBX_ADMIN_TOKEN || '';
function validateAdminToken(req) {
    if (!ADMIN_TOKEN)
        return true;
    const token = req.headers['x-admin-token'];
    if (!token)
        return false;
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    }
    catch {
        return false;
    }
}
function getPythonAgentUrl() {
    return process.env.PYTHON_AGENT_URL || 'http://localhost:3112';
}
function registerAdminRoutes(app) {
    const forward = async (req, res) => {
        if (!validateAdminToken(req)) {
            return res.status(403).json({ success: false, error: '无效的管理令牌' });
        }
        const bridgePath = req.originalUrl; // 形如 /v1/admin/runtime/posture
        const target = `${getPythonAgentUrl()}${bridgePath}`;
        try {
            const headers = {};
            const auth = req.headers['authorization'];
            if (auth)
                headers['Authorization'] = auth;
            const adminToken = req.headers['x-admin-token'];
            if (adminToken)
                headers['X-Admin-Token'] = adminToken;
            const contentType = req.headers['content-type'];
            if (contentType)
                headers['Content-Type'] = contentType;
            const init = {
                method: req.method,
                headers,
            };
            if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
                init.body =
                    typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            }
            const upstream = await fetch(target, init);
            const text = await upstream.text();
            res.status(upstream.status);
            const ct = upstream.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                try {
                    res.json(JSON.parse(text));
                    return;
                }
                catch {
                    /* fall through to raw */
                }
            }
            res.send(text);
        }
        catch (error) {
            Logger_1.Logger.error('R1 管理面代理失败', error, 'AdminRoutes');
            res
                .status(503)
                .json({ success: false, error: 'Python 后端未连接或代理失败' });
        }
    };
    app.get('/v1/admin/runtime/posture', forward);
    app.post('/v1/admin/runtime/posture', express_1.default.json({ limit: '1mb' }), forward);
    app.get('/v1/admin/runtime/lockdown', forward);
    app.post('/v1/admin/runtime/lockdown', express_1.default.json({ limit: '1mb' }), forward);
    app.get('/v1/admin/plugins/trust', forward);
    app.post('/v1/admin/plugins/trust', express_1.default.json({ limit: '1mb' }), forward);
}
