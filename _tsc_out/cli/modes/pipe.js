"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pipeMode = pipeMode;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
const utils_1 = require("../utils");
/**
 * 管道模式：从 stdin 读取全部内容，发送给后端 API，输出结果后退出
 * 支持 --json 参数输出 JSON 格式，--quiet 只输出结果
 * @param args - 命令行参数
 */
async function pipeMode(args) {
    const { options } = (0, utils_1.parseGlobalOptions)(args);
    let input = '';
    try {
        input = await new Promise((resolve, reject) => {
            const chunks = [];
            process.stdin.on('data', (chunk) => chunks.push(chunk));
            process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            process.stdin.on('error', reject);
        });
    }
    catch (err) {
        Logger_1.Logger.error('读取 stdin 失败', err, 'PipeMode');
        process.stderr.write(`读取输入失败: ${err.message}\n`);
        process.exit(1);
    }
    input = input.trim();
    if (!input) {
        process.stderr.write('错误: stdin 为空\n');
        process.exit(1);
    }
    Logger_1.Logger.info(`管道模式: 接收输入 ${input.length} 字符`, 'PipeMode');
    try {
        let data;
        // 优先尝试 IPC
        try {
            const ipcResult = await (0, ipc_1.ipcSend)('process', { input });
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
                body: JSON.stringify({ input }),
                signal: AbortSignal.timeout(120000),
            });
            data = (await res.json());
        }
        if (options.json) {
            process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        }
        else {
            const responseText = (0, ipc_1.extractResponse)(data);
            // 管道模式输出纯文本，不含 ANSI 颜色码
            process.stdout.write((0, utils_1.stripAnsi)(responseText) + '\n');
        }
        process.exit(0);
    }
    catch (err) {
        Logger_1.Logger.error('管道模式请求失败', err, 'PipeMode');
        process.stderr.write(`请求失败: ${err.message}\n`);
        process.exit(1);
    }
}
