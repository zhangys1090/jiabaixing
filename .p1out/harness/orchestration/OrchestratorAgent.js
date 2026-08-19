"use strict";
/**
 * Harness Phase 10: 多Agent编排 — 顶层协调Agent
 *
 * OrchestratorAgent 是用户目标和多Agent编排之间的桥梁：
 * 1. 接收用户目标
 * 2. 分析复杂度 → 简单任务直通 / 复杂任务拆解
 * 3. 调用 LLM 将目标拆解为 DAG TaskNode[]
 * 4. 通过 SubAgentFanout 扇出执行
 * 5. 通过 ResultAggregator 聚合结果
 * 6. 返回最终聚合报告
 *
 * P10增强：复杂度分析集成、Sub-Agent扇出、降级处理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrchestratorAgent = void 0;
const TaskComplexityAnalyzer_1 = require("../../core/TaskComplexityAnalyzer");
const EvolutionOrchestrator_1 = require("../../evolution/EvolutionOrchestrator");
const bridgeRegistry_1 = require("../../ide/bridgeRegistry");
const Logger_1 = require("../../utils/Logger");
const AgentFactory_1 = require("../agents/AgentFactory");
const QualityScorer_1 = require("../evaluation/QualityScorer");
const StepEvaluator_1 = require("../evaluation/StepEvaluator");
const ResultAggregator_1 = require("./ResultAggregator");
const SubAgentFanout_1 = require("./SubAgentFanout");
const TaskDispatcher_1 = require("./TaskDispatcher");
const DEFAULT_ORCHESTRATOR_CONFIG = {
    enableMultiAgent: true,
    complexityThreshold: 'complex',
    maxSubAgents: 5,
};
const COMPLEXITY_ORDER = {
    simple: 0,
    medium: 1,
    complex: 2,
    very_complex: 3,
};
class OrchestratorAgent {
    constructor(deps) {
        this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...deps.config };
        this.registry = deps.registry;
        this.dispatcher = new TaskDispatcher_1.TaskDispatcher(deps.registry, deps.executor);
        this.aggregator = new ResultAggregator_1.ResultAggregator();
        this.fanout = new SubAgentFanout_1.SubAgentFanout(deps.registry, deps.executor, this.config.fanoutConfig);
        this.llm = deps.llm;
        this.chatLLM = deps.chatLLM;
        this.qualityScorer = new QualityScorer_1.QualityScorer();
        this.stepEvaluator = new StepEvaluator_1.StepEvaluator();
        this.complexityAnalyzer = new TaskComplexityAnalyzer_1.TaskComplexityAnalyzer();
    }
    /**
     * 处理用户目标 — 复杂度分析 → 拆解 → 扇出 → 聚合
     *
     * P10增强：
     * - 简单任务直通单Agent路径
     * - 复杂任务走多Agent编排路径
     * - LLM不可用时降级到TaskComplexityAnalyzer拆解
     */
    async processGoal(userGoal, context) {
        const startTime = Date.now();
        Logger_1.Logger.info(`🎯 OrchestratorAgent 处理目标: ${userGoal.substring(0, 80)}`, 'OrchestratorAgent');
        try {
            // Step 0: 复杂度分析
            const complexityResult = this.complexityAnalyzer.analyzeComplexity(userGoal);
            Logger_1.Logger.info(`📊 复杂度分析: ${complexityResult.complexity} | 预估步骤=${complexityResult.estimatedSteps} | 可并行=${complexityResult.parallelizable}`, 'OrchestratorAgent');
            // 简单任务直通
            if (!this.config.enableMultiAgent ||
                !this.shouldUseMultiAgent(complexityResult.complexity)) {
                Logger_1.Logger.info('⚡ 简单任务，走单Agent直通路径', 'OrchestratorAgent');
                return this.processSimpleGoal(userGoal, context, startTime);
            }
            // Step 1: 调用LLM拆解目标为DAG任务
            Logger_1.Logger.info('🧠 正在拆解用户目标...', 'OrchestratorAgent');
            let tasks;
            try {
                tasks = await this.llm.decomposeGoal(userGoal, context);
            }
            catch (llmError) {
                Logger_1.Logger.warn(`⚠️ LLM拆解失败，降级到TaskComplexityAnalyzer: ${llmError.message}`, 'OrchestratorAgent');
                tasks = this.decomposeWithAnalyzer(userGoal);
            }
            if (!tasks || tasks.length === 0) {
                Logger_1.Logger.warn('⚠️ LLM拆解和Analyzer降级均未生成任务，尝试单任务直通', 'OrchestratorAgent');
                return this.processSimpleGoal(userGoal, context, startTime);
            }
            Logger_1.Logger.info(`📋 目标拆解完成: ${tasks.length} 个任务`, 'OrchestratorAgent');
            // 动态角色分配
            let roleAssignments = [];
            try {
                roleAssignments = await this.assignDynamicRoles(tasks);
                if (roleAssignments.length > 0) {
                    Logger_1.Logger.info(`🎭 动态角色分配完成: ${roleAssignments.length}/${tasks.length} 个任务已分配角色`, 'OrchestratorAgent');
                    for (const assignment of roleAssignments) {
                        Logger_1.Logger.debug(`  → 任务 ${assignment.taskId} → Agent ${assignment.agentId} (角色: ${assignment.role})`, 'OrchestratorAgent');
                    }
                    // P0-4: 动态角色分配实际应用到执行路径 — 将角色分配写入任务的 assignedTo 字段
                    this._applyRoleAssignmentsToTasks(tasks, roleAssignments);
                }
            }
            catch (roleError) {
                Logger_1.Logger.warn(`⚠️ 动态角色分配失败（不影响执行）: ${roleError.message}`, 'OrchestratorAgent');
            }
            // Step 2: 判断是否需要扇出执行
            if (tasks.length > 1 && complexityResult.parallelizable) {
                Logger_1.Logger.info(`🔀 使用 Sub-Agent 扇出执行 (${tasks.length} 个子任务)`, 'OrchestratorAgent');
                const fanoutResult = await this.fanout.fanout(`parent_${Date.now()}`, tasks, { maxFanout: this.config.maxSubAgents });
                const results = new Map();
                for (const sub of fanoutResult.subResults) {
                    results.set(sub.taskId, sub.success ? sub.result : { error: sub.error });
                }
                const aggregated = this.aggregator.aggregate(results, tasks);
                // 置信度合并
                this.mergeResultsWithConsensus(results, tasks);
                const finalResult = {
                    ...aggregated,
                    duration: Date.now() - startTime,
                    summary: fanoutResult.allSucceeded
                        ? `✅ 目标完成(扇出): ${userGoal.substring(0, 60)}`
                        : `⚠️ 目标部分完成(扇出): ${userGoal.substring(0, 60)} (${fanoutResult.failedCount} 个子任务失败)`,
                };
                // 冲突仲裁（在 finalResult 创建后调用，确保仲裁文本附加到最终摘要）
                await this.resolveConflictsIfAny(finalResult);
                const qualityScore = this.evaluateExecution(tasks, finalResult, userGoal, finalResult.duration);
                finalResult.qualityScore = qualityScore;
                this.recordToEvolution(userGoal, finalResult, finalResult.duration);
                return finalResult;
            }
            // Step 3: DAG分发执行（有依赖关系的任务）
            Logger_1.Logger.info('🚀 使用 DAG 分发执行...', 'OrchestratorAgent');
            const results = await this.dispatcher.dispatch(tasks);
            // 失败任务重平衡
            const failedTasks = tasks.filter((t) => t.status === 'failed');
            if (failedTasks.length > 0) {
                Logger_1.Logger.info(`🔄 检测到 ${failedTasks.length} 个失败任务，尝试重平衡...`, 'OrchestratorAgent');
                try {
                    const roleAssignments = await this.assignDynamicRoles(tasks);
                    const rebalanced = await this.rebalanceRoles(tasks, roleAssignments);
                    const rebalancedCount = rebalanced.filter((r, i) => r.agentId !== roleAssignments[i]?.agentId).length;
                    if (rebalancedCount > 0) {
                        Logger_1.Logger.info(`🔄 重平衡: ${rebalancedCount} 个任务已重新分配`, 'OrchestratorAgent');
                    }
                }
                catch (rebalanceError) {
                    Logger_1.Logger.warn(`⚠️ 重平衡失败（不影响结果）: ${rebalanceError.message}`, 'OrchestratorAgent');
                }
            }
            // Step 4: 聚合结果
            Logger_1.Logger.info('📊 聚合执行结果...', 'OrchestratorAgent');
            const aggregated = this.aggregator.aggregate(results, tasks);
            const actualDuration = Date.now() - startTime;
            const finalResult = {
                ...aggregated,
                duration: actualDuration,
                summary: aggregated.success
                    ? `✅ 目标完成: ${userGoal.substring(0, 60)}`
                    : `⚠️ 目标部分完成: ${userGoal.substring(0, 60)}`,
            };
            // 冲突仲裁（在 finalResult 创建后调用，确保仲裁文本附加到最终摘要）
            await this.resolveConflictsIfAny(finalResult);
            const qualityScore = this.evaluateExecution(tasks, finalResult, userGoal, actualDuration);
            finalResult.qualityScore = qualityScore;
            this.recordToEvolution(userGoal, finalResult, actualDuration);
            Logger_1.Logger.info(`🏁 OrchestratorAgent 完成 | 耗时=${actualDuration}ms | 成功=${finalResult.completedTasks}/${finalResult.totalTasks} | 质量=${qualityScore.overall}`, 'OrchestratorAgent');
            return finalResult;
        }
        catch (err) {
            const errorMsg = err.message || String(err);
            Logger_1.Logger.error('OrchestratorAgent 处理失败', err, 'OrchestratorAgent');
            return {
                success: false,
                summary: `❌ OrchestratorAgent 处理失败: ${errorMsg}`,
                details: new Map(),
                totalTasks: 0,
                completedTasks: 0,
                failedTasks: 0,
                duration: Date.now() - startTime,
            };
        }
    }
    /**
     * 简单任务直通处理
     */
    async processSimpleGoal(userGoal, context, startTime) {
        // 尝试选择专业化 Agent 执行
        try {
            const agent = AgentFactory_1.AgentFactory.selectAgentByGoal(userGoal);
            if (agent && agent.isReady) {
                Logger_1.Logger.info(`🤖 使用专业化 Agent: ${agent.name} 执行简单任务`, 'OrchestratorAgent');
                const agentResult = await agent.execute(userGoal, context || '');
                const duration = Date.now() - startTime;
                return {
                    success: true,
                    summary: `✅ 任务完成(Agent): ${userGoal.substring(0, 60)}`,
                    details: new Map([
                        [
                            'agent',
                            {
                                taskId: 'agent',
                                status: 'completed',
                                result: agentResult,
                            },
                        ],
                    ]),
                    totalTasks: 1,
                    completedTasks: 1,
                    failedTasks: 0,
                    duration,
                };
            }
        }
        catch (agentError) {
            Logger_1.Logger.warn(`⚠️ 专业化 Agent 执行失败，降级到通用执行器: ${agentError.message}`, 'OrchestratorAgent');
        }
        // 降级：通用执行器
        const singleTask = {
            id: `simple_${Date.now()}`,
            goal: userGoal,
            context: context || '',
            dependencies: [],
            priority: 5,
            status: 'pending',
        };
        const results = await this.dispatcher.dispatch([singleTask]);
        const aggregated = this.aggregator.aggregate(results, [singleTask]);
        const duration = Date.now() - startTime;
        return {
            ...aggregated,
            duration,
            summary: aggregated.success
                ? `✅ 任务完成: ${userGoal.substring(0, 60)}`
                : `❌ 任务失败: ${userGoal.substring(0, 60)}`,
        };
    }
    /**
     * 使用TaskComplexityAnalyzer降级拆解
     */
    decomposeWithAnalyzer(userGoal) {
        const decomposition = this.complexityAnalyzer.decomposeTask(userGoal);
        return decomposition.subTasks.map((sub, index) => ({
            id: sub.id,
            goal: sub.description,
            context: `子任务 ${index + 1}/${decomposition.subTasks.length}`,
            dependencies: sub.dependencies,
            priority: sub.complexity === 'very_complex'
                ? 8
                : sub.complexity === 'complex'
                    ? 6
                    : 4,
            tools: sub.tools,
            status: 'pending',
        }));
    }
    /**
     * 判断是否需要多Agent编排
     */
    shouldUseMultiAgent(complexity) {
        const threshold = COMPLEXITY_ORDER[this.config.complexityThreshold] ?? 2;
        const current = COMPLEXITY_ORDER[complexity] ?? 0;
        return current >= threshold;
    }
    /**
     * 获取底层的 TaskDispatcher
     */
    getDispatcher() {
        return this.dispatcher;
    }
    /**
     * 获取底层的 ResultAggregator
     */
    getAggregator() {
        return this.aggregator;
    }
    /**
     * 获取 SubAgentFanout
     */
    getFanout() {
        return this.fanout;
    }
    /**
     * 获取 Chat LLM 接口（用于冲突仲裁）
     * 优先使用显式传入的 chatLLM，否则检查 llm 是否也实现了 chat 方法
     * @returns Chat LLM 接口，不可用时返回 null
     */
    getChatLLM() {
        if (this.chatLLM)
            return this.chatLLM;
        // 鸭子类型检查：llm 是否也实现了 chat 方法
        const llm = this.llm;
        if (typeof llm.chat === 'function') {
            const chatFn = llm.chat;
            return { chat: chatFn };
        }
        return null;
    }
    /**
     * 冲突仲裁 — 当聚合结果检测到冲突时，使用 LLM 仲裁
     * @param aggregated - 聚合结果
     */
    async resolveConflictsIfAny(aggregated) {
        if (!aggregated.conflicts || aggregated.conflicts.length === 0)
            return;
        Logger_1.Logger.warn(`⚠️ 检测到 ${aggregated.conflicts.length} 个结果冲突，启动 LLM 仲裁...`, 'OrchestratorAgent');
        try {
            const chatLLM = this.getChatLLM();
            if (!chatLLM) {
                Logger_1.Logger.debug('Chat LLM 不可用，跳过冲突仲裁', 'OrchestratorAgent');
                return;
            }
            const resolutions = await this.aggregator.resolveConflictsWithLLM(aggregated.conflicts, chatLLM);
            for (const res of resolutions) {
                Logger_1.Logger.info(`🔧 冲突仲裁: ${res.conflict.description} → 获胜: ${res.winnerTaskId}`, 'OrchestratorAgent');
            }
            aggregated.summary += `\n🔧 已仲裁 ${resolutions.length} 个冲突`;
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 冲突仲裁失败: ${err.message}`, 'OrchestratorAgent');
        }
    }
    /**
     * 置信度合并 — 当多个结果包含置信度时，选择最高置信度结果
     * @param results - 任务结果映射
     * @param tasks - 任务节点列表
     */
    mergeResultsWithConsensus(results, tasks) {
        const resultsWithConfidence = [];
        for (const [taskId, result] of results) {
            if (result && typeof result === 'object' && 'confidence' in result) {
                const confidence = result.confidence;
                if (typeof confidence === 'number') {
                    resultsWithConfidence.push({
                        taskId,
                        result,
                        confidence,
                        agentId: tasks.find((t) => t.id === taskId)?.assignedTo || 'unknown',
                    });
                }
            }
        }
        if (resultsWithConfidence.length > 1) {
            const consensus = this.aggregator.mergeWithConsensus(resultsWithConfidence);
            Logger_1.Logger.info(`📊 置信度合并: 选择任务 ${consensus.selectedTaskId} (平均置信度: ${consensus.averageConfidence.toFixed(2)})`, 'OrchestratorAgent');
        }
    }
    /**
     * 动态角色分配 — 根据任务需求和能力匹配为 Agent 分配角色
     * @param tasks - 待分配的任务列表
     * @returns 角色分配结果
     */
    async assignDynamicRoles(tasks) {
        const assignments = [];
        for (const task of tasks) {
            const requiredTools = task.tools || [];
            if (requiredTools.length === 0)
                continue;
            const bestAgent = this.registry.findBestAgent(requiredTools[0]);
            if (!bestAgent)
                continue;
            const matchingCap = bestAgent.capabilities.find((c) => requiredTools.some((t) => c.tools.includes(t)));
            const role = this.inferRoleFromCapability(matchingCap?.name || 'execution');
            assignments.push({
                agentId: bestAgent.id,
                role,
                taskId: task.id,
                capability: matchingCap?.name || 'execution',
            });
        }
        return assignments;
    }
    /**
     * 重新平衡角色分配 — 过载 Agent 的任务转移给空闲 Agent
     * @param tasks - 任务列表
     * @param previousAssignments - 之前的分配结果
     * @returns 重新平衡后的分配结果
     */
    async rebalanceRoles(tasks, previousAssignments) {
        const rebalanced = [];
        for (const assignment of previousAssignments) {
            const agentInfo = this.registry.getAgent(assignment.agentId);
            if (agentInfo && agentInfo.status === 'busy') {
                const task = tasks.find((t) => t.id === assignment.taskId);
                const requiredTools = task?.tools || [];
                if (requiredTools.length > 0) {
                    const altAgent = this.registry.findBestAgent(requiredTools[0]);
                    if (altAgent && altAgent.id !== assignment.agentId) {
                        rebalanced.push({ ...assignment, agentId: altAgent.id });
                        continue;
                    }
                }
            }
            rebalanced.push(assignment);
        }
        return rebalanced;
    }
    /**
     * 根据能力名称推断角色
     * @param capabilityName - 能力名称
     * @returns 角色名称
     */
    inferRoleFromCapability(capabilityName) {
        const roleMap = {
            coding: 'developer',
            file_operation: 'file_manager',
            desktop_automation: 'desktop_agent',
            web_search: 'researcher',
            research: 'researcher',
            analysis: 'analyst',
        };
        return roleMap[capabilityName] || 'executor';
    }

    /**
     * P0-4: 将动态角色分配结果实际应用到任务的 assignedTo 字段
     *
     * 之前 assignDynamicRoles() 的结果仅被日志记录，从未写入任务对象，
     * 导致 TaskDispatcher/SubAgentFanout 执行时仍走 AgentFactory.selectAgentByGoal()
     * 的默认选择路径。此方法将角色分配写入 task.assignedTo，使编排层
     * 在分发/扇出时能感知到角色分配结果。
     *
     * @param tasks - 任务列表
     * @param assignments - 角色分配结果
     */
    _applyRoleAssignmentsToTasks(tasks, assignments) {
        const assignmentMap = new Map();
        for (const a of assignments) {
            assignmentMap.set(a.taskId, a);
        }
        let appliedCount = 0;
        for (const task of tasks) {
            const assignment = assignmentMap.get(task.id);
            if (assignment && assignment.agentId) {
                task.assignedTo = assignment.agentId;
                task.assignedRole = assignment.role;
                appliedCount++;
            }
        }
        Logger_1.Logger.info(`🔗 P0-4: 动态角色分配已应用到 ${appliedCount}/${tasks.length} 个任务的 assignedTo 字段`, 'OrchestratorAgent');
    }
    /**
     * 自动评估执行结果 — 五维质量评分
     */
    evaluateExecution(tasks, result, userGoal, duration) {
        const stepParams = tasks.map((task) => ({
            stepId: task.id,
            toolName: task.assignedTo || 'unknown',
            args: { goal: task.goal, context: task.context },
            result: {
                success: task.status === 'completed',
                output: task.result,
                error: task.error,
            },
            timestamp: Date.now(),
        }));
        const stepResults = stepParams.map((p) => this.stepEvaluator.evaluateStep(p));
        const scorerMetadata = {
            duration,
            retries: 0,
            errors: result.failedTasks,
            context: userGoal,
            totalToolCalls: tasks.length,
            successfulToolCalls: result.completedTasks,
            loopRounds: 1,
            outputLength: result.summary?.length || 0,
        };
        const qualityScore = this.qualityScorer.score(stepResults, scorerMetadata);
        Logger_1.Logger.info(`📊 自动评估完成 | 综合=${qualityScore.overall} | 准确=${qualityScore.dimensions.accuracy} 效率=${qualityScore.dimensions.efficiency} 安全=${qualityScore.dimensions.safety} 人设=${qualityScore.dimensions.persona} 稳定=${qualityScore.dimensions.stability}`, 'OrchestratorAgent');
        return qualityScore;
    }
    /**
     * 记录执行结果到进化编排器
     */
    recordToEvolution(userGoal, result, duration) {
        try {
            const qualityScore = result.qualityScore?.overall || 0;
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (bridge) {
                bridge
                    .submitFeedback({
                    kind: 'interaction',
                    traceId: `orch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    input: userGoal,
                    response: result.summary || '',
                    success: result.success && result.failedTasks === 0,
                    qualityScore: qualityScore / 100,
                    executionDuration: duration,
                    toolCalls: Array.from(result.details.entries()).map(([taskId, detail]) => {
                        const d = detail;
                        return {
                            toolName: d.agentId || taskId,
                            success: d.success !== false,
                            executionTime: 0,
                        };
                    }),
                    scene: 'orchestration',
            })
                .catch((err) => {
                Logger_1.Logger.debug(`Python后端进化记录失败（非关键）: ${err?.message}`, 'OrchestratorAgent');
            });
                Logger_1.Logger.debug('已记录编排执行结果到 Python 后端进化引擎', 'OrchestratorAgent');
                return;
            }
            const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
            orchestrator.recordInteraction({
                traceId: `orch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                input: userGoal,
                response: result.summary || '',
                success: result.success && result.failedTasks === 0,
                qualityScore: qualityScore / 100,
                executionDuration: duration,
                toolCalls: Array.from(result.details.entries()).map(([taskId, detail]) => {
                    const d = detail;
                    return {
                        toolName: d.agentId || taskId,
                        success: d.success !== false,
                        executionTime: 0,
                    };
                }),
                scene: 'orchestration',
            });
            Logger_1.Logger.debug('已记录编排执行结果到进化编排器', 'OrchestratorAgent');
        }
        catch (error) {
            Logger_1.Logger.debug(`记录到进化编排器失败（非关键）: ${error.message}`, 'OrchestratorAgent');
        }
    }
}
exports.OrchestratorAgent = OrchestratorAgent;
