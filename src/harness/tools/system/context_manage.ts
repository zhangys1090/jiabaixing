/**
 * Harness Tool: context_manage - 项目上下文文件管理
 *
 * 支持操作：load / list / refresh / create
 * 权限：Permission.FILE_READ
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

/** 上下文文件扫描列表（与 JiabaixingCore 保持一致） */
const CONTEXT_FILE_LIST = [
  'JIABAIXING.md',
  'CONTEXT.md',
  '.jiabaixing/context.md',
  'CLAUDE.md',
] as const;

/** 上下文文件模板内容 */
const CONTEXT_TEMPLATE = `# 项目上下文

> 此文件由家百星自动创建，内容将自动注入到每次对话的上下文中。

## 项目概述

<!-- 描述项目的目标和用途 -->

## 技术栈

<!-- 列出项目使用的主要技术 -->

## 开发规范

<!-- 列出团队的开发规范和约定 -->

## 注意事项

<!-- 列出需要特别注意的事项 -->
`;

export const CONTEXT_MANAGE_DEF: ToolDefinition = {
  name: 'context_manage',
  description:
    '管理项目上下文文件（Context Files）。支持操作：load（手动加载上下文文件）、list（列出已加载的上下文文件）、refresh（刷新缓存）、create（创建上下文文件模板）。项目上下文文件会自动注入到每次对话中，为 Agent 提供项目级别的知识。',
  category: ToolCategory.SYSTEM,
  parameters: {
    action: {
      type: 'string',
      description: '要执行的操作：load | list | refresh | create',
      enum: ['load', 'list', 'refresh', 'create'],
    },
    fileName: {
      type: 'string',
      description:
        '目标文件名（create 操作时使用，默认为 JIABAIXING.md）。可选值：JIABAIXING.md, CONTEXT.md, .jiabaixing/context.md, CLAUDE.md',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 10000,
};

/** context_manage 工具依赖 */
export interface ContextManageDeps {
  /** JiabaixingCore 实例，用于访问上下文文件缓存 */
  core: {
    refreshProjectContext(): Promise<number>;
    getLoadedContextFiles(): ReadonlyArray<{
      fileName: string;
      content: string;
      loadedAt: number;
    }>;
  };
}

/**
 * 创建 context_manage 执行器
 * @param deps - 工具依赖，包含 JiabaixingCore 实例
 */
export function createContextManageExecutor(deps: ContextManageDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const action = String(params.action || '');
    const fileName = String(params.fileName || 'JIABAIXING.md');

    try {
      switch (action) {
        case 'load':
          return await handleLoad(deps, startTime);
        case 'list':
          return handleList(deps, startTime);
        case 'refresh':
          return await handleRefresh(deps, startTime);
        case 'create':
          return await handleCreate(fileName, startTime);
        default:
          return {
            success: false,
            output: '',
            error: `不支持的操作: ${action}。支持的操作: load, list, refresh, create`,
            duration: Date.now() - startTime,
            validated: false,
          };
      }
    } catch (error) {
      Logger.error(
        `context_manage 执行失败: ${(error as Error).message}`,
        error as Error,
        'ContextManage'
      );
      return {
        success: false,
        output: '',
        error: `操作失败: ${(error as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

/**
 * 处理 load 操作：手动加载上下文文件
 */
async function handleLoad(
  deps: ContextManageDeps,
  startTime: number
): Promise<ToolResult> {
  const projectRoot = process.cwd();
  const loadedFiles: Array<{ fileName: string; size: number }> = [];

  for (const fileName of CONTEXT_FILE_LIST) {
    const filePath = path.join(projectRoot, fileName);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content.length > 0) {
          loadedFiles.push({ fileName, size: content.length });
        }
      }
    } catch {
      // 跳过读取失败的文件
    }
  }

  if (loadedFiles.length === 0) {
    Logger.info('📄 未找到项目上下文文件', 'ContextManage');
    return {
      success: true,
      output:
        '未找到项目上下文文件。可创建的文件：JIABAIXING.md, CONTEXT.md, .jiabaixing/context.md, CLAUDE.md。使用 context_manage action:create 创建模板。',
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  Logger.info(
    `📄 手动加载上下文文件: ${loadedFiles.length} 个`,
    'ContextManage'
  );

  const fileList = loadedFiles
    .map((f) => `- ${f.fileName} (${f.size} 字符)`)
    .join('\n');

  return {
    success: true,
    output: `已加载 ${loadedFiles.length} 个上下文文件：\n${fileList}`,
    duration: Date.now() - startTime,
    validated: false,
    metadata: { loadedFiles },
  };
}

/**
 * 处理 list 操作：列出已加载的上下文文件
 */
function handleList(
  deps: ContextManageDeps,
  startTime: number
): Promise<ToolResult> {
  const loadedFiles = deps.core.getLoadedContextFiles();

  if (loadedFiles.length === 0) {
    return Promise.resolve({
      success: true,
      output:
        '当前无已加载的上下文文件。可扫描的文件：JIABAIXING.md, CONTEXT.md, .jiabaixing/context.md, CLAUDE.md',
      duration: Date.now() - startTime,
      validated: false,
    });
  }

  const fileList = loadedFiles
    .map(
      (f) =>
        `- ${f.fileName} (${f.content.length} 字符, 加载于 ${new Date(f.loadedAt).toLocaleTimeString('zh-CN')})`
    )
    .join('\n');

  return Promise.resolve({
    success: true,
    output: `已加载 ${loadedFiles.length} 个上下文文件：\n${fileList}`,
    duration: Date.now() - startTime,
    validated: false,
    metadata: {
      files: loadedFiles.map((f) => ({
        fileName: f.fileName,
        size: f.content.length,
        loadedAt: f.loadedAt,
      })),
    },
  });
}

/**
 * 处理 refresh 操作：刷新上下文文件缓存
 */
async function handleRefresh(
  deps: ContextManageDeps,
  startTime: number
): Promise<ToolResult> {
  const count = await deps.core.refreshProjectContext();

  Logger.info(`📄 上下文文件缓存已刷新: ${count} 个文件`, 'ContextManage');

  return {
    success: true,
    output: `上下文文件缓存已刷新，当前加载 ${count} 个文件。`,
    duration: Date.now() - startTime,
    validated: false,
  };
}

/**
 * 处理 create 操作：创建上下文文件模板
 */
async function handleCreate(
  fileName: string,
  startTime: number
): Promise<ToolResult> {
  // 验证文件名是否在允许列表中
  const allowedFiles = [...CONTEXT_FILE_LIST];
  if (!allowedFiles.includes(fileName as (typeof CONTEXT_FILE_LIST)[number])) {
    return {
      success: false,
      output: '',
      error: `不支持的文件名: ${fileName}。允许的文件名: ${allowedFiles.join(', ')}`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const projectRoot = process.cwd();
  const filePath = path.join(projectRoot, fileName);

  // 检查文件是否已存在
  if (fs.existsSync(filePath)) {
    return {
      success: false,
      output: '',
      error: `文件已存在: ${fileName}。如需更新请直接编辑文件后使用 refresh 操作刷新缓存。`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  // 确保目录存在（如 .jiabaixing/context.md 需要创建 .jiabaixing 目录）
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, CONTEXT_TEMPLATE, 'utf-8');

  Logger.info(`📄 创建上下文文件模板: ${fileName}`, 'ContextManage');

  return {
    success: true,
    output: `已创建上下文文件模板: ${fileName}。请编辑该文件添加项目信息，内容将在下次对话时自动加载。`,
    duration: Date.now() - startTime,
    validated: false,
  };
}
