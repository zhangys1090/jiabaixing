"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const IntegrationManager_1 = require("./IntegrationManager");
const Logger_1 = require("../utils/Logger");
const EventBus_1 = require("../shared/EventBus");
const im = IntegrationManager_1.IntegrationManager.getInstance();
function send(msg) {
    if (process.send) {
        process.send(msg);
    }
}
function handleMessage(msg) {
    switch (msg.type) {
        case 'connect': {
            const { platform, config } = msg.payload;
            im.connectPlatform(platform, config)
                .then((success) => {
                send({
                    id: msg.id,
                    success,
                    data: { platform, status: success ? 'connected' : 'failed' },
                });
            })
                .catch((err) => {
                send({ id: msg.id, success: false, error: err.message });
            });
            break;
        }
        case 'disconnect': {
            const { platform: dp } = msg.payload;
            im.disconnectPlatform(dp)
                .then(() => {
                send({ id: msg.id, success: true, data: { platform: dp } });
            })
                .catch((err) => {
                send({ id: msg.id, success: false, error: err.message });
            });
            break;
        }
        case 'sendMessage': {
            const req = msg.payload;
            im.sendMessage(req)
                .then((result) => {
                send({ id: msg.id, success: result.success, data: result });
            })
                .catch((err) => {
                send({ id: msg.id, success: false, error: err.message });
            });
            break;
        }
        case 'getPlatforms': {
            const platforms = im.getPlatforms();
            send({ id: msg.id, success: true, data: { platforms } });
            break;
        }
        case 'getStatus': {
            const { platform: sp } = msg.payload;
            const status = im.getPlatformStatus(sp);
            send({ id: msg.id, success: true, data: status });
            break;
        }
        case 'getWeChatQRState': {
            const qrState = im.getWeChatQRState();
            send({ id: msg.id, success: true, data: qrState });
            break;
        }
        case 'handleWebhook': {
            const { platform: wp, payload: wPayload } = msg.payload;
            im.handleWebhook(wp, wPayload)
                .then((result) => {
                send({ id: msg.id, success: result.success, data: result });
            })
                .catch((err) => {
                send({ id: msg.id, success: false, error: err.message });
            });
            break;
        }
        case 'ping': {
            send({
                id: msg.id,
                success: true,
                data: { status: 'alive', pid: process.pid },
            });
            break;
        }
        default:
            send({
                id: msg.id,
                success: false,
                error: `Unknown message type: ${msg.type}`,
            });
    }
}
EventBus_1.EventBus.on('integration_message', (message) => {
    send({
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        success: true,
        data: { type: 'incoming_message', payload: message },
    });
});
process.on('message', (msg) => {
    handleMessage(msg);
});
process.on('uncaughtException', (error) => {
    Logger_1.Logger.error('Gateway Worker 未捕获异常', error, 'GatewayWorker');
    try {
        send({
            id: `err_${Date.now()}`,
            success: false,
            error: `Worker uncaught exception: ${error.message}`,
        });
    }
    catch {
        // 发送失败也继续退出
    }
    // 未捕获异常代表 Worker 已处于损坏状态，必须退出由父进程重启，
    // 否则僵尸 Worker 持续运行（审计 S-02：原仅上报不退出）。
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    Logger_1.Logger.error('Gateway Worker 未处理的 Promise 拒绝', reason, 'GatewayWorker');
    try {
        send({
            id: `err_${Date.now()}`,
            success: false,
            error: `Worker unhandled rejection: ${String(reason)}`,
        });
    }
    catch {
        // 发送失败也继续退出
    }
    process.exit(1);
});
Logger_1.Logger.info('🟢 Gateway Worker 已启动', 'GatewayWorker');
send({
    id: 'worker_ready',
    success: true,
    data: { type: 'ready', pid: process.pid },
});
