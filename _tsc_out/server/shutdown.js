"use strict";
/**
 * 优雅关闭处理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.gracefulShutdown = gracefulShutdown;
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const Logger_1 = require("../utils/Logger");
const bootstrap_1 = require("./bootstrap");
let isShuttingDown = false;
async function gracefulShutdown(signal, core, wss, server) {
    if (isShuttingDown) {
        Logger_1.Logger.info(`已在关闭流程中，忽略重复 ${signal} 信号`, 'Main');
        return;
    }
    isShuttingDown = true;
    Logger_1.Logger.info(`🔄 收到 ${signal} 信号，准备优雅关闭...`, 'Main');
    if (core) {
        const scheduler = core.getScenarioScheduler?.();
        if (scheduler && typeof scheduler.stop === 'function') {
            scheduler.stop();
            Logger_1.Logger.info('✅ 场景感知调度器已停止', 'Main');
        }
    }
    try {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            await bridge.stopAllMcpServers();
            Logger_1.Logger.info('✅ MCP服务器已停止', 'Main');
        }
        else {
            Logger_1.Logger.info('⏭️ MCP服务器跳过停止（Python 后端未连接）', 'Main');
        }
    }
    catch (err) {
        Logger_1.Logger.warn(`MCP 服务器清理失败（不影响关闭）: ${err}`, 'Main');
    }
    // 关闭 IPC 服务器
    try {
        await (0, bootstrap_1.stopIpcServer)();
    }
    catch (err) {
        Logger_1.Logger.warn(`IPC 关闭失败（不影响主流程）: ${err}`, 'Main');
    }
    if (wss) {
        wss.clients.forEach((client) => {
            client.close(1001, '系统维护中');
        });
        wss.close();
    }
    // 尝试使用 closeAllConnections (Node.js 18.2+) 确保残留连接被关闭
    if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
    }
    server.close(() => {
        Logger_1.Logger.info('✅ 服务已安全关闭', 'Main');
        process.exit(0);
    });
    setTimeout(() => {
        Logger_1.Logger.info('⚠️ 优雅关闭超时，强制退出', 'Main');
        // P1-6 修复: 优雅关闭超时仍属正常退出（非异常），使用 exit code 0
        // 避免监控系统（systemd/K8s/PM2）误判为异常崩溃而触发不必要的重启告警
        process.exit(0);
    }, 10000);
}
