"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleEvolutionCommand = handleEvolutionCommand;
exports.handleEvolutionCommandCLI = handleEvolutionCommandCLI;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
/**
 * 处理 /evolution 命令（REPL 模式）
 * 显示进化数据
 */
async function handleEvolutionCommand() {
    try {
        const data = await (0, ipc_1.requestWithFallback)('evolution.status', {}, { path: '/api/evolution/status' });
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}进化数据${constants_1.COLORS.reset}\n`, 'CLI');
        if (data.orchestrator) {
            const o = data.orchestrator;
            Logger_1.Logger.info(`  交互: ${o.totalInteractions || 0} 次`, 'CLI');
            Logger_1.Logger.info(`  优化: ${o.totalOptimizations || 0} 次`, 'CLI');
            Logger_1.Logger.info(`  平均质量: ${(o.averageQualityScore || 0).toFixed(3)}`, 'CLI');
            Logger_1.Logger.info(`  趋势: ${o.qualityTrend || 'stable'}`, 'CLI');
            Logger_1.Logger.info(`  失败率: ${((o.failureRate || 0) * 100).toFixed(1)}%`, 'CLI');
            Logger_1.Logger.info(`  今日周期: ${o.cyclesToday || 0}`, 'CLI');
            Logger_1.Logger.info(`  总周期: ${o.totalCycles || 0}`, 'CLI');
            if (o.lastCycleTime) {
                const ago = Math.round((Date.now() - o.lastCycleTime) / 60000);
                Logger_1.Logger.info(`  上次优化: ${ago} 分钟前`, 'CLI');
            }
            if (o.userProfileConfidence) {
                Logger_1.Logger.info(`  画像置信度: ${(o.userProfileConfidence * 100).toFixed(0)}%`, 'CLI');
            }
        }
        else {
            Logger_1.Logger.info(`  ${constants_1.COLORS.dim}进化引擎未启动${constants_1.COLORS.reset}`, 'CLI');
        }
        if (data.enginesActive?.length) {
            Logger_1.Logger.info(`  活跃引擎: ${data.enginesActive.join(', ')}`, 'CLI');
        }
        // 额外获取优化结果详情
        try {
            const metricsData = await (0, ipc_1.requestWithFallback)('evolution.metrics', {}, { path: '/api/evolution/metrics' });
            const history = metricsData.data?.optimizationHistory;
            if (history && history.length > 0) {
                Logger_1.Logger.info(`\n  ${constants_1.COLORS.dim}最近优化:${constants_1.COLORS.reset}`, 'CLI');
                for (const h of history.slice(-3)) {
                    const tone = h.toneAdjustments?.length || 0;
                    const skill = h.skillAdjustments?.length || 0;
                    const prompt = h.promptExamples?.length || 0;
                    Logger_1.Logger.info(`    ${constants_1.COLORS.cyan}●${constants_1.COLORS.reset} ${h.reason.substring(0, 40)} → 语气${tone} 技能${skill} 示例${prompt}`, 'CLI');
                }
            }
        }
        catch {
            Logger_1.Logger.warn('展示进化历史详情失败', 'EvolutionCommand');
        }
    }
    catch {
        Logger_1.Logger.info(`  ${(0, constants_1.c)(constants_1.COLORS.red, '❌ 获取进化数据失败')}`, 'CLI');
    }
    Logger_1.Logger.info('', 'CLI');
}
/**
 * 处理 evolution 子命令 — 查看进化状态
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleEvolutionCommandCLI(subArgs, options) {
    const action = subArgs[0] || 'status';
    switch (action) {
        case 'status': {
            try {
                let data;
                try {
                    const ipcResult = await (0, ipc_1.ipcSend)('evolution.status');
                    data = ipcResult;
                }
                catch {
                    Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
                    const resp = await fetch(`${constants_1.backendUrl}/api/evolution/status`);
                    data = (await resp.json());
                }
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    if (!options.quiet) {
                        process.stdout.write(`进化数据\n\n`);
                    }
                    if (data.orchestrator) {
                        const o = data.orchestrator;
                        process.stdout.write(`  交互: ${o.totalInteractions || 0} 次\n`);
                        process.stdout.write(`  优化: ${o.totalOptimizations || 0} 次\n`);
                        process.stdout.write(`  平均质量: ${(o.averageQualityScore || 0).toFixed(3)}\n`);
                        process.stdout.write(`  趋势: ${o.qualityTrend || 'stable'}\n`);
                        process.stdout.write(`  失败率: ${((o.failureRate || 0) * 100).toFixed(1)}%\n`);
                        process.stdout.write(`  今日周期: ${o.cyclesToday || 0}\n`);
                        process.stdout.write(`  总周期: ${o.totalCycles || 0}\n`);
                        if (o.lastCycleTime) {
                            const ago = Math.round((Date.now() - o.lastCycleTime) / 60000);
                            process.stdout.write(`  上次优化: ${ago} 分钟前\n`);
                        }
                        if (o.userProfileConfidence) {
                            process.stdout.write(`  画像置信度: ${(o.userProfileConfidence * 100).toFixed(0)}%\n`);
                        }
                    }
                    else {
                        process.stdout.write(`  进化引擎未启动\n`);
                    }
                    if (data.enginesActive?.length) {
                        process.stdout.write(`  活跃引擎: ${data.enginesActive.join(', ')}\n`);
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取进化状态失败', err, 'EvolutionCommand');
                process.stderr.write(`获取进化状态失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        default:
            process.stderr.write(`未知 evolution 子命令: ${action}\n`);
            process.stderr.write('用法: evolution status\n');
            process.exit(1);
    }
}
