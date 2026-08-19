/**
 * Harness Tool: lazy_deps - 懒加载依赖分析
 *
 * 分析项目依赖，识别哪些是真正被使用的、哪些可以延迟加载，
 * 生成优化建议。减少启动时间和内存占用。
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const LAZY_DEPS_DEF: ToolDefinition = {
  name: 'lazy_deps',
  description:
    '分析项目依赖使用情况，识别可懒加载的依赖，生成优化建议。适用场景：项目启动慢、包体积过大、依赖冗余检查。不适用：非 Node.js 项目。',
  category: ToolCategory.SYSTEM,
  parameters: {
    directory: {
      type: 'string',
      description: '项目根目录路径，默认为当前工作目录',
    },
    action: {
      type: 'string',
      description:
        '操作类型：analyze=分析依赖, suggest=生成优化建议, report=完整报告',
      enum: ['analyze', 'suggest', 'report'],
      default: 'report',
    },
    include_dev: {
      type: 'boolean',
      description: '是否包含 devDependencies 分析',
      default: false,
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};

interface DepInfo {
  name: string;
  version: string;
  isDev: boolean;
  importCount: number;
  importFiles: string[];
  category: 'core' | 'lazy_candidate' | 'unused' | 'conditional';
  estimatedSize?: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const LAZY_CANDIDATE_PATTERNS: Record<string, string[]> = {
  'heavy-ui': [
    'antd',
    '@mui/material',
    '@chakra-ui/react',
    'evergreen-ui',
    'ag-grid-react',
    'react-data-table-component',
  ],
  'markdown-it': ['markdown-it', 'marked', 'remark', 'rehype'],
  chart: ['chart.js', 'd3', 'echarts', 'recharts', 'plotly.js'],
  image: ['sharp', 'jimp', 'canvas', 'imagemagick'],
  pdf: ['pdfkit', 'puppeteer', 'jspdf', 'pdf-lib'],
  excel: ['xlsx', 'exceljs', 'node-xlsx'],
  'ai-ml': [
    '@tensorflow/tfjs',
    'onnxruntime-node',
    'openai',
    '@anthropic-ai/sdk',
  ],
  database: ['mongoose', 'pg', 'mysql2', 'better-sqlite3', 'prisma'],
  crypto: ['bcrypt', 'argon2', 'node-forge'],
  locale: ['i18next', 'react-intl', '@formatjs/intl'],
};

const KNOWN_SIZES: Record<string, string> = {
  antd: '~2.2MB',
  '@mui/material': '~1.5MB',
  lodash: '~1.4MB',
  moment: '~300KB',
  d3: '~500KB',
  'chart.js': '~200KB',
  sharp: '~30MB',
  puppeteer: '~300MB',
  '@tensorflow/tfjs': '~3MB',
  mongoose: '~2MB',
  i18next: '~100KB',
  xlsx: '~800KB',
  echarts: '~3MB',
  'ag-grid-react': '~1.5MB',
};

async function readPackageJson(
  projectRoot: string
): Promise<PackageJson | null> {
  const pkgPath = path.join(projectRoot, 'package.json');
  try {
    const content = fs.readFileSync(pkgPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function scanImports(
  projectRoot: string,
  depNames: string[]
): Promise<Map<string, { count: number; files: string[] }>> {
  const importMap = new Map<string, { count: number; files: string[] }>();

  for (const name of depNames) {
    importMap.set(name, { count: 0, files: [] });
  }

  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    return importMap;
  }

  function walkDir(dir: string, depth: number = 0): void {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath, depth + 1);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relPath = path.relative(projectRoot, fullPath);

          for (const name of depNames) {
            const patterns = [
              `require('${name}')`,
              `require("${name}")`,
              `from '${name}'`,
              `from "${name}"`,
              `from '${name}/`,
              `from "${name}/`,
              `import('${name}')`,
              `import("${name}")`,
            ];

            for (const pattern of patterns) {
              if (content.includes(pattern)) {
                const info = importMap.get(name)!;
                info.count++;
                if (info.files.length < 5) {
                  info.files.push(relPath);
                }
                break;
              }
            }
          }
        } catch {
          continue;
        }
      }
    }
  }

  walkDir(srcDir);

  const additionalDirs = ['app', 'lib', 'packages'];
  for (const dirName of additionalDirs) {
    const dir = path.join(projectRoot, dirName);
    if (fs.existsSync(dir)) {
      walkDir(dir);
    }
  }

  return importMap;
}

function categorizeDep(
  name: string,
  importCount: number,
  isDev: boolean
): DepInfo['category'] {
  if (isDev) return 'conditional';
  if (importCount === 0) return 'unused';

  for (const [, patterns] of Object.entries(LAZY_CANDIDATE_PATTERNS)) {
    if (patterns.includes(name)) {
      return importCount <= 3 ? 'lazy_candidate' : 'core';
    }
  }

  return importCount <= 2 ? 'lazy_candidate' : 'core';
}

export function createLazyDepsExecutor(deps?: { projectRoot?: string }) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const directory = (params.directory as string) || '.';
    const action = (params.action as string) || 'report';
    const includeDev = Boolean(params.include_dev);

    const projectRoot = path.isAbsolute(directory)
      ? directory
      : path.resolve(deps?.projectRoot || process.cwd(), directory);

    try {
      Logger.info(`📦 lazy_deps 开始分析: ${projectRoot}`, 'LazyDeps');

      const pkg = await readPackageJson(projectRoot);
      if (!pkg) {
        return {
          success: false,
          output: '',
          error: '未找到 package.json',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const allDeps: Array<{ name: string; version: string; isDev: boolean }> =
        [];

      for (const [name, version] of Object.entries(pkg.dependencies || {})) {
        allDeps.push({ name, version, isDev: false });
      }
      if (includeDev) {
        for (const [name, version] of Object.entries(
          pkg.devDependencies || {}
        )) {
          allDeps.push({ name, version, isDev: true });
        }
      }

      if (allDeps.length === 0) {
        return {
          success: true,
          output: '📦 项目没有声明任何依赖',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const importMap = await scanImports(
        projectRoot,
        allDeps.map((d) => d.name)
      );

      const depInfos: DepInfo[] = allDeps.map((dep) => {
        const importInfo = importMap.get(dep.name) || { count: 0, files: [] };
        const category = categorizeDep(dep.name, importInfo.count, dep.isDev);

        return {
          name: dep.name,
          version: dep.version,
          isDev: dep.isDev,
          importCount: importInfo.count,
          importFiles: importInfo.files,
          category,
          estimatedSize: KNOWN_SIZES[dep.name],
        };
      });

      const core = depInfos.filter((d) => d.category === 'core');
      const lazyCandidates = depInfos.filter(
        (d) => d.category === 'lazy_candidate'
      );
      const unused = depInfos.filter((d) => d.category === 'unused');
      const conditional = depInfos.filter((d) => d.category === 'conditional');

      if (action === 'analyze') {
        const output = [
          `📦 依赖分析: ${pkg.name || 'unnamed'}@${pkg.version || '0.0.0'}`,
          '',
          `总依赖数: ${allDeps.length}`,
          `  核心: ${core.length} | 可懒加载: ${lazyCandidates.length} | 未使用: ${unused.length} | 条件: ${conditional.length}`,
        ].join('\n');

        return {
          success: true,
          output,
          duration: Date.now() - startTime,
          validated: false,
          metadata: {
            total: allDeps.length,
            core: core.length,
            lazyCandidates: lazyCandidates.length,
            unused: unused.length,
          },
        };
      }

      if (action === 'suggest') {
        const lines: string[] = ['💡 依赖优化建议', ''];

        if (lazyCandidates.length > 0) {
          lines.push('🔄 可懒加载的依赖:');
          for (const dep of lazyCandidates) {
            const size = dep.estimatedSize ? ` (${dep.estimatedSize})` : '';
            lines.push(
              `  - ${dep.name}@${dep.version}${size} — 引用${dep.importCount}次`
            );
            if (dep.importFiles.length > 0) {
              lines.push(`    引用位置: ${dep.importFiles.join(', ')}`);
            }
          }
          lines.push('');
        }

        if (unused.length > 0) {
          lines.push('🗑️ 可能未使用的依赖:');
          for (const dep of unused) {
            lines.push(`  - ${dep.name}@${dep.version}`);
          }
          lines.push('');
          lines.push('💡 运行 `npm uninstall <package>` 移除未使用的依赖');
        }

        if (lazyCandidates.length === 0 && unused.length === 0) {
          lines.push('✅ 依赖使用合理，暂无优化建议');
        }

        return {
          success: true,
          output: lines.join('\n'),
          duration: Date.now() - startTime,
          validated: false,
          metadata: {
            lazyCandidates: lazyCandidates.map((d) => d.name),
            unused: unused.map((d) => d.name),
          },
        };
      }

      // action === 'report'
      const lines: string[] = [
        `📦 依赖分析报告: ${pkg.name || 'unnamed'}@${pkg.version || '0.0.0'}`,
        `📂 项目: ${projectRoot}`,
        '',
        `📊 概览: ${allDeps.length} 个依赖`,
        `  🔵 核心: ${core.length} | 🟡 可懒加载: ${lazyCandidates.length} | 🔴 未使用: ${unused.length} | ⚪ 条件: ${conditional.length}`,
        '',
      ];

      if (core.length > 0) {
        lines.push('🔵 核心依赖（频繁引用，应同步加载）:');
        for (const dep of core) {
          const size = dep.estimatedSize ? ` (${dep.estimatedSize})` : '';
          lines.push(
            `  ${dep.name}@${dep.version}${size} — ${dep.importCount}次引用`
          );
        }
        lines.push('');
      }

      if (lazyCandidates.length > 0) {
        lines.push('🟡 懒加载候选（低频引用，可延迟加载）:');
        for (const dep of lazyCandidates) {
          const size = dep.estimatedSize ? ` (${dep.estimatedSize})` : '';
          lines.push(
            `  ${dep.name}@${dep.version}${size} — ${dep.importCount}次引用`
          );
          if (dep.importFiles.length > 0) {
            lines.push(`    📍 ${dep.importFiles.join(', ')}`);
          }
          lines.push(`    → 使用 dynamic import() 或 React.lazy() 延迟加载`);
        }
        lines.push('');
      }

      if (unused.length > 0) {
        lines.push('🔴 未使用依赖（未发现引用，考虑移除）:');
        for (const dep of unused) {
          const size = dep.estimatedSize ? ` (${dep.estimatedSize})` : '';
          lines.push(`  ${dep.name}@${dep.version}${size}`);
        }
        lines.push('');
      }

      const potentialSavings = lazyCandidates.filter(
        (d) => d.estimatedSize
      ).length;
      if (potentialSavings > 0) {
        lines.push(
          `💡 通过懒加载可显著减少初始包体积，涉及 ${potentialSavings} 个大体积依赖`
        );
      }

      Logger.info(
        `📦 lazy_deps 完成: ${allDeps.length}依赖, ${lazyCandidates.length}可懒加载, ${unused.length}未使用`,
        'LazyDeps'
      );

      return {
        success: true,
        output: lines.join('\n'),
        duration: Date.now() - startTime,
        validated: false,
        metadata: {
          total: allDeps.length,
          core: core.length,
          lazyCandidates: lazyCandidates.length,
          unused: unused.length,
          conditional: conditional.length,
        },
      };
    } catch (error) {
      Logger.error('❌ lazy_deps 分析失败', error as Error, 'LazyDeps');
      return {
        success: false,
        output: '',
        error: `依赖分析失败: ${(error as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
