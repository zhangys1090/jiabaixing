"use strict";
/**
 * WebSocket 状态查询处理
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGetStatus = handleGetStatus;
const ws_1 = __importDefault(require("ws"));
/**
 * 处理状态查询
 */
function handleGetStatus(ws, clientCount) {
    if (ws.readyState === ws_1.default.OPEN) {
        ws.send(JSON.stringify({
            type: 'status',
            data: {
                status: 'running',
                model: process.env.LLM_MODEL || process.env.MODEL_NAME || 'unknown',
                uptime: process.uptime(),
                clients: clientCount,
            },
        }));
    }
}
