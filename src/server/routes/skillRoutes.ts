/**
 * 技能路由 - skills execute / list
 * 同时导出 registerSkillRoutes（main.ts 使用）和 skillRoutes Router（server/index.ts 兼容）
 */

import express, { Request, Response } from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { Logger } from '../../utils/Logger';

// 兼容 server/index.ts 的 Router 导出
export const skillRoutes = express.Router();

skillRoutes.post('/execute', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { skillName, params } = req.body as {
      skillName?: string;
      params?: Record<string, unknown>;
    };
    if (!skillName) {
      return res
        .status(400)
        .json({ success: false, error: '缺少 skillName' });
    }

    const registry = SkillRegistry.getInstance();
    const skill = registry.getSkill(skillName);

    if (!skill) {
      return res
        .status(404)
        .json({ success: false, error: `技能不存在: ${skillName}` });
    }

    const validation = await skill.validate(params || {});
    if (!validation.valid) {
      return res
        .status(400)
        .json({ success: false, error: validation.errors.join(', ') });
    }

    const context = {
      userId: (req.body as { userId?: string }).userId || 'api_user',
      traceId: Logger.generateTraceId(),
    };

    const startTime = Date.now();
    const result = await skill.execute(params || {}, context);
    const duration = Date.now() - startTime;

    res.json({
      success: result.success,
      output: result.output,
      error: result.error,
      metadata: { ...result.metadata, duration },
    });
  } catch (error) {
    Logger.error('❌ 技能执行失败', error as Error, 'API');
    res
      .status(500)
      .json({ success: false, error: (error as Error).message });
  }
});

skillRoutes.get('/list', (_req, res) => {
  try {
    const registry = SkillRegistry.getInstance();
    const skills = registry.getAllSkillMeta();
    res.json({ success: true, skills, count: skills.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// main.ts 使用的注册函数
export function registerSkillRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.post(
    '/api/skills/execute',
    express.json({ limit: '10mb' }),
    async (req, res) => {
      try {
        const { skillName, params } = req.body as {
          skillName?: string;
          params?: Record<string, unknown>;
        };
        if (!skillName) {
          return res
            .status(400)
            .json({ success: false, error: '缺少 skillName' });
        }

        const registry = SkillRegistry.getInstance();
        const skill = registry.getSkill(skillName);

        if (!skill) {
          return res
            .status(404)
            .json({ success: false, error: `技能不存在: ${skillName}` });
        }

        const validation = await skill.validate(params || {});
        if (!validation.valid) {
          return res
            .status(400)
            .json({ success: false, error: validation.errors.join(', ') });
        }

        const context = {
          userId: (req.body as { userId?: string }).userId || 'api_user',
          traceId: Logger.generateTraceId(),
        };

        const startTime = Date.now();
        const result = await skill.execute(params || {}, context);
        const duration = Date.now() - startTime;

        res.json({
          success: result.success,
          output: result.output,
          error: result.error,
          metadata: { ...result.metadata, duration },
        });
      } catch (error) {
        Logger.error('❌ 技能执行失败', error as Error, 'API');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.get('/api/skills/list', (_req, res) => {
    try {
      const registry = SkillRegistry.getInstance();
      const skills = registry.getAllSkillMeta();
      res.json({ success: true, skills, count: skills.length });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
