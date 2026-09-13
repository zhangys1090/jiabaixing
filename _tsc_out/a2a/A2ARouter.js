"use strict";
/**
 * A2A 协议 TS 薄壳 —— HTTP 入口路由转发（符合 AGENTS.md §0.1）。
 *
 * 将 `/a2a/*` 的 HTTP 请求透明代理转发到 Python FastAPI 的真实 A2A 端点
 * （`agent/a2a/server.create_a2a_router`，挂载前缀 `/a2a`）。
 *
 * 设计原则：
 * - 本文件**不实现任何 A2A 业务逻辑**，仅做透传。
 * - 鉴权、Task 生命周期、Agent Card 发现等全部由 Python 端处理。
 * - Python 后端不可用时统一返回 503，与 adminRoutes / mcpRoutes 行为一致。
 *
 * 转发目标：`${PYTHON_AGENT_URL}${req.originalUrl}`，
 * 其中 originalUrl 形如 `/a2a/tasks`，正好对齐 Python 端 `/a2a` 前缀。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerA2ARoutes = registerA2ARoutes;
const express_1 = __importDefault(require("express"));
const Logger_1 = require("../utils/Logger");
function getPythonAgentUrl() {
    return process.env.PYTHON_AGENT_URL || 'http://localhost:3112';
}
/**
 * 将 `/a2a/*` 注册为到 Python A2A 后端的透明代理。
 *
 * @param app Express 应用实例（来自 main.ts）
 */
function registerA2ARoutes(app) {
    const forward = async (req, res) => {
        const bridgePath = req.originalUrl; // 形如 /a2a/tasks 或 /a2a/.well-known/agent.json
        const target = `${getPythonAgentUrl()}${bridgePath}`;
        try {
            const headers = {};
            // 透传调用方鉴权头
            const auth = req.headers['authorization'];
            if (auth)
                headers['Authorization'] = auth;
            const apiKey = req.headers['x-api-key'];
            if (apiKey)
                headers['X-API-Key'] = apiKey;
            const a2aToken = req.headers['x-a2a-token'];
            if (a2aToken)
                headers['X-A2A-Token'] = a2aToken;
            // 透传 Content-Type（POST 体需要）
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
                    /* 解析失败则回退为原始文本 */
                }
            }
            res.send(text);
        }
        catch (error) {
            Logger_1.Logger.error('A2A 代理转发失败', error, 'A2ARouter');
            res.status(503).json({
                success: false,
                error: 'Python A2A 后端未连接或代理失败',
                path: bridgePath,
            });
        }
    };
    // 仅解析 JSON 体；GET/HEAD 无体，json 中间件对其无副作用。
    app.use('/a2a', express_1.default.json({ limit: '2mb' }), forward);
}
