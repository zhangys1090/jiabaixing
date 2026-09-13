"use strict";
/**
 * WebSocket 取消任务处理
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCancelTask = handleCancelTask;
const ws_1 = __importDefault(require("ws"));
const EventBus_1 = require("../../../shared/EventBus");
const Logger_1 = require("../../../utils/Logger");
/**
 * 处理取消任务
 */
function handleCancelTask(traceId, ws, taskManager) {
    if (!traceId) {
        Logger_1.Logger.info('🛑 取消任务缺少 traceId', 'WsHandler');
        return;
    }
    if (traceId.length > 256) {
        Logger_1.Logger.info('🛑 取消任务 traceId 过长', 'WsHandler');
        return;
    }
    if (!taskManager.has(traceId)) {
        Logger_1.Logger.info(`🛑 取消任务未找到: traceId=${traceId}`, 'WsHandler');
        return;
    }
    const cancelled = taskManager.cancel(traceId);
    if (cancelled) {
        Logger_1.Logger.info(`🛑 用户取消任务: traceId=${traceId}`, 'WsHandler');
        EventBus_1.EventBus.emit('agent_execution_update', {
            traceId,
            phase: 'cancelled',
            status: 'aborted',
            message: '用户已取消任务',
            timestamp: new Date().toISOString(),
        });
        if (ws.readyState === ws_1.default.OPEN) {
            ws.send(JSON.stringify({
                type: 'task_cancelled',
                data: { traceId, message: '任务已取消' },
            }));
        }
    }
}
