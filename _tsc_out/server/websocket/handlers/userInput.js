"use strict";
/**
 * WebSocket 用户输入处理
 * 处理 user_input 和 command 类型消息
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleUserInput = handleUserInput;
exports.extractUserId = extractUserId;
const ws_1 = __importDefault(require("ws"));
const contracts_1 = require("../../../shared/contracts");
const Logger_1 = require("../../../utils/Logger");
const WsDedup_1 = require("../WsDedup");
const WsProcessor_1 = require("../WsProcessor");
const WsRateLimit_1 = require("../WsRateLimit");
const rateLimiter = new WsRateLimit_1.WsRateLimiter();
/**
 * 处理用户输入
 */
async function handleUserInput(data, userId, clientIp, ws, core, taskManager, traceId) {
    // 提取输入
    const payload = (data.payload || data.data || {});
    const input = (payload.input ||
        payload.text ||
        payload.message ||
        data.input ||
        data.text ||
        data.message ||
        '');
    if (!input) {
        ws.send(JSON.stringify({
            type: 'error',
            data: { message: '缺少输入内容' },
        }));
        return;
    }
    if (input.length > contracts_1.SYSTEM_CONSTANTS.MAX_INPUT_LENGTH) {
        ws.send(JSON.stringify({
            type: 'error',
            data: {
                message: `消息过长（${input.length}字），请控制在${contracts_1.SYSTEM_CONSTANTS.MAX_INPUT_LENGTH}字以内`,
            },
        }));
        return;
    }
    // 限流检查
    const rateLimitKey = `ws:${userId}:${clientIp}`;
    const rateLimitResult = rateLimiter.checkStandard(rateLimitKey);
    if (!rateLimitResult.allowed) {
        Logger_1.Logger.warn(`⚠️ WebSocket限流: userId=${userId} ip=${clientIp}`, 'WsHandler');
        ws.send(JSON.stringify((0, WsRateLimit_1.createRateLimitErrorResponse)(rateLimitResult.resetIn)));
        return;
    }
    // 熔断检查
    const circuitBreaker = new WsRateLimit_1.WsCircuitBreaker('llm_processing');
    if (!circuitBreaker.canExecute().canExecute) {
        Logger_1.Logger.warn(`⚠️ LLM熔断器开启，拒绝请求: userId=${userId}`, 'WsHandler');
        ws.send(JSON.stringify((0, WsRateLimit_1.createCircuitOpenResponse)()));
        return;
    }
    Logger_1.Logger.info(`📩 WebSocket收到: ${String(input).substring(0, 50)}${String(input).length > 50 ? '...' : ''}`, 'WsHandler');
    // 去重检查
    if ((0, WsDedup_1.checkAndMarkResponse)(traceId)) {
        Logger_1.Logger.info(`⚠️ traceId ${traceId} 已处理，跳过重复请求`, 'WsHandler');
        return;
    }
    // 创建任务元数据
    const taskMeta = taskManager.createTaskMeta(clientIp);
    taskManager.register(traceId, taskMeta);
    // 发送处理中状态
    ws.send(JSON.stringify({
        type: 'processing_status',
        data: {
            status: 'processing',
            message: '收到消息，正在处理中...',
            traceId,
        },
    }));
    // 连接 loopController
    if (core) {
        const harness = core.getHarness();
        if (harness) {
            taskMeta.loopController = { abort: () => harness.abortCurrentLoop() };
        }
    }
    try {
        await (0, WsProcessor_1.processInputWithRetry)(input, userId, traceId, ws, core, clientIp, taskMeta);
        taskManager.delete(traceId);
    }
    catch (err) {
        Logger_1.Logger.error('❌ 处理输入失败（重试耗尽）', err, 'WsHandler');
        taskManager.delete(traceId);
        if (ws.readyState === ws_1.default.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: '处理请求时发生错误，请稍后重试。', traceId },
            }));
        }
    }
}
/**
 * 从消息数据提取用户 ID
 */
function extractUserId(data) {
    const payload = (data.payload || data.data || {});
    return (payload.userId ||
        payload.userid ||
        data.userId ||
        'anonymous');
}
