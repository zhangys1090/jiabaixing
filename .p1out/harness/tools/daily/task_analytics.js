"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_ANALYTICS_DEF = void 0;
exports.createTaskAnalyticsExecutor = createTaskAnalyticsExecutor;
const types_1 = require("../../types");
exports.TASK_ANALYTICS_DEF = {
    name: 'task_analytics',
    description: '任务统计分析。支持统计任务完成情况、生成日报/周报、分析任务趋势、识别瓶颈任务等操作。适用场景：项目进度跟踪、团队效率分析、任务管理报表。',
    category: types_1.ToolCategory.DAILY,
    parameters: {
        action: {
            type: 'string',
            description: '操作类型',
            enum: [
                'summary',
                'daily_report',
                'weekly_report',
                'trend',
                'bottleneck',
                'tag_analysis',
            ],
        },
        days: {
            type: 'number',
            description: '统计天数（默认7天）',
            default: 7,
        },
        tag: {
            type: 'string',
            description: '标签筛选（tag_analysis时使用）',
        },
    },
    requiredParams: ['action'],
    requiredPermissions: [types_1.Permission.MEMORY_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
};
function formatDate(ts) {
    return new Date(ts).toLocaleDateString('zh-CN');
}
function getDaysAgo(days) {
    return Date.now() - days * 24 * 60 * 60 * 1000;
}
function getWeekStart(date) {
    const d = new Date(date);
    d.setDate(d.getDate() - d.getDay() + 1);
    d.setHours(0, 0, 0, 0);
    return d;
}
function createTaskAnalyticsExecutor(deps) {
    return async (params, _context) => {
        const action = String(params.action || '');
        const days = typeof params.days === 'number' ? params.days : 7;
        try {
            const allTasks = await deps.taskStore.getTasks();
            switch (action) {
                case 'summary': {
                    const pending = allTasks.filter((t) => t.status === 'pending');
                    const completed = allTasks.filter((t) => t.status === 'completed');
                    const urgent = pending.filter((t) => t.priority === 'urgent' || t.priority === 'high');
                    const priorityStats = {
                        urgent: pending.filter((t) => t.priority === 'urgent').length,
                        high: pending.filter((t) => t.priority === 'high').length,
                        medium: pending.filter((t) => t.priority === 'medium').length,
                        low: pending.filter((t) => t.priority === 'low').length,
                    };
                    const completionRate = allTasks.length > 0
                        ? ((completed.length / allTasks.length) * 100).toFixed(1)
                        : '0';
                    return {
                        success: true,
                        output: `📊 任务统计摘要\n\n` +
                            `总任务数: ${allTasks.length}\n` +
                            `待办任务: ${pending.length} ⏳\n` +
                            `已完成: ${completed.length} ✅\n` +
                            `完成率: ${completionRate}%\n` +
                            `紧急/高优先级待办: ${urgent.length} 🔴\n\n` +
                            `待办优先级分布:\n` +
                            `  - 🔴 urgent: ${priorityStats.urgent}\n` +
                            `  - 🟠 high: ${priorityStats.high}\n` +
                            `  - 🟡 medium: ${priorityStats.medium}\n` +
                            `  - 🟢 low: ${priorityStats.low}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'daily_report': {
                    const cutoff = getDaysAgo(1);
                    const todayCreated = allTasks.filter((t) => t.createdAt >= cutoff);
                    const todayCompleted = allTasks.filter((t) => t.status === 'completed' &&
                        t.completedAt &&
                        t.completedAt >= cutoff);
                    const pending = allTasks.filter((t) => t.status === 'pending');
                    const urgentPending = pending.filter((t) => t.priority === 'urgent');
                    return {
                        success: true,
                        output: `📅 今日任务报告 (${formatDate(Date.now())})\n\n` +
                            `今日创建: ${todayCreated.length} 个任务\n` +
                            `今日完成: ${todayCompleted.length} 个任务\n` +
                            `待办总数: ${pending.length} 个\n` +
                            `紧急待办: ${urgentPending.length} 个 🔴\n\n` +
                            `今日新增任务:\n${todayCreated.map((t) => `  - [${t.id}] ${t.title}`).join('\n') || '  (无)'}\n\n` +
                            `今日完成任务:\n${todayCompleted.map((t) => `  - [${t.id}] ${t.title}`).join('\n') || '  (无)'}\n\n` +
                            `📈 提示: 建议优先处理 ${urgentPending.length > 0 ? urgentPending.length : '高'}优先级任务`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'weekly_report': {
                    const weekStart = getWeekStart(new Date());
                    const weekStartMs = weekStart.getTime();
                    const weekEndMs = weekStartMs + 7 * 24 * 60 * 60 * 1000;
                    const weekCreated = allTasks.filter((t) => t.createdAt >= weekStartMs && t.createdAt < weekEndMs);
                    const weekCompleted = allTasks.filter((t) => t.status === 'completed' &&
                        t.completedAt &&
                        t.completedAt >= weekStartMs &&
                        t.completedAt < weekEndMs);
                    const dailyStats = {};
                    const weekdays = [
                        '周一',
                        '周二',
                        '周三',
                        '周四',
                        '周五',
                        '周六',
                        '周日',
                    ];
                    for (let i = 0; i < 7; i++) {
                        const dayStart = weekStartMs + i * 24 * 60 * 60 * 1000;
                        const dayEnd = dayStart + 24 * 60 * 60 * 1000;
                        dailyStats[weekdays[i]] = {
                            created: allTasks.filter((t) => t.createdAt >= dayStart && t.createdAt < dayEnd).length,
                            completed: allTasks.filter((t) => t.status === 'completed' &&
                                t.completedAt &&
                                t.completedAt >= dayStart &&
                                t.completedAt < dayEnd).length,
                        };
                    }
                    const weekCompletionRate = weekCreated.length > 0
                        ? ((weekCompleted.length / weekCreated.length) * 100).toFixed(1)
                        : '0';
                    const dailyReport = weekdays
                        .map((day) => {
                        const stats = dailyStats[day];
                        return `${day}: 创建 ${stats.created} | 完成 ${stats.completed}`;
                    })
                        .join('\n');
                    return {
                        success: true,
                        output: `📋 本周任务报告 (${formatDate(weekStart.getTime())} ~ ${formatDate(weekEndMs - 1)})\n\n` +
                            `本周创建: ${weekCreated.length} 个任务\n` +
                            `本周完成: ${weekCompleted.length} 个任务\n` +
                            `周完成率: ${weekCompletionRate}%\n\n` +
                            `每日统计:\n${dailyReport}\n\n` +
                            `💡 建议: ${weekCompleted.length >= weekCreated.length ? '本周任务完成情况良好！' : '建议合理规划任务，提高完成效率。'}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'trend': {
                    const trendData = {};
                    for (let i = days - 1; i >= 0; i--) {
                        const dayStart = getDaysAgo(i + 1);
                        const dayEnd = getDaysAgo(i);
                        const dateStr = formatDate(dayEnd);
                        trendData[dateStr] = {
                            created: allTasks.filter((t) => t.createdAt >= dayStart && t.createdAt < dayEnd).length,
                            completed: allTasks.filter((t) => t.status === 'completed' &&
                                t.completedAt &&
                                t.completedAt >= dayStart &&
                                t.completedAt < dayEnd).length,
                        };
                    }
                    const trendReport = Object.entries(trendData)
                        .map(([date, stats]) => {
                        const balance = stats.completed - stats.created;
                        const icon = balance >= 0 ? '📈' : '📉';
                        return `${date}: 创建 ${stats.created} | 完成 ${stats.completed} ${icon}`;
                    })
                        .join('\n');
                    const totalCreated = Object.values(trendData).reduce((sum, s) => sum + s.created, 0);
                    const totalCompleted = Object.values(trendData).reduce((sum, s) => sum + s.completed, 0);
                    return {
                        success: true,
                        output: `📊 近${days}天任务趋势\n\n` +
                            `期间创建: ${totalCreated} 个任务\n` +
                            `期间完成: ${totalCompleted} 个任务\n` +
                            `净变化: ${totalCompleted - totalCreated > 0 ? '+' : ''}${totalCompleted - totalCreated}\n\n` +
                            `每日趋势:\n${trendReport}`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'bottleneck': {
                    const pendingTasks = allTasks.filter((t) => t.status === 'pending');
                    const oldTasks = pendingTasks.filter((t) => t.createdAt < getDaysAgo(3));
                    const priorityGroups = {
                        urgent: [],
                        high: [],
                        medium: [],
                        low: [],
                    };
                    for (const task of oldTasks) {
                        priorityGroups[task.priority]?.push(task);
                    }
                    const bottleneckReport = Object.entries(priorityGroups)
                        .filter(([, tasks]) => tasks.length > 0)
                        .map(([priority, tasks]) => {
                        const icon = priority === 'urgent'
                            ? '🔴'
                            : priority === 'high'
                                ? '🟠'
                                : priority === 'medium'
                                    ? '🟡'
                                    : '🟢';
                        return `${icon} ${priority.toUpperCase()} (${tasks.length}个超过3天):\n${tasks.map((t) => `  - [${t.id}] ${t.title}`).join('\n')}`;
                    })
                        .join('\n\n');
                    if (oldTasks.length === 0) {
                        return {
                            success: true,
                            output: `✅ 良好！没有超过3天的待办任务`,
                            duration: 0,
                            validated: false,
                        };
                    }
                    return {
                        success: true,
                        output: `🚨 瓶颈任务分析（超过3天未完成）\n\n` +
                            `总计: ${oldTasks.length} 个任务存在瓶颈\n\n` +
                            `${bottleneckReport}\n\n` +
                            `💡 建议: 优先处理高优先级的瓶颈任务`,
                        duration: 0,
                        validated: false,
                    };
                }
                case 'tag_analysis': {
                    const tag = String(params.tag || '');
                    if (!tag) {
                        const tagStats = {};
                        for (const task of allTasks) {
                            for (const t of task.tags) {
                                if (!tagStats[t]) {
                                    tagStats[t] = { total: 0, completed: 0 };
                                }
                                tagStats[t].total++;
                                if (task.status === 'completed') {
                                    tagStats[t].completed++;
                                }
                            }
                        }
                        if (Object.keys(tagStats).length === 0) {
                            return {
                                success: true,
                                output: `📭 暂无带标签的任务`,
                                duration: 0,
                                validated: false,
                            };
                        }
                        const tagReport = Object.entries(tagStats)
                            .map(([tagName, stats]) => {
                            const rate = ((stats.completed / stats.total) * 100).toFixed(0);
                            return `#${tagName}: ${stats.total}个任务 | 完成率 ${rate}%`;
                        })
                            .join('\n');
                        return {
                            success: true,
                            output: `🏷️ 标签统计分析\n\n${tagReport}`,
                            duration: 0,
                            validated: false,
                        };
                    }
                    const tagTasks = allTasks.filter((t) => t.tags.includes(tag));
                    const completed = tagTasks.filter((t) => t.status === 'completed');
                    const pending = tagTasks.filter((t) => t.status === 'pending');
                    return {
                        success: true,
                        output: `🏷️ 标签 "#${tag}" 分析\n\n` +
                            `总计任务: ${tagTasks.length} 个\n` +
                            `已完成: ${completed.length} 个 ✅\n` +
                            `待办: ${pending.length} 个 ⏳\n` +
                            `完成率: ${tagTasks.length > 0 ? ((completed.length / tagTasks.length) * 100).toFixed(1) : '0'}%\n\n` +
                            `待办列表:\n${pending.map((t) => `  - [${t.id}] ${t.title}`).join('\n') || '  (无)'}\n\n` +
                            `已完成列表:\n${completed.map((t) => `  - [${t.id}] ${t.title}`).join('\n') || '  (无)'}\n\n`,
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
                error: `统计分析失败: ${err.message}`,
                duration: 0,
                validated: false,
            };
        }
    };
}
