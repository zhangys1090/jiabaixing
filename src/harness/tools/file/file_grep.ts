/**
 * Harness Tool: file_grep — 使用系统 grep/ripgrep 快速搜索代码
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export const FILE_GREP_DEF: ToolDefinition = {
  name: 'file_grep',
  description:
    '使用系统 grep/ripgrep 在代码库中快速搜索内容，支持正则、文件类型过滤、行数预览等。适用场景：代码搜索、查找引用、定位问题。',
  category: ToolCategory.FILE,
  parameters: {
    pattern: {
      type: 'string',
      description: '搜索模式（正则或关键字）',
    },
    directory: {
      type: 'string',
      description: '搜索目录路径，默认为项目根目录',
    },
    file_pattern: {
      type: 'string',
      description: '文件类型过滤，例如 *.ts,*.tsx,*.js,*.json',
    },
    ignore_case: {
      type: 'boolean',
      description: '是否忽略大小写',
      default: false,
    },
    show_context: {
      type: 'number',
      description: '显示匹配行的上下文行数',
      default: 2,
    },
    max_results: {
      type: 'number',
      description: '最大返回结果数',
      default: 50,
    },
  },
  requiredParams: ['pattern'],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};

export interface FileGrepDeps {
  projectRoot?: string;
  useRgPath?: string;
}

export function createFileGrepExecutor(deps: FileGrepDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const pattern = String(params.pattern || '');
    const directory = (params.directory as string) || deps.projectRoot || process.cwd();
    const filePattern = (params.file_pattern as string) || '';
    const ignoreCase = Boolean(params.ignore_case);
    const showContext = Number(params.show_context) || 2;
    const maxResults = Number(params.max_results) || 50;

    if (!pattern) {
      return {
        success: false,
        output: null,
        error: '搜索模式不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    try {
      Logger.info(`🔍 file_grep: 搜索模式="${pattern}" 在目录 "${directory}"`, 'FileGrep');

      let result: string;
      let usedTool: string;

      // 优先尝试 ripgrep (rg)，更快
      if (deps.useRgPath || await isCommandAvailable('rg')) {
        usedTool = 'rg';
        result = await runRipGrep(pattern, directory, {
          filePattern,
          ignoreCase,
          showContext,
          maxResults,
          rgPath: deps.useRgPath,
        });
      } else {
        usedTool = 'grep';
        result = await runGrep(pattern, directory, {
          filePattern,
          ignoreCase,
          showContext,
          maxResults,
        });
      }

      return {
        success: true,
        output: `搜索结果 (使用 ${usedTool})\n${result}`,
        duration: Date.now() - startTime,
        validated: false,
        metadata: { tool: usedTool },
      };
    } catch (err) {
      Logger.error('❌ file_grep 失败', err as Error, 'FileGrep');
      return {
        success: false,
        output: null,
        error: `搜索失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execAsync(`${command} --version`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function runRipGrep(
  pattern: string,
  directory: string,
  options: {
    filePattern: string;
    ignoreCase: boolean;
    showContext: number;
    maxResults: number;
    rgPath?: string;
  }
): Promise<string> {
  const args = [
    options.ignoreCase ? '-i' : '',
    `-C` + options.showContext,
    '--color',
    'never',
    '--max-count',
    String(options.maxResults),
  ].filter(Boolean);

  if (options.filePattern) {
    const patterns = options.filePattern.split(',').map((p) => p.trim());
    for (const p of patterns) {
      if (p) args.push('-g', p);
    }
  }

  args.push(pattern);

  const rgCmd = options.rgPath || 'rg';
  const { stdout } = await execAsync(
    `${rgCmd} ${args.join(' ')}`,
    {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 25000,
    }
  );
  return stdout;
}

async function runGrep(
  pattern: string,
  directory: string,
  options: {
    filePattern: string;
    ignoreCase: boolean;
    showContext: number;
    maxResults: number;
  }
): Promise<string> {
  let args = [
    '-r',
    '-n',
    options.ignoreCase ? '-i' : '',
    `-C` + options.showContext,
    '--color=never',
  ].filter(Boolean);

  // 构建文件类型过滤
  if (options.filePattern) {
    const patterns = options.filePattern.split(',').map((p) => p.trim());
    for (const p of patterns) {
      if (p) args.push(`--include=${p}`);
    }
  }

  args.push(pattern, '.');

  const { stdout } = await execAsync(`grep ${args.join(' ')}`, {
    cwd: directory,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 25000,
  });
  return stdout;
}
