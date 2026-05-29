/**
 * 核心路由 - health / models / process / evolution(版本列表) / correct / logs
 */

import express from 'express';
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
      model: process.env.LLM_MODEL || 'deepseek-chat',
      autoOptimize: process.env.ENABLE_AUTO_OPTIMIZE !== 'false',
      llm: llmHealth || { available: false, message: 'not initialized' },
    });
  });

  app.get('/api/models', (_req, res) => {
    res.json({
      success: true,
      data: [
        {
          id: process.env.LLM_MODEL || 'deepseek-chat',
          name: 'DeepSeek Chat',
          status: 'available',
          version: '2.5',
          description: '通义千问2.5 VL，通过OpenAI兼容接口加载',
        },
      ],
    });
  });

  app.get('/api/models/status', async (_req, res) => {
    try {
      const { MultiModelLLMProvider } =
        await import('../../models/MultiModelLLMProvider');
      const provider = MultiModelLLMProvider.getInstance();
      await provider.initialize();

      const currentModel = process.env.LLM_MODEL || 'deepseek-chat';
      const models = provider.getAvailableModels();

      res.json({
        success: true,
        data: {
          currentModel,
          models,
          status: 'running',
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  app.get('/api/models/health', async (_req, res) => {
    try {
      const { MultiModelLLMProvider } =
        await import('../../models/MultiModelLLMProvider');
      const provider = MultiModelLLMProvider.getInstance();
      await provider.initialize();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const healthStatus = (provider as any).modelHealthStatus || new Map();
      const models = provider.getAvailableModels();

      const modelHealthList = models.map((model) => {
        const health = healthStatus.get(model.id) || {
          successCount: 0,
          failureCount: 0,
          avgLatency: 0,
          lastError: null,
        };

        const totalCalls = health.successCount + health.failureCount;
        const successRate =
          totalCalls > 0 ? (health.successCount / totalCalls) * 100 : 100;

        return {
          modelId: model.id,
          modelName: model.name,
          available: successRate > 50,
          successRate: Math.round(successRate),
          totalCalls,
          avgLatency: health.avgLatency || 0,
          lastSuccess: health.lastSuccess || null,
          lastError: health.lastError || null,
        };
      });

      res.json({
        success: true,
        data: {
          models: modelHealthList,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  app.post(
    '/api/models/switch',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { targetModel, reason } = req.body as {
          targetModel?: string;
          reason?: string;
        };

        if (!targetModel) {
          return res.status(400).json({
            success: false,
            error: '请提供目标模型名称',
          });
        }

        const { MultiModelLLMProvider } =
          await import('../../models/MultiModelLLMProvider');
        const provider = MultiModelLLMProvider.getInstance();

        const availableModels = provider.getAvailableModels();
        const modelExists = availableModels.some((m) => m.id === targetModel);

        if (!modelExists) {
          return res.status(404).json({
            success: false,
            error: `模型 ${targetModel} 不存在`,
          });
        }

        process.env.LLM_MODEL = targetModel;

        Logger.info(`模型已切换为: ${targetModel}`, 'Models', {
          reason: reason || '用户手动切换',
        });

        res.json({
          success: true,
          message: `模型已成功切换为 ${targetModel}`,
          currentModel: targetModel,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: (error as Error).message,
        });
      }
    }
  );

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
          traceId,
          images as Array<{ url: string; mimeType?: string }> | undefined
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

  // Renamed from /api/logs to avoid shadowing systemStateRoutes file-based logs
  app.get('/api/logs/stream', (req, res) => {
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

  // ── Desktop 面板 API ──
  app.post('/api/desktop/screenshot', async (_req, res) => {
    try {
      const harness = core?.getHarness();
      if (!harness) {
        return res.json({
          success: false,
          error: 'Harness 未初始化',
          mock: true,
          data: {
            screenshot:
              'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTUwIj48cmVjdCBmaWxsPSIjMjIyMjQ2IiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjE1MCIvPjx0ZXh0IGZpbGw9IiM2MDYwYTAiIHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5EZXNrdG9wIFBhbmVsIC0g5bqT55SoIEhhcm5lc3Mg5bel5YW354K55Ye7PC90ZXh0Pjwvc3ZnPg==',
          },
        });
      }
      const registry = harness.getToolRegistry();
      if (!registry) {
        return res.json({ success: false, error: '工具注册表不可用' });
      }
      const result = await registry.execute(
        'desktop_screenshot',
        { screenIndex: 0 },
        {
          userId: 'api',
          traceId: `screenshot_${Date.now()}`,
          permissions: new Set(),
          metadata: {},
        }
      );
      // 截图工具返回 buffer，需要转 base64
      const buffer = result.output as {
        buffer?: Buffer;
        width?: number;
        height?: number;
      };
      let screenshotData: string;
      if (buffer?.buffer) {
        const base64 = Buffer.from(buffer.buffer).toString('base64');
        screenshotData = `data:image/png;base64,${base64}`;
      } else {
        // fallback: 返回 mock 图
        screenshotData =
          'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTUwIj48cmVjdCBmaWxsPSIjMjIyMjQ2IiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjE1MCIvPjx0ZXh0IGZpbGw9IiM2MDYwYTAiIHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7mjqXlnovlt6Xlhbs8L3RleHQ+PC9zdmc+';
      }
      res.json({ success: true, data: { screenshot: screenshotData } });
    } catch (error) {
      Logger.error('❌ 截图失败', error as Error, 'DesktopAPI');
      res.json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/desktop/automate',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { task } = req.body as { task?: string };
        if (!task) return res.json({ success: false, error: '缺少 task 参数' });
        const harness = core?.getHarness();
        if (!harness)
          return res.json({ success: false, error: 'Harness 未初始化' });
        const registry = harness.getToolRegistry();
        if (!registry)
          return res.json({ success: false, error: '工具注册表不可用' });
        const result = await registry.execute(
          'desktop_automate',
          { task },
          {
            userId: 'api',
            traceId: `auto_${Date.now()}`,
            permissions: new Set(),
            metadata: {},
          }
        );
        res.json({ success: true, data: { output: result.output } });
      } catch (error) {
        res.json({ success: false, error: (error as Error).message });
      }
    }
  );
}
