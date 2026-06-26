/**
 * Harness Tool: execute_code - 代码执行（沙箱隔离）
 *
 * 支持 JavaScript（沙箱）/ Python / Shell 三种语言
 * JavaScript 通过 SandboxExecutor 在受限上下文执行；Python/Shell 通过子进程带超时执行
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ITerminalBackend } from '../../sandbox/backends/ITerminalBackend';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

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

const FORBIDDEN_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  'shutdown',
  'format',
  'del /s /q C:',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
  'fork bomb',
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

function containsForbidden(code: string): string | null {
  const lower = code.toLowerCase();
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
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

  // 回退：受限 eval，捕获 console 输出
  const logs: string[] = [];
  const sandboxConsole = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
  };

  try {
    const asyncFn = new Function('console', `"use strict";\n${code}`) as (
      c: typeof sandboxConsole
    ) => unknown;
    const result = asyncFn(sandboxConsole);
    const output = [
      ...logs,
      result !== undefined ? `=> ${JSON.stringify(result, null, 2)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return ok(output || '(无输出)', Date.now() - startTime, {
      language: 'javascript',
      sandboxed: false,
    });
  } catch (err) {
    return fail(
      `JavaScript 执行错误: ${(err as Error).message}`,
      Date.now() - startTime,
      logs.join('\n')
    );
  }
}

function executeSubprocess(
  code: string,
  language: 'python' | 'shell',
  timeout: number,
  startTime: number
): ToolResult {
  try {
    let command: string;
    let cleanupFile: string | null = null;

    if (language === 'python') {
      const tmpFile = path.join(
        os.tmpdir(),
        `jbx_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`
      );
      fs.writeFileSync(tmpFile, code, 'utf-8');
      cleanupFile = tmpFile;
      const py = process.platform === 'win32' ? 'python' : 'python3';
      command = `${py} "${tmpFile}"`;
    } else {
      command = code;
    }

    const result = execSync(command, {
      encoding: 'utf-8',
      timeout,
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });

    if (cleanupFile) {
      try {
        fs.unlinkSync(cleanupFile);
      } catch {
        /* ignore */
      }
    }

    Logger.info(`⚡ execute_code 成功 (${language})`, 'ExecuteCode');
    return ok(
      (result || '(无输出)').substring(0, 10000),
      Date.now() - startTime,
      { language, exitCode: 0 }
    );
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    const output = err.stdout || err.stderr || err.message || '执行失败';
    return fail(
      `${language} 执行失败 (exit ${err.status ?? 1}): ${err.message.substring(0, 200)}`,
      Date.now() - startTime,
      output.substring(0, 5000)
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

    const forbidden = containsForbidden(code);
    if (forbidden) {
      Logger.warn(
        `🛡️ execute_code 拦截危险代码: "${forbidden}"`,
        'ExecuteCode'
      );
      return fail(
        `代码被安全策略拦截: 包含禁止的操作 "${forbidden}"`,
        Date.now() - startTime
      );
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
