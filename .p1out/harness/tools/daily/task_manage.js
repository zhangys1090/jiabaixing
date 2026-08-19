"use strict";
/**
 * Harness Tool: task_manage - 任务/待办管理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_MANAGE_DEF = void 0;
exports.createTaskManageExecutor = createTaskManageExecutor;
const types_1 = require("../../types");
exports.TASK_MANAGE_DEF = {
    name: 'task_manage',
    description: '管理任务和待办事项。支持创建、查看、完成、删除和更新任务，支持子任务和依赖关系。适用场景：用户需要记录待办、管理任务列表、追踪任务进度。不适用：纯信息查询。',
    category: types_1.ToolCategory.DAILY,
    parameters: {
        action: {
            type: 'string',
            description: '操作类型',
            enum: ['create', 'list', 'complete', 'delete', 'update', 'add_subtask', 'add_dependency', 'stats'],
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
        parent_id: {
            type: 'string',
            description: '父任务ID（创建子任务时使用）',
        },
        depends_on: {
            type: 'string',
            description: '依赖的任务ID（该任务必须在依赖任务完成后才能开始）',
        },
        subtask_title: {
            type: 'string',
            description: '子任务标题（add_subtask时使用）',
        },
    },
    requiredParams: ['action'],
    requiredPermissions: [types_1.Permission.MEMORY_WRITE],
    riskLevel: 'low',
    idempotent: false,
    timeout: 5000,
};
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function formatTaskList(tasks) {
    if (tasks.length === 0)
        return '暂无任务';
    return tasks
        .map((t) => {
        const icon = t.status === 'completed' ? '✅' : '⏳';
        const priority = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
        const due = t.dueDate ? ` 📅${t.dueDate}` : '';
        const tagStr = t.tags.length > 0 ? ` [${t.tags.join(',')}]` : '';
        return `${icon} [${t.id}] ${t.title}${tagStr}${due} ${priority}`;
    })
        .join('\n');
} /** 创建 task_manage 执行器 */
function createTaskManageExecutor(deps) {
    return async (params, _context) => {
        const action = String(params.action || '');
        if (!deps.taskStore) {
            return {
                success: false,
                output: null,
                error: 'task_manage 不可用: taskStore 未注入，请在 initHarness 中配置任务存储依赖',
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
                    const task = {
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
                    await deps.taskStore.saveTask(task);
                    return {
                        success: true,
                        output: `任务已创建: [${task.id}] ${task.title}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'list': {
                    let tasks = await deps.taskStore.getTasks();
                    const statusFilter = params.status;
                    if (statusFilter && ['pending', 'completed'].includes(statusFilter)) {
                        tasks = tasks.filter((t) => t.status === statusFilter);
                    }
                    const priorityOrder = { high: 0, medium: 1, low: 2 };
                    tasks.sort((a, b) => (priorityOrder[a.priority] ?? 1) -
                        (priorityOrder[b.priority] ?? 1));
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
                    await deps.taskStore.deleteTask(taskId);
                    return {
                        success: true,
                        output: `任务已删除: ${taskId}`,
                        duration: 0,
                        validated: false,
                    };
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
                    if (params.title)
                        task.title = String(params.title);
                    if (params.description)
                        task.description = String(params.description);
                    if (params.priority)
                        task.priority = String(params.priority);
                    if (params.due_date)
                        task.dueDate = String(params.due_date);
                    if (Array.isArray(params.tags))
                        task.tags = params.tags.map(String);
                    await deps.taskStore.saveTask(task);
                    return {
                        success: true,
                        output: `任务已更新: [${task.id}] ${task.title}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'add_subtask': {
                    const parentId = String(params.task_id || params.parent_id || '');
                    const subtaskTitle = String(params.subtask_title || '');
                    if (!parentId) {
                        return { success: false, output: null, error: '添加子任务需要提供task_id', duration: 0, validated: false };
                    }
                    if (!subtaskTitle) {
                        return { success: false, output: null, error: '添加子任务需要提供subtask_title', duration: 0, validated: false };
                    }
                    const parentTasks = await deps.taskStore.getTasks();
                    const parent = parentTasks.find((t) => t.id === parentId);
                    if (!parent) {
                        return { success: false, output: null, error: `父任务不存在: ${parentId}`, duration: 0, validated: false };
                    }
                    const subtask = {
                        id: generateId(),
                        title: subtaskTitle,
                        description: `子任务 of [${parentId}]`,
                        priority: parent.priority,
                        status: 'pending',
                        tags: [...parent.tags],
                        createdAt: Date.now(),
                        parentId,
                    };
                    await deps.taskStore.saveTask(subtask);
                    return { success: true, output: `子任务已添加: [${subtask.id}] ${subtaskTitle} → 父任务[${parentId}]`, duration: 0, validated: false };
                }
                case 'add_dependency': {
                    const taskId = String(params.task_id || '');
                    const dependsOn = String(params.depends_on || '');
                    if (!taskId || !dependsOn) {
                        return { success: false, output: null, error: '添加依赖需要提供task_id和depends_on', duration: 0, validated: false };
                    }
                    const allTasks = await deps.taskStore.getTasks();
                    const task = allTasks.find((t) => t.id === taskId);
                    const depTask = allTasks.find((t) => t.id === dependsOn);
                    if (!task) return { success: false, output: null, error: `任务不存在: ${taskId}`, duration: 0, validated: false };
                    if (!depTask) return { success: false, output: null, error: `依赖任务不存在: ${dependsOn}`, duration: 0, validated: false };
                    if (taskId === dependsOn) return { success: false, output: null, error: '任务不能依赖自身', duration: 0, validated: false };
                    if (!task.dependencies) task.dependencies = [];
                    if (task.dependencies.includes(dependsOn)) {
                        return { success: true, output: `依赖关系已存在: [${taskId}] → [${dependsOn}]`, duration: 0, validated: false };
                    }
                    task.dependencies.push(dependsOn);
                    await deps.taskStore.saveTask(task);
                    return { success: true, output: `依赖已添加: [${taskId}] 依赖 [${dependsOn}]`, duration: 0, validated: false };
                }
                case 'stats': {
                    const allTasks = await deps.taskStore.getTasks();
                    const total = allTasks.length;
                    const completed = allTasks.filter((t) => t.status === 'completed').length;
                    const pending = total - completed;
                    const byPriority = { high: 0, medium: 0, low: 0 };
                    for (const t of allTasks) {
                        byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
                    }
                    const overdue = allTasks.filter((t) => t.status === 'pending' && t.dueDate && new Date(t.dueDate) < new Date()).length;
                    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
                    return {
                        success: true,
                        output: `📊 任务统计\n总计: ${total} | 完成: ${completed} | 待办: ${pending} | 逾期: ${overdue}\n完成率: ${completionRate}%\n优先级: 🔴${byPriority.high} 🟡${byPriority.medium} 🟢${byPriority.low}`,
                        duration: 0,
                        validated: false,
                        metadata: { total, completed, pending, overdue, completionRate, byPriority },
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
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `任务操作失败: ${err.message}`,
                duration: 0,
                validated: false,
            };
        }
    };
}
