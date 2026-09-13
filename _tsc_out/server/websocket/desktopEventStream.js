"use strict";
/**
 * 桌面事件 WebSocket 桥接
 *
 * 将 DesktopEventStream 的事件实时推送到前端监控面板
 * 参考 UI-TARS Event Stream 设计
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.desktopMonitorRoutes = void 0;
exports.setupDesktopEventWebSocket = setupDesktopEventWebSocket;
const ws_1 = __importDefault(require("ws"));
const DesktopEventStream_1 = require("../../desktop/DesktopEventStream");
const DesktopSafetyGuard_1 = require("../../desktop/DesktopSafetyGuard");
const ScreenCapture_1 = require("../../desktop/ScreenCapture");
const Logger_1 = require("../../utils/Logger");
/**
 * 设置桌面事件 WebSocket 处理
 */
function setupDesktopEventWebSocket(wss) {
    const eventStream = DesktopEventStream_1.DesktopEventStream.getInstance();
    const clients = new Set();
    const MAX_DESKTOP_WS_CLIENTS = 20;
    // 订阅事件流
    const unsubscribe = eventStream.subscribe((event) => {
        // 广播给所有连接的客户端
        clients.forEach((client) => {
            if (client.readyState === ws_1.default.OPEN) {
                client.send(JSON.stringify(event));
            }
        });
    });
    wss.on('connection', (ws) => {
        if (clients.size >= MAX_DESKTOP_WS_CLIENTS) {
            Logger_1.Logger.warn(`⚠️ 桌面监控面板连接数超限 (${clients.size}/${MAX_DESKTOP_WS_CLIENTS})`, 'DesktopWS');
            ws.close(1013, 'Max desktop monitoring connections reached');
            return;
        }
        Logger_1.Logger.info('🖥️  桌面监控面板已连接', 'DesktopWS');
        clients.add(ws);
        // 发送历史事件（最近50条）
        const history = eventStream.getHistory(50);
        history.forEach((event) => {
            ws.send(JSON.stringify(event));
        });
        // 处理客户端消息
        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message.toString());
                switch (data.type) {
                    case 'capture_screenshot':
                        // 触发截图
                        Logger_1.Logger.debug('📸 收到截图请求', 'DesktopWS');
                        try {
                            const screenCapture = ScreenCapture_1.ScreenCapture.getInstance();
                            const screenshot = await screenCapture.captureFullScreen();
                            // 截图成功，发送结果给请求的客户端
                            if (ws.readyState === ws_1.default.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'screenshot_result',
                                    success: true,
                                    timestamp: Date.now(),
                                    data: screenshot?.buffer
                                        ? `data:image/png;base64,${screenshot.buffer.toString('base64')}`
                                        : null,
                                }));
                            }
                        }
                        catch (error) {
                            Logger_1.Logger.warn(`截图失败: ${error.message}（桌面自动化可能未初始化）`, 'DesktopWS');
                            if (ws.readyState === ws_1.default.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'screenshot_result',
                                    success: false,
                                    error: error.message,
                                    timestamp: Date.now(),
                                }));
                            }
                        }
                        break;
                    case 'emergency_stop':
                        // 紧急停止
                        Logger_1.Logger.warn('⚠️  收到紧急停止请求', 'DesktopWS');
                        try {
                            const safetyGuard = DesktopSafetyGuard_1.DesktopSafetyGuard.getInstance();
                            safetyGuard.emergencyStop('前端面板触发');
                            if (ws.readyState === ws_1.default.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'emergency_stop_result',
                                    success: true,
                                    timestamp: Date.now(),
                                }));
                            }
                        }
                        catch (error) {
                            Logger_1.Logger.warn(`紧急停止失败: ${error.message}（桌面安全防护可能未初始化）`, 'DesktopWS');
                            if (ws.readyState === ws_1.default.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'emergency_stop_result',
                                    success: false,
                                    error: error.message,
                                    timestamp: Date.now(),
                                }));
                            }
                        }
                        break;
                    case 'get_history':
                        // 获取历史事件
                        const limit = data.limit || 100;
                        const historyEvents = eventStream.getHistory(limit);
                        ws.send(JSON.stringify({
                            type: 'history',
                            data: historyEvents,
                        }));
                        break;
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                        break;
                }
            }
            catch (error) {
                Logger_1.Logger.error('处理桌面WebSocket消息失败', error, 'DesktopWS');
            }
        });
        ws.on('close', () => {
            Logger_1.Logger.info('🖥️  桌面监控面板已断开', 'DesktopWS');
            clients.delete(ws);
        });
        ws.on('error', (error) => {
            Logger_1.Logger.error('桌面WebSocket错误', error, 'DesktopWS');
            clients.delete(ws);
        });
    });
    Logger_1.Logger.info('🔌 桌面事件 WebSocket 桥接已设置', 'DesktopWS');
    // 返回清理函数
    return () => {
        unsubscribe();
        clients.clear();
    };
}
/**
 * 桌面监控面板路由配置
 */
exports.desktopMonitorRoutes = {
    /**
     * 监控面板页面路径
     */
    monitorPagePath: '/desktop-monitor',
    /**
     * WebSocket 路径
     */
    websocketPath: '/desktop-events',
    /**
     * 静态文件目录
     */
    publicDir: 'src/server/public',
};
exports.default = {
    setupDesktopEventWebSocket,
    desktopMonitorRoutes: exports.desktopMonitorRoutes,
};
