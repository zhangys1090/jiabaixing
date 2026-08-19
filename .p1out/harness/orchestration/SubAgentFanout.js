"use strict";
/**
 * Harness Phase 10: 多Agent编排 — Sub-Agent 扇出机制
 *
 * 管理子 Agent 的扇出执行：
 * - parallel: 所有子任务并行执行（无依赖时）
 * - sequential: 顺序执行（有依赖时）
 * - adaptive: 根据 TaskComplexityAnalyzer 自动选择
 *
 * 每个 Sub-Agent 拥有独立的上下文窗口，确保上下文隔离。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubAgentFanout = exports.PERCEPTION_AGENT_TEMPLATES = void 0;
const crypto_1 = require("crypto");
const Logger_1 = require("../../utils/Logger");
const DEFAULT_FANOUT_CONFIG = {
    maxFanout: 5,
    strategy: 'adaptive',
    taskTimeoutMs: 30000,
    continueOnPartialFailure: true,
};
exports.PERCEPTION_AGENT_TEMPLATES = {
    visual_operator: {
        kind: 'visual_operator',
        description: '视觉操作型子 Agent：结合视觉定位与 UI 自动化执行界面操作。',
        modalities: ['visual', 'uia', 'ocr'],
        tools: ['visual_grounding', 'uia', 'ocr', 'screen_capture'],
        useSharedFusion: true,
    },
    desktop_automation: {
        kind: 'desktop_automation',
        description: '桌面自动化型子 Agent：调度桌面自动化完成点击/输入/拖拽等动作。',
        modalities: ['uia', 'visual', 'proprioception'],
        tools: ['nut', 'playwright', 'uia', 'action_verifier'],
        useSharedFusion: true,
    },
    device_control: {
        kind: 'device_control',
        description: '设备控制型子 Agent：读取真实设备网关状态并下发控制指令。',
        modalities: ['environment', 'proprioception'],
        tools: ['device_manager', 'device_gateway', 'action_verifier'],
        useSharedFusion: true,
    },
};
class SubAgentFanout {
    constructor(registry, executor, config) {
        this.registry = registry;
        this.executor = executor || null;
        this.config = { ...DEFAULT_FANOUT_CONFIG, ...config };
    }
    /**
     * 扇出执行子任务
     * @param parentTaskId - 父任务ID
     * @param subTasks - 子任务节点列表
     * @param configOverride - 可选的配置覆盖
     * @param options - W7/W8：traceId 贯通与感知模板
     * @returns 扇出执行结果
     */
    async fanout(parentTaskId, subTasks, configOverride, options) {
        const runConfig = { ...this.config, ...configOverride };
        const traceId = options?.traceId || (0, crypto_1.randomUUID)();
        const startTime = Date.now();
        const limitedTasks = subTasks.slice(0, runConfig.maxFanout);
        if (subTasks.length > runConfig.maxFanout) {
            Logger_1.Logger.warn(`⚠️ 子任务数 ${subTasks.length} 超过扇出限制 ${runConfig.maxFanout}，截断执行`, 'SubAgentFanout');
        }
        // W7：把感知模板透传到每个子任务的元数据，供执行器注入感知上下文
        if (options?.perceptionTemplate) {
            for (const t of limitedTasks) {
                t.metadata = { ...(t.metadata ?? {}), perceptionTemplate: options.perceptionTemplate };
            }
        }
        const strategy = this.resolveStrategy(limitedTasks, runConfig.strategy);
        Logger_1.Logger.info(`🔀 Sub-Agent 扇出: ${parentTaskId} | 策略=${strategy} | 子任务=${limitedTasks.length} | traceId=${traceId}`, 'SubAgentFanout');
        let subResults;
        switch (strategy) {
            case 'parallel':
                subResults = await this.executeParallel(parentTaskId, limitedTasks, runConfig, traceId);
                break;
            case 'sequential':
                subResults = await this.executeSequential(parentTaskId, limitedTasks, runConfig, traceId);
                break;
            case 'adaptive':
            default:
                if (this.hasDependencies(limitedTasks)) {
                    subResults = await this.executeSequential(parentTaskId, limitedTasks, runConfig, traceId);
                }
                else {
                    subResults = await this.executeParallel(parentTaskId, limitedTasks, runConfig, traceId);
                }
                break;
        }
        const totalDuration = Date.now() - startTime;
        const successCount = subResults.filter((r) => r.success).length;
        const failedCount = subResults.filter((r) => !r.success).length;
        Logger_1.Logger.info(`🏁 Sub-Agent 扇出完成: ${parentTaskId} | 成功=${successCount} 失败=${failedCount} | 耗时=${totalDuration}ms | traceId=${traceId}`, 'SubAgentFanout');
        return {
            parentTaskId,
            strategy,
            subResults,
            successCount,
            failedCount,
            totalDuration,
            allSucceeded: failedCount === 0,
            traceId,
        };
    }
    /**
     * 并行执行所有子任务
     */
    async executeParallel(parentTaskId, tasks, config, traceId) {
        const promises = tasks.map((task) => this.executeSubTask(parentTaskId, task, config, traceId));
        const settled = await Promise.allSettled(promises);
        return settled.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            }
            return {
                taskId: tasks[index].id,
                success: false,
                error: result.reason?.message || String(result.reason),
                duration: 0,
                traceId,
            };
        });
    }
    /**
     * 顺序执行所有子任务
     */
    async executeSequential(parentTaskId, tasks, config, traceId) {
        const results = [];
        for (const task of tasks) {
            try {
                const result = await this.executeSubTask(parentTaskId, task, config, traceId);
                results.push(result);
                if (!result.success && !config.continueOnPartialFailure) {
                    for (const remaining of tasks.slice(results.length)) {
                        results.push({
                            taskId: remaining.id,
                            success: false,
                            error: '前置任务失败，跳过执行',
                            duration: 0,
                            traceId,
                        });
                    }
                    break;
                }
            }
            catch (err) {
                results.push({
                    taskId: task.id,
                    success: false,
                    error: err.message,
                    duration: 0,
                    traceId,
                });
                if (!config.continueOnPartialFailure) {
                    for (const remaining of tasks.slice(results.length)) {
                        results.push({
                            taskId: remaining.id,
                            success: false,
                            error: '前置任务失败，跳过执行',
                            duration: 0,
                            traceId,
                        });
                    }
                    break;
                }
            }
        }
        return results;
    }
    /**
     * 执行单个子任务
     */
    async executeSubTask(parentTaskId, task, config, traceId) {
        const startTime = Date.now();
        const agent = this.registry.findBestAgent((task.tools && task.tools[0]) || '') ||
            this.registry.findAgentByCapability((task.tools && task.tools[0]) || '');
        if (!agent) {
            return {
                taskId: task.id,
                success: false,
                error: `无可用的 Agent 执行子任务: ${task.id}`,
                duration: Date.now() - startTime,
                traceId,
            };
        }
        this.registry.updateStatus(agent.id, 'busy');
        let timeoutId;
        try {
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`子任务超时 (${config.taskTimeoutMs}ms)`)), config.taskTimeoutMs);
                if (timeoutId.unref)
                    timeoutId.unref();
            });
            const taskWithTrace = {
                ...task,
                metadata: { ...(task.metadata ?? {}), traceId },
            };
            const result = this.executor
                ? await Promise.race([this.executor(taskWithTrace), timeoutPromise])
                : await Promise.race([
                    Promise.resolve({
                        taskId: task.id,
                        goal: task.goal,
                        completedAt: Date.now(),
                    }),
                    timeoutPromise,
                ]);
            clearTimeout(timeoutId);
            const duration = Date.now() - startTime;
            this.registry.recordExecution(agent.id, true, duration);
            task.status = 'completed';
            task.result = result;
            task.assignedTo = agent.id;
            return {
                taskId: task.id,
                success: true,
                result,
                duration,
                agentId: agent.id,
                traceId,
            };
        }
        catch (err) {
            clearTimeout(timeoutId);
            const duration = Date.now() - startTime;
            this.registry.recordExecution(agent.id, false, duration);
            task.status = 'failed';
            task.error = err.message;
            return {
                taskId: task.id,
                success: false,
                error: err.message,
                duration,
                agentId: agent.id,
                traceId,
            };
        }
        finally {
            this.registry.updateStatus(agent.id, 'idle');
        }
    }
    /**
     * 解析执行策略
     */
    resolveStrategy(tasks, configured) {
        if (configured !== 'adaptive')
            return configured;
        return this.hasDependencies(tasks) ? 'sequential' : 'parallel';
    }
    /**
     * 检查任务间是否有依赖关系
     */
    hasDependencies(tasks) {
        return tasks.some((t) => t.dependencies.length > 0);
    }
}
exports.SubAgentFanout = SubAgentFanout;
