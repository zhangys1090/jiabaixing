"use strict";
/**
 * WebSocket 事件处理
 * 处理 clarification_response、execution_confirm 等事件
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleClarificationResponse = handleClarificationResponse;
exports.handleExecutionConfirm = handleExecutionConfirm;
exports.handleConnection = handleConnection;
exports.handleDisconnect = handleDisconnect;
exports.sendConnectedMessage = sendConnectedMessage;
exports.sendError = sendError;
exports.handleUnknownMessage = handleUnknownMessage;
const ws_1 = require("ws");
const EventBus_1 = require("../../../shared/EventBus");
const Logger_1 = require("../../../utils/Logger");
/**
 * 处理澄清响应
 */
function handleClarificationResponse(data) {
    Logger_1.Logger.info(`💬 收到澄清回答: ${data.response}`, 'WsHandler');
    EventBus_1.EventBus.emit('clarification_response', {
        traceId: data.traceId || 'unknown',
        response: data.response,
        timestamp: data.timestamp || new Date().toISOString(),
    });
}
/**
 * 处理执行确认
 */
function handleExecutionConfirm(data) {
    Logger_1.Logger.info(`✅ 收到执行确认: ${data.confirmed ? '确认' : '取消'}`, 'WsHandler');
    EventBus_1.EventBus.emit('execution_confirm', {
        traceId: data.traceId || 'unknown',
        confirmed: data.confirmed,
        timestamp: data.timestamp || new Date().toISOString(),
    });
}
/**
 * 处理 WebSocket 连接
 */
function handleConnection(clientIp) {
    Logger_1.Logger.info(`💖 新客户端连接: ${clientIp}`, 'WsHandler');
}
/**
 * 处理 WebSocket 断开
 */
function handleDisconnect(clientIp, cleanupTasksFn) {
    Logger_1.Logger.info(`👋 客户端断开: ${clientIp}`, 'WsHandler');
    cleanupTasksFn(clientIp);
}
/**
 * 发送连接成功消息
 */
function sendConnectedMessage(ws) {
    if (ws.readyState === ws_1.WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'connected',
            data: {
                message: '💖 已连接到家百星智能助手',
                model: process.env.LLM_MODEL || process.env.MODEL_NAME || 'unknown',
                status: 'running',
                timestamp: new Date().toISOString(),
            },
        }));
    }
}
/**
 * 发送错误消息
 */
function sendError(ws, message, traceId) {
    if (ws.readyState === ws_1.WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'error',
            data: { message, traceId },
        }));
    }
}
/**
 * 处理未知消息类型
 */
function handleUnknownMessage(data) {
    Logger_1.Logger.info(`📨 WebSocket收到未知类型: ${data.type}`, 'WsHandler');
}
