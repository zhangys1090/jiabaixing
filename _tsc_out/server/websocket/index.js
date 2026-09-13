"use strict";
/**
 * WebSocket 模块化入口
 *
 * 模块结构：
 * - WsAuth.ts       # 认证逻辑
 * - WsRateLimit.ts  # 限流+熔断
 * - WsDedup.ts      # 去重缓存
 * - WsTaskManager.ts # 任务管理
 * - WsRetry.ts      # 重试逻辑
 * - WsProcessor.ts  # 输入处理核心（重试+熔断+超时+错误友好化）
 * - handlers/       # 消息处理器
 *
 * 使用方法：
 * import { setupWebSocket } from './websocket';
 * setupWebSocket(wss, core);
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.processInputWithRetry = exports.processInputOnce = void 0;
exports.setupWebSocket = setupWebSocket;
const Logger_1 = require("../../utils/Logger");
const SystemInitState_1 = require("../SystemInitState");
// 模块导入
const WsAuth_1 = require("./WsAuth");
const WsTaskManager_1 = require("./WsTaskManager");
// 处理器导入
const handlers_1 = require("./handlers");
// ==================== 单例实例 ====================
const taskManager = new WsTaskManager_1.WsTaskManager();
taskManager.startCleanup();
const authenticator = new WsAuth_1.WsAuthenticator();
const clientConnectTimes = new Map();
const CONNECT_RATE_LIMIT_MS = 2000;
const MAX_CONNECTS_PER_MINUTE = 30;
// P0-4 修复: WS 连接速率 Map 最大容量，防止恶意连接撑爆内存
const MAX_CONNECT_RATE_ENTRIES = 10000;
function checkConnectRate(clientIp) {
    const now = Date.now();
    const times = clientConnectTimes.get(clientIp) || [];
    const recent = times.filter((t) => now - t < 60_000);
    if (recent.length >= MAX_CONNECTS_PER_MINUTE) {
        return false;
    }
    const lastConnect = recent.length > 0 ? recent[recent.length - 1] : 0;
    if (now - lastConnect < CONNECT_RATE_LIMIT_MS) {
        return false;
    }
    recent.push(now);
    // P0-4: 超过最大条目时淘汰最旧条目
    if (!clientConnectTimes.has(clientIp) &&
        clientConnectTimes.size >= MAX_CONNECT_RATE_ENTRIES) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [ip, arr] of clientConnectTimes) {
            const t = arr[0] ?? Infinity;
            if (t < oldestTime) {
                oldestTime = t;
                oldestKey = ip;
            }
        }
        if (oldestKey !== null) {
            clientConnectTimes.delete(oldestKey);
        }
    }
    clientConnectTimes.set(clientIp, recent);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of clientConnectTimes) {
        const recent = times.filter((t) => now - t < 60_000);
        if (recent.length === 0) {
            clientConnectTimes.delete(ip);
        }
        else {
            clientConnectTimes.set(ip, recent);
        }
    }
}, 60_000).unref();
var WsProcessor_1 = require("./WsProcessor");
Object.defineProperty(exports, "processInputOnce", { enumerable: true, get: function () { return WsProcessor_1.processInputOnce; } });
Object.defineProperty(exports, "processInputWithRetry", { enumerable: true, get: function () { return WsProcessor_1.processInputWithRetry; } });
// ==================== 组装入口 ====================
/**
 * 向单个 WebSocket 客户端发送当前系统初始化状态
 */
function sendInitStatus(ws) {
    try {
        const initState = SystemInitState_1.SystemInitState.getInstance();
        ws.send(JSON.stringify({
            type: 'system_init_progress',
            data: initState.getSnapshot(),
        }));
    }
    catch (err) {
        Logger_1.Logger.warn('推送初始化状态失败', 'WsHandler', {
            error: err.message,
        });
    }
}
/**
 * 检查核心系统是否就绪；未就绪时向客户端推送 system_not_ready 消息
 * @returns true 表示已就绪，可以继续处理
 */
function ensureCoreReady(ws, core) {
    if (core && SystemInitState_1.SystemInitState.getInstance().isReady())
        return true;
    try {
        ws.send(JSON.stringify({
            type: 'system_not_ready',
            data: SystemInitState_1.SystemInitState.getInstance().getSnapshot(),
        }));
    }
    catch (err) {
        Logger_1.Logger.warn('无法推送 system_not_ready', 'WsHandler', {
            error: err.message,
        });
    }
    return false;
}
/**
 * 设置 WebSocket 服务器
 *
 * 统一入口：前端、CLI、网关都通过此通道通信。
 * 消息格式中可携带 source 字段：'frontend' | 'cli' | 'gateway'
 * 未就绪时对 user_input/command 返回 system_not_ready，不会阻塞核心。
 */
function setupWebSocket(wss, core) {
    wss?.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress || 'unknown';
        if (!checkConnectRate(clientIp)) {
            Logger_1.Logger.warn(`⚠️ WebSocket连接频率过高，拒绝: ${clientIp}`, 'WsHandler');
            ws.close(1013, '连接频率过高');
            return;
        }
        ws.on('error', (err) => {
            const errMsg = err.message || '';
            if (errMsg.includes('Invalid WebSocket frame')) {
                Logger_1.Logger.warn(`⚠️ WebSocket帧错误(静默关闭): ${errMsg.substring(0, 100)}`, 'WsHandler');
            }
            else {
                Logger_1.Logger.warn(`⚠️ WebSocket客户端错误: ${errMsg}`, 'WsHandler');
            }
            try {
                ws.close(1011, '内部错误');
            }
            catch {
                /* 连接已断开 */
            }
        });
        // 连接数限制
        const MAX_CONNECTIONS = 100;
        if (wss?.clients && wss.clients.size >= MAX_CONNECTIONS) {
            Logger_1.Logger.warn(`⚠️ WebSocket连接数已达上限 ${MAX_CONNECTIONS}，拒绝新连接`, 'WsHandler');
            ws.close(1013, '连接数已达上限');
            return;
        }
        // 生产环境验证 WebSocket 认证令牌
        if (process.env.NODE_ENV === 'production') {
            const token = authenticator.extractTokenFromUrl(req.url || '/');
            const authResult = authenticator.verifyToken(token);
            if (!authResult.valid) {
                Logger_1.Logger.warn(`⚠️ WebSocket认证失败: ${authResult.error}`, 'WsHandler');
                ws.close(4001, authResult.error);
                return;
            }
        }
        (0, handlers_1.handleConnection)(clientIp);
        // 连接建立后，立即推送当前初始化进度
        sendInitStatus(ws);
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message.toString());
                const msgType = data.type;
                const traceId = data.traceId || Logger_1.Logger.generateTraceId();
                switch (msgType) {
                    case 'user_input':
                    case 'command': {
                        // 核心系统未就绪时，返回 system_not_ready 消息，不调用 handleUserInput
                        if (!ensureCoreReady(ws, core))
                            return;
                        const userId = (0, handlers_1.extractUserId)(data);
                        void (0, handlers_1.handleUserInput)(data, userId, clientIp, ws, core, taskManager, traceId);
                        break;
                    }
                    case 'cancel_task':
                        (0, handlers_1.handleCancelTask)(data.traceId, ws, taskManager);
                        break;
                    case 'get_status':
                        (0, handlers_1.handleGetStatus)(ws, wss?.clients.size || 0);
                        // 额外推送一次初始化进度快照，前端可合并展示
                        sendInitStatus(ws);
                        break;
                    case 'get_init_status':
                        sendInitStatus(ws);
                        break;
                    case 'clarification_response':
                        (0, handlers_1.handleClarificationResponse)(data);
                        break;
                    case 'execution_confirm':
                        (0, handlers_1.handleExecutionConfirm)(data);
                        break;
                    case 'automation_task_toggle':
                        if (!ensureCoreReady(ws, core))
                            return;
                        (0, handlers_1.handleAutomationTaskToggle)(data, ws, core);
                        break;
                    case 'automation_task_create':
                        if (!ensureCoreReady(ws, core))
                            return;
                        (0, handlers_1.handleAutomationTaskCreate)(data, core);
                        break;
                    case 'automation_trigger_execute':
                        if (!ensureCoreReady(ws, core))
                            return;
                        (0, handlers_1.handleAutomationTriggerExecute)(data);
                        break;
                    default:
                        (0, handlers_1.handleUnknownMessage)(data);
                }
            }
            catch (error) {
                Logger_1.Logger.error('❌ 解析WebSocket消息失败', error, 'WsHandler');
            }
        });
        ws.on('close', () => {
            (0, handlers_1.handleDisconnect)(clientIp, (ip) => taskManager.cleanupByClientIp(ip));
        });
        (0, handlers_1.sendConnectedMessage)(ws);
    });
}
