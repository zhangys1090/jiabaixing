"use strict";
/**
 * Harness Tool: system_status - 系统状态查询
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_STATUS_DEF = void 0;
exports.createSystemStatusExecutor = createSystemStatusExecutor;
const types_1 = require("../../types");
exports.SYSTEM_STATUS_DEF = {
    name: 'system_status',
    description: '查询系统各组件的运行状态。支持查看内存、工具、Harness、进化、调度器等组件状态。适用场景：用户想了解系统运行情况、排查问题、查看资源使用。不适用：任务管理、提醒设置。',
    category: types_1.ToolCategory.DAILY,
    parameters: {
        component: {
            type: 'string',
            description: '查询的组件',
            enum: ['all', 'memory', 'tools', 'harness', 'evolution', 'scheduler'],
            default: 'all',
        },
        detail_level: {
            type: 'string',
            description: '详情级别',
            enum: ['summary', 'detailed'],
            default: 'summary',
        },
    },
    requiredParams: [],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
};
function statusIcon(ok) {
    return ok ? '✅' : '⚠️';
}
function formatMemoryStats(stats, detailed) {
    const count = typeof stats.count === 'number' ? stats.count : 0;
    const line = `${statusIcon(true)} 记忆条目: ${count}`;
    if (!detailed)
        return line;
    const entries = Object.entries(stats)
        .filter(([k]) => k !== 'count')
        .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
        .join('\n');
    return line + (entries ? '\n' + entries : '');
}
function formatToolStats(stats, detailed) {
    const line = `${statusIcon(true)} 已注册工具: ${stats.registered}`;
    if (!detailed)
        return line;
    const cats = Object.entries(stats.byCategory)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
    return line + (cats ? '\n' + cats : '');
}
function formatHarnessStats(stats, detailed) {
    const icon = statusIcon(stats.initialized);
    const line = `${icon} Harness: ${stats.initialized ? '已初始化' : '未初始化'}`;
    if (!detailed)
        return line;
    const cfg = Object.entries(stats.config)
        .map(([k, v]) => `  ${k}: ${v ? '✅' : '❌'}`)
        .join('\n');
    return line + (cfg ? '\n' + cfg : '');
}
function formatGenericStats(name, stats, detailed) {
    const hasData = Object.keys(stats).length > 0;
    const line = `${statusIcon(hasData)} ${name}: ${hasData ? '正常' : '无数据'}`;
    if (!detailed)
        return line;
    const entries = Object.entries(stats)
        .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
        .join('\n');
    return line + (entries ? '\n' + entries : '');
}
function createSystemStatusExecutor(deps) {
    return async (params, _context) => {
        const component = String(params.component || 'all');
        const detailed = String(params.detail_level || 'summary') === 'detailed';
        try {
            const lines = ['📊 系统状态报告\n'];
            if (component === 'all' || component === 'memory') {
                lines.push(formatMemoryStats(deps.getMemoryStats(), detailed));
            }
            if (component === 'all' || component === 'tools') {
                lines.push(formatToolStats(deps.getToolStats(), detailed));
            }
            if (component === 'all' || component === 'harness') {
                lines.push(formatHarnessStats(deps.getHarnessStats(), detailed));
            }
            if (component === 'all' || component === 'evolution') {
                lines.push(formatGenericStats('进化系统', await deps.getEvolutionStats(), detailed));
            }
            if (component === 'all' || component === 'scheduler') {
                lines.push(formatGenericStats('调度器', deps.getSchedulerStats(), detailed));
            }
            return {
                success: true,
                output: lines.join('\n'),
                duration: 0,
                validated: false,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `状态查询失败: ${err.message}`,
                duration: 0,
                validated: false,
            };
        }
    };
}
