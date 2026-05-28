/**
 * /api/orchestrate — 多Agent编排 + 自评估 API 路由
 * POST /api/orchestrate — 多Agent任务编排
 * POST /api/evaluate — 自评估管道
 */

import { Router, Request, Response } from 'express';
import { JiabaixingCore } from '../core/JiabaixingCore';
import { OrchestratorAgent } from '../harness/orchestration/OrchestratorAgent';
import { AgentRegistry } from '../harness/orchestration/AgentRegistry';
import { TaskNode } from '../harness/orchestration/TaskDispatcher';
import { QualityScorer } from '../harness/evaluation/QualityScorer';
import { StepEvaluator } from '../harness/evaluation/StepEvaluator';
import { Logger } from '../utils/Logger';

const router = Router();

let _core: JiabaixingCore | null = null;

export function setOrchestrateCore(core: JiabaixingCore): void {
  _core = core;
}

function getCore(): JiabaixingCore {
  if (!_core) {
    throw new Error('orchestrateRoutes: 核心实例未注入');
  }
  return _core;
}

// POST /api/orchestrate — 多Agent编排执行
router.post('/orchestrate', async (req: Request, res: Response) => {
  try {
    const { goal, context } = req.body as {
      goal?: string;
      context?: string;
    };

    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
      res.status(400).json({ success: false, error: '目标不能为空' });
      return;
    }

    Logger.info(
      `[Orchestrate] 收到编排请求: ${goal.substring(0, 60)}...`,
      'OrchestrateRoute'
    );

    // 注册默认Agent，确保 TaskDispatcher.assignAgent() 能找到执行者
    const registry = new AgentRegistry();
    registry.register({
      id: 'core-agent',
      name: '核心执行Agent',
      capabilities: [
        { name: '通用执行', description: '可执行任意编排任务', tools: ['*'] },
      ],
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    const orchestrator = new OrchestratorAgent({
      registry,
      llm: {
        decomposeGoal: async (userGoal: string, ctx?: string) => {
          const result = await getCore().processInput(
            `请将以下目标拆解为子任务列表：\n目标: ${userGoal}\n上下文: ${ctx || '无'}\n\n返回JSON数组，每个元素包含: goal, dependencies[], priority`,
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
            return tasks.map((t: Partial<TaskNode>, i: number) => ({
              id: t.id || `task-${i + 1}`,
              goal: t.goal || userGoal,
              context: t.context || ctx || '',
              dependencies: t.dependencies || [],
              priority: t.priority || 5,
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
      // 注入实际执行器：每个子任务通过 core.processInput 真正执行
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
    const result = await orchestrator.processGoal(goal.trim(), context);

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

    // 评估步骤 (如果有)
    const stepEvaluator = new StepEvaluator();
    const stepResults = (context?.steps || []).map((s) =>
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
