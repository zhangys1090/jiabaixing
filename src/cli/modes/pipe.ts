import { Logger } from '../../utils/Logger';
import { backendUrl } from '../constants';
import { extractResponse, ipcSend } from '../ipc';
import { parseGlobalOptions, stripAnsi } from '../utils';

/**
 * 管道模式：从 stdin 读取全部内容，发送给后端 API，输出结果后退出
 * 支持 --json 参数输出 JSON 格式，--quiet 只输出结果
 * @param args - 命令行参数
 */
export async function pipeMode(args: string[]): Promise<void> {
  const { options } = parseGlobalOptions(args);

  let input = '';
  try {
    input = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on('end', () =>
        resolve(Buffer.concat(chunks).toString('utf-8'))
      );
      process.stdin.on('error', reject);
    });
  } catch (err) {
    Logger.error('读取 stdin 失败', err as Error, 'PipeMode');
    process.stderr.write(`读取输入失败: ${(err as Error).message}\n`);
    process.exit(1);
  }

  input = input.trim();
  if (!input) {
    process.stderr.write('错误: stdin 为空\n');
    process.exit(1);
  }

  Logger.info(`管道模式: 接收输入 ${input.length} 字符`, 'PipeMode');

  try {
    let data: Record<string, unknown>;

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input });
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
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(120000),
      });
      data = (await res.json()) as Record<string, unknown>;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const responseText = extractResponse(data);
      // 管道模式输出纯文本，不含 ANSI 颜色码
      process.stdout.write(stripAnsi(responseText) + '\n');
    }

    process.exit(0);
  } catch (err) {
    Logger.error('管道模式请求失败', err as Error, 'PipeMode');
    process.stderr.write(`请求失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
