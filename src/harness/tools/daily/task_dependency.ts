import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import type { TaskEntry, TaskManageDeps } from './task_manage';

export const TASK_DEPENDENCY_DEF: ToolDefinition = {
  name: 'task_dependency',
  description:
    '管理任务之间的依赖关系。支持设置前置任务、查看依赖链、检查阻塞状态、解除依赖等操作。适用场景：项目管理、任务编排、工作流管理。',
  category: ToolCategory.DAILY,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: [
        'add_dependency',
        'remove_dependency',
        'list_dependencies',
        'check_blocked',
        'get_dependency_chain',
        'unblock',
      ],
    },
    task_id: {
      type: 'string',
      description: '任务ID',
    },
    depends_on: {
      type: 'string',
      description: '依赖的前置任务ID',
    },
  },
  requiredParams: ['action', 'task_id'],
  requiredPermissions: [Permission.MEMORY_WRITE],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

export type TaskDependencyDeps = Pick<TaskManageDeps, 'taskStore'>;

function formatDependencyChain(
  tasks: TaskEntry[],
  taskId: string,
  depth = 0
): string {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return '';

  const indent = '  '.repeat(depth);
  const statusIcon = task.status === 'completed' ? '✅' : '⏳';
  const result = `${indent}${statusIcon} [${task.id}] ${task.title}`;

  if (task.dependencies && task.dependencies.length > 0) {
    const deps = task.dependencies
      .map((depId) => formatDependencyChain(tasks, depId, depth + 1))
      .filter(Boolean);
    if (deps.length > 0) {
      return `${result}\n${deps.join('\n')}`;
    }
  }

  return result;
}

function isTaskBlocked(
  task: TaskEntry,
  allTasks: TaskEntry[]
): { blocked: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const dependencies = task.dependencies || [];
  for (const depId of dependencies) {
    const depTask = allTasks.find((t) => t.id === depId);
    if (depTask && depTask.status !== 'completed') {
      blockers.push(depId);
    }
  }
  return { blocked: blockers.length > 0, blockers };
}

export function createTaskDependencyExecutor(deps: TaskDependencyDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const action = String(params.action || '');
    const taskId = String(params.task_id || '');

    try {
      switch (action) {
        case 'add_dependency': {
          const dependsOn = String(params.depends_on || '');
          if (!dependsOn) {
            return {
              success: false,
              output: null,
              error: '添加依赖需要提供depends_on（前置任务ID）',
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
          const depTask = tasks.find((t) => t.id === dependsOn);
          if (!depTask) {
            return {
              success: false,
              output: null,
              error: `依赖任务不存在: ${dependsOn}`,
              duration: 0,
              validated: false,
            };
          }
          if (task.dependencies?.includes(dependsOn)) {
            return {
              success: true,
              output: `依赖已存在: [${taskId}] 已依赖 [${dependsOn}]`,
              duration: 0,
              validated: false,
            };
          }
          if (!task.dependencies) {
            task.dependencies = [];
          }
          task.dependencies.push(dependsOn);
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `依赖已添加: [${taskId}] ${task.title} → [${dependsOn}] ${depTask.title}`,
            duration: 0,
            validated: false,
          };
        }

        case 'remove_dependency': {
          const dependsOn = String(params.depends_on || '');
          if (!dependsOn) {
            return {
              success: false,
              output: null,
              error: '移除依赖需要提供depends_on（前置任务ID）',
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
          const index = task.dependencies?.indexOf(dependsOn) ?? -1;
          if (index === -1) {
            return {
              success: true,
              output: `依赖不存在: [${taskId}] 不依赖 [${dependsOn}]`,
              duration: 0,
              validated: false,
            };
          }
          task.dependencies?.splice(index, 1);
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `依赖已移除: [${taskId}] ${task.title}不再依赖 [${dependsOn}]`,
            duration: 0,
            validated: false,
          };
        }

        case 'list_dependencies': {
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
          if (!task.dependencies || task.dependencies.length === 0) {
            return {
              success: true,
              output: `[${taskId}] ${task.title} 没有前置依赖`,
              duration: 0,
              validated: false,
            };
          }
          const depList = (task.dependencies || [])
            .map((depId) => {
              const depTask = tasks.find((t) => t.id === depId);
              const statusIcon = depTask?.status === 'completed' ? '✅' : '⏳';
              return `${statusIcon} [${depId}] ${depTask?.title || '未知任务'}`;
            })
            .join('\n');
          return {
            success: true,
            output: `[${taskId}] ${task.title} 的前置依赖:\n${depList}`,
            duration: 0,
            validated: false,
          };
        }

        case 'check_blocked': {
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
          const { blocked, blockers } = isTaskBlocked(task, tasks);
          if (!blocked) {
            return {
              success: true,
              output: `✅ [${taskId}] ${task.title} 未被阻塞，可以执行`,
              duration: 0,
              validated: false,
            };
          }
          const blockerDetails = blockers
            .map((blockerId) => {
              const blockerTask = tasks.find((t) => t.id === blockerId);
              return `[${blockerId}] ${blockerTask?.title || '未知任务'}`;
            })
            .join(', ');
          return {
            success: true,
            output: `🔒 [${taskId}] ${task.title} 被以下任务阻塞:\n${blockerDetails}`,
            duration: 0,
            validated: false,
          };
        }

        case 'get_dependency_chain': {
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
          const chain = formatDependencyChain(tasks, taskId);
          return {
            success: true,
            output: `📊 [${taskId}] ${task.title} 的依赖链:\n${chain}`,
            duration: 0,
            validated: false,
          };
        }

        case 'unblock': {
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
          task.dependencies = [];
          await deps.taskStore.saveTask(task);
          return {
            success: true,
            output: `🔓 [${taskId}] ${task.title} 的所有依赖已解除`,
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
        error: `依赖操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
