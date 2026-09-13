"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGatewayStatus = handleGatewayStatus;
exports.handleGatewayMenu = handleGatewayMenu;
exports.handleGatewayCommandCLI = handleGatewayCommandCLI;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const repl_1 = require("../repl");
const utils_1 = require("../utils");
/**
 * 处理 /gateway 命令 — 显示网关状态（REPL 模式）
 */
async function handleGatewayStatus() {
    const im = (0, utils_1.getIM)();
    const platforms = await im.getPlatforms();
    Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}网关状态${constants_1.COLORS.reset}\n`, 'CLI');
    if (platforms.length === 0) {
        Logger_1.Logger.info(`  ${constants_1.COLORS.dim}未配置任何平台连接${constants_1.COLORS.reset}`, 'CLI');
    }
    else {
        Logger_1.Logger.info(`  已配置 ${platforms.length} 个平台:\n`, 'CLI');
        for (const p of platforms) {
            const s = p.status?.status || 'disconnected';
            const mark = s === 'connected'
                ? '🟢'
                : s === 'connecting'
                    ? '🟡'
                    : s === 'error'
                        ? '🔴'
                        : '⚪';
            const statusText = s === 'connected'
                ? (0, constants_1.c)(constants_1.COLORS.green, '已连接')
                : s === 'connecting'
                    ? (0, constants_1.c)(constants_1.COLORS.yellow, '连接中')
                    : s === 'error'
                        ? (0, constants_1.c)(constants_1.COLORS.red, '错误')
                        : (0, constants_1.c)(constants_1.COLORS.dim, '未连接');
            Logger_1.Logger.info(`    ${mark} ${p.icon} ${p.name}: ${statusText}`, 'CLI');
        }
    }
    Logger_1.Logger.info(`\n  输入 ${constants_1.COLORS.cyan}/gateway menu${constants_1.COLORS.reset} 进入配置菜单`, 'CLI');
    Logger_1.Logger.info('', 'CLI');
}
/**
 * 处理 /gateway 交互菜单（REPL 模式）
 * @param rl - readline 接口
 */
async function handleGatewayMenu(rl) {
    while (true) {
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.cyan}GATEWAY 网关配置${constants_1.COLORS.reset}\n`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}1.${constants_1.COLORS.reset} 微信 (扫码登录) 🟢`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}2.${constants_1.COLORS.reset} 微信 (企业号/公众号 API)`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}3.${constants_1.COLORS.reset} QQ (Mirai) 🐧`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}4.${constants_1.COLORS.reset} 飞书 ✈️`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}5.${constants_1.COLORS.reset} 钉钉 📌`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.dim}  list  查看连接状态  |  back  返回${constants_1.COLORS.reset}\n`, 'CLI');
        const choice = await (0, repl_1.ask)(rl, `  ${constants_1.COLORS.cyan}gateway${constants_1.COLORS.reset}> `);
        if (choice === 'back')
            return;
        const im = (0, utils_1.getIM)();
        switch (choice) {
            case '1': {
                Logger_1.Logger.info('\n  📱 微信扫码登录\n  Playwright 将打开 wx.qq.com 获取二维码', 'CLI');
                try {
                    const ok = await im.connectPlatform('wechat', { mode: 'qr' });
                    Logger_1.Logger.info(ok ? '  ✅ 微信扫码模式已启动' : '  ❌ 启动失败', 'CLI');
                }
                catch (e) {
                    Logger_1.Logger.info(`  ❌ 错误: ${e.message}`, 'CLI');
                }
                break;
            }
            case '2': {
                const appId = await (0, repl_1.ask)(rl, '  AppID: ');
                const appSecret = await (0, repl_1.ask)(rl, '  AppSecret: ');
                const token = await (0, repl_1.ask)(rl, '  Token: ');
                const encodingAESKey = await (0, repl_1.ask)(rl, '  EncodingAESKey (可选): ');
                Logger_1.Logger.info('  ⏳ 连接中...', 'CLI');
                const ok = await im.connectPlatform('wechat', {
                    mode: 'official',
                    appId,
                    appSecret,
                    token,
                    encodingAESKey: encodingAESKey || undefined,
                });
                Logger_1.Logger.info(ok ? '  ✅ 连接成功' : '  ❌ 连接失败', 'CLI');
                break;
            }
            case '3': {
                Logger_1.Logger.info('\n  🐧 QQ 机器人 (Mirai)\n', 'CLI');
                const host = (await (0, repl_1.ask)(rl, '  Mirai HTTP 地址 [localhost]: ')) || 'localhost';
                const port = (await (0, repl_1.ask)(rl, '  Mirai HTTP 端口 [8080]: ')) || '8080';
                const vk = await (0, repl_1.ask)(rl, '  verifyKey: ');
                const qq = await (0, repl_1.ask)(rl, '  QQ 账号: ');
                const qqPassword = await (0, repl_1.ask)(rl, '  QQ 密码 (可选): ');
                Logger_1.Logger.info('  ⏳ 连接中...', 'CLI');
                const ok = await im.connectPlatform('qq', {
                    miraiHttpHost: host,
                    miraiHttpPort: port,
                    miraiVerifyKey: vk,
                    qqAccount: qq,
                    qqPassword: qqPassword || undefined,
                });
                Logger_1.Logger.info(ok ? '  ✅ QQ 已连接' : '  ❌ 连接失败', 'CLI');
                break;
            }
            case '4': {
                const appId = await (0, repl_1.ask)(rl, '  App ID: ');
                const appSecret = await (0, repl_1.ask)(rl, '  App Secret: ');
                const verificationToken = await (0, repl_1.ask)(rl, '  Verification Token (可选): ');
                const encryptKey = await (0, repl_1.ask)(rl, '  Encrypt Key (可选): ');
                Logger_1.Logger.info('  ⏳ 连接中...', 'CLI');
                const ok = await im.connectPlatform('feishu', {
                    appId,
                    appSecret,
                    verificationToken: verificationToken || undefined,
                    encryptKey: encryptKey || undefined,
                });
                Logger_1.Logger.info(ok ? '  ✅ 连接成功' : '  ❌ 连接失败', 'CLI');
                break;
            }
            case '5': {
                const clientId = await (0, repl_1.ask)(rl, '  Client ID: ');
                const clientSecret = await (0, repl_1.ask)(rl, '  Client Secret: ');
                const signatureSecret = await (0, repl_1.ask)(rl, '  签名密钥 (可选): ');
                Logger_1.Logger.info('  ⏳ 连接中...', 'CLI');
                const ok = await im.connectPlatform('dingtalk', {
                    appId: clientId,
                    appSecret: clientSecret,
                    signatureSecret: signatureSecret || undefined,
                });
                Logger_1.Logger.info(ok ? '  ✅ 连接成功' : '  ❌ 连接失败', 'CLI');
                break;
            }
            case 'list': {
                const im2 = (0, utils_1.getIM)();
                const platforms = await im2.getPlatforms();
                Logger_1.Logger.info('\n  平台连接状态:\n', 'CLI');
                for (const p of platforms) {
                    const s = p.status?.status || 'disconnected';
                    const mark = s === 'connected'
                        ? '🟢'
                        : s === 'connecting'
                            ? '🟡'
                            : s === 'error'
                                ? '🔴'
                                : '⚪';
                    Logger_1.Logger.info(`  ${mark} ${p.icon} ${p.name.padEnd(12)} ${s}`, 'CLI');
                }
                Logger_1.Logger.info('', 'CLI');
                break;
            }
            default:
                Logger_1.Logger.info('  未知选项', 'CLI');
        }
    }
}
/**
 * 处理 gateway 子命令 — 网关管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleGatewayCommandCLI(subArgs, options) {
    const action = subArgs[0] || 'list';
    switch (action) {
        case 'list': {
            try {
                const im = (0, utils_1.getIM)();
                const platforms = await im.getPlatforms();
                if (options.json) {
                    process.stdout.write(JSON.stringify(platforms, null, 2) + '\n');
                }
                else {
                    if (!options.quiet) {
                        process.stdout.write(`网关状态 (${platforms.length} 个平台)\n\n`);
                    }
                    if (platforms.length === 0) {
                        process.stdout.write(`  未配置任何平台连接\n`);
                    }
                    else {
                        for (const p of platforms) {
                            const s = p.status?.status || 'disconnected';
                            const mark = s === 'connected'
                                ? '🟢'
                                : s === 'connecting'
                                    ? '🟡'
                                    : s === 'error'
                                        ? '🔴'
                                        : '⚪';
                            process.stdout.write(`  ${mark} ${p.icon} ${p.name}: ${s}\n`);
                        }
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取网关状态失败', err, 'GatewayCommand');
                process.stderr.write(`获取网关状态失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'connect': {
            const platform = subArgs[1];
            if (!platform) {
                process.stderr.write('错误: gateway connect 需要提供平台名称\n');
                process.stderr.write('可用平台: wechat, qq, feishu, dingtalk\n');
                process.exit(1);
            }
            Logger_1.Logger.info(`连接平台: ${platform}`, 'GatewayCommand');
            try {
                const im = (0, utils_1.getIM)();
                const ok = await im.connectPlatform(platform, {});
                if (options.json) {
                    process.stdout.write(JSON.stringify({ success: ok, platform }, null, 2) + '\n');
                }
                else {
                    process.stdout.write(ok ? `✅ ${platform} 已连接\n` : `❌ ${platform} 连接失败\n`);
                }
            }
            catch (err) {
                Logger_1.Logger.error('连接平台失败', err, 'GatewayCommand');
                process.stderr.write(`连接平台失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        default:
            process.stderr.write(`未知 gateway 子命令: ${action}\n`);
            process.stderr.write('用法: gateway list | gateway connect <平台>\n');
            process.exit(1);
    }
}
