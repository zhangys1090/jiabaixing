"use strict";
/**
 * CLI WebSocket 客户端
 *
 * 连接后端 WebSocket 服务器，接收实时事件：
 *   - 工具执行追踪（tool_start / tool_complete / tool_error）
 *   - Agent 执行状态（plan / execute / evaluate / report）
 *   - 进化事件（evolution_cycle / strategy_adjust）
 *   - 会话事件（session_switch / message_stream）
 *
 * 使得 CLI 从"请求-响应"模式升级为"实时事件驱动"模式，
 * 用户可以在终端中实时看到 Agent 的每一步执行过程。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLIWebSocketClient = void 0;
exports.getWSClient = getWSClient;
exports.initCLIWebSocket = initCLIWebSocket;
const ws_1 = __importDefault(require("ws"));
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
const constants_1 = require("./constants");
const WS_URL = `ws://localhost:${constants_1.backendPort}`;
class CLIWebSocketClient {
    ws = null;
    reconnectAttempts = 0;
    maxReconnectAttempts = 10;
    reconnectInterval = 3000;
    isConnecting = false;
    sessionId = null;
    /** 连接状态 */
    get connected() {
        return this.ws !== null && this.ws.readyState === ws_1.default.OPEN;
    }
    /**
     * 设置当前会话 ID
     * WebSocket 连接后发送此 ID，后端据此推送对应会话的事件
     */
    setSessionId(id) {
        this.sessionId = id;
        if (this.connected && this.ws) {
            this.ws.send(JSON.stringify({ type: 'session_switch', sessionId: id }));
        }
    }
    /**
     * 连接到后端 WebSocket 服务器
     */
    connect() {
        if (this.isConnecting || this.connected)
            return;
        this.isConnecting = true;
        Logger_1.Logger.debug(`连接 WebSocket: ${WS_URL}`, 'CLIWS');
        try {
            this.ws = new ws_1.default(WS_URL);
            this.ws.on('open', () => {
                this.reconnectAttempts = 0;
                this.isConnecting = false;
                Logger_1.Logger.debug('WebSocket 已连接', 'CLIWS');
                // 发送会话 ID（如果已有）
                if (this.sessionId) {
                    this.ws.send(JSON.stringify({
                        type: 'session_switch',
                        sessionId: this.sessionId,
                    }));
                }
                EventBus_1.EventBus.emit('ws_connected', { url: WS_URL });
            });
            this.ws.on('message', (data) => {
                try {
                    const event = JSON.parse(data.toString());
                    // 将所有事件转发到 EventBus
                    if (event.type) {
                        // 使用类型断言绕过 EventMap 严格键检查（事件来自后端动态推送）
                        EventBus_1.EventBus.emit(event.type, event);
                    }
                }
                catch (err) {
                    Logger_1.Logger.debug('WebSocket 消息解析失败', 'CLIWS', err);
                }
            });
            this.ws.on('close', () => {
                this.isConnecting = false;
                Logger_1.Logger.debug('WebSocket 已断开', 'CLIWS');
                EventBus_1.EventBus.emit('ws_disconnected', {});
                this.scheduleReconnect();
            });
            this.ws.on('error', (err) => {
                this.isConnecting = false;
                Logger_1.Logger.warn('WebSocket 错误', 'CLIWS', err);
                this.scheduleReconnect();
            });
        }
        catch (err) {
            this.isConnecting = false;
            Logger_1.Logger.warn('WebSocket 连接失败', 'CLIWS', err);
            this.scheduleReconnect();
        }
    }
    /**
     * 断开 WebSocket 连接
     */
    disconnect() {
        this.maxReconnectAttempts = 0; // 阻止重连
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    /**
     * 发送消息到 WebSocket 服务器
     */
    send(message) {
        if (this.connected && this.ws) {
            this.ws.send(JSON.stringify(message));
        }
    }
    /**
     * 自动重连调度
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            Logger_1.Logger.debug('WebSocket 重连次数超限，停止重连', 'CLIWS');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectInterval * this.reconnectAttempts, 30000);
        Logger_1.Logger.debug(`WebSocket ${delay}ms 后尝试第 ${this.reconnectAttempts} 次重连`, 'CLIWS');
        setTimeout(() => {
            this.connect();
        }, delay);
    }
}
exports.CLIWebSocketClient = CLIWebSocketClient;
/** 全局单例 */
let wsClient = null;
function getWSClient() {
    if (!wsClient) {
        wsClient = new CLIWebSocketClient();
    }
    return wsClient;
}
/**
 * 初始化 WebSocket 客户端并注册 CLI 事件显示
 * 在 REPL mainLoop 中调用
 */
function initCLIWebSocket() {
    const client = getWSClient();
    // 注册工具追踪事件 → 在终端显示
    EventBus_1.EventBus.on('tool_start', (payload) => {
        Logger_1.Logger.info(`  🔧 执行工具: ${payload.toolName}`, 'CLIWS');
    });
    EventBus_1.EventBus.on('tool_complete', (payload) => {
        const dur = payload.duration ? ` (${payload.duration}ms)` : '';
        Logger_1.Logger.info(`  ✅ 工具完成: ${payload.toolName}${dur}`, 'CLIWS');
    });
    EventBus_1.EventBus.on('tool_error', (payload) => {
        Logger_1.Logger.info(`  ❌ 工具错误: ${payload.toolName} — ${payload.error}`, 'CLIWS');
    });
    // 注册 Agent 执行状态事件
    EventBus_1.EventBus.on('agent_plan', (payload) => {
        Logger_1.Logger.info(`  📋 规划 ${payload.steps.length} 步: ${payload.steps[0]?.description}`, 'CLIWS');
    });
    EventBus_1.EventBus.on('agent_execute', (payload) => {
        const icon = payload.status === 'running'
            ? '⏳'
            : payload.status === 'completed'
                ? '✅'
                : '❌';
        Logger_1.Logger.info(`  ${icon} 步骤 ${payload.stepIndex}: ${payload.status}`, 'CLIWS');
    });
    EventBus_1.EventBus.on('agent_evaluate', (payload) => {
        Logger_1.Logger.info(`  🔍 评估: 质量 ${(payload.qualityScore * 100).toFixed(0)}%`, 'CLIWS');
    });
    // 注册进化事件
    EventBus_1.EventBus.on('evolution_cycle', (payload) => {
        Logger_1.Logger.info(`  🧬 进化周期: ${payload.reason}`, 'CLIWS');
    });
    // 注册审批请求事件 — 在 CLI 中显示确认提示
    EventBus_1.EventBus.on('approval_request', async (request) => {
        const riskIcon = request.risk === 'critical'
            ? '🚨'
            : request.risk === 'high'
                ? '⚠️'
                : 'ℹ️';
        Logger_1.Logger.info(`\n  ${riskIcon} 审批请求 [${request.type}] 风险: ${request.risk}`, 'Approval');
        Logger_1.Logger.info(`  ${request.description}`, 'Approval');
        Logger_1.Logger.info(`  目标: ${request.target}`, 'Approval');
        Logger_1.Logger.info(`  输入 y 批准 / n 拒绝 / b 批量批准（10分钟内同类操作自动批准）`, 'Approval');
        // 通过 stdin 等待用户输入
        process.stdout.write('  批准? [y/N/b]: ');
        const answer = await new Promise((resolve) => {
            const handler = (data) => {
                process.stdin.removeListener('data', handler);
                resolve(data.toString().trim().toLowerCase());
            };
            process.stdin.once('data', handler);
            // 60 秒超时
            setTimeout(() => {
                process.stdin.removeListener('data', handler);
                resolve('');
            }, 60000);
        });
        const approved = answer === 'y' || answer === 'yes';
        const batchApprove = answer === 'b' || answer === 'batch';
        // 通过 HTTP 响应审批
        try {
            const { backendUrl } = require('./constants');
            await fetch(`${backendUrl}/api/approvals/${request.id}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    approved: approved || batchApprove,
                    batchApprove,
                }),
            });
            Logger_1.Logger.info(approved || batchApprove ? '  ✅ 已批准' : '  ❌ 已拒绝', 'Approval');
        }
        catch (err) {
            Logger_1.Logger.warn(`  审批响应发送失败: ${err.message}`, 'Approval');
        }
    });
    client.connect();
    return client;
}
