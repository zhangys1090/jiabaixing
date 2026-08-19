import fs from 'fs/promises';
import { realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

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
    line_numbers: {
      type: 'boolean',
      description: '是否在每行前标注行号',
      default: false,
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

/**
 * 将路径解析并断言落在允许根目录内（项目根 + /tmp 映射 + /home 映射）。
 * 防止 file_read 越界读取项目根之外的任意文件（沙箱逃逸）。
 * 越界时抛出 Error，由上层 catch 转为失败结果。
 */
export function resolveWithinRoot(rawPath: string, projectRoot?: string): string {
  const roots = [
    projectRoot || process.cwd(),
    os.tmpdir(),
    process.env.USERPROFILE || process.env.HOME || '',
  ]
    .filter(Boolean)
    .map((r) => path.resolve(r as string));

  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(projectRoot || process.cwd(), rawPath);

  const within = roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });

  if (!within) {
    throw new Error(
      `路径越界: 拒绝访问项目根目录之外的路径 "${rawPath}"`
    );
  }

  // 二级防护: 词法判定在根内, 但允许根内的符号链接可能指向根外。
  // 仅当路径真实存在时跟随 symlink 复检(将 roots 一并 realpath, 避免根自身为软链时误杀);
  // 路径不存在(realpath 抛 ENOENT)或其他 fs 错误时, 词法判定已通过, 保守放行交由上层执行阶段自然失败。
  try {
    const real = realpathSync(resolved);
    const realRoots = roots.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return r;
      }
    });
    const stillWithin = realRoots.some((root) => {
      const rel = path.relative(root, real);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!stillWithin) {
      throw new Error(
        `路径越界(symlink): 拒绝访问经符号链接指向项目根目录之外的路径 "${rawPath}"`
      );
    }
    return real;
  } catch (err) {
    // 仅当 realpath 因路径不存在(ENOENT)抛错时, 词法判定已通过, 保守放行交由上层执行阶段自然失败;
    // 其余错误(含 symlink 越界断言)必须向上传播, 不得静默降级为词法放行。
    if ((err as { code?: string }).code === 'ENOENT') return resolved;
    throw err;
  }
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
    const lineNumbers = params.line_numbers === true;

    if (!rawPath) {
      return {
        success: false,
        output: null,
        error: '文件路径不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    // P0-1 沙箱 containment: 在真正访问文件前，将路径解析并断言落在允许根目录内
    // （项目根 + os.tmpdir 映射 + USERPROFILE/HOME 映射）。越界路径（如 /etc/shadow、
    // C:\Windows\...）会在此抛出，由下方 catch 转为失败结果，杜绝 file_read 沙箱逃逸。
    let safePath: string;
    try {
      safePath = resolveWithinRoot(rawPath, deps.projectRoot);
    } catch (err) {
      Logger.error('❌ file_read 路径越界被拒绝', err as Error, 'FileRead');
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    try {
      let content: string;

      if (deps.readFileContent) {
        content = await deps.readFileContent(safePath);
      } else {
        // 以沙箱约束后的 safePath 为基准（已确保落在允许根目录内）
        let resolvedPath = safePath;

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
        const numbered = selectedLines
          .map((line, i) => `${startLine + i + 1}→${line}`)
          .join('\n');
        content = numbered;
      } else if (lineNumbers) {
        const lines = content.split('\n');
        content = lines.map((line, i) => `${i + 1}→${line}`).join('\n');
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
