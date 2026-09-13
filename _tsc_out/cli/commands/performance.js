"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePerformanceCommandCLI = handlePerformanceCommandCLI;
const Logger_1 = require("../../utils/Logger");
const ipc_1 = require("../ipc");
/**
 * 处理 performance 子命令 — 性能监控
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handlePerformanceCommandCLI(subArgs, options) {
    const action = subArgs[0] || 'snapshot';
    switch (action) {
        case 'snapshot': {
            try {
                const data = await (0, ipc_1.requestWithFallback)('performance.snapshot', {}, { path: '/api/performance/snapshot' });
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    process.stdout.write(`性能快照:\n${JSON.stringify(data, null, 2)}\n`);
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取性能快照失败', err, 'PerformanceCommand');
                process.stderr.write(`获取性能快照失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'stats': {
            try {
                const data = await (0, ipc_1.requestWithFallback)('performance.stats', {}, { path: '/api/performance/stats' });
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    process.stdout.write(`性能统计:\n${JSON.stringify(data, null, 2)}\n`);
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取性能统计失败', err, 'PerformanceCommand');
                process.stderr.write(`获取性能统计失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        default:
            process.stderr.write(`未知 performance 子命令: ${action}。可用: snapshot, stats\n`);
            process.exit(1);
    }
}
