/**
 * Harness Tool: file_search - 在文件内容中搜索关键词
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

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
}

/** 创建 file_search 执行器 */
export function createFileSearchExecutor(deps: FileSearchDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const query = String(params.query || '');
    const directory = params.directory as string | undefined;
    const filePattern = (params.filePattern as string) || '*';
    const maxResults = Number(params.maxResults) || 20;

    if (!deps.searchInFiles) {
      return {
        success: false,
        output: '文件搜索服务不可用。请直接提供文件路径。',
        duration: 0,
        validated: false,
      };
    }

    try {
      const results = await deps.searchInFiles({
        query,
        directory,
        filePattern,
        maxResults,
      });

      if (results.length === 0) {
        return {
          success: true,
          output: `未找到包含"${query}"的内容`,
          duration: 0,
          validated: false,
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.filePath}:${r.line} — ${r.match}`
        )
        .join('\n');

      return {
        success: true,
        output: formatted,
        duration: 0,
        validated: false,
        metadata: { resultCount: results.length },
      };
    } catch (error) {
      return {
        success: false,
        output: `搜索失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: 0,
        validated: false,
      };
    }
  };
}
