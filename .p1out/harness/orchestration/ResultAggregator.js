"use strict";
/**
 * Harness Phase 10: 多Agent编排 — 结果聚合器
 *
 * 合并多个Agent的执行结果，生成结构化摘要报告。
 * 提供成功/失败统计、执行时长、详细追踪等维度。
 * P10增强：LLM摘要生成、冲突检测
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResultAggregator = void 0;
const Logger_1 = require("../../utils/Logger");
class ResultAggregator {
    constructor(llm) {
        this.llm = llm;
    }
    /**
     * 聚合所有Agent的执行结果
     */
    aggregate(agentResults, taskNodes) {
        const startTime = Date.now();
        const details = new Map();
        let completedCount = 0;
        let failedCount = 0;
        const failedTasks = [];
        const taskMap = new Map();
        for (const task of taskNodes) {
            taskMap.set(task.id, task);
        }
        for (const task of taskNodes) {
            const detail = {
                taskId: task.id,
                status: 'failed',
            };
            if (task.status === 'completed' && agentResults.has(task.id)) {
                detail.status = 'completed';
                detail.result = agentResults.get(task.id);
                completedCount++;
            }
            else if (task.status === 'failed') {
                detail.status = 'failed';
                detail.error = task.error || '未知错误';
                failedCount++;
                failedTasks.push(task.id);
            }
            else {
                detail.status = 'failed';
                detail.error = `任务未完成 (状态: ${task.status})`;
                failedCount++;
                failedTasks.push(task.id);
            }
            details.set(task.id, detail);
        }
        const success = failedCount === 0;
        const duration = Date.now() - startTime;
        const conflicts = this.detectConflicts(agentResults, taskNodes);
        const summary = this.buildSummary(success, taskNodes.length, completedCount, failedCount, failedTasks, duration);
        Logger_1.Logger.info(`📊 结果聚合: ${completedCount}/${taskNodes.length} 成功 | 耗时 ${duration}ms | 冲突 ${conflicts.length}`, 'ResultAggregator');
        return {
            success,
            summary,
            details,
            totalTasks: taskNodes.length,
            completedTasks: completedCount,
            failedTasks: failedCount,
            duration,
            conflicts,
        };
    }
    /**
     * 聚合并生成LLM自然语言摘要
     */
    async aggregateWithSummary(agentResults, taskNodes) {
        const result = this.aggregate(agentResults, taskNodes);
        if (this.llm && result.totalTasks > 0) {
            try {
                const taskSummaries = taskNodes
                    .map((t) => `- ${t.id}: ${t.status} | 目标: ${t.goal.substring(0, 80)}`)
                    .join('\n');
                const prompt = `请用简洁的中文总结以下多Agent编排执行结果：

总任务数: ${result.totalTasks}
成功: ${result.completedTasks}
失败: ${result.failedTasks}
冲突: ${result.conflicts?.length || 0}

任务详情:
${taskSummaries}

请生成一段100字以内的执行摘要。`;
                result.llmSummary = await this.llm.chat(prompt);
            }
            catch (err) {
                Logger_1.Logger.debug(`LLM摘要生成失败: ${err.message}`, 'ResultAggregator');
            }
        }
        return result;
    }
    /**
     * 检测不同Agent结果之间的冲突
     */
    detectConflicts(agentResults, taskNodes) {
        const conflicts = [];
        const fileWriteMap = new Map();
        const goalMap = new Map();
        for (const task of taskNodes) {
            if (task.status !== 'completed')
                continue;
            const result = agentResults.get(task.id);
            if (!result || typeof result !== 'object')
                continue;
            const resultObj = result;
            const filePath = resultObj.filePath || resultObj.path || resultObj.file_path;
            if (typeof filePath === 'string') {
                if (!fileWriteMap.has(filePath)) {
                    fileWriteMap.set(filePath, []);
                }
                fileWriteMap.get(filePath).push(task.id);
            }
            if (task.goal) {
                if (!goalMap.has(task.goal)) {
                    goalMap.set(task.goal, []);
                }
                goalMap.get(task.goal).push(task.id);
            }
        }
        for (const [filePath, taskIds] of fileWriteMap) {
            if (taskIds.length > 1) {
                conflicts.push({
                    type: 'file_write',
                    description: `多个Agent写入同一文件: ${filePath}`,
                    involvedTasks: taskIds,
                    severity: 'high',
                });
            }
        }
        for (const [goal, taskIds] of goalMap) {
            if (taskIds.length > 1) {
                conflicts.push({
                    type: 'goal_overlap',
                    description: `多个Agent执行相同目标: ${goal}`,
                    involvedTasks: taskIds,
                    severity: 'medium',
                });
            }
        }
        return conflicts;
    }
    /**
     * 使用 LLM 仲裁解决结果冲突
     * @param conflicts - 待解决的冲突列表
     * @param llm - LLM 接口
     * @returns 仲裁结果列表
     */
    async resolveConflictsWithLLM(conflicts, llm) {
        const resolutions = [];
        for (const conflict of conflicts) {
            const prompt = `请仲裁以下任务结果冲突，选择最佳结果：

冲突类型: ${conflict.type}
冲突描述: ${conflict.description}
涉及任务: ${conflict.involvedTasks.join(', ')}

请以 JSON 格式返回仲裁结果，包含 winnerTaskId（获胜任务ID）和 reasoning（仲裁理由）。`;
            try {
                const response = await llm.chat(prompt);
                const parsed = JSON.parse(response);
                resolutions.push({
                    conflict,
                    winnerTaskId: parsed.winnerTaskId,
                    resolution: `${parsed.winnerTaskId}: ${parsed.reasoning || ''}`,
                });
            }
            catch (err) {
                Logger_1.Logger.warn(`LLM 仲裁失败: ${err.message}`, 'ResultAggregator');
                resolutions.push({
                    conflict,
                    winnerTaskId: conflict.involvedTasks[0],
                    resolution: `默认选择第一个任务: ${conflict.involvedTasks[0]}`,
                });
            }
        }
        return resolutions;
    }
    /**
     * 置信度加权合并 — 选择最高置信度的结果
     * @param results - 带置信度的结果列表
     * @returns 合并后的共识结果
     */
    mergeWithConsensus(results) {
        if (results.length === 0) {
            return {
                selectedTaskId: '',
                result: null,
                averageConfidence: 0,
                selectedAgentId: '',
            };
        }
        const sorted = [...results].sort((a, b) => b.confidence - a.confidence);
        const winner = sorted[0];
        const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;
        return {
            selectedTaskId: winner.taskId,
            result: winner.result,
            averageConfidence: avgConfidence,
            selectedAgentId: winner.agentId,
        };
    }
    /**
     * 构建可读的摘要文本
     */
    buildSummary(success, total, completed, failed, failedTaskIds, duration) {
        const lines = [];
        const statusEmoji = success ? '✅' : '⚠️';
        const statusText = success ? '全部任务执行成功' : '部分任务执行失败';
        lines.push(`${statusEmoji} 多Agent编排: ${statusText}`);
        lines.push(`   总任务数: ${total}`);
        lines.push(`   成功: ${completed}`);
        lines.push(`   失败: ${failed}`);
        lines.push(`   总耗时: ${duration}ms`);
        if (!success && failedTaskIds.length > 0) {
            lines.push(`   失败任务: ${failedTaskIds.join(', ')}`);
        }
        return lines.join('\n');
    }
    /**
     * 快速检查结果是否全部成功
     */
    static isAllSuccessful(result) {
        return result.success;
    }
    /**
     * 提取所有失败任务的详细信息
     */
    static getFailedDetails(result) {
        const failed = [];
        for (const detail of result.details.values()) {
            if (detail.status === 'failed') {
                failed.push(detail);
            }
        }
        return failed;
    }
}
exports.ResultAggregator = ResultAggregator;
