/**
 * /api/orchestrate — 多Agent编排 + 自评估 API 路由
 * POST /api/orchestrate — 多Agent任务编排
 * POST /api/evaluate — 自评估管道
 */

import { Request, Response, Router } from 'express';
import { JiabaixingCore } from '../../core/JiabaixingCore';
import { QualityScorer } from '../../harness/evaluation/QualityScorer';
import { StepEvaluator } from '../../harness/evaluation/StepEvaluator';
import { AgentRegistry } from '../../harness/orchestration/AgentRegistry';
import { OrchestratorAgent } from '../../harness/orchestration/OrchestratorAgent';
import { TaskNode } from '../../harness/orchestration/TaskDispatcher';
import { Logger } from '../../utils/Logger';

const router = Router();

const MAX_GOAL_LENGTH = 5000;
const MAX_CONTEXT_LENGTH = 10000;
const MAX_STEPS_PER_EVALUATE = 50;
const ORCHESTRATE_RATE_LIMIT_WINDOW_MS = 60000;
const ORCHESTRATE_RATE_LIMIT_MAX = 10;
const ORCHESTRATE_TIMEOUT_MS = 120000;
const _orchestrateRateMap = new Map<
  string,
  { count: number; resetAt: number }
>();

const RATE_MAP_MAX_ENTRIES = 1000;

function trimRateMap(): void {
  if (_orchestrateRateMap.size <= RATE_MAP_MAX_ENTRIES) return;
  const now = Date.now();
  const expired: string[] = [];
  for (const [key, entry] of _orchestrateRateMap) {
    if (now >= entry.resetAt) {
      expired.push(key);
    }
  }
  for (const key of expired) {
    _orchestrateRateMap.delete(key);
  }
  if (_orchestrateRateMap.size > RATE_MAP_MAX_ENTRIES) {
    const keys = Array.from(_orchestrateRateMap.keys());
    const toRemove = keys.slice(
      0,
      _orchestrateRateMap.size - RATE_MAP_MAX_ENTRIES
    );
    for (const k of toRemove) {
      _orchestrateRateMap.delete(k);
    }
  }
}

let _core: JiabaixingCore | null = null;
let _sharedRegistry: AgentRegistry | null = null;

export function setOrchestrateCore(core: JiabaixingCore): void {
  _core = core;
}

function getSharedRegistry(): AgentRegistry {
  if (!_sharedRegistry) {
    _sharedRegistry = new AgentRegistry();
    _sharedRegistry.register({
      id: 'core-agent',
      name: '核心执行Agent',
      capabilities: [
        { name: '通用执行', description: '可执行任意编排任务', tools: ['*'] },
      ],
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
  }
  return _sharedRegistry;
}

function getCore(): JiabaixingCore {
  if (!_core) {
    throw new Error('orchestrateRoutes: 核心实例未注入');
  }
  return _core;
}

function checkOrchestrateRate(clientIp: string): {
  allowed: boolean;
  resetIn: number;
} {
  const now = Date.now();
  const entry = _orchestrateRateMap.get(clientIp);
  if (!entry || now >= entry.resetAt) {
    trimRateMap();
    _orchestrateRateMap.set(clientIp, {
      count: 1,
      resetAt: now + ORCHESTRATE_RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, resetIn: 0 };
  }
  if (entry.count >= ORCHESTRATE_RATE_LIMIT_MAX) {
    return { allowed: false, resetIn: entry.resetAt - now };
  }
  entry.count++;
  return { allowed: true, resetIn: 0 };
}

function sanitizeForPrompt(input: string): string {
  return input
    .replace(/```/g, '`\\`\\`')
    .replace(/<\|.*?\|>/g, '')
    .substring(0, MAX_GOAL_LENGTH);
}

// POST /api/orchestrate — 多Agent编排执行
router.post('/orchestrate', async (req: Request, res: Response) => {
  try {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rateResult = checkOrchestrateRate(clientIp);
    if (!rateResult.allowed) {
      res.setHeader('Retry-After', Math.ceil(rateResult.resetIn / 1000));
      res
        .status(429)
        .json({ success: false, error: '编排请求过于频繁，请稍后再试' });
      return;
    }

    const { goal, context } = req.body as {
      goal?: string;
      context?: string;
    };

    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
      res.status(400).json({ success: false, error: '目标不能为空' });
      return;
    }

    if (goal.length > MAX_GOAL_LENGTH) {
      res.status(400).json({
        success: false,
        error: `目标长度不能超过${MAX_GOAL_LENGTH}字`,
      });
      return;
    }

    if (
      context &&
      typeof context === 'string' &&
      context.length > MAX_CONTEXT_LENGTH
    ) {
      res.status(400).json({
        success: false,
        error: `上下文长度不能超过${MAX_CONTEXT_LENGTH}字`,
      });
      return;
    }

    const safeGoal = sanitizeForPrompt(goal.trim());
    const safeContext = context ? sanitizeForPrompt(context) : undefined;

    Logger.info(
      `[Orchestrate] 收到编排请求: ${safeGoal.substring(0, 60)}...`,
      'OrchestrateRoute'
    );

    const registry = getSharedRegistry();

    const orchestrator = new OrchestratorAgent({
      registry,
      llm: {
        decomposeGoal: async (userGoal: string, ctx?: string) => {
          const result = await getCore().processInput(
            `你是家百星的任务编排模块。请将以下目标拆解为子任务列表。

【反幻觉护栏】
1. 只使用已知可用的工具，不假设不存在的工具能力
2. 只返回JSON格式，不输出任何其他内容
3. 不要编造不存在的任务或结果
4. 每个子任务必须目标明确、可独立执行

目标: ${userGoal}
上下文: ${ctx || '无'}

返回严格JSON数组，每个元素格式如下:
[
  {
    "id": "task-1",
    "goal": "子任务目标描述",
    "dependencies": [],
    "priority": 5,
    "tools": ["tool_name"]
  }
]

规则:
- id格式: task-{序号}
- priority: 1-10整数，10最高
- dependencies: 依赖的前置任务id数组
- tools: 该子任务需要的工具名数组（不确定时留空[]）
- 子任务数量不超过10个`,
            'orchestrator'
          );
          try {
            let jsonStr = result.response.trim();
            const codeBlockMatch = jsonStr.match(
              /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/
            );
            if (codeBlockMatch) {
              jsonStr = codeBlockMatch[1].trim();
            }
            const raw = JSON.parse(jsonStr);
            const tasks = Array.isArray(raw)
              ? raw
              : [{ goal: userGoal, dependencies: [], priority: 5 }];
            return tasks
              .slice(0, 10)
              .map((t: Partial<TaskNode>, i: number) => ({
                id: t.id || `task-${i + 1}`,
                goal: t.goal || userGoal,
                context: t.context || ctx || '',
                dependencies: Array.isArray(t.dependencies)
                  ? t.dependencies
                  : [],
                priority:
                  typeof t.priority === 'number'
                    ? Math.min(10, Math.max(1, t.priority))
                    : 5,
                tools: Array.isArray(t.tools) ? t.tools : [],
                status: 'pending' as const,
              }));
          } catch {
            return [
              {
                id: 'task-1',
                goal: userGoal,
                context: ctx || '',
                dependencies: [],
                priority: 5,
                status: 'pending' as const,
              },
            ];
          }
        },
      },
      executor: async (task: TaskNode) => {
        Logger.info(
          `[Orchestrate] 执行子任务: ${task.id} — ${task.goal.substring(0, 60)}`,
          'OrchestrateRoute'
        );
        const result = await getCore().processInput(task.goal, task.id);
        return {
          taskId: task.id,
          goal: task.goal,
          response: result.response,
          completedAt: Date.now(),
        };
      },
    });
    const result = await Promise.race([
      orchestrator.processGoal(safeGoal, safeContext),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`编排执行超时 (${ORCHESTRATE_TIMEOUT_MS / 1000}秒)`)
            ),
          ORCHESTRATE_TIMEOUT_MS
        )
      ),
    ]);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      success: result.success,
      summary: result.summary,
      totalTasks: result.totalTasks,
      completedTasks: result.completedTasks,
      failedTasks: result.failedTasks,
      duration: result.duration,
      details: Object.fromEntries(result.details),
    });
  } catch (error) {
    Logger.error('[Orchestrate] 编排失败', error as Error, 'OrchestrateRoute');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/evaluate — 自评估
router.post('/evaluate', async (req: Request, res: Response) => {
  try {
    const { context } = req.body as {
      context?: {
        input?: string;
        response?: string;
        steps?: Array<{
          stepId: string;
          toolName: string;
          args: Record<string, unknown>;
          result: { success: boolean; output?: unknown; error?: string };
          timestamp?: number;
        }>;
        duration?: number;
        retries?: number;
        errors?: number;
      };
    };

    Logger.info('[Evaluate] 收到评估请求', 'EvaluateRoute');

    const steps = context?.steps || [];
    if (steps.length > MAX_STEPS_PER_EVALUATE) {
      res.status(400).json({
        success: false,
        error: `评估步骤数量不能超过${MAX_STEPS_PER_EVALUATE}条`,
      });
      return;
    }

    const stepEvaluator = new StepEvaluator();
    const stepResults = steps.map((s) =>
      stepEvaluator.evaluateStep({
        stepId: s.stepId,
        toolName: s.toolName,
        args: s.args,
        result: s.result,
        timestamp: s.timestamp || Date.now(),
      })
    );

    // 质量评分
    const scorer = new QualityScorer();
    const qualityScore = scorer.score(stepResults, {
      duration: context?.duration || 0,
      retries: context?.retries || 0,
      errors: context?.errors || 0,
      context: context?.input || '',
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      success: true,
      score: qualityScore,
      report:
        `综合评分: ${qualityScore.overall}/100\n` +
        `  准确率: ${qualityScore.dimensions.accuracy}\n` +
        `  效率: ${qualityScore.dimensions.efficiency}\n` +
        `  安全: ${qualityScore.dimensions.safety}\n` +
        `  人设: ${qualityScore.dimensions.persona}\n` +
        `  稳定: ${qualityScore.dimensions.stability}\n` +
        `  建议: ${qualityScore.suggestions.join('; ')}`,
    });
  } catch (error) {
    Logger.error('[Evaluate] 评估失败', error as Error, 'EvaluateRoute');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
