"use strict";
/**
 * /api/chat 对话 API 路由
 * 提供 POST /api/chat 端点，接收用户消息并返回 AI 回复
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setChatCore = setChatCore;
const express_1 = require("express");
const Logger_1 = require("../../utils/Logger");
const bootstrap_1 = require("../bootstrap");
const router = (0, express_1.Router)();
let _core = null;
/**
 * 设置核心实例引用（由 main.ts 在初始化时调用）
 */
function setChatCore(core) {
    _core = core;
}
function getCore() {
    if (!_core) {
        throw new Error('chatRoutes: 核心实例未注入，请在 main.ts 中调用 setChatCore()');
    }
    return _core;
}
// POST /api/chat — 发送对话消息
router.post('/chat', async (req, res) => {
    try {
        const { message, conversation_id } = req.body;
        if (!message ||
            typeof message !== 'string' ||
            message.trim().length === 0) {
            res.status(400).json({
                success: false,
                error: '消息不能为空',
            });
            return;
        }
        const userId = conversation_id || 'default';
        const input = message.trim();
        Logger_1.Logger.info(`[Chat API] 收到消息: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`, 'ChatRoute');
        const responseConversationId = conversation_id || userId;
        if ((0, bootstrap_1.isPythonBackend)()) {
            const bridge = (0, bootstrap_1.getPythonBridge)();
            const result = await bridge.processInput(input, userId);
            res.json({
                success: true,
                response: result.response,
                conversation_id: responseConversationId,
                trace_id: result.traceId,
                backend: 'python',
            });
            return;
        }
        const core = getCore();
        const result = await core.processInput(input, userId);
        res.json({
            success: true,
            response: result.response,
            conversation_id: responseConversationId,
            trace_id: result.traceId,
            backend: 'typescript',
        });
    }
    catch (error) {
        Logger_1.Logger.error('[Chat API] 处理失败', error, 'ChatRoute');
        res.status(500).json({
            success: false,
            error: '对话处理失败',
            details: error.message,
        });
    }
});
exports.default = router;
