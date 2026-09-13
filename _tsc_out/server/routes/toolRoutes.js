"use strict";
/**
 * 工具执行路由 - Hermes P2 前端入口
 *
 * POST /api/tools/execute - 执行已注册的 Harness 工具（image_generate / tts_speak / web_fetch 等）
 * GET  /api/tools/list    - 列出所有已注册工具
 *
 * 复用 ToolRegistry.execute()，与 SkillRegistry 双轨并行
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolRoutes = registerToolRoutes;
const express_1 = __importDefault(require("express"));
const Logger_1 = require("../../utils/Logger");
const TOOL_RATE_LIMIT_WINDOW_MS = 60000;
const TOOL_RATE_LIMIT_MAX = 30;
const _toolRateMap = new Map();
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_PARAMS_SIZE = 100000;
function checkToolRate(key) {
    const now = Date.now();
    const entry = _toolRateMap.get(key);
    if (!entry || now >= entry.resetAt) {
        _toolRateMap.set(key, {
            count: 1,
            resetAt: now + TOOL_RATE_LIMIT_WINDOW_MS,
        });
        return { allowed: true, resetIn: 0 };
    }
    if (entry.count >= TOOL_RATE_LIMIT_MAX) {
        return { allowed: false, resetIn: entry.resetAt - now };
    }
    entry.count++;
    return { allowed: true, resetIn: 0 };
}
async function handleToolExecute(req, res) {
    try {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateResult = checkToolRate(clientIp);
        if (!rateResult.allowed) {
            res.setHeader('Retry-After', Math.ceil(rateResult.resetIn / 1000));
            res
                .status(429)
                .json({ success: false, error: '工具调用过于频繁，请稍后再试' });
            return;
        }
        const { toolName, params, userId } = req.body;
        if (!toolName) {
            res.status(400).json({ success: false, error: '缺少 toolName' });
            return;
        }
        if (typeof toolName !== 'string' ||
            toolName.length > MAX_TOOL_NAME_LENGTH) {
            res.status(400).json({ success: false, error: 'toolName 格式无效' });
            return;
        }
        if (params && JSON.stringify(params).length > MAX_PARAMS_SIZE) {
            res.status(400).json({ success: false, error: '参数过大' });
            return;
        }
        const core = req.app.locals.core;
        if (!core) {
            res.status(503).json({ success: false, error: '核心未初始化' });
            return;
        }
        const harness = core.getHarness();
        if (!harness) {
            res.status(503).json({ success: false, error: 'Harness 未初始化' });
            return;
        }
        const registry = harness.getToolRegistry();
        if (!registry) {
            res.status(503).json({ success: false, error: '工具注册表不可用' });
            return;
        }
        const traceId = Logger_1.Logger.generateTraceId();
        const result = await registry.execute(toolName, params || {}, {
            userId: userId || 'api_user',
            traceId,
            permissions: new Set(),
            metadata: {},
        });
        res.json({
            success: result.success,
            output: result.output,
            error: result.error,
            metadata: {
                ...result.metadata,
                duration: result.duration,
                traceId,
                toolName,
            },
        });
    }
    catch (error) {
        Logger_1.Logger.error('❌ 工具执行失败', error, 'ToolRoutes');
        res.status(500).json({ success: false, error: error.message });
    }
}
function handleToolList(req, res) {
    try {
        const core = req.app.locals.core;
        if (!core) {
            res.status(503).json({ success: false, error: '核心未初始化' });
            return;
        }
        const harness = core.getHarness();
        if (!harness) {
            res.status(503).json({ success: false, error: 'Harness 未初始化' });
            return;
        }
        const registry = harness.getToolRegistry();
        if (!registry) {
            res.status(503).json({ success: false, error: '工具注册表不可用' });
            return;
        }
        const tools = registry.getAll().map((t) => ({
            name: t.definition.name,
            description: t.definition.description,
            category: t.definition.category,
            parameters: t.definition.parameters,
            riskLevel: t.definition.riskLevel,
        }));
        res.json({ success: true, tools, count: tools.length });
    }
    catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}
function registerToolRoutes(app, core) {
    app.locals.core = core;
    app.post('/api/tools/execute', express_1.default.json({ limit: '10mb' }), handleToolExecute);
    app.get('/api/tools/list', handleToolList);
}
