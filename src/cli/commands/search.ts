import { Logger } from '../../utils/Logger';
import { backendUrl } from '../constants';
import { extractResponse, ipcSend } from '../ipc';
import { SubcommandOptions } from '../types';
import { stripAnsi } from '../utils';

/**
 * 处理 search 子命令 — 网页搜索
 * @param query - 搜索查询
 * @param options - 子命令选项
 */
export async function handleSearchCommand(
  query: string,
  options: SubcommandOptions
): Promise<void> {
  if (!query) {
    process.stderr.write('错误: search 命令需要提供搜索内容\n');
    process.exit(1);
  }

  Logger.info(`搜索: ${query.substring(0, 50)}`, 'SearchCommand');

  try {
    let data: Record<string, unknown>;

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input: `搜索: ${query}` });
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
        body: JSON.stringify({ input: `搜索: ${query}` }),
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
    Logger.error('搜索请求失败', err as Error, 'SearchCommand');
    process.stderr.write(`搜索失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
