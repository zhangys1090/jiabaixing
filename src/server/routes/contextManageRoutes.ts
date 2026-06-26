/**
 * 上下文管理路由 - 提供 context_manage 工具的 REST API 接口
 */

import express from 'express';
import { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';
import fs from 'fs';
import path from 'path';

/** 上下文文件扫描列表 */
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

export function registerContextManageRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  /**
   * 列出已加载的上下文文件
   * GET /api/context/list
   */
  app.get('/api/context/list', async (req, res) => {
    try {
      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const loadedFiles = core.getLoadedContextFiles();

      res.json({
        success: true,
        data: {
          files: loadedFiles.map((f) => ({
            fileName: f.fileName,
            size: f.content.length,
            loadedAt: f.loadedAt,
          })),
          count: loadedFiles.length,
        },
      });
    } catch (error) {
      Logger.error('❌ 获取上下文文件列表失败', error as Error, 'ContextAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  /**
   * 刷新上下文文件缓存
   * POST /api/context/refresh
   */
  app.post('/api/context/refresh', express.json(), async (req, res) => {
    try {
      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const count = await core.refreshProjectContext();

      Logger.info(`📄 上下文文件缓存已刷新: ${count} 个文件`, 'ContextAPI');

      res.json({
        success: true,
        data: {
          count,
          message: `上下文文件缓存已刷新，当前加载 ${count} 个文件。`,
        },
      });
    } catch (error) {
      Logger.error('❌ 刷新上下文文件失败', error as Error, 'ContextAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  /**
   * 手动加载上下文文件
   * POST /api/context/load
   */
  app.post('/api/context/load', express.json(), async (req, res) => {
    try {
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

      Logger.info(
        `📄 手动加载上下文文件: ${loadedFiles.length} 个`,
        'ContextAPI'
      );

      res.json({
        success: true,
        data: {
          files: loadedFiles,
          count: loadedFiles.length,
          message:
            loadedFiles.length === 0
              ? '未找到项目上下文文件。可创建的文件：JIABAIXING.md, CONTEXT.md, .jiabaixing/context.md, CLAUDE.md'
              : `已加载 ${loadedFiles.length} 个上下文文件。`,
        },
      });
    } catch (error) {
      Logger.error('❌ 加载上下文文件失败', error as Error, 'ContextAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  /**
   * 创建上下文文件模板
   * POST /api/context/create
   */
  app.post('/api/context/create', express.json(), async (req, res) => {
    try {
      const { fileName = 'JIABAIXING.md' } = req.body as {
        fileName?: string;
      };

      // 验证文件名是否在允许列表中
      const allowedFiles = [...CONTEXT_FILE_LIST];
      if (
        !allowedFiles.includes(fileName as (typeof CONTEXT_FILE_LIST)[number])
      ) {
        return res.status(400).json({
          success: false,
          error: `不支持的文件名: ${fileName}。允许的文件名: ${allowedFiles.join(', ')}`,
        });
      }

      const projectRoot = process.cwd();
      const filePath = path.join(projectRoot, fileName);

      // 检查文件是否已存在
      if (fs.existsSync(filePath)) {
        return res.status(409).json({
          success: false,
          error: `文件已存在: ${fileName}。如需更新请直接编辑文件后使用 refresh 操作刷新缓存。`,
        });
      }

      // 确保目录存在（如 .jiabaixing/context.md 需要创建 .jiabaixing 目录）
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, CONTEXT_TEMPLATE, 'utf-8');

      Logger.info(`📄 创建上下文文件模板: ${fileName}`, 'ContextAPI');

      res.json({
        success: true,
        data: {
          fileName,
          message: `已创建上下文文件模板: ${fileName}。请编辑该文件添加项目信息，内容将在下次对话时自动加载。`,
        },
      });
    } catch (error) {
      Logger.error('❌ 创建上下文文件失败', error as Error, 'ContextAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  /**
   * 读取指定上下文文件的内容
   * GET /api/context/read/:fileName
   */
  app.get('/api/context/read/:fileName', async (req, res) => {
    try {
      const { fileName } = req.params;

      // 验证文件名是否在允许列表中
      const allowedFiles = [...CONTEXT_FILE_LIST];
      if (
        !allowedFiles.includes(fileName as (typeof CONTEXT_FILE_LIST)[number])
      ) {
        return res.status(400).json({
          success: false,
          error: `不支持的文件名: ${fileName}。允许的文件名: ${allowedFiles.join(', ')}`,
        });
      }

      const projectRoot = process.cwd();
      const filePath = path.join(projectRoot, fileName);

      if (!fs.existsSync(filePath)) {
        return res
          .status(404)
          .json({ success: false, error: `文件不存在: ${fileName}` });
      }

      const content = fs.readFileSync(filePath, 'utf-8');

      res.json({
        success: true,
        data: {
          fileName,
          content,
          size: content.length,
        },
      });
    } catch (error) {
      Logger.error('❌ 读取上下文文件失败', error as Error, 'ContextAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
