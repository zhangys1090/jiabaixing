/**
 * Harness Tool: task_manage - 任务/待办管理
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { withStoreLock } from './storeLock';

export interface TaskEntry {
  id: string;
  title: string;
  description?: string;
  priority: string;
  status: 'pending' | 'completed';
  dueDate?: string;
  tags: string[];
  createdAt: number;
  completedAt?: number;
  dependencies?: string[];
}

export const TASK_MANAGE_DEF: ToolDefinition = {
  name: 'task_manage',
  description:
    '管理任务和待办事项。支持创建、查看、完成、删除和更新任务。适用场景：用户需要记录待办、管理任务列表、追踪任务进度。不适用：纯信息查询。',
  category: ToolCategory.DAILY,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['create', 'list', 'complete', 'delete', 'update'],
    },
    task_id: {
      type: 'string',
      description: '任务ID（list/complete/delete/update时需要）',
    },
    title: {
      type: 'string',
      description: '任务标题（create时需要）',
    },
    description: {
      type: 'string',
      description: '任务描述',
    },
    priority: {
      type: 'string',
      description: '优先级',
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    due_date: {
      type: 'string',
      description: '截止日期',
    },
    tags: {
      type: 'array',
      description: '标签',
      items: { type: 'string', description: '标签名' },
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.MEMORY_WRITE],
  riskLevel: 'low',
  idempotent: false,
  timeout: 5000,
};

export interface TaskManageDeps {
  taskStore: {
    getTasks(): Promise<TaskEntry[]>;
    saveTask(task: TaskEntry): Promise<void>;
    deleteTask(id: string): Promise<void>;
  };
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatTaskList(tasks: TaskEntry[]): string {
  if (tasks.length === 0) return '暂无任务';
  return tasks
    .map((t) => {
      const icon = t.status === 'completed' ? '✅' : '⏳';
      const priority =
        t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
      const due = t.dueDate ? ` 📅${t.dueDate}` : '';
      const tagStr = t.tags.length > 0 ? ` [${t.tags.join(',')}]` : '';
      return `${icon} [${t.id}] ${t.title}${tagStr}${due} ${priority}`;
    })
    .join('\n');
} /** 创建 task_manage 执行器 */
export function createTaskManageExecutor(deps: TaskManageDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const action = String(params.action || '');

    if (!deps.taskStore) {
      return {
        success: false,
        output: null,
        error:
          'task_manage 不可用: taskStore 未注入，请在 initHarness 中配置任务存储依赖',
        duration: 0,
        validated: false,
      };
    }

    try {
      switch (action) {
        case 'create': {
          const title = String(params.title || '');
          if (!title) {
            return {
              success: false,
              output: null,
              error: '创建任务需要提供标题',
              duration: 0,
              validated: false,
            };
          }
          const task: TaskEntry = {
            id: generateId(),
            title,
            description: params.description
              ? String(params.description)
              : undefined,
            priority: String(params.priority || 'medium'),
            status: 'pending',
            dueDate: params.due_date ? String(params.due_date) : undefined,
            tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
            createdAt: Date.now(),
          };
          return withStoreLock(deps.taskStore, async () => {
            await deps.taskStore.saveTask(task);
            return {
              success: true,
              output: `任务已创建: [${task.id}] ${task.title}`,
              duration: 0,
              validated: false,
            };
          });
        }

        case 'list': {
          let tasks = await deps.taskStore.getTasks();
          const statusFilter = params.status as string | undefined;
          if (statusFilter && ['pending', 'completed'].includes(statusFilter)) {
            tasks = tasks.filter((t) => t.status === statusFilter);
          }
          const priorityOrder = { high: 0, medium: 1, low: 2 };
          tasks.sort(
            (a, b) =>
              (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 1) -
              (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 1)
          );
          const summary = `共 ${tasks.length} 个任务${statusFilter ? ` (筛选: ${statusFilter})` : ''}`;
          return {
            success: true,
            output: `${summary}\n${formatTaskList(tasks)}`,
            duration: 0,
            validated: false,
            metadata: {
              total: tasks.length,
              pending: tasks.filter((t) => t.status === 'pending').length,
              completed: tasks.filter((t) => t.status === 'completed').length,
            },
          };
        }

        case 'complete': {
          const taskId = String(params.task_id || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '完成任务需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          return withStoreLock(deps.taskStore, async () => {
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
            task.status = 'completed';
            task.completedAt = Date.now();
            await deps.taskStore.saveTask(task);
            return {
              success: true,
              output: `任务已完成: [${task.id}] ${task.title}`,
              duration: 0,
              validated: false,
            };
          });
        }

        case 'delete': {
          const taskId = String(params.task_id || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '删除任务需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          return withStoreLock(deps.taskStore, async () => {
            await deps.taskStore.deleteTask(taskId);
            return {
              success: true,
              output: `任务已删除: ${taskId}`,
              duration: 0,
              validated: false,
            };
          });
        }

        case 'update': {
          const taskId = String(params.task_id || '');
          if (!taskId) {
            return {
              success: false,
              output: null,
              error: '更新任务需要提供task_id',
              duration: 0,
              validated: false,
            };
          }
          return withStoreLock(deps.taskStore, async () => {
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
            if (params.title) task.title = String(params.title);
            if (params.description) task.description = String(params.description);
            if (params.priority) task.priority = String(params.priority);
            if (params.due_date) task.dueDate = String(params.due_date);
            if (Array.isArray(params.tags)) task.tags = params.tags.map(String);
            await deps.taskStore.saveTask(task);
            return {
              success: true,
              output: `任务已更新: [${task.id}] ${task.title}`,
              duration: 0,
              validated: false,
            };
          });
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
        error: `任务操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
