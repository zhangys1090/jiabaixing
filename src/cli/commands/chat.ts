import { Logger } from '../../utils/Logger';
import { COLORS, backendUrl } from '../constants';
import { extractResponse, ipcSend } from '../ipc';
import { printThinking, clearThinking } from '../repl';
import { EventBus } from '../../shared/EventBus';
import { SubcommandOptions } from '../types';
import { stripAnsi } from '../utils';

/**
 * 发送聊天消息（REPL 模式）
 * 支持流式输出，优先 IPC 通信
 * @param input - 用户输入
 * @returns AI 响应文本
 */
export async function sendChatMessage(input: string): Promise<string> {
  printThinking();

  // 注册流式监听器，实现逐字输出
  let streamText = '';
  let streamStarted = false;
  let resolveStream: ((text: string) => void) | null = null;
  const streamPromise = new Promise<string>((resolve) => {
    resolveStream = resolve;
  });

  const onStreamStart = (_payload: {
    traceId: string;
    totalLength: number;
    timestamp: number;
  }): void => {
    clearThinking();
    streamStarted = true;
    process.stdout.write(
      `\n  ${COLORS.bold}${COLORS.green}✦ Response${COLORS.reset}\n  `
    );
  };

  const onStreamChunk = (payload: {
    traceId: string;
    chunk: string;
    offset: number;
    timestamp: number;
  }): void => {
    if (streamStarted && payload.chunk) {
      process.stdout.write(payload.chunk);
      streamText += payload.chunk;
    }
  };

  const onStreamDone = (payload: {
    traceId: string;
    fullText: string;
    timestamp: number;
  }): void => {
    if (streamStarted) {
      process.stdout.write('\n\n');
    }
    // 清理监听器
    EventBus.off('stream_start', onStreamStart);
    EventBus.off('stream_chunk', onStreamChunk);
    EventBus.off('stream_done', onStreamDone);
    if (resolveStream) {
      resolveStream(payload.fullText || streamText);
    }
  };

  EventBus.on('stream_start', onStreamStart);
  EventBus.on('stream_chunk', onStreamChunk);
  EventBus.on('stream_done', onStreamDone);

  try {
    // 优先尝试 IPC 通信（更快，无 HTTP 开销）
    try {
      const ipcResult = await ipcSend('process', { input });
      clearThinking();
      // 如果流式未启动，直接返回IPC结果
      if (!streamStarted) {
        EventBus.off('stream_start', onStreamStart);
        EventBus.off('stream_chunk', onStreamChunk);
        EventBus.off('stream_done', onStreamDone);
        if (typeof ipcResult === 'string') {
          return ipcResult;
        }
        return extractResponse(ipcResult);
      }
      // 流式已启动，等待流式完成
      return await streamPromise;
    } catch {
      Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
    }

    const res = await fetch(`${backendUrl}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(60000),
    });
    clearThinking();
    // 如果流式未启动，直接返回HTTP结果
    if (!streamStarted) {
      EventBus.off('stream_start', onStreamStart);
      EventBus.off('stream_chunk', onStreamChunk);
      EventBus.off('stream_done', onStreamDone);
      const data = (await res.json()) as Record<string, unknown>;
      return extractResponse(data);
    }
    // 流式已启动，等待流式完成
    return await streamPromise;
  } catch (err) {
    // 清理监听器
    EventBus.off('stream_start', onStreamStart);
    EventBus.off('stream_chunk', onStreamChunk);
    EventBus.off('stream_done', onStreamDone);
    clearThinking();
    if ((err as Error).name === 'AbortError') throw new Error('请求超时');
    throw err;
  }
}

/**
 * 处理 ask 子命令 — 单次问答
 * @param query - 用户提问内容
 * @param options - 子命令选项
 */
export async function handleAskCommand(
  query: string,
  options: SubcommandOptions
): Promise<void> {
  if (!query) {
    process.stderr.write('错误: ask 命令需要提供问题内容\n');
    process.exit(1);
  }

  Logger.info(`ask 命令: ${query.substring(0, 50)}`, 'AskCommand');

  try {
    let data: Record<string, unknown>;

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input: query });
      if (typeof ipcResult === 'string') {
        data = { response: ipcResult };
      } else {
        data = ipcResult as Record<string, unknown>;
      }
    } catch {
      Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
      const res = await fetch(`${backendUrl}/api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: query }),
        signal: AbortSignal.timeout(120000),
      });
      data = (await res.json()) as Record<string, unknown>;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const responseText = extractResponse(data);
      process.stdout.write(stripAnsi(responseText) + '\n');
    }
  } catch (err) {
    Logger.error('ask 命令请求失败', err as Error, 'AskCommand');
    process.stderr.write(`请求失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
