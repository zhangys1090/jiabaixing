/**
 * 工具执行路由 - Hermes P2 前端入口
 *
 * POST /api/tools/execute - 执行已注册的 Harness 工具（image_generate / tts_speak / web_fetch 等）
 * GET  /api/tools/list    - 列出所有已注册工具
 *
 * 复用 ToolRegistry.execute()，与 SkillRegistry 双轨并行
 */

import express from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

async function handleToolExecute(
  req: express.Request,
  res: express.Response
): Promise<void> {
  try {
    const { toolName, params, userId } = req.body as {
      toolName?: string;
      params?: Record<string, unknown>;
      userId?: string;
    };

    if (!toolName) {
      res.status(400).json({ success: false, error: '缺少 toolName' });
      return;
    }

    const core = (req.app.locals as { core?: JiabaixingCore | null }).core;
    if (!core) {
      res.status(503).json({ success: false, error: '核心未初始化' });
      return;
    }

    const harness = core.getHarness();
    if (!harness) {
      res.status(503).json({ success: false, error: 'Harness 未初始化' });
      return;
    }

    const registry = harness.getToolRegistry();
    if (!registry) {
      res.status(503).json({ success: false, error: '工具注册表不可用' });
      return;
    }

    const traceId = Logger.generateTraceId();
    const result = await registry.execute(toolName, params || {}, {
      userId: userId || 'api_user',
      traceId,
      permissions: new Set(),
      metadata: {},
    });

    res.json({
      success: result.success,
      output: result.output,
      error: result.error,
      metadata: {
        ...result.metadata,
        duration: result.duration,
        traceId,
        toolName,
      },
    });
  } catch (error) {
    Logger.error('❌ 工具执行失败', error as Error, 'ToolRoutes');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

function handleToolList(req: express.Request, res: express.Response): void {
  try {
    const core = (req.app.locals as { core?: JiabaixingCore | null }).core;
    if (!core) {
      res.status(503).json({ success: false, error: '核心未初始化' });
      return;
    }

    const harness = core.getHarness();
    if (!harness) {
      res.status(503).json({ success: false, error: 'Harness 未初始化' });
      return;
    }

    const registry = harness.getToolRegistry();
    if (!registry) {
      res.status(503).json({ success: false, error: '工具注册表不可用' });
      return;
    }

    const tools = registry.getAll().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      category: t.definition.category,
      parameters: t.definition.parameters,
      riskLevel: t.definition.riskLevel,
    }));

    res.json({ success: true, tools, count: tools.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

export function registerToolRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.locals.core = core;

  app.post(
    '/api/tools/execute',
    express.json({ limit: '10mb' }),
    handleToolExecute
  );
  app.get('/api/tools/list', handleToolList);
}
