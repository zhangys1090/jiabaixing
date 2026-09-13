"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleStatusCommand = handleStatusCommand;
exports.handleStatusCommandCLI = handleStatusCommandCLI;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const utils_1 = require("../utils");
/**
 * 处理 /status 命令（REPL 模式）
 * 显示系统运行状态
 */
async function handleStatusCommand() {
    const health = await (0, utils_1.checkBackendHealth)();
    Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}系统状态${constants_1.COLORS.reset}\n`, 'CLI');
    Logger_1.Logger.info(`  后端服务: ${health.online ? (0, constants_1.c)(constants_1.COLORS.green, '🟢 在线') : (0, constants_1.c)(constants_1.COLORS.red, '🔴 离线')}`, 'CLI');
    Logger_1.Logger.info(`  健康状态: ${health.status || 'unknown'}`, 'CLI');
    if (health.uptime) {
        Logger_1.Logger.info(`  运行时间: ${Math.round(health.uptime / 60)} 分钟`, 'CLI');
    }
    if (health.services) {
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.dim}服务组件:${constants_1.COLORS.reset}`, 'CLI');
        for (const [name, svc] of Object.entries(health.services)) {
            const info = svc;
            const mark = info.status === 'ok' ? (0, constants_1.c)(constants_1.COLORS.green, '🟢') : (0, constants_1.c)(constants_1.COLORS.red, '🔴');
            Logger_1.Logger.info(`    ${mark} ${name}: ${info.message || info.status || '-'}`, 'CLI');
        }
    }
    const im = (0, utils_1.getIM)();
    const platforms = await im.getPlatforms();
    if (platforms.length > 0) {
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.dim}平台连接:${constants_1.COLORS.reset}`, 'CLI');
        for (const p of platforms) {
            const s = p.status?.status || 'disconnected';
            const mark = s === 'connected'
                ? '🟢'
                : s === 'connecting'
                    ? '🟡'
                    : s === 'error'
                        ? '🔴'
                        : '⚪';
            Logger_1.Logger.info(`    ${mark} ${p.icon} ${p.name}: ${s}`, 'CLI');
        }
    }
    Logger_1.Logger.info('', 'CLI');
}
/**
 * 处理 status 子命令 — 查看系统状态
 * @param options - 子命令选项
 */
async function handleStatusCommandCLI(options) {
    Logger_1.Logger.info('查看系统状态', 'StatusCommand');
    try {
        const health = await (0, utils_1.checkBackendHealth)();
        if (options.json) {
            process.stdout.write(JSON.stringify(health, null, 2) + '\n');
        }
        else {
            process.stdout.write(`系统状态\n\n`);
            process.stdout.write(`  后端服务: ${health.online ? '在线' : '离线'}\n`);
            process.stdout.write(`  健康状态: ${health.status || 'unknown'}\n`);
            if (health.uptime) {
                process.stdout.write(`  运行时间: ${Math.round(health.uptime / 60)} 分钟\n`);
            }
            if (health.model) {
                process.stdout.write(`  模型: ${health.model}\n`);
            }
            if (health.services) {
                process.stdout.write(`\n  服务组件:\n`);
                for (const [name, svc] of Object.entries(health.services)) {
                    const info = svc;
                    process.stdout.write(`    ${info.status === 'ok' ? '🟢' : '🔴'} ${name}: ${info.message || info.status || '-'}\n`);
                }
            }
        }
    }
    catch (err) {
        Logger_1.Logger.error('获取系统状态失败', err, 'StatusCommand');
        process.stderr.write(`获取系统状态失败: ${err.message}\n`);
        process.exit(1);
    }
}
