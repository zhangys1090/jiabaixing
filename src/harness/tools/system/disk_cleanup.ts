/**
 * Harness Tool: disk_cleanup - 智能磁盘清理
 *
 * 扫描并清理项目中的临时文件、缓存、构建产物等。
 * 提供预览模式，确认后才执行删除。
 */

import fs from 'fs/promises';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const DISK_CLEANUP_DEF: ToolDefinition = {
  name: 'disk_cleanup',
  description:
    '扫描并清理项目中的临时文件、缓存和构建产物。适用场景：磁盘空间不足、项目体积过大、清理CI/CD缓存。不适用：清理用户个人文件。默认预览模式，需confirm=true才执行删除。',
  category: ToolCategory.SYSTEM,
  parameters: {
    directory: {
      type: 'string',
      description: '要扫描的项目根目录',
    },
    categories: {
      type: 'array',
      items: { type: 'string', description: '清理类别' },
      description:
        '要清理的类别: cache,build,temp,logs,node_modules,all。默认all',
      default: ['all'],
    },
    confirm: {
      type: 'boolean',
      description: '确认执行删除。默认false（仅预览）',
      default: false,
    },
    dry_run: {
      type: 'boolean',
      description: '模拟运行，不实际删除。默认true',
      default: true,
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.FILE_WRITE, Permission.SYSTEM_ADMIN],
  riskLevel: 'high',
  idempotent: true,
  timeout: 30000,
  requiresConfirmation: true,
};

interface CleanupItem {
  path: string;
  category: string;
  size: number;
  description: string;
}

const CLEANUP_TARGETS: Record<
  string,
  { patterns: string[]; description: string }
> = {
  cache: {
    patterns: [
      '.cache',
      '.parcel-cache',
      '.eslintcache',
      '.stylelintcache',
      'tsconfig.tsbuildinfo',
      '.tsbuildinfo',
    ],
    description: '工具缓存文件',
  },
  build: {
    patterns: [
      'dist',
      'build',
      'out',
      '.next',
      '.nuxt',
      '.output',
      '.svelte-kit',
    ],
    description: '构建产物',
  },
  temp: {
    patterns: ['.tmp', 'tmp', 'temp', '.temp', '*.tmp', '*.bak', '*.swp', '*~'],
    description: '临时文件',
  },
  logs: {
    patterns: [
      'logs',
      '*.log',
      'npm-debug.log*',
      'yarn-debug.log*',
      'yarn-error.log*',
    ],
    description: '日志文件',
  },
  node_modules: {
    patterns: ['node_modules'],
    description: 'Node.js 依赖（谨慎清理）',
  },
};

async function getDirSize(dirPath: string): Promise<number> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return stat.size;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let totalSize = 0;

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirSize(fullPath);
      } else {
        try {
          const fileStat = await fs.stat(fullPath);
          totalSize += fileStat.size;
        } catch {
          continue;
        }
      }
    }
    return totalSize;
  } catch {
    return 0;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

async function scanForCleanup(
  projectRoot: string,
  categories: string[]
): Promise<CleanupItem[]> {
  const items: CleanupItem[] = [];
  const cats = categories.includes('all')
    ? Object.keys(CLEANUP_TARGETS)
    : categories;

  for (const cat of cats) {
    const target = CLEANUP_TARGETS[cat];
    if (!target) continue;

    for (const pattern of target.patterns) {
      if (pattern.includes('*')) {
        // glob pattern - scan root for matching files
        try {
          const entries = await fs.readdir(projectRoot, {
            withFileTypes: true,
          });
          for (const entry of entries) {
            const regex = new RegExp(
              pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
            );
            if (regex.test(entry.name)) {
              const fullPath = path.join(projectRoot, entry.name);
              const size = entry.isDirectory()
                ? await getDirSize(fullPath)
                : (await fs.stat(fullPath)).size;
              if (size > 0) {
                items.push({
                  path: fullPath,
                  category: cat,
                  size,
                  description: target.description,
                });
              }
            }
          }
        } catch {
          continue;
        }
      } else {
        const fullPath = path.join(projectRoot, pattern);
        try {
          const stat = await fs.stat(fullPath);
          const size = stat.isDirectory()
            ? await getDirSize(fullPath)
            : stat.size;
          if (size > 0) {
            items.push({
              path: fullPath,
              category: cat,
              size,
              description: target.description,
            });
          }
        } catch {
          continue;
        }
      }
    }
  }

  return items.sort((a, b) => b.size - a.size);
}

async function deleteItem(itemPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(itemPath);
    if (stat.isDirectory()) {
      await fs.rm(itemPath, { recursive: true, force: true });
    } else {
      await fs.unlink(itemPath);
    }
    return true;
  } catch {
    return false;
  }
}

export function createDiskCleanupExecutor(deps?: { projectRoot?: string }) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const directory = (params.directory as string) || '.';
    const categories = (params.categories as string[]) || ['all'];
    const confirm = Boolean(params.confirm);
    const dryRun =
      params.dry_run !== undefined ? Boolean(params.dry_run) : true;

    const projectRoot = path.isAbsolute(directory)
      ? directory
      : path.resolve(deps?.projectRoot || process.cwd(), directory);

    try {
      Logger.info(`🧹 disk_cleanup 开始: ${projectRoot}`, 'DiskCleanup');

      const items = await scanForCleanup(projectRoot, categories);

      if (items.length === 0) {
        return {
          success: true,
          output: '✅ 项目目录很干净，无需清理',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const totalSize = items.reduce((sum, i) => sum + i.size, 0);
      const willDelete = confirm && !dryRun;

      const categoryGroups: Record<string, CleanupItem[]> = {};
      for (const item of items) {
        if (!categoryGroups[item.category]) {
          categoryGroups[item.category] = [];
        }
        categoryGroups[item.category].push(item);
      }

      const lines: string[] = [
        `🧹 磁盘清理${willDelete ? '报告' : '预览'}`,
        `📂 项目: ${projectRoot}`,
        '',
        `📊 可释放空间: ${formatSize(totalSize)}`,
        '',
      ];

      for (const [cat, catItems] of Object.entries(categoryGroups)) {
        const catSize = catItems.reduce((sum, i) => sum + i.size, 0);
        lines.push(
          `**${cat.toUpperCase()}** — ${catItems[0].description} (${formatSize(catSize)})`
        );
        for (const item of catItems) {
          const icon = willDelete ? '🗑️' : '📁';
          lines.push(
            `  ${icon} ${path.relative(projectRoot, item.path)} — ${formatSize(item.size)}`
          );
        }
        lines.push('');
      }

      if (willDelete) {
        let deleted = 0;
        let failed = 0;
        let freedBytes = 0;

        for (const item of items) {
          const ok = await deleteItem(item.path);
          if (ok) {
            deleted++;
            freedBytes += item.size;
          } else {
            failed++;
          }
        }

        lines.push(
          `✅ 清理完成: 删除${deleted}项, 释放${formatSize(freedBytes)}`
        );
        if (failed > 0) {
          lines.push(`⚠️ ${failed}项删除失败（可能被占用）`);
        }

        Logger.info(
          `🧹 disk_cleanup 完成: 删除${deleted}项, 释放${formatSize(freedBytes)}`,
          'DiskCleanup'
        );
      } else {
        lines.push('⚠️ 预览模式，未实际删除');
        lines.push('💡 设置 confirm=true 执行清理，或使用 dry_run=false');
      }

      return {
        success: true,
        output: lines.join('\n'),
        duration: Date.now() - startTime,
        validated: willDelete,
        metadata: {
          totalItems: items.length,
          totalSize,
          categories: Object.keys(categoryGroups),
          executed: willDelete,
        },
      };
    } catch (error) {
      Logger.error('❌ disk_cleanup 失败', error as Error, 'DiskCleanup');
      return {
        success: false,
        output: `磁盘清理失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
