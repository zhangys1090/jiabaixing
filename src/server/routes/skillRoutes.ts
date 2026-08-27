/**
 * 技能路由 - skills execute / list
 * 提取公共处理逻辑，消除 Router 和 registerSkillRoutes 之间的重复代码
 */

import express from 'express';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { Logger } from '../../utils/Logger';

const SKILL_RATE_LIMIT_WINDOW_MS = 60000;
const SKILL_RATE_LIMIT_MAX = 30;
const _skillRateMap = new Map<string, { count: number; resetAt: number }>();
const MAX_SKILL_NAME_LENGTH = 128;

function checkSkillRate(key: string): { allowed: boolean; resetIn: number } {
  const now = Date.now();
  const entry = _skillRateMap.get(key);
  if (!entry || now >= entry.resetAt) {
    _skillRateMap.set(key, {
      count: 1,
      resetAt: now + SKILL_RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, resetIn: 0 };
  }
  if (entry.count >= SKILL_RATE_LIMIT_MAX) {
    return { allowed: false, resetIn: entry.resetAt - now };
  }
  entry.count++;
  return { allowed: true, resetIn: 0 };
}

async function handleSkillExecute(
  req: express.Request,
  res: express.Response
): Promise<void> {
  try {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rateResult = checkSkillRate(clientIp);
    if (!rateResult.allowed) {
      res.setHeader('Retry-After', Math.ceil(rateResult.resetIn / 1000));
      res
        .status(429)
        .json({ success: false, error: '技能调用过于频繁，请稍后再试' });
      return;
    }

    const { skillName, params } = req.body as {
      skillName?: string;
      params?: Record<string, unknown>;
    };
    if (!skillName) {
      res.status(400).json({ success: false, error: '缺少 skillName' });
      return;
    }

    if (
      typeof skillName !== 'string' ||
      skillName.length > MAX_SKILL_NAME_LENGTH
    ) {
      res.status(400).json({ success: false, error: 'skillName 格式无效' });
      return;
    }

    const registry = SkillRegistry.getInstance();
    const skill = registry.getSkill(skillName);

    if (!skill) {
      res
        .status(404)
        .json({ success: false, error: `技能不存在: ${skillName}` });
      return;
    }

    const validation = await skill.validate(params || {});
    if (!validation.valid) {
      res
        .status(400)
        .json({ success: false, error: validation.errors.join(', ') });
      return;
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
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * 技能列表公共处理逻辑
 */
function handleSkillList(_req: express.Request, res: express.Response): void {
  try {
    const registry = SkillRegistry.getInstance();
    const skills = registry.getAllSkillMeta();
    res.json({ success: true, skills, count: skills.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// 兼容 server/index.ts 的 Router 导出
export const skillRoutes = express.Router();

skillRoutes.post(
  '/execute',
  express.json({ limit: '10mb' }),
  handleSkillExecute
);
skillRoutes.get('/list', handleSkillList);

// main.ts 使用的注册函数
export function registerSkillRoutes(
  app: express.Application,
  _core: JiabaixingCore | null
): void {
  app.post(
    '/api/skills/execute',
    express.json({ limit: '10mb' }),
    handleSkillExecute
  );
  app.get('/api/skills/list', handleSkillList);
}
