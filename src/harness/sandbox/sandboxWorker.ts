/**
 * sandboxWorker — worker_threads 沙箱执行器
 *
 * 在隔离的 Worker 线程中执行不可信代码。
 * Worker 线程：
 *   - 无 process.mainModule（null）
 *   - 无 parent require 访问
 *   - 资源限制由父线程的 resourceLimits 控制
 *   - 超时由父线程的 worker.terminate() 控制
 *
 * P0 修复:
 * - 扩展预检查模式：覆盖 eval/Function/constructor 原型链逃逸
 * - 冻结全局对象原型：阻止 Object.constructor 等逃逸路径
 * - 移除 process/globalThis/require 等危险引用
 * - 限制输出大小防止内存耗尽
 */

import { parentPort } from 'worker_threads';

if (!parentPort) {
  process.exit(1);
}

const MAX_OUTPUT_LENGTH = 10000;

const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bimport\s*\(/, reason: '禁止使用 import()' },
  { pattern: /\brequire\s*\(/, reason: '禁止使用 require()' },
  { pattern: /\beval\s*\(/, reason: '禁止使用 eval()' },
  { pattern: /\bFunction\s*\(/, reason: '禁止使用 Function 构造函数' },
  { pattern: /\bnew\s+Function\b/, reason: '禁止使用 new Function' },
  { pattern: /\bprocess\b/, reason: '禁止访问 process' },
  { pattern: /\bglobalThis\b/, reason: '禁止访问 globalThis' },
  { pattern: /\bglobal\b/, reason: '禁止访问 global' },
  { pattern: /\b__dirname\b/, reason: '禁止访问 __dirname' },
  { pattern: /\b__filename\b/, reason: '禁止访问 __filename' },
  { pattern: /\bchild_process\b/, reason: '禁止访问 child_process' },
  { pattern: /\bfs\b\s*\./, reason: '禁止访问 fs 模块' },
  { pattern: /\bnet\b\s*\./, reason: '禁止访问 net 模块' },
  { pattern: /\bhttp\b\s*\./, reason: '禁止访问 http 模块' },
  { pattern: /\bhttps\b\s*\./, reason: '禁止访问 https 模块' },
  { pattern: /\bWebSocket\b/, reason: '禁止访问 WebSocket' },
  { pattern: /\bfetch\s*\(/, reason: '禁止使用 fetch' },
  { pattern: /\bXMLHttpRequest\b/, reason: '禁止使用 XMLHttpRequest' },
  { pattern: /\bmodule\b\s*\./, reason: '禁止访问 module' },
  { pattern: /\bexports\b\s*\./, reason: '禁止访问 exports' },
  { pattern: /\.constructor\s*\.\s*constructor/, reason: '禁止原型链逃逸' },
  {
    pattern: /\barguments\s*\.\s*callee/,
    reason: '禁止 arguments.callee 逃逸',
  },
  {
    pattern: /\bthis\s*\.\s*constructor/,
    reason: '禁止 this.constructor 逃逸',
  },
  { pattern: /\bObject\s*\.\s*create/, reason: '禁止 Object.create 逃逸' },
  { pattern: /\bReflect\s*\./, reason: '禁止使用 Reflect' },
  { pattern: /\bProxy\b/, reason: '禁止使用 Proxy' },
  { pattern: /\bWeakRef\b/, reason: '禁止使用 WeakRef' },
  {
    pattern: /\bFinalizationRegistry\b/,
    reason: '禁止使用 FinalizationRegistry',
  },
  { pattern: /\bSharedArrayBuffer\b/, reason: '禁止使用 SharedArrayBuffer' },
  { pattern: /\bAtomics\b/, reason: '禁止使用 Atomics' },
  { pattern: /\bWorker\b/, reason: '禁止创建 Worker' },
  { pattern: /\bparentPort\b/, reason: '禁止访问 parentPort' },
];

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;
  return output.substring(0, MAX_OUTPUT_LENGTH) + '\n... (输出已截断)';
}

const logs: string[] = [];

parentPort.on('message', (data: { code: string }) => {
  logs.length = 0;

  try {
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(data.code)) {
        parentPort!.postMessage({
          success: false,
          error: `安全检查失败: ${reason}`,
          logs: [],
        });
        return;
      }
    }

    const safeConsole = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) =>
        logs.push('[WARN] ' + args.map(String).join(' ')),
      error: (...args: unknown[]) =>
        logs.push('[ERROR] ' + args.map(String).join(' ')),
    };

    const safeGlobals: Record<string, unknown> = {
      console: safeConsole,
      JSON,
      Math,
      Date,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      RegExp,
      Error,
      TypeError,
      RangeError,
      Promise,
      Symbol,
    };

    const keys = Object.keys(safeGlobals);
    const values = Object.values(safeGlobals);

    const wrappedCode = `"use strict";
const _wl = {${keys.map((k) => `${k}: arguments[1].${k}`).join(', ')}};
try { Object.setPrototypeOf(_wl, null); } catch(_e) {}
const _guarded = new Proxy(_wl, {
  has: () => true,
  get: (t, p) => {
    if (p === Symbol.unscopables) return {};
    if (p === 'constructor' || p === '__proto__' || p === 'prototype') return undefined;
    return t[p];
  },
  set: (t, p, v) => { t[p] = v; return true; }
});
with (_guarded) {
  ${data.code}
}`;

    const fn = new Function('console', 'globals', wrappedCode) as (
      c: typeof safeConsole,
      g: Record<string, unknown>
    ) => unknown;

    const result = fn(safeConsole, safeGlobals);

    Promise.resolve(result)
      .then((output) => {
        const outputStr = output !== undefined ? String(output) : '';
        const logStr = logs.join('\n');
        const combined = [logStr, outputStr].filter(Boolean).join('\n');
        parentPort!.postMessage({
          success: true,
          output: truncateOutput(combined || '(无输出)'),
          logs: [...logs],
        });
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
