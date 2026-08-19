/**
 * Harness Tool: subdirectory_hints - 智能子目录提示
 *
 * 分析项目结构，为 Agent 提供子目录导航提示。
 * 减少盲目搜索，让 Agent 快速定位目标目录。
 */

import fs from 'fs/promises';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

const COMMON_DIRS: Record<string, string[]> = {
  src: ['源代码目录', '通常包含主要业务逻辑'],
  lib: ['库代码目录', '可复用模块'],
  components: ['UI组件目录', '前端组件'],
  pages: ['页面目录', '路由页面'],
  routes: ['路由定义目录'],
  services: ['服务层目录', '业务逻辑封装'],
  controllers: ['控制器目录', '请求处理'],
  models: ['数据模型目录'],
  utils: ['工具函数目录'],
  helpers: ['辅助函数目录'],
  types: ['类型定义目录'],
  interfaces: ['接口定义目录'],
  config: ['配置文件目录'],
  tests: ['测试目录', '__tests__'],
  spec: ['测试规格目录'],
  docs: ['文档目录'],
  assets: ['静态资源目录'],
  public: ['公共资源目录'],
  styles: ['样式文件目录'],
  hooks: ['React Hooks目录'],
  stores: ['状态管理目录'],
  contexts: ['React Context目录'],
  api: ['API接口目录'],
  middleware: ['中间件目录'],
  plugins: ['插件目录'],
  scripts: ['脚本目录'],
  tools: ['工具目录'],
  migrations: ['数据库迁移目录'],
  seeds: ['数据库种子目录'],
};

interface DirHint {
  name: string;
  path: string;
  description: string;
  fileCount: number;
  subDirs: string[];
  relevance: number;
}

export const SUBDIRECTORY_HINTS_DEF: ToolDefinition = {
  name: 'subdirectory_hints',
  description:
    '分析项目目录结构，返回智能导航提示。适用场景：Agent需要了解项目布局、定位特定功能的目录、减少盲目搜索。不适用：已知目标路径的情况。',
  category: ToolCategory.FILE,
  parameters: {
    directory: {
      type: 'string',
      description: '要分析的根目录路径，默认为项目根目录',
    },
    query: {
      type: 'string',
      description: '搜索意图关键词，如"组件"、"API"、"测试"，用于排序相关性',
    },
    max_depth: {
      type: 'number',
      description: '最大扫描深度',
      default: 3,
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 15000,
};

function scoreRelevance(dirName: string, query?: string): number {
  let score = 0;
  const lower = dirName.toLowerCase();

  if (query) {
    const q = query.toLowerCase();
    if (lower.includes(q)) score += 10;
    if (COMMON_DIRS[lower]) {
      const desc = COMMON_DIRS[lower].join('');
      if (desc.includes(q)) score += 8;
    }
  }

  if (COMMON_DIRS[lower]) score += 3;
  if (lower === 'src' || lower === 'lib') score += 2;

  return score;
}

async function scanDirectory(
  rootDir: string,
  maxDepth: number,
  query?: string,
  currentDepth: number = 0
): Promise<DirHint[]> {
  if (currentDepth > maxDepth) return [];

  const hints: DirHint[] = [];

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const subDirs: string[] = [];
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    if (entry.isDirectory()) {
      subDirs.push(entry.name);
      const fullPath = path.join(rootDir, entry.name);
      const childHints = await scanDirectory(
        fullPath,
        maxDepth,
        query,
        currentDepth + 1
      );
      hints.push(...childHints);
    } else {
      fileCount++;
    }
  }

  const dirName = path.basename(rootDir);
  const relevance = scoreRelevance(dirName, query);

  if (currentDepth > 0 || subDirs.length > 0 || fileCount > 0) {
    hints.push({
      name: dirName,
      path: rootDir,
      description: COMMON_DIRS[dirName.toLowerCase()]?.join(' - ') || '',
      fileCount,
      subDirs,
      relevance,
    });
  }

  return hints.sort((a, b) => b.relevance - a.relevance);
}

export function createSubdirectoryHintsExecutor(deps?: {
  projectRoot?: string;
}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const directory = (params.directory as string) || '.';
    const query = params.query as string | undefined;
    const maxDepth = Number(params.max_depth) || 3;

    const rootDir = path.isAbsolute(directory)
      ? directory
      : path.resolve(deps?.projectRoot || process.cwd(), directory);

    try {
      const hints = await scanDirectory(rootDir, maxDepth, query);

      if (hints.length === 0) {
        return {
          success: true,
          output: `目录 "${directory}" 为空或不可访问`,
          duration: 0,
          validated: false,
        };
      }

      const lines = hints.slice(0, 30).map((h) => {
        const icon = h.subDirs.length > 0 ? '📁' : '📂';
        const desc = h.description ? ` — ${h.description}` : '';
        const subs =
          h.subDirs.length > 0
            ? ` [子目录: ${h.subDirs.slice(0, 5).join(', ')}${h.subDirs.length > 5 ? '...' : ''}]`
            : '';
        return `${icon} ${h.name}/ (${h.fileCount}文件)${desc}${subs}`;
      });

      const output = [
        `📂 项目目录提示 (${hints.length}个目录)`,
        query ? `🔍 搜索意图: "${query}"` : '',
        '',
        ...lines,
        '',
        '💡 提示: 使用 file_list 查看具体目录内容，使用 file_search 搜索文件',
      ]
        .filter(Boolean)
        .join('\n');

      Logger.info(
        `📂 subdirectory_hints: ${hints.length}个目录 (${directory})`,
        'SubdirectoryHints'
      );

      return {
        success: true,
        output,
        duration: 0,
        validated: false,
        metadata: {
          totalDirs: hints.length,
          topRelevant: hints.slice(0, 5).map((h) => h.name),
        },
      };
    } catch (error) {
      Logger.error(
        '❌ subdirectory_hints 失败',
        error as Error,
        'SubdirectoryHints'
      );
      return {
        success: false,
        output: `目录分析失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: 0,
        validated: false,
      };
    }
  };
}
