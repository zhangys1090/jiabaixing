/**
 * Harness Tool: file_list - 列出目录内容
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

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
}

/** 创建 file_list 执行器 */
export function createFileListExecutor(deps: FileListDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const directory = (params.directory as string) || '.';
    const pattern = (params.pattern as string) || '*';
    const recursive = Boolean(params.recursive);

    if (!deps.listDirectory) {
      return {
        success: false,
        output: '目录列表服务不可用。请直接提供文件路径。',
        duration: 0,
        validated: false,
      };
    }

    try {
      const entries = await deps.listDirectory({
        directory,
        pattern,
        recursive,
      });

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
