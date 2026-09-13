"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSearchCommand = handleSearchCommand;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
const utils_1 = require("../utils");
/**
 * 处理 search 子命令 — 网页搜索
 * @param query - 搜索查询
 * @param options - 子命令选项
 */
async function handleSearchCommand(query, options) {
    if (!query) {
        process.stderr.write('错误: search 命令需要提供搜索内容\n');
        process.exit(1);
    }
    Logger_1.Logger.info(`搜索: ${query.substring(0, 50)}`, 'SearchCommand');
    try {
        let data;
        // 优先尝试 IPC
        try {
            const ipcResult = await (0, ipc_1.ipcSend)('process', { input: `搜索: ${query}` });
            if (typeof ipcResult === 'string') {
                data = { response: ipcResult };
            }
            else {
                data = ipcResult;
            }
        }
        catch {
            Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
            const res = await fetch(`${constants_1.backendUrl}/api/process`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: `搜索: ${query}` }),
                signal: AbortSignal.timeout(120000),
            });
            data = (await res.json());
        }
        if (options.json) {
            process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        }
        else {
            const responseText = (0, ipc_1.extractResponse)(data);
            process.stdout.write((0, utils_1.stripAnsi)(responseText) + '\n');
        }
    }
    catch (err) {
        Logger_1.Logger.error('搜索请求失败', err, 'SearchCommand');
        process.stderr.write(`搜索失败: ${err.message}\n`);
        process.exit(1);
    }
}
