"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendChatMessage = sendChatMessage;
exports.handleAskCommand = handleAskCommand;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
const repl_1 = require("../repl");
const EventBus_1 = require("../../shared/EventBus");
const utils_1 = require("../utils");
/**
 * 发送聊天消息（REPL 模式）
 * 支持流式输出，优先 IPC 通信
 * @param input - 用户输入
 * @returns AI 响应文本
 */
async function sendChatMessage(input) {
    (0, repl_1.printThinking)();
    // 注册流式监听器，实现逐字输出
    let streamText = '';
    let streamStarted = false;
    let resolveStream = null;
    const streamPromise = new Promise((resolve) => {
        resolveStream = resolve;
    });
    const onStreamStart = (_payload) => {
        (0, repl_1.clearThinking)();
        streamStarted = true;
        process.stdout.write(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.green}✦ Response${constants_1.COLORS.reset}\n  `);
    };
    const onStreamChunk = (payload) => {
        if (streamStarted && payload.chunk) {
            process.stdout.write(payload.chunk);
            streamText += payload.chunk;
        }
    };
    const onStreamDone = (payload) => {
        if (streamStarted) {
            process.stdout.write('\n\n');
        }
        // 清理监听器
        EventBus_1.EventBus.off('stream_start', onStreamStart);
        EventBus_1.EventBus.off('stream_chunk', onStreamChunk);
        EventBus_1.EventBus.off('stream_done', onStreamDone);
        if (resolveStream) {
            resolveStream(payload.fullText || streamText);
        }
    };
    EventBus_1.EventBus.on('stream_start', onStreamStart);
    EventBus_1.EventBus.on('stream_chunk', onStreamChunk);
    EventBus_1.EventBus.on('stream_done', onStreamDone);
    try {
        // 优先尝试 IPC 通信（更快，无 HTTP 开销）
        try {
            const ipcResult = await (0, ipc_1.ipcSend)('process', { input });
            (0, repl_1.clearThinking)();
            // 如果流式未启动，直接返回IPC结果
            if (!streamStarted) {
                EventBus_1.EventBus.off('stream_start', onStreamStart);
                EventBus_1.EventBus.off('stream_chunk', onStreamChunk);
                EventBus_1.EventBus.off('stream_done', onStreamDone);
                if (typeof ipcResult === 'string') {
                    return ipcResult;
                }
                return (0, ipc_1.extractResponse)(ipcResult);
            }
            // 流式已启动，等待流式完成
            return await streamPromise;
        }
        catch {
            Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
        }
        const res = await fetch(`${constants_1.backendUrl}/api/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input }),
            signal: AbortSignal.timeout(60000),
        });
        (0, repl_1.clearThinking)();
        // 如果流式未启动，直接返回HTTP结果
        if (!streamStarted) {
            EventBus_1.EventBus.off('stream_start', onStreamStart);
            EventBus_1.EventBus.off('stream_chunk', onStreamChunk);
            EventBus_1.EventBus.off('stream_done', onStreamDone);
            const data = (await res.json());
            return (0, ipc_1.extractResponse)(data);
        }
        // 流式已启动，等待流式完成
        return await streamPromise;
    }
    catch (err) {
        // 清理监听器
        EventBus_1.EventBus.off('stream_start', onStreamStart);
        EventBus_1.EventBus.off('stream_chunk', onStreamChunk);
        EventBus_1.EventBus.off('stream_done', onStreamDone);
        (0, repl_1.clearThinking)();
        if (err.name === 'AbortError')
            throw new Error('请求超时');
        throw err;
    }
}
/**
 * 处理 ask 子命令 — 单次问答
 * @param query - 用户提问内容
 * @param options - 子命令选项
 */
async function handleAskCommand(query, options) {
    if (!query) {
        process.stderr.write('错误: ask 命令需要提供问题内容\n');
        process.exit(1);
    }
    Logger_1.Logger.info(`ask 命令: ${query.substring(0, 50)}`, 'AskCommand');
    try {
        let data;
        // 优先尝试 IPC
        try {
            const ipcResult = await (0, ipc_1.ipcSend)('process', { input: query });
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
                body: JSON.stringify({ input: query }),
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
        Logger_1.Logger.error('ask 命令请求失败', err, 'AskCommand');
        process.stderr.write(`请求失败: ${err.message}\n`);
        process.exit(1);
    }
}
