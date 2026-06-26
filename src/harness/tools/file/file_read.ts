import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const FILE_READ_DEF: ToolDefinition = {
  name: 'file_read',
  description:
    '读取指定文件的内容。适用场景：查看源代码文件、读取配置文件、获取文档内容。不适用：列出目录内容（用 file_list）、搜索文件（用 file_search）。',
  category: ToolCategory.FILE,
  parameters: {
    file_path: {
      type: 'string',
      description: '要读取的文件路径（绝对路径或相对于项目根目录的路径）',
    },
    encoding: {
      type: 'string',
      description: '文件编码格式',
      enum: ['utf-8', 'ascii', 'base64', 'hex'],
      default: 'utf-8',
    },
    offset: {
      type: 'number',
      description: '起始行号（从1开始），用于读取文件的部分内容',
      default: 1,
    },
    limit: {
      type: 'number',
      description: '最多读取的行数，0表示读取全部',
      default: 0,
    },
  },
  requiredParams: ['file_path'],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 10000,
};

export interface FileReadDeps {
  readFileContent?: (path: string) => Promise<string>;
  projectRoot?: string;
}

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_OUTPUT_LENGTH = 50000;

/** Windows 路径兼容：将 Unix 风格路径转换为当前平台兼容路径 */
function normalizePath(rawPath: string): string {
  // /tmp/ → Windows 临时目录
  if (rawPath.startsWith('/tmp/')) {
    const tmpDir = os.tmpdir().replace(/\\/g, '/');
    return rawPath.replace('/tmp/', tmpDir + '/');
  }
  // /home/user/ → USERPROFILE
  if (rawPath.startsWith('/home/') && process.platform === 'win32') {
    const home =
      process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default';
    return rawPath.replace(/^\/home\/[^/]+\//, home.replace(/\\/g, '/') + '/');
  }
  return rawPath;
}

export function createFileReadExecutor(deps: FileReadDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    let rawPath = normalizePath(String(params.file_path || ''));
    const encoding = String(params.encoding || 'utf-8') as BufferEncoding;
    const offset = Math.max(1, Number(params.offset) || 1);
    const limit = Number(params.limit) || 0;

    if (!rawPath) {
      return {
        success: false,
        output: null,
        error: '文件路径不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    try {
      let content: string;

      if (deps.readFileContent) {
        content = await deps.readFileContent(rawPath);
      } else {
        let resolvedPath = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(deps.projectRoot || process.cwd(), rawPath);

        // 自动修正: 尝试常见路径变体
        let statResult: Awaited<ReturnType<typeof fs.stat>> | null = null;
        const pathCandidates = [resolvedPath];

        if (!path.isAbsolute(rawPath)) {
          pathCandidates.push(
            path.resolve(process.cwd(), rawPath),
            path.resolve(process.cwd(), 'src', rawPath)
          );
        }

        for (const candidate of pathCandidates) {
          try {
            statResult = await fs.stat(candidate);
            resolvedPath = candidate;
            break;
          } catch {
            continue;
          }
        }

        if (!statResult) {
          await fs.stat(resolvedPath);
        } else if (statResult.size > MAX_FILE_SIZE) {
          return {
            success: false,
            output: null,
            error: `文件过大 (${(Number(statResult.size) / 1024 / 1024).toFixed(1)}MB)，超过最大限制 2MB。请使用 offset 和 limit 参数分段读取。`,
            duration: Date.now() - startTime,
            validated: false,
          };
        }

        content = await fs.readFile(resolvedPath, {
          encoding: encoding as BufferEncoding,
        });
      }

      if (limit > 0 || offset > 1) {
        const lines = content.split('\n');
        const startLine = offset - 1;
        const endLine = limit > 0 ? startLine + limit : lines.length;
        const selectedLines = lines.slice(startLine, endLine);
        const lineNumbers = selectedLines
          .map((line, i) => `${startLine + i + 1}→${line}`)
          .join('\n');
        content = lineNumbers;
      }

      if (content.length > MAX_OUTPUT_LENGTH) {
        content =
          content.substring(0, MAX_OUTPUT_LENGTH) + '\n\n... (内容已截断)';
      }

      Logger.info(
        `📄 file_read 成功: ${rawPath} (${content.length}字符)`,
        'FileRead'
      );

      return {
        success: true,
        output: content,
        duration: Date.now() - startTime,
        validated: false,
        metadata: { filePath: rawPath, encoding, offset, limit },
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      let userMessage: string;

      if (error.code === 'ENOENT') {
        userMessage = `文件不存在: ${rawPath}`;
      } else if (error.code === 'EACCES') {
        userMessage = `权限不足，无法读取文件: ${rawPath}`;
      } else if (error.code === 'EISDIR') {
        userMessage = `路径是目录而非文件: ${rawPath}，请使用 file_list 工具列出目录内容`;
      } else {
        userMessage = `读取文件失败: ${error.message}`;
      }

      Logger.error('❌ file_read 失败', error, 'FileRead');

      return {
        success: false,
        output: null,
        error: userMessage,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
