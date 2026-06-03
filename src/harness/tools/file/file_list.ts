/**
 * Harness Tool: file_list - 列出目录内容
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';
import fs from 'fs/promises';
import path from 'path';

export const FILE_LIST_DEF: ToolDefinition = {
  name: 'file_list',
  description:
    '列出指定目录下的文件和子目录。适用场景：需要了解项目结构、查找某个目录下有哪些文件、确认文件是否存在。不适用：搜索文件内容（用 file_search）。',
  category: ToolCategory.FILE,
  parameters: {
    directory: {
      type: 'string',
      description: '要列出的目录路径，默认为项目根目录',
    },
    pattern: {
      type: 'string',
      description: '文件名匹配模式，如 "*.ts"、"src/**"',
      default: '*',
    },
    recursive: {
      type: 'boolean',
      description: '是否递归列出子目录内容',
      default: false,
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 10000,
};

/** file_list 依赖接口 */
export interface FileListDeps {
  listDirectory?: (params: {
    directory: string;
    pattern: string;
    recursive: boolean;
  }) => Promise<
    Array<{
      name: string;
      path: string;
      type: 'file' | 'directory';
      size?: number;
    }>
  >;
  projectRoot?: string;
}

function matchesPattern(fileName: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**/*') return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(fileName);
}

async function listWithFs(
  directory: string,
  pattern: string,
  recursive: boolean,
  projectRoot: string
): Promise<
  Array<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
  }>
> {
  const resolvedDir = path.isAbsolute(directory)
    ? directory
    : path.resolve(projectRoot, directory);

  const results: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
  }> = [];

  async function walkDir(dir: string, depth: number): Promise<void> {
    if (recursive && depth > 10) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(projectRoot, fullPath);

      if (entry.isDirectory()) {
        results.push({
          name: entry.name,
          path: relativePath || fullPath,
          type: 'directory',
        });
        if (recursive) {
          await walkDir(fullPath, depth + 1);
        }
      } else if (entry.isFile() && matchesPattern(entry.name, pattern)) {
        let size: number | undefined;
        try {
          const stat = await fs.stat(fullPath);
          size = stat.size;
        } catch { /* best-effort */ }
        results.push({
          name: entry.name,
          path: relativePath || fullPath,
          type: 'file',
          size,
        });
      }
    }
  }

  await walkDir(resolvedDir, 0);
  return results;
}

/** 创建 file_list 执行器 */
export function createFileListExecutor(deps: FileListDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const directory = (params.directory as string) || '.';
    const pattern = (params.pattern as string) || '*';
    const recursive = Boolean(params.recursive);

    try {
      let entries: Array<{
        name: string;
        path: string;
        type: 'file' | 'directory';
        size?: number;
      }>;

      if (deps.listDirectory) {
        entries = await deps.listDirectory({
          directory,
          pattern,
          recursive,
        });
      } else {
        entries = await listWithFs(
          directory,
          pattern,
          recursive,
          deps.projectRoot || process.cwd()
        );
      }

      if (entries.length === 0) {
        return {
          success: true,
          output: `目录 "${directory}" 为空或无匹配项`,
          duration: 0,
          validated: false,
        };
      }

      const formatted = entries
        .map((e) => `${e.type === 'directory' ? '📁' : '📄'} ${e.path}`)
        .join('\n');

      Logger.info(`📂 file_list 成功: ${directory} (${entries.length}项)`, 'FileList');

      return {
        success: true,
        output: formatted,
        duration: 0,
        validated: false,
        metadata: {
          totalFiles: entries.filter((e) => e.type === 'file').length,
          totalDirs: entries.filter((e) => e.type === 'directory').length,
        },
      };
    } catch (error) {
      Logger.error('❌ file_list 失败', error as Error, 'FileList');
      return {
        success: false,
        output: `目录列表失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: 0,
        validated: false,
      };
    }
  };
}
