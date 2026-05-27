/**
 * 核心路由 - health / models / process / evolution(版本列表) / correct / logs
 */

import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

import { JiabaixingCore, ProcessInputResult } from '../../core/JiabaixingCore';
import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../utils/Logger';

export function registerCoreRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.get('/api/health', async (_req, res) => {
    const llmHealth = await core
      ?.getLLMHealth?.()
      .catch(() => ({ available: false, message: 'unknown' }));
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      model: process.env.LLM_MODEL || 'qwen2.5-vl',
      autoOptimize: process.env.ENABLE_AUTO_OPTIMIZE !== 'false',
      llm: llmHealth || { available: false, message: 'not initialized' },
    });
  });

  app.get('/api/models', (_req, res) => {
    res.json({
      success: true,
      data: [
        {
          id: process.env.LLM_MODEL || 'qwen2.5-vl',
          name: 'Qwen 2.5 VL',
          status: 'available',
          version: '2.5',
          description: '通义千问2.5 VL，通过OpenAI兼容接口加载',
        },
      ],
    });
  });

  app.post(
    '/api/process',
    express.json({ limit: '10mb' }),
    async (req, res) => {
      try {
        const { input: rawInput, images } = req.body as {
          input?: string;
          images?: string[];
        };
        const userId = (req.body as { userId?: string }).userId || 'api_user';

        const input = typeof rawInput === 'string' ? rawInput.trim() : '';
        const hasValidInput = input.length > 0;
        const hasImages = Array.isArray(images) && images.length > 0;

        if (!hasValidInput && !hasImages) {
          return res.status(400).json({
            success: false,
            error: '请输入文字或上传图片',
          });
        }

        const MAX_INPUT_LENGTH = 100000;
        const processedInput =
          input.length > MAX_INPUT_LENGTH
            ? input.substring(0, MAX_INPUT_LENGTH) + '...[内容已截断]'
            : input;

        const traceId = Logger.generateTraceId();

        if (!core) {
          res.status(503).json({ error: '核心系统未初始化' });
          return;
        }

        const result: ProcessInputResult = await core.processInput(
          processedInput,
          userId,
          traceId
        );

        res.json({
          success: true,
          data: { response: result.response },
          traceId: result.traceId,
          intent: result.intent,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : '未知错误';
        Logger.error('⚠️ /api/process 处理失败', error as Error, 'Main');
        res.status(500).json({
          error: `处理失败: ${errMsg}`,
        });
      }
    }
  );

  app.get('/api/evolution', async (_req, res) => {
    const evolutionDir = path.join(process.cwd(), 'data', 'evolution');
    const dirExists = await fs.promises
      .access(evolutionDir)
      .then(() => true)
      .catch(() => false);
    if (!dirExists) {
      return res.json({ versions: [], current: null, metrics: {} });
    }

    try {
      const entries = await fs.promises.readdir(evolutionDir);
      const files = entries.filter((f: string) => f.endsWith('.json')).sort();

      const versions = await Promise.all(
        files.map(async (f: string) => {
          try {
            const content = await fs.promises.readFile(
              path.join(evolutionDir, f),
              'utf-8'
            );
            return JSON.parse(content) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
      );
      const validVersions = versions.filter(Boolean);

      res.json({
        versions: validVersions,
        current: validVersions[validVersions.length - 1] || null,
        metrics: { totalEvolutions: validVersions.length },
      });
    } catch {
      res.json({ versions: [], current: null, metrics: {} });
    }
  });

  app.post('/api/correct', express.json({ limit: '1mb' }), (req, res) => {
    try {
      const {
        toolId,
        tool_name,
        correctionType,
        type,
        reason,
        message,
        severity,
        traceId,
      } = req.body;

      if (!toolId && !tool_name) {
        return res.status(400).json({ error: '缺少 toolId 或 tool_name' });
      }

      void EventBus.emit('user_correction', {
        toolId: toolId || tool_name,
        correctionType: correctionType || type || 'incorrect',
        reason: reason || message || '用户纠正',
        severity: severity !== undefined ? severity : 1,
        traceId: traceId || Logger.generateTraceId(),
      });

      res.json({
        success: true,
        message: '用户纠正已提交，权重调整已生效',
      });
    } catch (error) {
      Logger.error('❌ 处理纠正请求失败', error as Error, 'API');
      res.status(500).json({
        error: '内部服务错误',
        message: (error as Error).message,
      });
    }
  });

  app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const logHandler = (logEntry: unknown) => {
      const logData = logEntry as {
        timestamp?: string;
        level?: string;
        message?: string;
        service?: string;
        traceId?: string;
      };
      res.write(`data: ${JSON.stringify(logData)}\n\n`);
    };

    Logger.on('log', logHandler);

    req.on('close', () => {
      Logger.off('log', logHandler);
      res.end();
    });

    Logger.info('📝 新的日志流客户端已连接', 'SSE');
  });
}
