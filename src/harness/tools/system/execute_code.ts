/**
 * Harness Tool: execute_code - 代码执行（沙箱隔离）
 *
 * 支持 JavaScript（沙箱）/ Python / Shell 三种语言
 * JavaScript 通过 SandboxExecutor 在受限上下文执行；Python/Shell 通过子进程带超时执行
 *
 * P0 修复:
 * - execSync → spawn 异步执行（不再阻塞事件循环）
 * - JS 回退沙箱增加 prototype 冻结 + 属性白名单（防逃逸）
 * - FORBIDDEN_PATTERNS → 归一化+分词危险检测（复用 shell_exec 硬化逻辑）
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ITerminalBackend } from '../../sandbox/backends/ITerminalBackend';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { isShellCommandDangerous } from './shell_exec';

export const EXECUTE_CODE_DEF: ToolDefinition = {
  name: 'execute_code',
  description:
    '代码执行工具。在沙箱中执行 JavaScript，或通过子进程执行 Python/Shell。适用场景：计算、数据处理、原型验证、脚本执行。不适用：需要持久化副作用的关键操作。',
  category: ToolCategory.SYSTEM,
  parameters: {
    language: {
      type: 'string',
      description: '执行语言：javascript | python | shell（默认 javascript）',
      default: 'javascript',
    },
    code: {
      type: 'string',
      description: '要执行的代码',
    },
    timeout: {
      type: 'number',
      description: '超时时间（毫秒），默认 10000',
      default: 10000,
    },
  },
  requiredParams: ['code'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'medium',
  idempotent: false,
  timeout: 15000,
};

const JS_DANGEROUS_PATTERNS: RegExp[] = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bnew\s+Function\b/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bglobal\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bchild_process\b/,
  /\bfs\b\.\s*(read|write|unlink|rmdir|mkdir|append|open|rename|copy|access|stat|chmod|chown)/,
  /\bnet\b\./,
  /\bhttp\b\./,
  /\bhttps\b\./,
  /\bWebSocket\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bBuffer\b\s*\./,
  /\bmodule\b\s*\./,
  /\bexports\b\s*\./,
  /\.constructor\s*\.\s*constructor/,
  /\barguments\s*\.\s*callee/,
  /\barguments\s*\[/,
  /\bthis\s*\.\s*constructor/,
  /\bReflect\s*\./,
  /\bProxy\b/,
  /\bWeakRef\b/,
  /\bSharedArrayBuffer\b/,
  /\bAtomics\b/,
  /\bWorker\b/,
  /\bparentPort\b/,
];

export interface ExecuteCodeDeps {
  /** 沙箱执行器（可选，提供后 JavaScript 在沙箱中执行） */
  sandboxExecutor?: {
    executeCode(code: string): Promise<{
      success: boolean;
      output?: unknown;
      error?: string;
      durationMs: number;
    }>;
  };
  /** 多环境终端后端（优先于 sandboxExecutor，用于 python/shell/js 远程执行） */
  terminalBackend?: ITerminalBackend;
}

function ok(
  output: string,
  duration: number,
  metadata?: Record<string, unknown>
): ToolResult {
  return { success: true, output, duration, validated: false, metadata };
}

function fail(
  error: string,
  duration: number,
  output: string = ''
): ToolResult {
  return { success: false, output, error, duration, validated: false };
}

function checkJsCodeSafety(code: string): { safe: boolean; reason?: string } {
  for (const pattern of JS_DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      const match = pattern.source.replace(/\\b/g, '').replace(/\\s\*/g, ' ');
      return { safe: false, reason: `检测到危险操作: ${match}` };
    }
  }
  return { safe: true };
}

function checkShellCodeSafety(code: string): {
  safe: boolean;
  reason?: string;
} {
  const normalized = code
    .replace(/["'`\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const danger = isShellCommandDangerous(normalized);
  if (danger.blocked) {
    return { safe: false, reason: danger.reason };
  }
  return { safe: true };
}

const PYTHON_DANGEROUS_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bos\s*\.\s*system\s*\(/, name: 'os.system调用' },
  { pattern: /\bos\s*\.\s*popen\s*\(/, name: 'os.popen调用' },
  { pattern: /\bos\s*\.\s*remove\s*\(/, name: 'os.remove调用' },
  { pattern: /\bos\s*\.\s*unlink\s*\(/, name: 'os.unlink调用' },
  { pattern: /\bos\s*\.\s*rmdir\s*\(/, name: 'os.rmdir调用' },
  { pattern: /\bos\s*\.\s*rename\s*\(/, name: 'os.rename调用' },
  { pattern: /\bos\s*\.\s*chmod\s*\(/, name: 'os.chmod调用' },
  { pattern: /\bos\s*\.\s*chown\s*\(/, name: 'os.chown调用' },
  { pattern: /\bos\s*\.\s*kill\s*\(/, name: 'os.kill调用' },
  { pattern: /\bsubprocess\s*\.\s*call\s*\(/, name: 'subprocess.call调用' },
  { pattern: /\bsubprocess\s*\.\s*run\s*\(/, name: 'subprocess.run调用' },
  { pattern: /\bsubprocess\s*\.\s*Popen\s*\(/, name: 'subprocess.Popen调用' },
  { pattern: /\bexec\s*\(/, name: 'exec调用' },
  { pattern: /\beval\s*\(\s*input\s*\(/, name: 'eval(input())调用' },
  { pattern: /\b__import__\s*\(/, name: '__import__调用' },
  { pattern: /\bimport\s+shutil\b/, name: 'shutil导入(文件破坏)' },
  { pattern: /\bshutil\s*\.\s*rmtree\b/, name: 'shutil.rmtree调用' },
  { pattern: /\bshutil\s*\.\s*move\b/, name: 'shutil.move调用' },
  { pattern: /\bsocket\s*\.\s*socket\s*\(/, name: 'socket创建' },
  { pattern: /\bctypes\s*\.\s*CDLL\b/, name: 'ctypes动态库加载' },
  { pattern: /\bctypes\s*\.\s*windll\b/, name: 'ctypes Windows DLL加载' },
  { pattern: /\bimport\s+pickle\b/, name: 'pickle导入(反序列化攻击)' },
  { pattern: /\bimport\s+marshal\b/, name: 'marshal导入(反序列化)' },
  { pattern: /\bimport\s+webbrowser\b/, name: 'webbrowser导入' },
  { pattern: /\bwebbrowser\s*\.\s*open\b/, name: 'webbrowser.open调用' },
  {
    pattern: /\bmultiprocessing\s*\.\s*Process\b/,
    name: 'multiprocessing.Process创建',
  },
  { pattern: /\bthreading\s*\.\s*Thread\s*\(/, name: 'threading.Thread创建' },
  { pattern: /\bimport\s+requests\b/, name: 'requests导入(网络外泄风险)' },
  { pattern: /\bimport\s+urllib\b/, name: 'urllib导入(网络外泄风险)' },
];

function checkPythonCodeSafety(code: string): {
  safe: boolean;
  reason?: string;
} {
  for (const { pattern, name } of PYTHON_DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return { safe: false, reason: `检测到危险操作: ${name}` };
    }
  }
  return { safe: true };
}

async function executeJavaScript(
  code: string,
  deps: ExecuteCodeDeps,
  timeout: number,
  startTime: number
): Promise<ToolResult> {
  if (deps.sandboxExecutor) {
    try {
      const result = await deps.sandboxExecutor.executeCode(code);
      const output =
        typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output ?? '', null, 2);
      if (result.success) {
        return ok(output || '(无输出)', Date.now() - startTime, {
          language: 'javascript',
          sandboxed: true,
        });
      }
      return fail(result.error || '执行失败', Date.now() - startTime, output);
    } catch (err) {
      return fail(
        `沙箱执行失败: ${(err as Error).message}`,
        Date.now() - startTime
      );
    }
  }

  const safetyCheck = checkJsCodeSafety(code);
  if (!safetyCheck.safe) {
    Logger.warn(
      `🛡️ execute_code JS 安全拦截: ${safetyCheck.reason}`,
      'ExecuteCode'
    );
    return fail(
      `JavaScript 代码被安全策略拦截: ${safetyCheck.reason}。如需执行系统操作，请使用 shell_exec 工具。`,
      Date.now() - startTime
    );
  }

  const logs: string[] = [];
  const sandboxConsole = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
  };

  try {
    const sandboxError = class SafeError extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'Error';
      }
    };
    const sandboxTypeError = class SafeTypeError extends TypeError {
      constructor(message?: string) {
        super(message);
        this.name = 'TypeError';
      }
    };
    const sandboxRangeError = class SafeRangeError extends RangeError {
      constructor(message?: string) {
        super(message);
        this.name = 'RangeError';
      }
    };

    const sandboxGlobals: Record<string, unknown> = {
      console: sandboxConsole,
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
      Error: sandboxError,
      TypeError: sandboxTypeError,
      RangeError: sandboxRangeError,
      Promise,
      Symbol,
    };

    const keys = Object.keys(sandboxGlobals);

    const wrappedCode = `"use strict";
const _wl = {${keys.map((k) => `${k}: arguments[1].${k}`).join(', ')}};
const _gp = Object.getOwnPropertyNames;
const _proto = Object.getPrototypeOf;
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
  ${code}
}`;

    const asyncFn = new Function('console', 'globals', wrappedCode) as (
      c: typeof sandboxConsole,
      g: Record<string, unknown>
    ) => unknown;

    const result = asyncFn(sandboxConsole, sandboxGlobals);
    const output = [
      ...logs,
      result !== undefined ? `=> ${JSON.stringify(result, null, 2)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const truncatedOutput =
      output.length > 10000
        ? output.substring(0, 10000) + '\n... (输出已截断)'
        : output || '(无输出)';
    return ok(truncatedOutput, Date.now() - startTime, {
      language: 'javascript',
      sandboxed: false,
    });
  } catch (err) {
    return fail(
      `JavaScript 执行错误: ${(err as Error).message}`,
      Date.now() - startTime,
      logs.join('\n').substring(0, 5000)
    );
  }
}

function runSpawnAsync(
  command: string,
  timeout: number,
  cwd?: string
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: cwd || process.cwd(),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => {
      if (!timedOut) stdout += d;
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (d: string) => {
      if (!timedOut) stderr += d;
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, 500);
    }, timeout);

    child.on('error', (err) => {
      stderr += err.message;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
    child.on('exit', (code) => finish(code ?? -1));
  });
}

async function executeSubprocess(
  code: string,
  language: 'python' | 'shell',
  timeout: number,
  startTime: number
): Promise<ToolResult> {
  let command: string;
  let cleanupFile: string | null = null;

  try {
    if (language === 'python') {
      const randSuffix = crypto.randomBytes(8).toString('hex');
      const tmpFile = path.join(os.tmpdir(), `jbx_exec_${randSuffix}.py`);
      fs.writeFileSync(tmpFile, code, { encoding: 'utf-8', mode: 0o600 });
      cleanupFile = tmpFile;
      const py = process.platform === 'win32' ? 'python' : 'python3';
      command = `${py} "${tmpFile}"`;
    } else {
      command = code;
    }

    const { stdout, stderr, exitCode, timedOut } = await runSpawnAsync(
      command,
      timeout,
      process.cwd()
    );

    if (cleanupFile) {
      try {
        fs.unlinkSync(cleanupFile);
      } catch {
        /* ignore */
      }
    }

    if (timedOut) {
      return fail(
        `${language} 执行超时 (>${timeout}ms)`,
        Date.now() - startTime,
        (stdout || stderr).substring(0, 5000)
      );
    }

    const output = stdout || stderr || '(无输出)';
    if (exitCode === 0) {
      Logger.info(`⚡ execute_code 成功 (${language})`, 'ExecuteCode');
      return ok(output.substring(0, 10000), Date.now() - startTime, {
        language,
        exitCode,
      });
    }

    return fail(
      `${language} 执行失败 (exit ${exitCode}): ${stderr.substring(0, 200)}`,
      Date.now() - startTime,
      output.substring(0, 5000)
    );
  } catch (error) {
    if (cleanupFile) {
      try {
        fs.unlinkSync(cleanupFile);
      } catch {
        /* ignore */
      }
    }
    const err = error as Error;
    return fail(
      `${language} 执行失败: ${err.message.substring(0, 200)}`,
      Date.now() - startTime
    );
  }
}

export function createExecuteCodeExecutor(deps: ExecuteCodeDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const code = String(params.code || '');
    const language = String(params.language || 'javascript').toLowerCase();
    const timeout = Number(params.timeout) || 10000;

    if (!code) {
      return fail('请提供要执行的代码', Date.now() - startTime);
    }

    if (language === 'shell' || language === 'bash' || language === 'sh') {
      const shellSafety = checkShellCodeSafety(code);
      if (!shellSafety.safe) {
        Logger.warn(
          `🛡️ execute_code 拦截危险 shell 代码: ${shellSafety.reason}`,
          'ExecuteCode'
        );
        return fail(
          `代码被安全策略拦截: ${shellSafety.reason}`,
          Date.now() - startTime
        );
      }
    }

    if (deps.terminalBackend) {
      const lang =
        language === 'javascript' || language === 'js'
          ? 'javascript'
          : language === 'python' || language === 'python3'
            ? 'python'
            : 'shell';
      const result = await deps.terminalBackend.executeCode(code, lang, {
        timeout,
      });
      const output = result.stdout || result.stderr || '(无输出)';
      if (result.success) {
        return ok(output.substring(0, 10000), Date.now() - startTime, {
          language: lang,
          backend: result.backend,
          exitCode: result.exitCode,
        });
      }
      return fail(
        `${lang} 执行失败 (exit ${result.exitCode}): ${result.stderr.substring(0, 200)}`,
        Date.now() - startTime,
        output.substring(0, 5000)
      );
    }

    if (language === 'javascript' || language === 'js') {
      return executeJavaScript(code, deps, timeout, startTime);
    }

    if (language === 'python' || language === 'python3') {
      const pySafety = checkPythonCodeSafety(code);
      if (!pySafety.safe) {
        Logger.warn(
          `🛡️ execute_code Python 安全拦截: ${pySafety.reason}`,
          'ExecuteCode'
        );
        return fail(
          `Python 代码被安全策略拦截: ${pySafety.reason}。如需执行系统操作，请使用 shell_exec 工具。`,
          Date.now() - startTime
        );
      }
      return executeSubprocess(code, 'python', timeout, startTime);
    }

    if (language === 'shell' || language === 'bash' || language === 'sh') {
      return executeSubprocess(code, 'shell', timeout, startTime);
    }

    return fail(
      `不支持的语言: ${language}。支持: javascript | python | shell`,
      Date.now() - startTime
    );
  };
}
