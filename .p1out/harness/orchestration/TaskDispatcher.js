"use strict";
/**
 * Harness Phase 10: 多Agent编排 — DAG任务分发引擎
 *
 * 基于DAG依赖关系的智能任务调度：
 * - 拓扑排序分层，无依赖的并行执行
 * - 通过AgentRegistry自动分配Agent
 * - 支持优先级调度
 * - 完整的错误处理和状态追踪
 * P10增强：超时控制、自动重试、任务取消、并发限制
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskDispatcher = exports.TaskMessageBus = void 0;
const Logger_1 = require("../../utils/Logger");
const DEFAULT_DISPATCHER_CONFIG = {
    taskTimeoutMs: 30000,
    maxRetries: 2,
    retryDelayMs: 1000,
    maxConcurrentPerLayer: 5,
};
/**
 * 轻量级任务间消息总线
 * 允许并行执行的子任务之间共享中间结果
 */
class TaskMessageBus {
    constructor() {
        this.messages = new Map();
        this.MAX_CHANNELS = 1000;
        this.waiters = new Map();
    }
    /**
     * 发布消息到指定频道
     * @param channel - 频道名称（通常用 taskId）
     * @param data - 消息数据
     */
    publish(channel, data) {
        if (!this.messages.has(channel)) {
            if (this.messages.size >= this.MAX_CHANNELS) {
                const oldestKey = this.messages.keys().next().value;
                this.messages.delete(oldestKey);
                this.waiters.delete(oldestKey);
            }
            this.messages.set(channel, []);
        }
        this.messages.get(channel).push(data);
        const waiters = this.waiters.get(channel);
        if (waiters) {
            const waiter = waiters.shift();
            if (waiter) {
                waiter(data);
                if (waiters.length === 0) {
                    this.waiters.delete(channel);
                }
            }
        }
    }
    /**
     * 订阅频道消息（立即返回已有消息）
     * @param channel - 频道名称
     * @returns 该频道的所有已有消息
     */
    subscribe(channel) {
        return this.messages.get(channel) || [];
    }
    /**
     * 等待频道消息（Promise 版本，带超时）
     * @param channel - 频道名称
     * @param timeoutMs - 超时时间（默认 5000ms）
     * @returns 消息数据，超时返回 null
     */
    waitForMessage(channel, timeoutMs = 5000) {
        const existing = this.messages.get(channel);
        if (existing && existing.length > 0) {
            return Promise.resolve(existing[0]);
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const waiters = this.waiters.get(channel);
                if (waiters) {
                    const idx = waiters.indexOf(resolve);
                    if (idx >= 0)
                        waiters.splice(idx, 1);
                }
                resolve(null);
            }, timeoutMs);
            if (!this.waiters.has(channel)) {
                this.waiters.set(channel, []);
            }
            this.waiters.get(channel).push((value) => {
                clearTimeout(timer);
                resolve(value);
            });
        });
    }
    /**
     * 清理所有消息和等待者
     */
    clear() {
        this.messages.clear();
        this.waiters.clear();
    }
}
exports.TaskMessageBus = TaskMessageBus;
class TaskDispatcher {
    constructor(registry, executor, config) {
        this.activeControllers = new Map();
        this.messageBus = new TaskMessageBus();
        this.registry = registry;
        this.executor = executor || null;
        this.config = { ...DEFAULT_DISPATCHER_CONFIG, ...config };
    }
    /**
     * 分发所有任务，按DAG依赖关系执行
     * @param tasks - 任务节点列表
     * @param config - 可选的运行时配置覆盖
     * @returns 所有任务的结果映射 (taskId → result)
     */
    async dispatch(tasks, config) {
        const runConfig = { ...this.config, ...config };
        const results = new Map();
        const taskMap = new Map();
        // 创建新的消息总线实例（每次 dispatch 独立）
        this.messageBus = new TaskMessageBus();
        for (const task of tasks) {
            taskMap.set(task.id, { ...task, status: 'pending' });
        }
        this.validateDAG(tasks);
        const layers = this.buildDAG(tasks);
        Logger_1.Logger.info(`📋 DAG 分层完成: ${layers.length} 层, ${tasks.length} 个任务`, 'TaskDispatcher');
        for (const layer of layers) {
            Logger_1.Logger.info(`🏗️ 执行第 ${layer.layer + 1} 层 (${layer.tasks.length} 个任务)`, 'TaskDispatcher');
            const batchSize = runConfig.maxConcurrentPerLayer;
            for (let offset = 0; offset < layer.tasks.length; offset += batchSize) {
                const batch = layer.tasks.slice(offset, offset + batchSize);
                if (offset > 0) {
                    Logger_1.Logger.debug(`  批次 ${Math.floor(offset / batchSize) + 1}: ${batch.length} 个任务`, 'TaskDispatcher');
                }
                const batchPromises = batch.map((task) => this.executeTaskWithRetry(taskMap.get(task.id), results, runConfig));
                const batchResults = await Promise.allSettled(batchPromises);
                for (let i = 0; i < batchResults.length; i++) {
                    const task = batch[i];
                    const settled = batchResults[i];
                    const node = taskMap.get(task.id);
                    if (settled.status === 'fulfilled') {
                        results.set(task.id, settled.value);
                    }
                    else {
                        node.status = 'failed';
                        node.error = settled.reason?.message || String(settled.reason);
                        results.set(task.id, { error: node.error });
                        Logger_1.Logger.error(`❌ 任务执行失败: ${task.id} (${task.goal})`, settled.reason, 'TaskDispatcher');
                    }
                }
            }
        }
        for (const task of tasks) {
            const updated = taskMap.get(task.id);
            if (updated) {
                task.status = updated.status;
                task.result = updated.result;
                task.error = updated.error;
                task.assignedTo = updated.assignedTo;
            }
        }
        Logger_1.Logger.info(`✅ DAG 执行完成: ${tasks.length} 个任务, ${results.size} 个结果`, 'TaskDispatcher');
        // 清理消息总线
        this.messageBus.clear();
        return results;
    }
    /**
     * 取消正在执行的任务
     * @param taskId - 任务ID
     */
    cancel(taskId) {
        const controller = this.activeControllers.get(taskId);
        if (controller) {
            controller.abort();
            this.activeControllers.delete(taskId);
            Logger_1.Logger.info(`🚫 任务已取消: ${taskId}`, 'TaskDispatcher');
        }
    }
    /**
     * 获取当前消息总线实例
     * @returns TaskMessageBus 实例
     */
    getMessageBus() {
        return this.messageBus;
    }
    /**
     * 带重试的任务执行
     */
    async executeTaskWithRetry(task, results, config) {
        let lastError = null;
        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
            if (task.status === 'cancelled') {
                throw new Error(`任务已取消: ${task.id}`);
            }
            try {
                return await this.executeTaskWithTimeout(task, results, config);
            }
            catch (err) {
                lastError = err;
                if (this.isRetryableError(err) &&
                    attempt < config.maxRetries) {
                    Logger_1.Logger.info(`🔄 任务重试 (${attempt + 1}/${config.maxRetries}): ${task.id}`, 'TaskDispatcher');
                    await this.delay(config.retryDelayMs * (attempt + 1));
                }
                else {
                    break;
                }
            }
        }
        throw lastError || new Error(`任务执行失败: ${task.id}`);
    }
    /**
     * 带超时的任务执行
     */
    async executeTaskWithTimeout(task, results, config) {
        const controller = new AbortController();
        this.activeControllers.set(task.id, controller);
        let timeoutTimer;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => {
                controller.abort();
                reject(new Error(`任务超时 (${config.taskTimeoutMs}ms): ${task.id}`));
            }, config.taskTimeoutMs);
            if (timeoutTimer.unref)
                timeoutTimer.unref();
        });
        try {
            const result = await Promise.race([
                this.executeTask(task, results),
                timeoutPromise,
            ]);
            clearTimeout(timeoutTimer);
            return result;
        }
        catch (err) {
            clearTimeout(timeoutTimer);
            throw err;
        }
        finally {
            this.activeControllers.delete(task.id);
        }
    }
    /**
     * 执行单个任务
     */
    async executeTask(task, results) {
        task.status = 'running';
        const agent = this.assignAgent(task);
        if (!agent) {
            task.status = 'failed';
            task.error = `无可用的 Agent 执行任务: ${task.id} (需要工具: ${(task.tools || []).join(', ') || '(不限)'})`;
            throw new Error(task.error);
        }
        task.assignedTo = agent.id;
        this.registry.updateStatus(agent.id, 'busy');
        const execStart = Date.now();
        Logger_1.Logger.info(`🎯 执行任务: ${task.id} | Agent: ${agent.name} | 目标: ${task.goal.substring(0, 60)}`, 'TaskDispatcher');
        try {
            const dependencyContext = this.buildDependencyContext(task, results);
            const result = this.executor
                ? await this.executor({
                    ...task,
                    context: task.context
                        ? `${task.context}\n依赖结果: ${JSON.stringify(dependencyContext)}`
                        : `依赖结果: ${JSON.stringify(dependencyContext)}`,
                })
                : await Promise.resolve({
                    taskId: task.id,
                    goal: task.goal,
                    context: task.context,
                    dependencyContext,
                    completedAt: Date.now(),
                });
            task.status = 'completed';
            task.result = result;
            const execDuration = Date.now() - execStart;
            this.registry.recordExecution(agent.id, true, execDuration);
            Logger_1.Logger.info(`✅ 任务完成: ${task.id} | Agent: ${agent.name}`, 'TaskDispatcher');
            return result;
        }
        catch (err) {
            task.status = 'failed';
            task.error = err.message;
            const execDuration = Date.now() - execStart;
            this.registry.recordExecution(agent.id, false, execDuration);
            throw err;
        }
        finally {
            this.registry.updateStatus(agent.id, 'idle');
        }
    }
    /**
     * 判断错误是否可重试
     */
    isRetryableError(error) {
        const retryablePatterns = [
            'timeout',
            'ETIMEDOUT',
            'ECONNRESET',
            'rate_limit',
            '503',
            '429',
            'ECONNREFUSED',
        ];
        const msg = error.message.toLowerCase();
        return retryablePatterns.some((p) => msg.includes(p.toLowerCase()));
    }
    /**
     * 延迟
     */
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * 构建DAG分层（拓扑排序）
     */
    buildDAG(tasks) {
        const taskIds = new Set(tasks.map((t) => t.id));
        const visited = new Set();
        const inDegree = new Map();
        const dependents = new Map();
        for (const task of tasks) {
            inDegree.set(task.id, 0);
            dependents.set(task.id, new Set());
        }
        for (const task of tasks) {
            for (const depId of task.dependencies) {
                if (!taskIds.has(depId)) {
                    Logger_1.Logger.warn(`依赖任务不存在: ${depId} (来自: ${task.id})`, 'TaskDispatcher');
                    continue;
                }
                inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
                const depSet = dependents.get(depId) || new Set();
                depSet.add(task.id);
                dependents.set(depId, depSet);
            }
        }
        const layers = [];
        let layerIndex = 0;
        let remaining = tasks.length;
        const currentLayer = new Set();
        for (const [taskId, degree] of inDegree) {
            if (degree === 0) {
                currentLayer.add(taskId);
            }
        }
        while (currentLayer.size > 0) {
            const layerTasks = [];
            const nextLayer = new Set();
            const sorted = Array.from(currentLayer)
                .map((id) => tasks.find((t) => t.id === id))
                .filter(Boolean)
                .sort((a, b) => b.priority - a.priority);
            for (const task of sorted) {
                layerTasks.push(task);
                visited.add(task.id);
                remaining--;
                const deps = dependents.get(task.id) || new Set();
                for (const dependentId of deps) {
                    const newDegree = (inDegree.get(dependentId) || 1) - 1;
                    inDegree.set(dependentId, newDegree);
                    if (newDegree === 0 && !visited.has(dependentId)) {
                        nextLayer.add(dependentId);
                    }
                }
            }
            layers.push({ layer: layerIndex, tasks: layerTasks });
            layerIndex++;
            currentLayer.clear();
            for (const id of nextLayer) {
                currentLayer.add(id);
            }
        }
        if (remaining > 0) {
            // P0 修复：检测到环时抛异常，而非仅 warning，避免死锁
            const cyclicTaskIds = tasks
                .filter((t) => !visited.has(t.id))
                .map((t) => t.id);
            const cycleError = new Error(`DAG_CYCLE_DETECTED: ${remaining} 个任务形成循环依赖: [${cyclicTaskIds.join(', ')}]`);
            Logger_1.Logger.error(`❌ DAG 存在环路: ${cycleError.message}`, cycleError, 'TaskDispatcher');
            throw cycleError;
        }
        return layers;
    }
    /**
     * 验证DAG合法性
     */
    validateDAG(tasks) {
        const taskIds = new Set();
        for (const task of tasks) {
            if (taskIds.has(task.id)) {
                throw new Error(`重复的任务ID: ${task.id}`);
            }
            taskIds.add(task.id);
            if (task.dependencies.includes(task.id)) {
                throw new Error(`任务自依赖: ${task.id}`);
            }
            if (task.priority < 1 || task.priority > 10) {
                throw new Error(`优先级超出范围 (1-10): ${task.id} → ${task.priority}`);
            }
        }
        const visited = new Set();
        const inStack = new Set();
        const taskMap = new Map(tasks.map((t) => [t.id, t]));
        const detectCycle = (id) => {
            if (inStack.has(id))
                return true;
            if (visited.has(id))
                return false;
            visited.add(id);
            inStack.add(id);
            const task = taskMap.get(id);
            if (task) {
                for (const dep of task.dependencies) {
                    if (taskMap.has(dep) && detectCycle(dep))
                        return true;
                }
            }
            inStack.delete(id);
            return false;
        };
        for (const task of tasks) {
            if (detectCycle(task.id)) {
                throw new Error(`DAG循环依赖: 涉及任务 ${task.id}`);
            }
        }
    }
    /**
     * 为任务分配Agent（使用findBestAgent优先）
     */
    assignAgent(task) {
        if (task.agentId) {
            const agent = this.registry.getAgent(task.agentId);
            if (!agent) {
                Logger_1.Logger.warn(`指定的 Agent 不存在: ${task.agentId}`, 'TaskDispatcher');
                return null;
            }
            if (agent.status !== 'idle') {
                Logger_1.Logger.warn(`指定的 Agent 不空闲: ${task.agentId} (${agent.status})`, 'TaskDispatcher');
                return null;
            }
            return agent;
        }
        if (task.tools && task.tools.length > 0) {
            for (const toolName of task.tools) {
                const agent = this.registry.findBestAgent(toolName) ||
                    this.registry.findAgentByCapability(toolName);
                if (agent)
                    return agent;
            }
            Logger_1.Logger.warn(`未找到具备任何所需工具的 Agent: ${task.tools.join(', ')}`, 'TaskDispatcher');
            return null;
        }
        const agents = this.registry.getIdleAgents();
        if (agents.length === 0) {
            Logger_1.Logger.warn('没有空闲的 Agent 可用', 'TaskDispatcher');
            return null;
        }
        return agents[0];
    }
    /**
     * 构建依赖上下文
     */
    buildDependencyContext(task, results) {
        const context = {};
        for (const depId of task.dependencies) {
            if (results.has(depId)) {
                context[depId] = results.get(depId);
            }
            else {
                Logger_1.Logger.warn(`依赖任务结果不存在: ${depId} (来自: ${task.id})`, 'TaskDispatcher');
            }
        }
        return context;
    }
}
exports.TaskDispatcher = TaskDispatcher;
