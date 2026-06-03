/**
 * 文件去重工具 — 检测目录中的重复文件
 *
 * 从 AI Agent 文件管理模式学到：
 * - 内容哈希检测精确重复
 * - 文件名相似度检测近似重复
 * - 返回候选对供用户确认，不自动删除
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const FILE_DEDUP_DEF: ToolDefinition = {
  name: 'file_dedup',
  description:
    '扫描目录中的重复文件。USE WHEN: 用户要求清理重复文件、整理目录、释放磁盘空间。DO NOT USE WHEN: 用户要搜索文件内容（用file_search）或列出目录（用file_list）。返回重复文件对列表，不自动删除。',
  category: ToolCategory.FILE,
  parameters: {
    directory: {
      type: 'string',
      description: '要扫描的目录路径，默认当前目录',
    },
    recursive: {
      type: 'boolean',
      description: '是否递归扫描子目录',
      default: true,
    },
    min_size: {
      type: 'number',
      description: '最小文件大小(字节)，跳过太小的文件',
      default: 1024,
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 60000,
};

interface FileInfo {
  path: string;
  size: number;
  hash: string;
  name: string;
}

export function createFileDedupExecutor() {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const dir = String(params.directory || process.cwd());
    const recursive = params.recursive !== false;
    const minSize = Number(params.min_size || 1024);

    try {
      if (!fs.existsSync(dir)) {
        return {
          success: false,
          output: null,
          error: `目录不存在: ${dir}`,
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      // 扫描文件
      const files = scanFiles(dir, recursive, minSize);
      if (files.length === 0) {
        return {
          success: true,
          output: '目录为空或没有符合条件的文件',
          duration: Date.now() - startTime,
          validated: true,
        };
      }

      // 按大小分组（大小相同的才可能是重复）
      const sizeGroups = new Map<number, FileInfo[]>();
      for (const file of files) {
        const group = sizeGroups.get(file.size) || [];
        group.push(file);
        sizeGroups.set(file.size, group);
      }

      // 对大小相同的文件计算哈希
      const duplicates: Array<{ files: string[]; size: number; hash: string }> = [];
      let totalWastedBytes = 0;

      for (const [, group] of sizeGroups) {
        if (group.length < 2) continue;

        // 计算哈希
        for (const file of group) {
          file.hash = await hashFile(file.path);
        }

        // 按哈希分组
        const hashGroups = new Map<string, FileInfo[]>();
        for (const file of group) {
          const hGroup = hashGroups.get(file.hash) || [];
          hGroup.push(file);
          hashGroups.set(file.hash, hGroup);
        }

        for (const [hash, hGroup] of hashGroups) {
          if (hGroup.length >= 2) {
            duplicates.push({
              files: hGroup.map((f) => f.path),
              size: hGroup[0].size,
              hash: hash.substring(0, 12),
            });
            totalWastedBytes += hGroup[0].size * (hGroup.length - 1);
          }
        }
      }

      // 格式化输出
      if (duplicates.length === 0) {
        return {
          success: true,
          output: `扫描了 ${files.length} 个文件，未发现重复文件。`,
          duration: Date.now() - startTime,
          validated: true,
        };
      }

      const lines: string[] = [];
      lines.push(`扫描了 ${files.length} 个文件，发现 ${duplicates.length} 组重复文件：`);
      lines.push(`浪费空间: ${formatSize(totalWastedBytes)}\n`);

      for (let i = 0; i < duplicates.length; i++) {
        const dup = duplicates[i];
        lines.push(`--- 第 ${i + 1} 组 (${formatSize(dup.size)}, hash: ${dup.hash}) ---`);
        for (const filePath of dup.files) {
          lines.push(`  ${filePath}`);
        }
        lines.push('');
      }

      lines.push('提示: 以上文件内容完全相同，请手动确认后删除不需要的副本。');

      return {
        success: true,
        output: lines.join('\n'),
        duration: Date.now() - startTime,
        validated: true,
        metadata: {
          scannedFiles: files.length,
          duplicateGroups: duplicates.length,
          wastedBytes: totalWastedBytes,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `文件去重扫描失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

function scanFiles(dir: string, recursive: boolean, minSize: number): FileInfo[] {
  const results: FileInfo[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size >= minSize) {
            results.push({
              path: fullPath,
              size: stat.size,
              hash: '',
              name: entry.name,
            });
          }
        } catch {
          // 跳过不可读文件
        }
      } else if (entry.isDirectory() && recursive && !entry.name.startsWith('.')) {
        results.push(...scanFiles(fullPath, recursive, minSize));
      }
    }
  } catch {
    // 目录不可读
  }
  return results;
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
