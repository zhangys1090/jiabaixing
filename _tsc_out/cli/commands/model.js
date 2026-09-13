"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleModelCommand = handleModelCommand;
exports.handleModelCommandCLI = handleModelCommandCLI;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
const utils_1 = require("../utils");
/**
 * 处理 /model 命令（REPL 模式）
 * 显示当前模型信息
 */
async function handleModelCommand() {
    const health = await (0, utils_1.checkBackendHealth)();
    Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}当前模型${constants_1.COLORS.reset}\n`, 'CLI');
    Logger_1.Logger.info(`  模型: ${health.model || 'deepseek-v4-flash'}`, 'CLI');
    Logger_1.Logger.info(`  LLM: ${health.llm?.available ? (0, constants_1.c)(constants_1.COLORS.green, '✅ 可用') : (0, constants_1.c)(constants_1.COLORS.red, '❌ 不可用')}`, 'CLI');
    if (health.llm?.message)
        Logger_1.Logger.info(`  信息: ${health.llm.message}`, 'CLI');
    Logger_1.Logger.info('', 'CLI');
}
/**
 * 处理 model 子命令 — 模型管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleModelCommandCLI(subArgs, options) {
    const action = subArgs[0] || 'list';
    switch (action) {
        case 'list': {
            const data = await (0, ipc_1.requestWithFallback)('model.list', {}, { path: '/api/models' });
            if (options.json) {
                process.stdout.write(JSON.stringify(data, null, 2) + '\n');
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const models = data?.models || [];
                process.stdout.write(`可用模型 (${models.length}):\n`);
                for (const m of models) {
                    process.stdout.write(`  ${m.name || m.id || m}\n`);
                }
            }
            break;
        }
        case 'switch': {
            const modelName = subArgs[1];
            if (!modelName) {
                process.stderr.write('错误: model switch 需要模型名称\n');
                process.exit(1);
            }
            const data = await (0, ipc_1.requestWithFallback)('model.switch', { modelName }, {
                path: '/api/models/switch',
                method: 'POST',
                body: { model: modelName },
            });
            process.stdout.write(`模型切换: ${JSON.stringify(data)}\n`);
            break;
        }
        default:
            process.stderr.write(`未知 model 子命令: ${action}。可用: list, switch\n`);
            process.exit(1);
    }
}
