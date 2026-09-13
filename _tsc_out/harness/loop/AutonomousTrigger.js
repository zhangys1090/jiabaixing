"use strict";
/**
 * 自主循环触发器 - 让 LLM 能主动发起任务
 *
 * 三种触发模式：
 * 1. 定时巡检：按固定间隔检查环境，发现异常主动处理
 * 2. 事件驱动：监听系统事件（文件变化、网络消息等），触发自主行动
 * 3. 目标驱动：LLM 自身判断需要执行的操作
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutonomousTrigger = void 0;
const Logger_1 = require("../../utils/Logger");
const DEFAULT_AUTONOMOUS_CONFIG = {
    enabled: false,
    patrolIntervalMs: 300000,
    maxConcurrentTasks: 3,
    allowedActions: [
        'system_health_check',
        'memory_consolidation',
        'desktop_screenshot',
        'web_fetch',
        'file_list',
        'system_status',
    ],
    forbiddenActions: ['desktop_automate', 'shell_exec', 'incremental_edit'],
    requireConfirmation: true,
};
class AutonomousTrigger {
    static instance = null;
    config;
    harness = null;
    patrolTimer = null;
    activeTasks = new Map();
    taskHistory = [];
    static MAX_HISTORY = 100;
    constructor(config) {
        this.config = { ...DEFAULT_AUTONOMOUS_CONFIG, ...config };
    }
    static getInstance(config) {
        if (!AutonomousTrigger.instance) {
            AutonomousTrigger.instance = new AutonomousTrigger(config);
        }
        return AutonomousTrigger.instance;
    }
    setHarness(harness) {
        this.harness = harness;
    }
    start() {
        if (!this.config.enabled) {
            Logger_1.Logger.info('🤖 自主触发器未启用，跳过启动', 'AutonomousTrigger');
            return;
        }
        if (this.patrolTimer) {
            Logger_1.Logger.warn('⚠️ 自主触发器已在运行', 'AutonomousTrigger');
            return;
        }
        Logger_1.Logger.info(`🤖 自主触发器启动 (巡检间隔=${this.config.patrolIntervalMs / 1000}s)`, 'AutonomousTrigger');
        this.patrolTimer = setInterval(() => this.patrol(), this.config.patrolIntervalMs);
        setTimeout(() => this.patrol(), 5000);
    }
    stop() {
        if (this.patrolTimer) {
            clearInterval(this.patrolTimer);
            this.patrolTimer = null;
        }
        for (const task of this.activeTasks.values()) {
            if (task.status === 'running') {
                task.status = 'failed';
                task.completedAt = Date.now();
                task.result = '触发器停止，任务中断';
            }
        }
        Logger_1.Logger.info('🤖 自主触发器已停止', 'AutonomousTrigger');
    }
    async patrol() {
        if (this.activeTasks.size >= this.config.maxConcurrentTasks) {
            Logger_1.Logger.debug('🤖 巡检跳过：活跃任务数已达上限', 'AutonomousTrigger');
            return;
        }
        if (!this.harness) {
            Logger_1.Logger.debug('🤖 巡检跳过：Harness 未设置', 'AutonomousTrigger');
            return;
        }
        const taskId = `patrol_${Date.now()}`;
        const task = {
            id: taskId,
            trigger: 'patrol',
            description: '定时巡检：系统健康检查',
            status: 'running',
            createdAt: Date.now(),
        };
        this.activeTasks.set(taskId, task);
        try {
            Logger_1.Logger.info('🤖 开始定时巡检...', 'AutonomousTrigger');
            const input = {
                text: '执行系统健康检查：检查内存状态、工具可用性、MCP服务器状态。同时扫描 data/evolution/skills/ 目录下的 evolve skill 文件，检查是否有长时间未使用的 skill（30天以上），如果有则标记为待优化。如果发现异常，尝试自动修复。只报告关键发现。',
                traceId: taskId,
            };
            const result = await this.harness.processInput(input);
            task.status = 'completed';
            task.completedAt = Date.now();
            task.result = result.response
                ? result.response.substring(0, 500)
                : '巡检完成';
            Logger_1.Logger.info(`🤖 巡检完成: ${task.result.substring(0, 100)}`, 'AutonomousTrigger');
        }
        catch (err) {
            task.status = 'failed';
            task.completedAt = Date.now();
            task.result = err.message;
            Logger_1.Logger.error('🤖 巡检失败', err, 'AutonomousTrigger');
        }
        this.activeTasks.delete(taskId);
        this.taskHistory.push(task);
        if (this.taskHistory.length > AutonomousTrigger.MAX_HISTORY) {
            this.taskHistory.shift();
        }
    }
    async triggerEvent(eventDescription, eventData) {
        if (!this.config.enabled || !this.harness)
            return null;
        if (this.activeTasks.size >= this.config.maxConcurrentTasks) {
            Logger_1.Logger.warn('🤖 事件触发跳过：活跃任务数已达上限', 'AutonomousTrigger');
            return null;
        }
        const taskId = `event_${Date.now()}`;
        const task = {
            id: taskId,
            trigger: 'event',
            description: eventDescription,
            status: 'running',
            createdAt: Date.now(),
        };
        this.activeTasks.set(taskId, task);
        try {
            const prompt = `系统事件触发：${eventDescription}${eventData
                ? `\n事件数据: ${JSON.stringify(eventData).substring(0, 500)}`
                : ''}\n\n请分析此事件并决定是否需要采取行动。如果不需要行动，回复"无需行动"。`;
            const input = { text: prompt, traceId: taskId };
            const result = await this.harness.processInput(input);
            task.status = 'completed';
            task.completedAt = Date.now();
            task.result = result.response
                ? result.response.substring(0, 500)
                : '事件处理完成';
            return task.result;
        }
        catch (err) {
            task.status = 'failed';
            task.completedAt = Date.now();
            task.result = err.message;
            return null;
        }
        finally {
            this.activeTasks.delete(taskId);
            this.taskHistory.push(task);
            if (this.taskHistory.length > AutonomousTrigger.MAX_HISTORY) {
                this.taskHistory.shift();
            }
        }
    }
    async triggerGoal(goalDescription) {
        if (!this.harness)
            return null;
        const taskId = `goal_${Date.now()}`;
        const task = {
            id: taskId,
            trigger: 'goal',
            description: goalDescription,
            status: 'running',
            createdAt: Date.now(),
        };
        this.activeTasks.set(taskId, task);
        try {
            const input = { text: goalDescription, traceId: taskId };
            const result = await this.harness.processInput(input);
            task.status = 'completed';
            task.completedAt = Date.now();
            task.result = result.response
                ? result.response.substring(0, 500)
                : '目标完成';
            return task.result;
        }
        catch (err) {
            task.status = 'failed';
            task.completedAt = Date.now();
            task.result = err.message;
            return null;
        }
        finally {
            this.activeTasks.delete(taskId);
            this.taskHistory.push(task);
            if (this.taskHistory.length > AutonomousTrigger.MAX_HISTORY) {
                this.taskHistory.shift();
            }
        }
    }
    updateConfig(updates) {
        this.config = { ...this.config, ...updates };
        if (updates.patrolIntervalMs && this.patrolTimer) {
            this.stop();
            if (this.config.enabled) {
                this.start();
            }
        }
    }
    getConfig() {
        return { ...this.config };
    }
    getActiveTasks() {
        return Array.from(this.activeTasks.values());
    }
    getTaskHistory(limit = 20) {
        return this.taskHistory.slice(-limit);
    }
    getStatus() {
        const completed = this.taskHistory.filter((t) => t.status === 'completed').length;
        const failed = this.taskHistory.filter((t) => t.status === 'failed').length;
        return {
            enabled: this.config.enabled,
            running: !!this.patrolTimer,
            activeTasks: this.activeTasks.size,
            totalCompleted: completed,
            totalFailed: failed,
        };
    }
}
exports.AutonomousTrigger = AutonomousTrigger;
