import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/Logger';
import { DocsIndexGenerator } from '../docs/docsIndexGenerator';

export function registerDocsRoutes(
  app: express.Application,
  projectRoot: string
): void {
  const docsGenerator = new DocsIndexGenerator(projectRoot);
  const docsDir = path.join(projectRoot, 'docs');

  // 服务 /llms.txt 和 /llms-full.txt
  app.get('/llms.txt', async (_req, res) => {
    try {
      const content = await docsGenerator.generateLLMSTxt();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5分钟缓存
      res.send(content);
    } catch (error) {
      Logger.error('生成llms.txt失败', error as Error, 'DocsRoutes');
      res.status(500).send('Error generating document index');
    }
  });

  app.get('/llms-full.txt', async (_req, res) => {
    try {
      const content = await docsGenerator.generateLLMSFullTxt();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5分钟缓存
      res.send(content);
    } catch (error) {
      Logger.error('生成llms-full.txt失败', error as Error, 'DocsRoutes');
      res.status(500).send('Error generating full document collection');
    }
  });

  // 兼容路径 /docs/llms.txt 和 /docs/llms-full.txt
  app.get('/docs/llms.txt', async (_req, res) => {
    res.redirect(302, '/llms.txt');
  });
  app.get('/docs/llms-full.txt', async (_req, res) => {
    res.redirect(302, '/llms-full.txt');
  });

  // API端点 - 获取文档索引
  app.get('/api/docs/index', async (_req, res) => {
    try {
      const index = await docsGenerator.buildIndex();
      res.json({
        success: true,
        data: index,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({
        success: false,
        error: 'Failed to build document index',
      });
    }
  });

  // API端点 - 重新生成文档索引文件
  app.post('/api/docs/generate', async (_req, res) => {
    try {
      await docsGenerator.buildIndex(true);
      await docsGenerator.writeStaticFiles();
      res.json({
        success: true,
        message: 'Documentation index regenerated',
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({
        success: false,
        error: 'Failed to regenerate documentation',
      });
    }
  });

  // 静态文档访问
  app.get('/docs/*', async (req, res) => {
    const docPath = (req.params as Record<string, string>)['0'];
    const fullPath = path.join(docsDir, docPath);

    // 安全检查：防止目录遍历
    if (!fullPath.startsWith(docsDir)) {
      return res.status(403).send('Access denied');
    }

    try {
      if (!fs.existsSync(fullPath)) {
        return res.status(404).send('Document not found');
      }

      const stat = await fs.promises.stat(fullPath);
      if (stat.isDirectory()) {
        return res.status(403).send('Directory access not supported');
      }

      const content = await docsGenerator.getDocContent(docPath);
      if (content === null) {
        return res.status(404).send('Document not found');
      }

      // 根据扩展名设置内容类型
      const ext = path.extname(docPath).toLowerCase();
      const contentType =
        ext === '.md'
          ? 'text/markdown; charset=utf-8'
          : ext === '.html'
            ? 'text/html; charset=utf-8'
            : 'text/plain; charset=utf-8';

      res.setHeader('Content-Type', contentType);
      res.send(content);
    } catch (error) {
      Logger.error(`访问文档失败: ${docPath}`, error as Error, 'DocsRoutes');
      res.status(500).send('Error reading document');
    }
  });

  Logger.info('文档路由已注册', 'DocsRoutes');
}
