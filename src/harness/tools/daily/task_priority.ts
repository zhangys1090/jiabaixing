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
