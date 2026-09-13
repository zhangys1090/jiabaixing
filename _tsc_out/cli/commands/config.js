"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleConfigMenu = handleConfigMenu;
exports.handleEnvCommand = handleEnvCommand;
const path = __importStar(require("path"));
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
const repl_1 = require("../repl");
const utils_1 = require("../utils");
/**
 * 处理 /config 交互菜单（REPL 模式）
 * @param rl - readline 接口
 */
async function handleConfigMenu(rl) {
    while (true) {
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.cyan}CONFIG 系统配置${constants_1.COLORS.reset}\n`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}show${constants_1.COLORS.reset}   显示当前配置`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}env${constants_1.COLORS.reset}    编辑 .env 文件`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}model${constants_1.COLORS.reset}  模型配置`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}gateway${constants_1.COLORS.reset} Tool Gateway 配置`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.dim}  back  返回${constants_1.COLORS.reset}\n`, 'CLI');
        const choice = await (0, repl_1.ask)(rl, `  ${constants_1.COLORS.cyan}config${constants_1.COLORS.reset}> `);
        if (choice === 'back')
            return;
        switch (choice) {
            case 'show': {
                const envFile = (0, utils_1.getEnvFilePath)();
                Logger_1.Logger.info('\n  .env 配置:\n', 'CLI');
                const lines = (0, utils_1.readEnvFileSafe)(envFile);
                for (const line of lines) {
                    Logger_1.Logger.info(`  ${line}`, 'CLI');
                }
                Logger_1.Logger.info('', 'CLI');
                break;
            }
            case 'env': {
                const envFile = (0, utils_1.getEnvFilePath)();
                try {
                    const { execSync } = require('child_process');
                    if (process.platform === 'win32') {
                        execSync(`notepad "${envFile}"`);
                    }
                    else {
                        execSync(`vi "${envFile}"`, { stdio: 'inherit' });
                    }
                }
                catch {
                    Logger_1.Logger.info(`  .env 路径: ${envFile}\n`, 'CLI');
                }
                break;
            }
            case 'model': {
                const { getProviderManager, runSetupCLI, } = require('../../../config/setup');
                Logger_1.Logger.info('', 'CLI');
                const manager = getProviderManager();
                const providers = manager.getAll();
                const primary = manager.getPrimary();
                if (providers.length === 0) {
                    Logger_1.Logger.info('  ⚠️ 未配置任何 LLM Provider\n', 'CLI');
                    Logger_1.Logger.info('  是否添加第一个 Provider?', 'CLI');
                    const ans = await (0, repl_1.ask)(rl, '  (y/n): ');
                    if (ans.toLowerCase() === 'y') {
                        await runSetupCLI(['--add']);
                    }
                }
                else {
                    Logger_1.Logger.info(`  ${constants_1.COLORS.bold}已配置 ${providers.length} 个 Provider:${constants_1.COLORS.reset}\n`, 'CLI');
                    for (const p of providers) {
                        const mark = primary?.name === p.name
                            ? ` ${constants_1.COLORS.green}(主)${constants_1.COLORS.reset}`
                            : '';
                        const status = p.healthy === undefined
                            ? '?'
                            : p.healthy
                                ? `${constants_1.COLORS.green}✓${constants_1.COLORS.reset}`
                                : `${constants_1.COLORS.red}✗${constants_1.COLORS.reset}`;
                        Logger_1.Logger.info(`  ${status} ${p.displayName} ${constants_1.COLORS.dim}(${p.model})${constants_1.COLORS.reset}${mark}`, 'CLI');
                    }
                    Logger_1.Logger.info(`\n  路由: ${manager.getRouting().enabled ? `${constants_1.COLORS.green}启用${constants_1.COLORS.reset}` : '禁用'}`, 'CLI');
                    Logger_1.Logger.info(`\n  输入 ${constants_1.COLORS.cyan}setup${constants_1.COLORS.reset} 打开配置向导`, 'CLI');
                    Logger_1.Logger.info(`  输入 ${constants_1.COLORS.cyan}add${constants_1.COLORS.reset} 添加新的 Provider`, 'CLI');
                    Logger_1.Logger.info(`  输入 ${constants_1.COLORS.cyan}switch${constants_1.COLORS.reset} 切换主模型`, 'CLI');
                    const sub = await (0, repl_1.ask)(rl, `  ${constants_1.COLORS.cyan}config model${constants_1.COLORS.reset}> `);
                    if (sub === 'setup') {
                        await runSetupCLI([]);
                    }
                    else if (sub === 'add') {
                        await runSetupCLI(['--add']);
                    }
                    else if (sub === 'switch') {
                        Logger_1.Logger.info('', 'CLI');
                        providers.forEach((p, _i) => {
                            const mark = primary?.name === p.name ? ' ★' : '';
                            Logger_1.Logger.info(`  ${_i + 1}. ${p.displayName}${mark}`, 'CLI');
                        });
                        const idx = parseInt(await (0, repl_1.ask)(rl, '  选择主模型 (1)')) - 1;
                        if (idx >= 0 && idx < providers.length) {
                            manager.setPrimary(providers[idx].name);
                            Logger_1.Logger.info(`  ${constants_1.COLORS.green}✅ 主模型已切换为 ${providers[idx].displayName}${constants_1.COLORS.reset}\n`, 'CLI');
                        }
                    }
                }
                break;
            }
            case 'gateway': {
                await handleGatewayConfig(rl);
                break;
            }
            default:
                Logger_1.Logger.info('  未知命令', 'CLI');
        }
    }
}
/**
 * 处理 Tool Gateway 交互式配置
 * @param rl - readline 接口
 */
async function handleGatewayConfig(rl) {
    const { getProviderManager } = require('../../models/ProviderManager');
    const manager = getProviderManager();
    const status = manager.getToolGatewayStatus();
    Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.cyan}◆ Nous Tool Gateway${constants_1.COLORS.reset}\n`, 'CLI');
    // 显示当前状态
    if (status.hasToken) {
        Logger_1.Logger.info(`  订阅状态: ${constants_1.COLORS.green}✓ 已配置${constants_1.COLORS.reset}`, 'CLI');
    }
    else {
        Logger_1.Logger.info(`  订阅状态: ${constants_1.COLORS.yellow}○ 未配置 Token${constants_1.COLORS.reset}`, 'CLI');
    }
    Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}工具网关状态:${constants_1.COLORS.reset}`, 'CLI');
    for (const tool of status.tools) {
        const gatewayMark = tool.useGateway
            ? `${constants_1.COLORS.green}✓ 网关${constants_1.COLORS.reset} (${tool.backend})`
            : `${constants_1.COLORS.dim}○ 直连${constants_1.COLORS.reset}`;
        Logger_1.Logger.info(`    ${tool.name.padEnd(12)} ${gatewayMark}`, 'CLI');
    }
    Logger_1.Logger.info(`\n  ${constants_1.COLORS.cyan}token${constants_1.COLORS.reset}   设置 Nous Portal Token`, 'CLI');
    Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}toggle${constants_1.COLORS.reset}  切换工具网关开关`, 'CLI');
    Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}enable${constants_1.COLORS.reset}  一键启用全部网关`, 'CLI');
    Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}disable${constants_1.COLORS.reset} 一键禁用全部网关`, 'CLI');
    Logger_1.Logger.info(`  ${constants_1.COLORS.dim}  back  返回${constants_1.COLORS.reset}\n`, 'CLI');
    const sub = await (0, repl_1.ask)(rl, `  ${constants_1.COLORS.cyan}config gateway${constants_1.COLORS.reset}> `);
    switch (sub) {
        case 'token': {
            Logger_1.Logger.info('\n  请输入 Nous Portal Token（从 https://nousresearch.com 获取）:', 'CLI');
            const token = await (0, repl_1.ask)(rl, '  Token: ');
            if (token && token.trim()) {
                manager.updateToolGateway({ userToken: token.trim() });
                Logger_1.Logger.info(`  ${constants_1.COLORS.green}✅ Token 已保存${constants_1.COLORS.reset}\n`, 'CLI');
            }
            break;
        }
        case 'toggle': {
            Logger_1.Logger.info('\n  选择要切换的工具:', 'CLI');
            const toolNames = ['web', 'imageGen', 'tts', 'browser'];
            const toolLabels = {
                web: '网页搜索与抓取',
                imageGen: '文生图',
                tts: '语音合成',
                browser: '浏览器自动化',
            };
            toolNames.forEach((name, i) => {
                const current = status.tools.find((t) => t.name === name);
                const state = current?.useGateway
                    ? `${constants_1.COLORS.green}网关${constants_1.COLORS.reset}`
                    : `${constants_1.COLORS.dim}直连${constants_1.COLORS.reset}`;
                Logger_1.Logger.info(`  ${i + 1}. ${toolLabels[name].padEnd(12)} ${state}`, 'CLI');
            });
            const idx = parseInt(await (0, repl_1.ask)(rl, '  选择 (1-4): ')) - 1;
            if (idx >= 0 && idx < toolNames.length) {
                const toolName = toolNames[idx];
                const current = status.tools.find((t) => t.name === toolName);
                manager.updateToolGatewayTool(toolName, {
                    useGateway: !current?.useGateway,
                });
                const newState = !current?.useGateway ? '网关' : '直连';
                Logger_1.Logger.info(`  ${constants_1.COLORS.green}✅ ${toolLabels[toolName]} 已切换为 ${newState}${constants_1.COLORS.reset}\n`, 'CLI');
            }
            break;
        }
        case 'enable': {
            manager.updateToolGateway({
                tools: {
                    web: { useGateway: true, backend: 'firecrawl' },
                    imageGen: { useGateway: true, backend: 'fal' },
                    tts: { useGateway: true, backend: 'openai' },
                    browser: { useGateway: true, backend: 'browser-use' },
                },
            });
            Logger_1.Logger.info(`  ${constants_1.COLORS.green}✅ 全部工具已启用网关${constants_1.COLORS.reset}\n`, 'CLI');
            break;
        }
        case 'disable': {
            manager.updateToolGateway({
                tools: {
                    web: { useGateway: false, backend: 'firecrawl' },
                    imageGen: { useGateway: false, backend: 'fal' },
                    tts: { useGateway: false, backend: 'openai' },
                    browser: { useGateway: false, backend: 'browser-use' },
                },
            });
            Logger_1.Logger.info(`  ${constants_1.COLORS.yellow}✅ 全部工具已切换为直连模式${constants_1.COLORS.reset}\n`, 'CLI');
            break;
        }
        case 'back':
            return;
        default:
            Logger_1.Logger.info('  未知命令', 'CLI');
    }
}
/**
 * 处理 /env 命令（REPL 模式）
 * 显示桌面环境信息
 */
async function handleEnvCommand() {
    try {
        const health = await (0, ipc_1.requestWithFallback)('status', {}, { path: '/api/health' });
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}桌面环境${constants_1.COLORS.reset}\n`, 'CLI');
        Logger_1.Logger.info(`  后端: ${health.status}`, 'CLI');
        Logger_1.Logger.info(`  模型: ${health.model}`, 'CLI');
        Logger_1.Logger.info(`  运行: ${Math.round(health.uptime / 60)} 分钟\n`, 'CLI');
        // 尝试获取前台窗口信息
        const windowInfo = (0, utils_1.getForegroundWindowInfo)();
        if (windowInfo) {
            Logger_1.Logger.info(`  前台窗口:`, 'CLI');
            Logger_1.Logger.info(`    ${constants_1.COLORS.cyan}进程:${constants_1.COLORS.reset} ${windowInfo.proc}`, 'CLI');
            Logger_1.Logger.info(`    ${constants_1.COLORS.cyan}标题:${constants_1.COLORS.reset} ${windowInfo.title.substring(0, 80)}`, 'CLI');
            const envType = (0, utils_1.detectEnvironmentType)(windowInfo.title, windowInfo.proc);
            Logger_1.Logger.info(`  环境: ${envType}`, 'CLI');
        }
        else {
            Logger_1.Logger.info(`  ${constants_1.COLORS.dim}未检测到前台窗口${constants_1.COLORS.reset}`, 'CLI');
        }
        // Git状态
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.dim}项目Git状态:${constants_1.COLORS.reset}`, 'CLI');
        const dirs = [
            process.cwd(),
            path.resolve(process.cwd(), '..', 'hermes-agent-main'),
        ];
        const gitResults = (0, utils_1.getGitStatus)(dirs);
        for (const resultJson of gitResults) {
            const { name, branch, uncommitted, lastMsg } = JSON.parse(resultJson);
            const marker = uncommitted > 0
                ? (0, constants_1.c)(constants_1.COLORS.yellow, ` ⚡${uncommitted}个未提交`)
                : (0, constants_1.c)(constants_1.COLORS.green, ' ✅ 干净');
            Logger_1.Logger.info(`    ${constants_1.COLORS.cyan}${name}${constants_1.COLORS.reset} [${branch}]${marker}`, 'CLI');
            Logger_1.Logger.info(`    ${constants_1.COLORS.dim}${lastMsg.substring(0, 60)}${constants_1.COLORS.reset}`, 'CLI');
        }
    }
    catch {
        Logger_1.Logger.info(`  ${(0, constants_1.c)(constants_1.COLORS.red, '❌ 获取环境状态失败')}`, 'CLI');
    }
    Logger_1.Logger.info('', 'CLI');
}
