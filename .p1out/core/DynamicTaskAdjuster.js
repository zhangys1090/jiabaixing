"use strict";
/**
 * 动态任务调整模块
 * 根据任务执行过程中的实际情况动态调整任务计划
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamicTaskAdjuster = void 0;
const Logger_1 = __importDefault(require("../utils/Logger"));
class DynamicTaskAdjuster {
    constructor(config) {
        this.executionStates = new Map();
        this.adjustmentHistory = [];
        this.isMonitoring = false;
        this.monitoringConfig = {
            checkInterval: 5000, // 5秒检查一次
            progressThreshold: 10, // 进度低于10%触发调整
            timeThreshold: 10, // 超过预估时间10分钟触发调整
            errorThreshold: 3, // 错误3次触发调整
            resourceThreshold: {
                cpu: 80, // CPU使用率80%
                memory: 85, // 内存使用率85%
                io: 70, // IO使用率70%
            },
            ...config,
        };
    }
    /**
     * 开始监控任务执行
     */
    startMonitoring(taskIds) {
        if (this.isMonitoring)
            return;
        this.isMonitoring = true;
        Logger_1.default.info('动态任务调整器：开始监控任务执行', 'DynamicTaskAdjuster');
        // 初始化任务状态
        for (const taskId of taskIds) {
            if (!this.executionStates.has(taskId)) {
                this.executionStates.set(taskId, {
                    taskId,
                    status: 'pending',
                    progress: 0,
                    executionTime: 0,
                    errorCount: 0,
                    resourceUsage: { cpu: 0, memory: 0, io: 0 },
                });
            }
        }
        // 启动监控循环
        this.monitoringInterval = setInterval(() => {
            this.checkAndAdjust();
        }, this.monitoringConfig.checkInterval);
        if (this.monitoringInterval.unref)
            this.monitoringInterval.unref();
    }
    /**
     * 停止监控
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = undefined;
        }
        this.isMonitoring = false;
        Logger_1.default.info('动态任务调整器：停止监控', 'DynamicTaskAdjuster');
    }
    /**
     * 更新任务执行状态
     */
    updateTaskState(taskId, updates) {
        const currentState = this.executionStates.get(taskId);
        if (!currentState) {
            this.executionStates.set(taskId, {
                taskId,
                status: 'pending',
                progress: 0,
                executionTime: 0,
                errorCount: 0,
                resourceUsage: { cpu: 0, memory: 0, io: 0 },
                ...updates,
            });
        }
        else {
            Object.assign(currentState, updates);
            this.executionStates.set(taskId, currentState);
        }
    }
    /**
     * 检查并调整任务
     */
    checkAndAdjust() {
        for (const [taskId, state] of this.executionStates) {
            if (state.status === 'running') {
                const decision = this.evaluateTaskState(taskId, state);
                if (decision.type !== 'continue') {
                    this.executeAdjustment(decision);
                }
            }
        }
    }
    /**
     * 评估任务状态并做出调整决策
     */
    evaluateTaskState(taskId, state) {
        // 检查错误次数
        if (state.errorCount >= this.monitoringConfig.errorThreshold) {
            return {
                type: 'replan',
                reason: `任务${taskId}错误次数超过阈值(${state.errorCount}次)，需要重新规划`,
                affectedTasks: [taskId],
            };
        }
        // 检查执行时间
        if (state.startTime) {
            const elapsedMinutes = (Date.now() - state.startTime.getTime()) / (1000 * 60);
            if (elapsedMinutes > this.monitoringConfig.timeThreshold &&
                state.progress < 50) {
                return {
                    type: 'retry',
                    reason: `任务${taskId}执行时间过长(${elapsedMinutes.toFixed(1)}分钟)但进度较低(${state.progress}%)，需要重试`,
                    affectedTasks: [taskId],
                    parameters: { timeout: this.monitoringConfig.timeThreshold * 2 },
                };
            }
        }
        // 检查资源使用
        if (state.resourceUsage.cpu > this.monitoringConfig.resourceThreshold.cpu ||
            state.resourceUsage.memory >
                this.monitoringConfig.resourceThreshold.memory) {
            return {
                type: 'sequentialize',
                reason: `任务${taskId}资源使用过高(CPU: ${state.resourceUsage.cpu}%, 内存: ${state.resourceUsage.memory}%)，需要串行化执行`,
                affectedTasks: [taskId],
                parameters: { resourceLimit: 70 },
            };
        }
        // 检查进度
        if (state.progress < this.monitoringConfig.progressThreshold &&
            state.executionTime > 5) {
            return {
                type: 'retry',
                reason: `任务${taskId}进度缓慢(${state.progress}%)，需要重试`,
                affectedTasks: [taskId],
                parameters: { retryCount: state.errorCount + 1 },
            };
        }
        // 检查失败状态
        if (state.status === 'failed') {
            if (state.errorCount < 3) {
                return {
                    type: 'retry',
                    reason: `任务${taskId}执行失败，尝试重试(${state.errorCount + 1}/3)`,
                    affectedTasks: [taskId],
                    parameters: { retryCount: state.errorCount + 1 },
                };
            }
            else {
                return {
                    type: 'skip',
                    reason: `任务${taskId}多次失败，跳过该任务`,
                    affectedTasks: [taskId],
                };
            }
        }
        return {
            type: 'continue',
            reason: `任务${taskId}执行正常`,
            affectedTasks: [taskId],
        };
    }
    /**
     * 执行调整决策
     */
    executeAdjustment(decision) {
        Logger_1.default.info(`动态任务调整器：执行调整 - ${decision.type}`, 'DynamicTaskAdjuster');
        Logger_1.default.info(`   原因: ${decision.reason}`, 'DynamicTaskAdjuster');
        Logger_1.default.info(`   影响任务: ${decision.affectedTasks.join(', ')}`, 'DynamicTaskAdjuster');
        this.adjustmentHistory.push(decision);
        switch (decision.type) {
            case 'retry':
                this.handleRetry(decision);
                break;
            case 'skip':
                this.handleSkip(decision);
                break;
            case 'replan':
                this.handleReplan(decision);
                break;
            case 'parallelize':
                this.handleParallelize(decision);
                break;
            case 'sequentialize':
                this.handleSequentialize(decision);
                break;
            case 'abort':
                this.handleAbort(decision);
                break;
        }
    }
    handleRetry(decision) {
        for (const taskId of decision.affectedTasks) {
            const state = this.executionStates.get(taskId);
            if (state) {
                state.status = 'retrying';
                state.errorCount++;
                state.progress = 0;
                state.startTime = new Date();
                this.executionStates.set(taskId, state);
                Logger_1.default.info(`   重试任务: ${taskId} (第${state.errorCount}次)`, 'DynamicTaskAdjuster');
            }
        }
    }
    handleSkip(decision) {
        for (const taskId of decision.affectedTasks) {
            const state = this.executionStates.get(taskId);
            if (state) {
                state.status = 'skipped';
                state.progress = 0;
                state.endTime = new Date();
                this.executionStates.set(taskId, state);
                Logger_1.default.info(`   跳过任务: ${taskId}`, 'DynamicTaskAdjuster');
            }
        }
    }
    handleReplan(decision) {
        Logger_1.default.info(`   重新规划任务: ${decision.affectedTasks.join(', ')}`, 'DynamicTaskAdjuster');
        // 实际应用中这里应该调用任务重新规划逻辑
        for (const taskId of decision.affectedTasks) {
            const state = this.executionStates.get(taskId);
            if (state) {
                state.status = 'pending';
                state.progress = 0;
                state.errorCount = 0;
                this.executionStates.set(taskId, state);
            }
        }
    }
    handleParallelize(decision) {
        Logger_1.default.info(`   并行化任务: ${decision.affectedTasks.join(', ')}`, 'DynamicTaskAdjuster');
        // 实际应用中这里应该调整任务执行策略为并行
    }
    handleSequentialize(decision) {
        Logger_1.default.info(`   串行化任务: ${decision.affectedTasks.join(', ')}`, 'DynamicTaskAdjuster');
        // 实际应用中这里应该调整任务执行策略为串行
    }
    handleAbort(decision) {
        Logger_1.default.info(`   中止任务: ${decision.affectedTasks.join(', ')}`, 'DynamicTaskAdjuster');
        for (const taskId of decision.affectedTasks) {
            const state = this.executionStates.get(taskId);
            if (state) {
                state.status = 'failed';
                state.endTime = new Date();
                this.executionStates.set(taskId, state);
            }
        }
    }
    /**
     * 动态调整任务计划
     */
    adjustTaskPlan(currentPlan, executionStates) {
        const adjustedSubTasks = [];
        for (const subTask of currentPlan.subTasks) {
            const state = executionStates.get(subTask.id);
            if (!state || state.status === 'pending') {
                // 未开始的任务，保持原计划
                adjustedSubTasks.push(subTask);
            }
            else if (state.status === 'running') {
                const adjustedTask = { ...subTask };
                if (state.progress > 0) {
                    const remainingProgress = 1 - state.progress;
                    const timePerProgress = subTask.estimatedTime / state.progress;
                    adjustedTask.estimatedTime = Math.ceil(remainingProgress * timePerProgress);
                }
                adjustedSubTasks.push(adjustedTask);
            }
            else if (state.status === 'completed') {
                // 已完成的任务，记录实际执行时间
                const adjustedTask = { ...subTask };
                adjustedTask.estimatedTime = state.executionTime;
                adjustedSubTasks.push(adjustedTask);
            }
            else if (state.status === 'failed' || state.status === 'skipped') {
                // 失败或跳过的任务，标记为可选
                const adjustedTask = { ...subTask };
                adjustedTask.canParallel = true;
                adjustedSubTasks.push(adjustedTask);
            }
        }
        // 重新计算并行组和关键路径
        const parallelGroups = this.recalculateParallelGroups(adjustedSubTasks);
        const criticalPath = this.recalculateCriticalPath(adjustedSubTasks);
        return {
            mainTask: currentPlan.mainTask,
            subTasks: adjustedSubTasks,
            totalEstimatedTime: adjustedSubTasks.reduce((sum, st) => sum + st.estimatedTime, 0),
            parallelGroups,
            criticalPath,
        };
    }
    recalculateParallelGroups(subTasks) {
        const groups = [];
        const processed = new Set();
        for (const task of subTasks) {
            if (processed.has(task.id))
                continue;
            const parallelGroup = subTasks
                .filter((t) => t.canParallel &&
                !processed.has(t.id) &&
                !t.dependencies.some((dep) => subTasks.find((st) => st.id === dep)?.dependencies.includes(t.id)))
                .map((t) => t.id);
            if (parallelGroup.length > 1) {
                groups.push(parallelGroup);
                parallelGroup.forEach((id) => processed.add(id));
            }
        }
        return groups;
    }
    recalculateCriticalPath(subTasks) {
        const path = [];
        const visited = new Set();
        const startTasks = subTasks.filter((t) => t.dependencies.length === 0);
        for (const startTask of startTasks) {
            this.dfsCriticalPath(startTask, subTasks, path, visited);
        }
        return path;
    }
    dfsCriticalPath(currentTask, allTasks, path, visited) {
        if (visited.has(currentTask.id))
            return;
        visited.add(currentTask.id);
        path.push(currentTask.id);
        const dependentTasks = allTasks.filter((t) => t.dependencies.includes(currentTask.id));
        const nextTask = dependentTasks.sort((a, b) => b.estimatedTime - a.estimatedTime)[0];
        if (nextTask) {
            this.dfsCriticalPath(nextTask, allTasks, path, visited);
        }
    }
    /**
     * P1集成：为DAG任务的重试循环提供动态调整
     * 在任务失败时调整节点的超时时间、重试策略等
     */
    adjustForRetry(taskGraph, failedNodeIds, retryCount, maxRetryRounds) {
        const adjustedNodes = [];
        for (const nodeId of failedNodeIds) {
            const node = taskGraph.getNode(nodeId);
            if (!node)
                continue;
            // 更新执行状态
            this.updateTaskState(nodeId, {
                status: 'retrying',
                errorCount: retryCount,
                executionTime: Date.now(),
                progress: 0,
            });
            // 评估任务状态并做出调整决策
            const state = this.executionStates.get(nodeId);
            if (state) {
                const decision = this.evaluateTaskState(nodeId, state);
                if (decision.parameters?.timeout) {
                    node.timeout = decision.parameters.timeout;
                    adjustedNodes.push(nodeId);
                    Logger_1.default.info(`  🔧 调整任务 [${nodeId}] 超时时间: ${node.timeout}ms`, 'DynamicTaskAdjuster');
                }
                if (decision.parameters?.retryCount !== undefined) {
                    node.maxRetries = Math.min(node.maxRetries + 1, maxRetryRounds);
                    adjustedNodes.push(nodeId);
                    Logger_1.default.info(`  🔧 调整任务 [${nodeId}] 重试次数: ${node.maxRetries}`, 'DynamicTaskAdjuster');
                }
                if (decision.type === 'skip') {
                    taskGraph.markTaskSkipped(nodeId);
                    Logger_1.default.info(`  ⏭️ 跳过任务 [${nodeId}]: ${decision.reason}`, 'DynamicTaskAdjuster');
                }
            }
        }
        if (adjustedNodes.length > 0) {
            Logger_1.default.info(`📊 动态任务调整完成: ${adjustedNodes.length}/${failedNodeIds.length} 个节点已调整`, 'DynamicTaskAdjuster');
        }
        return adjustedNodes;
    }
    /**
     * 获取执行统计信息
     */
    getExecutionStatistics() {
        const states = Array.from(this.executionStates.values());
        return {
            totalTasks: states.length,
            completedTasks: states.filter((s) => s.status === 'completed').length,
            failedTasks: states.filter((s) => s.status === 'failed').length,
            averageProgress: states.reduce((sum, s) => sum + s.progress, 0) / states.length || 0,
            totalExecutionTime: states.reduce((sum, s) => sum + s.executionTime, 0),
            adjustmentCount: this.adjustmentHistory.length,
        };
    }
    /**
     * 获取调整历史
     */
    getAdjustmentHistory() {
        return [...this.adjustmentHistory];
    }
    /**
     * 重置所有状态
     */
    reset() {
        this.stopMonitoring();
        this.executionStates.clear();
        this.adjustmentHistory = [];
    }
}
exports.DynamicTaskAdjuster = DynamicTaskAdjuster;
exports.default = DynamicTaskAdjuster;
