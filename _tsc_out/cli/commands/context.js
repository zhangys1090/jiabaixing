"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleContextCommandCLI = handleContextCommandCLI;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
/**
 * 处理 context 子命令 — 项目上下文管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleContextCommandCLI(subArgs, options) {
    const action = subArgs[0] || 'list';
    switch (action) {
        case 'list': {
            Logger_1.Logger.info('列出已加载的上下文文件', 'ContextCommand');
            try {
                let data;
                try {
                    const ipcResult = await (0, ipc_1.ipcSend)('context.list');
                    data = ipcResult;
                }
                catch {
                    Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
                    const resp = await fetch(`${constants_1.backendUrl}/api/context/list`);
                    const result = (await resp.json());
                    if (!result.data) {
                        throw new Error('响应格式错误');
                    }
                    data = result.data;
                }
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    if (!options.quiet) {
                        process.stdout.write(`已加载的上下文文件 (${data.count} 个)\n\n`);
                    }
                    if (data.files.length === 0) {
                        process.stdout.write(`  未加载任何上下文文件。可用文件: JIABAIXING.md, AGENTS.md, CLAUDE.md, CONTEXT.md, .jiabaixing/context.md\n`);
                        process.stdout.write(`  使用 context create [文件名] 创建模板文件。\n`);
                    }
                    else {
                        for (const file of data.files) {
                            const sizeStr = file.size < 1024
                                ? `${file.size}B`
                                : `${(file.size / 1024).toFixed(1)}KB`;
                            const timeStr = new Date(file.loadedAt).toLocaleString();
                            process.stdout.write(`  ${file.fileName} (${sizeStr}, 加载于 ${timeStr})\n`);
                        }
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.error('列出上下文文件失败', err, 'ContextCommand');
                process.stderr.write(`列出上下文文件失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'refresh': {
            Logger_1.Logger.info('刷新上下文文件缓存', 'ContextCommand');
            try {
                let data;
                try {
                    const ipcResult = await (0, ipc_1.ipcSend)('context.refresh');
                    data = ipcResult;
                }
                catch {
                    Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
                    const resp = await fetch(`${constants_1.backendUrl}/api/context/refresh`, {
                        method: 'POST',
                    });
                    const result = (await resp.json());
                    if (!result.data) {
                        throw new Error('响应格式错误');
                    }
                    data = result.data;
                }
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    process.stdout.write(`  ${data.message}\n`);
                }
            }
            catch (err) {
                Logger_1.Logger.error('刷新上下文文件失败', err, 'ContextCommand');
                process.stderr.write(`刷新上下文文件失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'create': {
            const fileName = subArgs[1] || 'JIABAIXING.md';
            Logger_1.Logger.info(`创建上下文文件模板: ${fileName}`, 'ContextCommand');
            try {
                let data;
                try {
                    const ipcResult = await (0, ipc_1.ipcSend)('context.create', { fileName });
                    data = ipcResult;
                }
                catch {
                    Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
                    const resp = await fetch(`${constants_1.backendUrl}/api/context/create`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fileName }),
                    });
                    const result = (await resp.json());
                    if (!result.data) {
                        throw new Error(result.error || '响应格式错误');
                    }
                    data = result.data;
                }
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    process.stdout.write(`  ${data.message}\n`);
                }
            }
            catch (err) {
                Logger_1.Logger.error('创建上下文文件失败', err, 'ContextCommand');
                process.stderr.write(`创建上下文文件失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'read': {
            const fileName = subArgs[1];
            if (!fileName) {
                process.stderr.write('错误: context read 需要提供文件名\n');
                process.stderr.write('可用文件: JIABAIXING.md, AGENTS.md, CLAUDE.md, CONTEXT.md, .jiabaixing/context.md\n');
                process.exit(1);
            }
            Logger_1.Logger.info(`读取上下文文件: ${fileName}`, 'ContextCommand');
            try {
                let data;
                try {
                    const ipcResult = await (0, ipc_1.ipcSend)('context.read', { fileName });
                    data = ipcResult;
                }
                catch {
                    Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
                    const resp = await fetch(`${constants_1.backendUrl}/api/context/read/${encodeURIComponent(fileName)}`);
                    const result = (await resp.json());
                    if (!result.data) {
                        throw new Error(result.error || '响应格式错误');
                    }
                    data = result.data;
                }
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    if (!options.quiet) {
                        process.stdout.write(`${data.fileName}\n\n`);
                    }
                    process.stdout.write(data.content + '\n');
                }
            }
            catch (err) {
                Logger_1.Logger.error('读取上下文文件失败', err, 'ContextCommand');
                process.stderr.write(`读取上下文文件失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        default:
            process.stderr.write(`未知 context 子命令: ${action}\n`);
            process.stderr.write('用法: context list | context refresh | context create [文件名] | context read <文件名>\n');
            process.exit(1);
    }
}
