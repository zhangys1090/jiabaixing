"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BATCH_TASK_DEF = void 0;
exports.createBatchTaskExecutor = createBatchTaskExecutor;
const types_1 = require("../../types");
exports.BATCH_TASK_DEF = {
    name: 'batch_task',
    description: '批量操作任务。支持批量创建、批量完成、批量删除、批量更新优先级、批量添加标签等操作。适用场景：一次性处理多个任务、批量管理任务列表。',
    category: types_1.ToolCategory.DAILY,
    parameters: {
        action: {
            type: 'string',
            description: '操作类型',
            enum: [
                'create_batch',
                'complete_batch',
                'delete_batch',
                'update_priority_batch',
                'add_tags_batch',
                'list_by_status',
            ],
        },
        tasks: {
            type: 'array',
            description: '任务列表（create_batch时使用）',
            items: {
                type: 'object',
                description: '任务对象',
                properties: {
                    title: { type: 'string', description: '任务标题' },
                    description: { type: 'string', description: '任务描述' },
                    priority: { type: 'string', description: '优先级' },
                    due_date: { type: 'string', description: '截止日期' },
                    tags: {
                        type: 'array',
                        description: '标签',
                        items: { type: 'string', description: '标签名' },
                    },
                },
            },
        },
        task_ids: {
            type: 'array',
            description: '任务ID列表（批量操作时使用）',
            items: { type: 'string', description: '任务ID' },
        },
        priority: {
            type: 'string',
            description: '目标优先级（批量更新优先级时使用）',
            enum: ['low', 'medium', 'high', 'urgent'],
        },
        tags: {
            type: 'array',
            description: '标签列表（批量添加标签时使用）',
            items: { type: 'string', description: '标签名' },
        },
        status: {
            type: 'string',
            description: '任务状态（list_by_status时使用）',
            enum: ['pending', 'completed'],
        },
    },
    requiredParams: ['action'],
    requiredPermissions: [types_1.Permission.MEMORY_WRITE],
    riskLevel: 'low',
    idempotent: false,
    timeout: 10000,
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
        const priority = t.priority === 'high' || t.priority === 'urgent'
            ? '🔴'
            : t.priority === 'low'
                ? '🟢'
                : '🟡';
        const due = t.dueDate
            ? ` 📅${new Date(t.dueDate).toLocaleDateString('zh-CN')}`
            : '';
        const tagStr = t.tags.length > 0 ? ` [${t.tags.join(',')}]` : '';
        return `${icon} [${t.id}] ${t.title}${tagStr}${due} ${priority}`;
    })
        .join('\n');
}
function createBatchTaskExecutor(deps) {
    return async (params, _context) => {
        const action = String(params.action || '');
        try {
            switch (action) {
                case 'create_batch': {
                    const tasksInput = params.tasks || [];
                    if (tasksInput.length === 0) {
                        return {
                            success: false,
                            output: null,
                            error: '批量创建任务需要提供tasks数组',
                            duration: 0,
                            validated: false,
                        };
                    }
                    const createdIds = [];
                    for (const taskInput of tasksInput) {
                        const title = String(taskInput.title || '');
                        if (!title)
                            continue;
                        const task = {
                            id: generateId(),
                            title,
                            description: taskInput.description
                                ? String(taskInput.description)
                                : undefined,
                            priority: String(taskInput.priority || 'medium'),
                            status: 'pending',
                            dueDate: taskInput.due_date
                                ? String(taskInput.due_date)
                                : undefined,
                            tags: Array.isArray(taskInput.tags)
                                ? taskInput.tags.map(String)
                                : [],
                            createdAt: Date.now(),
                        };
                        await deps.taskStore.saveTask(task);
                        createdIds.push(task.id);
                    }
                    if (createdIds.length === 0) {
                        return {
                            success: false,
                            output: null,
                            error: '没有有效的任务被创建',
                            duration: 0,
                            validated: false,
                        };
                    }
                    return {
                        success: true,
                        output: `已批量创建 ${createdIds.length} 个任务，ID: ${createdIds.join(', ')}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'complete_batch': {
                    const taskIds = params.task_ids || [];
                    if (taskIds.length === 0) {
                        return {
                            success: false,
                            output: null,
                            error: '批量完成任务需要提供task_ids数组',
                            duration: 0,
                            validated: false,
                        };
                    }
                    const tasks = await deps.taskStore.getTasks();
                    const completedIds = [];
                    for (const taskId of taskIds) {
                        const task = tasks.find((t) => t.id === taskId);
                        if (task && task.status === 'pending') {
                            task.status = 'completed';
                            task.completedAt = Date.now();
                            await deps.taskStore.saveTask(task);
                            completedIds.push(taskId);
                        }
                    }
                    return {
                        success: true,
                        output: `已批量完成 ${completedIds.length} 个任务，ID: ${completedIds.join(', ')}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'delete_batch': {
                    const taskIds = params.task_ids || [];
                    if (taskIds.length === 0) {
                        return {
                            success: false,
                            output: null,
                            error: '批量删除任务需要提供task_ids数组',
                            duration: 0,
                            validated: false,
                        };
                    }
                    const deletedIds = [];
                    for (const taskId of taskIds) {
                        try {
                            await deps.taskStore.deleteTask(taskId);
                            deletedIds.push(taskId);
                        }
                        catch {
                            // 忽略删除失败的任务
                        }
                    }
                    return {
                        success: true,
                        output: `已批量删除 ${deletedIds.length} 个任务，ID: ${deletedIds.join(', ')}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'update_priority_batch': {
                    const taskIds = params.task_ids || [];
                    const priority = String(params.priority || '');
                    if (taskIds.length === 0) {
                        return {
                            success: false,
                            output: null,
                            error: '批量更新优先级需要提供task_ids数组',
                            duration: 0,
                            validated: false,
                        };
                    }
                    if (!['low', 'medium', 'high', 'urgent'].includes(priority)) {
                        return {
                            success: false,
                            output: null,
                            error: `无效的优先级值: ${priority}`,
                            duration: 0,
                            validated: false,
                        };
                    }
                    const tasks = await deps.taskStore.getTasks();
                    const updatedIds = [];
                    for (const taskId of taskIds) {
                        const task = tasks.find((t) => t.id === taskId);
                        if (task) {
                            task.priority = priority;
                            await deps.taskStore.saveTask(task);
                            updatedIds.push(taskId);
                        }
                    }
                    return {
                        success: true,
                        output: `已批量更新 ${updatedIds.length} 个任务的优先级为 ${priority}，ID: ${updatedIds.join(', ')}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'add_tags_batch': {
                    const taskIds = params.task_ids || [];
                    const tags = params.tags || [];
                    if (taskIds.length === 0) {
                        return {
                            success: false,
                            output: null,
                            error: '批量添加标签需要提供task_ids数组',
                            duration: 0,
                            validated: false,
                        };
                    }
                    if (tags.length === 0) {
                        return {
                            success: false,
                            output: null,
                            error: '批量添加标签需要提供tags数组',
                            duration: 0,
                            validated: false,
                        };
                    }
                    const tasks = await deps.taskStore.getTasks();
                    const updatedIds = [];
                    for (const taskId of taskIds) {
                        const task = tasks.find((t) => t.id === taskId);
                        if (task) {
                            for (const tag of tags) {
                                if (!task.tags.includes(tag)) {
                                    task.tags.push(tag);
                                }
                            }
                            await deps.taskStore.saveTask(task);
                            updatedIds.push(taskId);
                        }
                    }
                    return {
                        success: true,
                        output: `已为 ${updatedIds.length} 个任务添加标签 [${tags.join(', ')}]，ID: ${updatedIds.join(', ')}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'list_by_status': {
                    const status = String(params.status || 'pending');
                    if (!['pending', 'completed'].includes(status)) {
                        return {
                            success: false,
                            output: null,
                            error: `无效的状态值: ${status}`,
                            duration: 0,
                            validated: false,
                        };
                    }
                    const tasks = await deps.taskStore.getTasks();
                    const filtered = tasks.filter((t) => t.status === status);
                    const statusLabel = status === 'pending' ? '待办' : '已完成';
                    return {
                        success: true,
                        output: `${statusLabel}任务列表 (共${filtered.length}个):\n${formatTaskList(filtered)}`,
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
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `批量操作失败: ${err.message}`,
                duration: 0,
                validated: false,
            };
        }
    };
}
