/**
 * Harness Tool: file_search - 在文件内容中搜索关键词
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';
import fs from 'fs/promises';
import path from 'path';

export const FILE_SEARCH_DEF: ToolDefinition = {
  name: 'file_search',
  description:
    '在文件内容中搜索关键词或模式。适用场景：查找某个函数定义、搜索包含特定文本的文件、定位代码中的某个配置项。不适用：按文件名查找（用 file_list）。',
  category: ToolCategory.FILE,
  parameters: {
    query: {
      type: 'string',
      description: '搜索关键词或正则表达式',
    },
    directory: {
      type: 'string',
      description: '搜索目录路径，默认为项目根目录',
    },
    filePattern: {
      type: 'string',
      description: '文件匹配模式，如 "*.ts"、"*.json"',
      default: '*',
    },
    maxResults: {
      type: 'number',
      description: '最大返回结果数，默认20',
      default: 20,
    },
  },
  requiredParams: ['query'],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 15000,
};

/** file_search 依赖接口 */
export interface FileSearchDeps {
  searchInFiles?: (params: {
    query: string;
    directory?: string;
    filePattern?: string;
    maxResults?: number;
  }) => Promise<
    Array<{
      filePath: string;
      line: number;
      content: string;
      match: string;
    }>
  >;
  projectRoot?: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'coverage', '__pycache__', '.cache', 'tmp', 'data',
]);

function matchesFilePattern(fileName: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**/*') return true;
  const ext = pattern.replace('*.', '');
  if (fileName.endsWith(`.${ext}`)) return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(fileName);
}

async function searchWithFs(
  query: string,
  directory: string,
  filePattern: string,
  maxResults: number,
  projectRoot: string
): Promise<
  Array<{
    filePath: string;
    line: number;
    content: string;
    match: string;
  }>
> {
  const resolvedDir = path.isAbsolute(directory)
    ? directory
    : path.resolve(projectRoot, directory);

  const results: Array<{
    filePath: string;
    line: number;
    content: string;
    match: string;
  }> = [];

  let regex: RegExp;
  try {
    regex = new RegExp(query, 'gi');
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, 'gi');
  }

  async function walkAndSearch(dir: string, depth: number): Promise<void> {
    if (results.length >= maxResults) return;
    if (depth > 15) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walkAndSearch(fullPath, depth + 1);
      } else if (entry.isFile() && matchesFilePattern(entry.name, filePattern)) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > 1024 * 1024) continue;

          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              const relativePath = path.relative(projectRoot, fullPath);
              results.push({
                filePath: relativePath || fullPath,
                line: i + 1,
                content: lines[i].trim().substring(0, 200),
                match: lines[i].trim().substring(0, 100),
              });
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  await walkAndSearch(resolvedDir, 0);
  return results;
}

/** 创建 file_search 执行器 */
export function createFileSearchExecutor(deps: FileSearchDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const query = String(params.query || '');
    const directory = (params.directory as string) || '.';
    const filePattern = (params.filePattern as string) || '*';
    const maxResults = Number(params.maxResults) || 20;

    if (!query) {
      return {
        success: false,
        output: null,
        error: '搜索关键词不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    try {
      let results: Array<{
        filePath: string;
        line: number;
        content: string;
        match: string;
      }>;

      if (deps.searchInFiles) {
        results = await deps.searchInFiles({
          query,
          directory,
          filePattern,
          maxResults,
        });
      } else {
        results = await searchWithFs(
          query,
          directory,
          filePattern,
          maxResults,
          deps.projectRoot || process.cwd()
        );
      }

      if (results.length === 0) {
        return {
          success: true,
          output: `未找到包含"${query}"的内容`,
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.filePath}:${r.line} — ${r.match}`)
        .join('\n');

      Logger.info(`🔍 file_search 成功: "${query}" (${results.length}结果)`, 'FileSearch');

      return {
        success: true,
        output: formatted,
        duration: Date.now() - startTime,
        validated: false,
        metadata: { resultCount: results.length },
      };
    } catch (error) {
      Logger.error('❌ file_search 失败', error as Error, 'FileSearch');
      return {
        success: false,
        output: `搜索失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
