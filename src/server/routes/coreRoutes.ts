/**
 * 核心路由 - health / models / process / evolution(版本列表) / correct / logs
 */

import Busboy from 'busboy';
import * as crypto from 'crypto';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

import { JiabaixingCore, ProcessInputResult } from '../../core/JiabaixingCore';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';
import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../utils/Logger';
import { getPythonBridge, isPythonBackend } from '../bootstrap';

function requireAdmin(req: express.Request, res: express.Response): boolean {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(503).json({
      success: false,
      error: '管理员认证未配置，请联系系统管理员设置 ADMIN_TOKEN',
    });
    return false;
  }
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : ((req.query?.token as string | undefined) ?? req.body?.token);
  if (!token) {
    res.status(401).json({
      success: false,
      error: '缺少管理员认证令牌',
    });
    return false;
  }
  const a = Buffer.from(String(token), 'utf8');
  const b = Buffer.from(String(adminToken), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({
      success: false,
      error: '管理员认证失败',
    });
    return false;
  }
  return true;
}

export function registerCoreRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.get('/api/health', async (_req, res) => {
    if (isPythonBackend()) {
      const bridge = getPythonBridge()!;
      const pyHealth = await bridge.getLlmStatus();
      const pyModel = (pyHealth as Record<string, unknown>).models as
        | Array<Record<string, unknown>>
        | undefined;
      const modelName = pyModel?.[0]?.name as string | undefined;
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        model: modelName || process.env.LLM_MODEL || 'unknown',
        autoOptimize: process.env.ENABLE_AUTO_OPTIMIZE !== 'false',
        llm: pyHealth,
        backend: 'python',
      });
      return;
    }
    const llmHealth = await core
      ?.getLLMHealth?.()
      .catch(() => ({ available: false, message: 'unknown' }));
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      model: process.env.LLM_MODEL || 'deepseek-v4-flash',
      autoOptimize: process.env.ENABLE_AUTO_OPTIMIZE !== 'false',
      llm: llmHealth || { available: false, message: 'not initialized' },
      backend: 'typescript',
    });
  });

  app.get('/api/models', (_req, res) => {
    res.json({
      success: true,
      data: [
        {
          id: process.env.LLM_MODEL || 'deepseek-v4-flash',
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
      const { getProviderManager } =
        await import('../../models/ProviderManager');
      const pm = getProviderManager();

      const currentModel = pm.getPrimary();
      const models = pm.getAll();

      res.json({
        success: true,
        data: {
          currentModel: currentModel?.model || 'unknown',
          currentProvider: currentModel?.name || '',
          models: models.map((p) => ({
            name: p.name,
            displayName: p.displayName,
            model: p.model,
            healthy: p.healthy,
          })),
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
        if (!requireAdmin(req, res)) return;

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
    express.json({ limit: '50mb' }),
    async (req, res) => {
      const processTimeout = setTimeout(() => {
        if (!res.headersSent) {
          res
            .status(504)
            .json({ success: false, error: '请求处理超时，请稍后重试' });
        }
      }, 60000);
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

        if (isPythonBackend()) {
          const bridge = getPythonBridge()!;
          const result = await bridge.processInput(
            processedInput,
            userId,
            traceId,
            Array.isArray(images) && images.length > 0
              ? images.map((url: string) => ({ url }))
              : undefined
          );
          res.json({
            success: true,
            data: {
              response: result.response,
              finishReason: result.finishReason,
              qualityScore: result.qualityScore,
              toolCallsMade: result.toolCallsMade,
              roundsUsed: result.roundsUsed,
              duration: result.duration,
            },
            traceId: result.traceId || traceId,
            intent: result.intent || 'chat',
            backend: 'python',
          });
          return;
        }

        if (!core) {
          res.status(503).json({ error: '核心系统未初始化' });
          return;
        }

        const result: ProcessInputResult = await core.processInput(
          processedInput,
          userId,
          traceId,
          Array.isArray(images) && images.length > 0
            ? images.map((url: string) => ({ url }))
            : undefined
        );

        res.json({
          success: true,
          data: { response: result.response },
          traceId: result.traceId,
          intent: result.intent,
        });
      } catch (error) {
        Logger.error('⚠️ /api/process 处理失败', error as Error, 'Main');
        res.status(500).json({
          error: '处理失败，请稍后重试。',
        });
      } finally {
        clearTimeout(processTimeout);
      }
    }
  );

  app.get('/api/upload/history', async (_req, res) => {
    try {
      const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        return res.json({ files: [] });
      }
      const files = await fs.promises.readdir(uploadsDir);
      const fileInfos = await Promise.all(
        files.map(async (f) => {
          const stat = await fs.promises.stat(path.join(uploadsDir, f));
          return {
            name: f,
            size: stat.size,
            uploaded: stat.mtime.toISOString(),
          };
        })
      );
      res.json({
        files: fileInfos.sort((a, b) => b.uploaded.localeCompare(a.uploaded)),
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── 文件上传端点 ──────────────────────────

  /** MIME 白名单：仅允许上传安全的文件类型 */
  const MIME_WHITELIST = new Set([
    // 图片
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/tiff',
    // 文档
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/html',
    'text/markdown',
    'application/json',
    'application/xml',
    // Office 文档
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // 代码
    'text/javascript',
    'application/javascript',
    'text/x-python',
    'text/x-typescript',
    // 压缩
    'application/zip',
    'application/gzip',
  ]);

  /** 扩展名到 MIME 的回退映射（当 client 未提供 MIME 时） */
  const EXTENSION_MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.doc': 'application/msword',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.js': 'text/javascript',
    '.ts': 'text/x-typescript',
    '.py': 'text/x-python',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
  };

  app.post('/api/upload', (req, res) => {
    const uploadedFiles: Array<{
      name: string;
      path: string;
      size: number;
      mimeType: string;
    }> = [];
    const rejectedFiles: string[] = [];
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: 50 * 1024 * 1024 },
    });

    bb.on(
      'file',
      (
        _fieldname: string,
        file: NodeJS.ReadableStream,
        info: { filename: string; encoding: string; mimeType: string }
      ) => {
        const { filename, mimeType } = info;
        let mimeToCheck = mimeType;
        if (!mimeToCheck || mimeToCheck === 'application/octet-stream') {
          const ext = path.extname(filename).toLowerCase();
          mimeToCheck = EXTENSION_MIME_MAP[ext] || '';
        }
        if (!MIME_WHITELIST.has(mimeToCheck)) {
          rejectedFiles.push(`${filename} (${mimeToCheck || 'unknown type'})`);
          file.resume();
          return;
        }
        const chunks: Buffer[] = [];
        file.on('data', (chunk: Buffer) => chunks.push(chunk));
        file.on('end', async () => {
          try {
            const data = Buffer.concat(chunks);
            const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
            if (!fs.existsSync(uploadsDir)) {
              await fs.promises.mkdir(uploadsDir, { recursive: true });
            }
            const timestamp = Date.now();
            const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadsDir, `${timestamp}_${safeName}`);
            await fs.promises.writeFile(filePath, data);
            uploadedFiles.push({
              name: filename,
              path: filePath,
              size: data.length,
              mimeType: mimeType || 'application/octet-stream',
            });
          } catch (err) {
            Logger.error(`写入 ${filename} 失败`, err as Error, 'coreRoutes');
          }
        });
      }
    );

    bb.on('finish', () => {
      if (uploadedFiles.length === 0) {
        const extra =
          rejectedFiles.length > 0
            ? `; 已拒绝 ${rejectedFiles.length} 个不安全文件: ${rejectedFiles.join(', ')}`
            : '';
        return res.status(400).json({ error: `未找到合法文件${extra}` });
      }
      res.json({
        success: true,
        files: uploadedFiles.map((f) => ({
          name: f.name,
          size: f.size,
          mimeType: f.mimeType,
          url: `/api/files/${path.basename(f.path)}`,
        })),
        ...(rejectedFiles.length > 0 ? { rejected: rejectedFiles } : {}),
      });
    });

    bb.on('error', (err: Error) => {
      Logger.error('busboy 上传错误', err, 'coreRoutes');
      if (!res.headersSent) {
        res.status(500).json({ error: `上传失败: ${err.message}` });
      }
    });

    req.pipe(bb);
  });

  // 文件访问端点
  app.get('/api/files/:filename', async (req, res) => {
    try {
      const filePath = path.join(
        process.cwd(),
        'data',
        'uploads',
        req.params.filename
      );
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
      }
      res.sendFile(filePath);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // 上传历史
  app.get('/api/upload/history', async (_req, res) => {
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

  // ── 音频上传 + 语音识别端点 ──────────────

  const AUDIO_MIME_WHITELIST = new Set([
    'audio/wav',
    'audio/mp3',
    'audio/mpeg',
    'audio/webm',
    'audio/ogg',
    'audio/flac',
    'audio/x-m4a',
    'audio/mp4',
  ]);

  app.post('/api/audio/upload', (req, res) => {
    let audioBuffer: Buffer | null = null;
    let audioMime = '';
    let audioName = '';
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: 25 * 1024 * 1024 },
    });

    bb.on('file', (_fieldname, file, info) => {
      const { filename, mimeType } = info;
      audioName = filename;
      audioMime = mimeType || '';

      if (
        !AUDIO_MIME_WHITELIST.has(audioMime) &&
        !audioMime.startsWith('audio/')
      ) {
        file.resume();
        res
          .status(400)
          .json({ success: false, error: `不支持的音频类型: ${audioMime}` });
        return;
      }

      const chunks: Buffer[] = [];
      file.on('data', (chunk: Buffer) => chunks.push(chunk));
      file.on('end', async () => {
        audioBuffer = Buffer.concat(chunks);
      });
    });

    bb.on('finish', async () => {
      if (!audioBuffer) {
        return res
          .status(400)
          .json({ success: false, error: '未收到音频数据' });
      }

      try {
        const uploadsDir = path.join(process.cwd(), 'data', 'uploads', 'audio');
        if (!fs.existsSync(uploadsDir)) {
          await fs.promises.mkdir(uploadsDir, { recursive: true });
        }

        const timestamp = Date.now();
        const safeName = audioName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(uploadsDir, `${timestamp}_${safeName}`);
        await fs.promises.writeFile(filePath, audioBuffer);

        const { SpeechRecognizer } =
          await import('../../multimodal/SpeechRecognizer');
        const recognizer = new SpeechRecognizer();
        await recognizer.initialize();
        // SpeechRecognizer 只有 recognize(buffer) 接口，读取文件后转 Buffer
        const audioBuffer2 = await fs.promises.readFile(filePath);
        const result = await recognizer.recognize(audioBuffer2);

        res.json({
          success: true,
          text: result.text,
          confidence: result.confidence,
          duration: result.duration || 0,
          language: result.language || 'zh-CN',
          file: {
            name: audioName,
            size: audioBuffer.length,
            mimeType: audioMime,
            url: `/api/files/audio/${timestamp}_${safeName}`,
          },
        });
      } catch (error) {
        Logger.error('音频处理失败', error as Error, 'coreRoutes');
        res.status(500).json({
          success: false,
          error: `音频处理失败: ${(error as Error).message}`,
        });
      }
    });

    bb.on('error', (err: Error) => {
      Logger.error('音频上传错误', err, 'coreRoutes');
      if (!res.headersSent) {
        res.status(500).json({ error: `上传失败: ${err.message}` });
      }
    });

    req.pipe(bb);
  });

  app.get('/api/health/slo', async (_req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res.status(200).json({
          success: true,
          data: {
            status: 'degraded',
            message: 'Python 后端未连接，SLO 指标不可用',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
          },
        });
      }
      const result = await bridge.request('GET', '/v1/health/slo');
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('SLO 健康检查失败', error as Error, 'coreRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
