import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import type { TaskEntry, TaskManageDeps } from './task_manage';

export const TASK_PRIORITY_DEF: ToolDefinition = {
  name: 'task_priority',
  description:
    '管理任务优先级。支持提升优先级、降低优先级、批量调整优先级、设置截止日期提醒等操作。适用场景：用户需要按优先级排序任务、处理紧急任务、管理任务截止日期。',
  category: ToolCategory.DAILY,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: [
        'promote',
        'demote',
        'set',
        'list_by_priority',
        'set_deadline',
        'urgent',
        'dynamic_score',
      ],
    },
    task_id: {
      type: 'string',
      description: '任务ID',
    },
    task_ids: {
      type: 'array',
      description: '任务ID列表（批量操作时使用）',
      items: { type: 'string', description: '任务ID' },
    },
    priority: {
      type: 'string',
      description: '目标优先级',
      enum: ['low', 'medium', 'high', 'urgent'],
    },
    deadline: {
      type: 'string',
      description: '截止日期（ISO格式或自然语言如"明天下午3点"）',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.MEMORY_WRITE],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

export type TaskPriorityDeps = Pick<TaskManageDeps, 'taskStore'>;

const priorityOrder = ['low', 'medium', 'high', 'urgent'];

function getNextPriority(current: string): string {
  const index = priorityOrder.indexOf(current);
  if (index >= 0 && index < priorityOrder.length - 1) {
    return priorityOrder[index + 1];
  }
  return current;
}

function getPrevPriority(current: string): string {
  const index = priorityOrder.indexOf(current);
  if (index > 0) {
    return priorityOrder[index - 1];
  }
  return current;
}

function parseDeadline(expr: string): string {
  const tomorrowMatch = expr.match(/明天(\s+下午)?(\s+(\d+)\s*点)?/);
  if (tomorrowMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (tomorrowMatch[3]) {
      d.setHours(parseInt(tomorrowMatch[3], 10), 0, 0, 0);
    }
    return d.toISOString();
  }
  const daysMatch = expr.match(/(\d+)\s*天后/);
  if (daysMatch) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(daysMatch[1], 10));
    return d.toISOString();
  }
  const parsed = Date.parse(expr);
  if (!isNaN(parsed)) return new Date(parsed).toISOString();
  return expr;
}

function formatPriorityIcon(priority: string): string {
  switch (priority) {
    case 'urgent':
      return '🔴';
    case 'high':
      return '🟠';
    case 'medium':
      return '🟡';
    case 'low':
    default:
      return '🟢';
  }
}

function formatTaskByPriority(tasks: TaskEntry[]): string {
  const sorted = [...tasks]
    .filter((t) => t.status === 'pending')
    .sort(
      (a, b) =>
        priorityOrder.indexOf(b.priority) - priorityOrder.indexOf(a.priority)
    );

  if (sorted.length === 0) return '暂无待办任务';

  const grouped = priorityOrder
    .reverse()
    .map((p) => ({
      priority: p,
      tasks: sorted.filter((t) => t.priority === p),
    }))
    .filter((g) => g.tasks.length > 0);

  return grouped
    .map((g) => {
      const header = `${formatPriorityIcon(g.priority)} ${g.priority.toUpperCase()} (${g.tasks.length})`;
      const items = g.tasks.map(
        (t) =>
          `  - [${t.id}] ${t.title}${t.dueDate ? ` 📅${new Date(t.dueDate).toLocaleDateString('zh-CN')}` : ''}`
      );
      return [header, ...items].join('\n');
    })
    .join('\n\n');
}

export function createTaskPriorityExecutor(deps: TaskPriorityDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'promote': {
          const taskId = String(params.task_id || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '提升优先级需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          const tasks = await deps.taskStore.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (!task) {
            return {
              success: false,
              output: null,
              error: `任务不存在: ${taskId}`,
              duration: 0,
              validated: false,
            };
          }
          const oldPriority = task.priority;
          task.priority = getNextPriority(task.priority);
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `任务优先级已提升: [${task.id}] ${task.title} (${oldPriority} → ${task.priority})`,
            duration: 0,
            validated: false,
          };
        }

        case 'demote': {
          const taskId = String(params.task_id || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '降低优先级需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          const tasks = await deps.taskStore.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (!task) {
            return {
              success: false,
              output: null,
              error: `任务不存在: ${taskId}`,
              duration: 0,
              validated: false,
            };
          }
          const oldPriority = task.priority;
          task.priority = getPrevPriority(task.priority);
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `任务优先级已降低: [${task.id}] ${task.title} (${oldPriority} → ${task.priority})`,
            duration: 0,
            validated: false,
          };
        }

        case 'set': {
          const taskId = String(params.task_id || '');
          const priority = String(params.priority || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '设置优先级需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          if (!priorityOrder.includes(priority)) {
            return {
              success: false,
              output: null,
              error: `无效的优先级值: ${priority}，有效值为: ${priorityOrder.join(', ')}`,
              duration: 0,
              validated: false,
            };
          }
          const tasks = await deps.taskStore.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (!task) {
            return {
              success: false,
              output: null,
              error: `任务不存在: ${taskId}`,
              duration: 0,
              validated: false,
            };
          }
          const oldPriority = task.priority;
          task.priority = priority;
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `任务优先级已设置: [${task.id}] ${task.title} (${oldPriority} → ${priority})`,
            duration: 0,
            validated: false,
          };
        }

        case 'list_by_priority': {
          const tasks = await deps.taskStore.getTasks();
          return {
            success: true,
            output: formatTaskByPriority(tasks),
            duration: 0,
            validated: false,
          };
        }

        case 'set_deadline': {
          const taskId = String(params.task_id || '');
          const deadline = String(params.deadline || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '设置截止日期需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          if (!deadline) {
            return {
              success: false,
              output: null,
              error: '设置截止日期需要提供deadline',
              duration: 0,
              validated: false,
            };
          }
          const tasks = await deps.taskStore.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (!task) {
            return {
              success: false,
              output: null,
              error: `任务不存在: ${taskId}`,
              duration: 0,
              validated: false,
            };
          }
          task.dueDate = parseDeadline(deadline);
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `任务截止日期已设置: [${task.id}] ${task.title} → 📅${new Date(task.dueDate!).toLocaleString('zh-CN')}`,
            duration: 0,
            validated: false,
          };
        }

        case 'urgent': {
          const taskId = String(params.task_id || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '标记紧急需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          const tasks = await deps.taskStore.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (!task) {
            return {
              success: false,
              output: null,
              error: `任务不存在: ${taskId}`,
              duration: 0,
              validated: false,
            };
          }
          const oldPriority = task.priority;
          task.priority = 'urgent';
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `🔴 任务已标记为紧急: [${task.id}] ${task.title} (${oldPriority} → urgent)`,
            duration: 0,
            validated: false,
          };
        }

        case 'dynamic_score': {
          const tasks = await deps.taskStore.getTasks();
          const pendingTasks = tasks.filter((t) => t.status === 'pending');

          if (pendingTasks.length === 0) {
            return {
              success: true,
              output: '暂无待办任务需要动态评分',
              duration: 0,
              validated: false,
            };
          }

          const scored = dynamicPriorityScore(pendingTasks);
          let changed = 0;
          for (const item of scored) {
            if (item.task.priority !== item.suggestedPriority) {
              const oldP = item.task.priority;
              item.task.priority = item.suggestedPriority;
              await deps.taskStore.saveTask(item.task);
              changed++;
              Logger.debug(
                `动态优先级: [${item.task.id}] ${item.task.title} (${oldP} → ${item.suggestedPriority}, score=${item.score.toFixed(2)})`,
                'TaskPriority'
              );
            }
          }

          const summary = scored
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map(
              (s, i) =>
                `${i + 1}. [${s.task.id}] ${s.task.title} → ${s.suggestedPriority} (score=${s.score.toFixed(2)}, urgency=${s.factors.urgency.toFixed(2)}, impact=${s.factors.impact.toFixed(2)})`
            )
            .join('\n');

          return {
            success: true,
            output: `动态优先级评分完成: ${pendingTasks.length} 个任务, ${changed} 个优先级调整\n\n${summary}`,
            duration: 0,
            validated: false,
          };
        }

        default:
          return {
            success: false,
            output: null,
            error: `未知操作: ${action}`,
            duration: 0,
            validated: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `优先级操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}

/**
 * P1 #10: 动态优先级评分 — 基于多因子规则约束的智能排序
 * 因子：紧急度(截止日期)、影响力(依赖数)、等待时长、原始优先级
 */
export interface DynamicScoreFactors {
  urgency: number;
  impact: number;
  waitTime: number;
  basePriority: number;
}

export interface DynamicScoreResult {
  task: TaskEntry;
  score: number;
  suggestedPriority: string;
  factors: DynamicScoreFactors;
}

export function dynamicPriorityScore(tasks: TaskEntry[]): DynamicScoreResult[] {
  const now = Date.now();

  return tasks.map((task) => {
    const factors = computeScoreFactors(task, now);
    const score =
      factors.urgency * 0.35 +
      factors.impact * 0.25 +
      factors.waitTime * 0.15 +
      factors.basePriority * 0.25;

    let suggestedPriority: string;
    if (score >= 0.75) suggestedPriority = 'urgent';
    else if (score >= 0.55) suggestedPriority = 'high';
    else if (score >= 0.35) suggestedPriority = 'medium';
    else suggestedPriority = 'low';

    return { task, score, suggestedPriority, factors };
  });
}

function computeScoreFactors(
  task: TaskEntry,
  now: number
): DynamicScoreFactors {
  // 紧急度：基于截止日期
  let urgency = 0.3;
  if (task.dueDate) {
    const dueTime = new Date(task.dueDate).getTime();
    const timeUntilDue = dueTime - now;
    if (timeUntilDue <= 0) urgency = 1.0;
    else if (timeUntilDue <= 3600000) urgency = 0.9;
    else if (timeUntilDue <= 86400000) urgency = 0.7;
    else if (timeUntilDue <= 259200000) urgency = 0.5;
    else urgency = 0.3;
  }

  // 影响力：基于依赖数（暂用 tags 数量作为代理指标）
  const tagCount = task.tags?.length || 0;
  const impact = Math.min(1, tagCount / 5 + 0.2);

  // 等待时长：创建越久越需要关注
  const createdTime = task.createdAt ? new Date(task.createdAt).getTime() : now;
  const waitDays = (now - createdTime) / 86400000;
  const waitTime = Math.min(1, waitDays / 7);

  // 原始优先级
  const priorityMap: Record<string, number> = {
    urgent: 1.0,
    high: 0.75,
    medium: 0.5,
    low: 0.25,
  };
  const basePriority = priorityMap[task.priority] ?? 0.5;

  return { urgency, impact, waitTime, basePriority };
}
