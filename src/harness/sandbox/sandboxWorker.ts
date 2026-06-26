/**
 * sandboxWorker — worker_threads 沙箱执行器
 *
 * 在隔离的 Worker 线程中执行不可信代码。
 * Worker 线程：
 *   - 无 process.mainModule（null）
 *   - 无 parent require 访问
 *   - 资源限制由父线程的 resourceLimits 控制
 *   - 超时由父线程的 worker.terminate() 控制
 */

import { parentPort } from 'worker_threads';

if (!parentPort) {
  process.exit(1);
}

const logs: string[] = [];

parentPort.on('message', (data: { code: string }) => {
  logs.length = 0;

  try {
    // 预检查（防御：阻止 eval 中的动态导入）
    const patterns = [/\bimport\s*\(/, /\brequire\s*\(/];
    for (const p of patterns) {
      if (p.test(data.code)) {
        parentPort!.postMessage({
          success: false,
          error: '禁止使用 import() 或 require()',
          logs: [],
        });
        return;
      }
    }

    // 在 Worker 中执行代码（Worker 无 parent require/process.mainModule）
    const fn = new Function(
      'console',
      `"use strict"; return (async () => { ${data.code} })();`
    );

    const safeConsole = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) =>
        logs.push('[WARN] ' + args.map(String).join(' ')),
      error: (...args: unknown[]) =>
        logs.push('[ERROR] ' + args.map(String).join(' ')),
    };

    Promise.resolve(fn(safeConsole))
      .then((output) => {
        parentPort!.postMessage({ success: true, output, logs: [...logs] });
      })
      .catch((err: Error) => {
        parentPort!.postMessage({
          success: false,
          error: err.message,
          logs: [...logs],
        });
      });
  } catch (err) {
    parentPort!.postMessage({
      success: false,
      error: (err as Error).message,
      logs: [...logs],
    });
  }
});
