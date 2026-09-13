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
 *
 * D4-I3: 目标拆解现在经过 DecisionAuthority (Plan Decision)。
 * OrchestratorProposer 将 decomposeGoal() 转为 Proposer，
 * DecisionAuthority 做 FINAL plan decision。
 * 简单任务直通路径也经过 DecisionAuthority (Action Decision)。
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
const DecisionAuthority_1 = require("../../authority/DecisionAuthority");
const GoalAuthority_1 = require("../../authority/GoalAuthority");
const StateAuthority_1 = require("../../authority/StateAuthority");
const OrchestratorProposer_1 = require("../../authority/OrchestratorProposer");
const types_1 = require("../../authority/types");
const GoalContextResolver_1 = require("../../core/GoalContextResolver");
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
    dispatcher;
    aggregator;
    fanout;
    llm;
    chatLLM;
    qualityScorer;
    stepEvaluator;
    complexityAnalyzer;
    config;
    registry;
    _projectContext;
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
        this.orchestratorProposer = new OrchestratorProposer_1.OrchestratorProposer();
        this.orchestratorProposer.setDecomposeFn(async (goal, ctx) => this.llm.decomposeGoal(goal, ctx));
    }
    orchestratorProposer;
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
            // Step 1: D4-I3 — 目标拆解经过 DecisionAuthority (Plan Decision)
            // OrchestratorProposer 将 decomposeGoal() 转为 DecisionCandidate，
            // DecisionAuthority 做 FINAL plan decision。
            Logger_1.Logger.info('🧠 正在拆解用户目标（经过 DecisionAuthority Plan Decision）...', 'OrchestratorAgent');
            let tasks;
            try {
                const goalAuthority = GoalAuthority_1.GoalAuthority.getInstance();
                const stateAuthority = StateAuthority_1.StateAuthority.getInstance();
                const goalBinding = (0, GoalContextResolver_1.resolveGoalBinding)(this.buildGoalContext());
                const goal = goalAuthority.createGoal({
                    description: userGoal,
                    originalInput: userGoal,
                    executionDomain: 'orchestrator',
                    bindings: goalBinding,
                });
                const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);
                const planCandidates = await this.orchestratorProposer.propose({
                    goalId: goal.goalId,
                    snapshot,
                    candidates: [],
                });
                if (planCandidates.length === 0) {
                    Logger_1.Logger.warn('⚠️ OrchestratorProposer 无候选，降级到直接 LLM 拆解', 'OrchestratorAgent');
                    tasks = await this.llm.decomposeGoal(userGoal, context);
                }
                else {
                    const decisionAuthority = DecisionAuthority_1.DecisionAuthority.getInstance();
                    const planDecision = await decisionAuthority.decide({
                        goalId: goal.goalId,
                        snapshot,
                        candidates: planCandidates,
                        decisionType: types_1.DecisionType.PLAN,
                    });
                    Logger_1.Logger.info(`🔗 D4-I3: Plan Decision ${planDecision.decisionId} — chosen=${planDecision.chosen.candidateId} proposer=${planDecision.chosen.proposerId}`, 'OrchestratorAgent');
                    const planPayload = planDecision.chosen.action.payload;
                    tasks = planPayload.tasks || [];
                    // D4-I3 验收复核: plan decisionId 与父 goalId 必须下沉到每个子任务，
                    // 否则 G→planDecision→subtask 链在 ID 层断裂（D4-I4 replay 无法回溯）。
                    for (const t of tasks) {
                        t.metadata = {
                            ...t.metadata,
                            parentGoalId: goal.goalId,
                            planDecisionId: planDecision.decisionId,
                            planSnapshotId: snapshot.snapshotId,
                        };
                    }
                }
            }
            catch (llmError) {
                Logger_1.Logger.warn(`⚠️ LLM拆解失败，降级到TaskComplexityAnalyzer: ${llmError.message}`, 'OrchestratorAgent');
                tasks = this.decomposeWithAnalyzer(userGoal);
            }
            if (!tasks || tasks.length === 0) {
                return {
                    success: false,
                    summary: '❌ 目标拆解失败: 未生成任何任务',
                    details: new Map(),
                    totalTasks: 0,
                    completedTasks: 0,
                    failedTasks: 0,
                    duration: Date.now() - startTime,
                };
            }
            Logger_1.Logger.info(`📋 目标拆解完成: ${tasks.length} 个任务`, 'OrchestratorAgent');
            // 动态角色分配 — P0-4: 将分配结果实际写入 TaskNode，消除空转
            try {
                const roleAssignments = await this.assignDynamicRoles(tasks);
                if (roleAssignments.length > 0) {
                    Logger_1.Logger.info(`🎭 动态角色分配完成: ${roleAssignments.length}/${tasks.length} 个任务已分配角色`, 'OrchestratorAgent');
                    // P0-4: 将角色分配结果写入 TaskNode，影响后续执行路径
                    for (const assignment of roleAssignments) {
                        const task = tasks.find((t) => t.id === assignment.taskId);
                        if (task) {
                            task.assignedTo = assignment.agentId;
                            task.metadata = {
                                ...task.metadata,
                                assignedRole: assignment.role,
                                assignedCapability: assignment.capability,
                            };
                            Logger_1.Logger.debug(`  → 任务 ${assignment.taskId} → Agent ${assignment.agentId} (角色: ${assignment.role})`, 'OrchestratorAgent');
                        }
                    }
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
                // P1-8: 优先尝试动态重规划（Python端9种动作）
                try {
                    const replannedTasks = await this.dynamicReplan(tasks, failedTasks.map((t) => t.id), `${failedTasks.length} 个子任务执行失败`);
                    if (replannedTasks !== tasks) {
                        Logger_1.Logger.info(`🔄 P1-8: 动态重规划产出新任务图，重新执行...`, 'OrchestratorAgent');
                        const replanResults = await this.dispatcher.dispatch(replannedTasks);
                        const replanAggregated = this.aggregator.aggregate(replanResults, replannedTasks);
                        if (replanAggregated.success) {
                            const replanDuration = Date.now() - startTime;
                            return {
                                ...replanAggregated,
                                duration: replanDuration,
                                summary: `✅ 目标完成(重规划): ${userGoal.substring(0, 60)}`,
                            };
                        }
                    }
                }
                catch (replanErr) {
                    Logger_1.Logger.warn(`⚠️ 动态重规划执行失败，回退到角色重平衡: ${replanErr.message}`, 'OrchestratorAgent');
                }
                try {
                    const roleAssignments = await this.assignDynamicRoles(tasks);
                    const rebalanced = await this.rebalanceRoles(tasks, roleAssignments);
                    const rebalancedCount = rebalanced.filter((r, i) => r.agentId !== roleAssignments[i]?.agentId).length;
                    if (rebalancedCount > 0) {
                        Logger_1.Logger.info(`🔄 重平衡: ${rebalancedCount} 个任务已重新分配，重新执行失败任务...`, 'OrchestratorAgent');
                        const retryTasks = [];
                        for (const assignment of rebalanced) {
                            const task = tasks.find((t) => t.id === assignment.taskId);
                            if (task && task.status === 'failed') {
                                retryTasks.push({
                                    ...task,
                                    assignedTo: assignment.agentId,
                                    status: 'pending',
                                    error: undefined,
                                });
                            }
                        }
                        const retryFailedTasks = retryTasks;
                        if (retryFailedTasks.length > 0) {
                            const retryResults = await this.dispatcher.dispatch(retryFailedTasks);
                            for (const [taskId, result] of retryResults) {
                                results.set(taskId, result);
                                const originalTask = tasks.find((t) => t.id === taskId);
                                if (originalTask) {
                                    const retried = retryFailedTasks.find((t) => t.id === taskId);
                                    if (retried) {
                                        originalTask.status = retried.status;
                                        originalTask.result = retried.result;
                                        originalTask.error = retried.error;
                                        originalTask.assignedTo = retried.assignedTo;
                                    }
                                }
                            }
                        }
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
        // D4-I3 验收复核: 简单任务直通路径同样必须经过 DecisionAuthority（Action Decision）。
        // 此前实现直接 agent.execute()/dispatch()，无 Goal/Snapshot/Decision —— 注释与实现不符。
        let simpleGoalId = null;
        let simpleDecisionId = null;
        try {
            const goalAuthority = GoalAuthority_1.GoalAuthority.getInstance();
            const stateAuthority = StateAuthority_1.StateAuthority.getInstance();
            const decisionAuthority = DecisionAuthority_1.DecisionAuthority.getInstance();
            const simpleGoalBinding = (0, GoalContextResolver_1.resolveGoalBinding)(this.buildGoalContext());
            const goal = goalAuthority.createGoal({
                description: userGoal,
                originalInput: userGoal,
                executionDomain: 'orchestrator',
                bindings: simpleGoalBinding,
            });
            simpleGoalId = goal.goalId;
            const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);
            const decision = await decisionAuthority.decide({
                goalId: goal.goalId,
                snapshot,
                decisionType: types_1.DecisionType.ACTION,
                candidates: [
                    {
                        candidateId: `C_simple_${Date.now().toString(36)}`,
                        proposerId: 'orchestrator_simple_path',
                        action: {
                            type: 'composite',
                            payload: { execute: 'simple_direct', goal: userGoal },
                        },
                        confidence: 0.9,
                        reasoning: 'Simple task direct path — single candidate ratified by DecisionAuthority',
                        estimatedGoalProgress: 0.5,
                    },
                ],
            });
            simpleDecisionId = decision.decisionId;
            Logger_1.Logger.info(`🔗 D4-I3: simple-path Action Decision ${decision.decisionId} for goal ${goal.goalId}`, 'OrchestratorAgent');
        }
        catch (authError) {
            Logger_1.Logger.warn(`⚠️ D4-I3: simple-path authority 前置失败，降级旧直通路径: ${authError.message}`, 'OrchestratorAgent');
        }
        // 尝试选择专业化 Agent 执行
        try {
            const agent = AgentFactory_1.AgentFactory.selectAgentByGoal(userGoal);
            if (agent && agent.isReady) {
                Logger_1.Logger.info(`🤖 使用专业化 Agent: ${agent.name} 执行简单任务`, 'OrchestratorAgent');
                const agentResult = await agent.execute(userGoal, context || '');
                const duration = Date.now() - startTime;
                const result = {
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
                const qualityScore = this.evaluateExecution([
                    {
                        id: 'agent',
                        goal: userGoal,
                        context: context || '',
                        dependencies: [],
                        priority: 5,
                        status: 'completed',
                        result: agentResult,
                    },
                ], result, userGoal, duration);
                result.qualityScore = qualityScore;
                this.recordToEvolution(userGoal, result, duration);
                this.recordSimplePathEvidence(simpleGoalId, simpleDecisionId, true, userGoal);
                return result;
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
        const result = {
            ...aggregated,
            duration,
            summary: aggregated.success
                ? `✅ 任务完成: ${userGoal.substring(0, 60)}`
                : `❌ 任务失败: ${userGoal.substring(0, 60)}`,
        };
        const qualityScore = this.evaluateExecution([singleTask], result, userGoal, duration);
        result.qualityScore = qualityScore;
        this.recordToEvolution(userGoal, result, duration);
        this.recordSimplePathEvidence(simpleGoalId, simpleDecisionId, result.success, userGoal);
        return result;
    }
    setProjectContext(context) {
        this._projectContext = context;
    }
    buildGoalContext() {
        return {
            projectContext: this._projectContext,
        };
    }
    /**
     * D4-I3 验收复核: 简单路径执行结果以 Evidence 写回同一 goalId（与 I2 模式一致）。
     * progressDelta 仍为结果驱动 stub，等待 D5 Learning 校准。
     */
    recordSimplePathEvidence(goalId, decisionId, success, userGoal) {
        if (!goalId || !decisionId)
            return;
        try {
            GoalAuthority_1.GoalAuthority.getInstance().updateFromEvidence({
                goalId,
                decisionId,
                observation: success ? 'simple-path task completed' : 'simple-path task failed',
                action: { type: 'composite', payload: { execute: 'simple_direct', goal: userGoal } },
                expectedEffect: `complete: ${userGoal.slice(0, 60)}`,
                actualEffect: success ? 'success' : 'failed',
                progressDelta: success ? 0.5 : -0.05,
            });
        }
        catch (e) {
            Logger_1.Logger.warn(`D4-I3: simple-path evidence write-back failed — ${e.message}`, 'OrchestratorAgent');
        }
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
            let bestAgent = null;
            let bestScore = -1;
            let bestCapName = 'execution';
            const idleAgents = this.registry.getIdleAgents();
            for (const agent of idleAgents) {
                let matchedTools = 0;
                let matchedCapName = 'execution';
                for (const cap of agent.capabilities) {
                    const capMatchCount = requiredTools.filter((t) => cap.tools.includes(t)).length;
                    if (capMatchCount > matchedTools) {
                        matchedTools = capMatchCount;
                        matchedCapName = cap.name;
                    }
                }
                const health = this.registry.getHealthStatus(agent.id);
                const healthBonus = health ? health.successRate * 10 : 0;
                const score = matchedTools * 10 + healthBonus;
                if (score > bestScore) {
                    bestScore = score;
                    bestAgent = agent;
                    bestCapName = matchedCapName;
                }
            }
            if (!bestAgent) {
                const fallbackAgent = this.registry.findBestAgent(requiredTools[0]);
                if (!fallbackAgent)
                    continue;
                bestAgent = fallbackAgent;
                const matchingCap = bestAgent.capabilities.find((c) => requiredTools.some((t) => c.tools.includes(t)));
                bestCapName = matchingCap?.name || 'execution';
            }
            const role = this.inferRoleFromCapability(bestCapName);
            assignments.push({
                agentId: bestAgent.id,
                role,
                taskId: task.id,
                capability: bestCapName,
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
                void bridge
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
                    .catch((err) => Logger_1.Logger.warn('记录编排执行结果到进化引擎失败', 'OrchestratorAgent', err));
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
    /**
     * P1-8: TS 侧动态重规划桥接
     *
     * 当编排执行检测到失败任务时，通过 PythonBridge 调用
     * Python 端 dynamic_dag_replanner 进行任务级重规划，
     * 支持 INSERT/REMOVE/REPLACE/RETRY 等 9 种动作。
     *
     * @param tasks - 当前任务列表
     * @param failedTaskIds - 失败的任务 ID 列表
     * @param reason - 重规划原因
     * @returns 重规划后的任务列表（可能增/删/替换任务）
     */
    async dynamicReplan(tasks, failedTaskIds, reason) {
        Logger_1.Logger.info(`🔄 P1-8: 请求动态重规划 (${failedTaskIds.length} 个失败任务): ${reason}`, 'OrchestratorAgent');
        try {
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (bridge) {
                const replanResult = await bridge.processInput(JSON.stringify({
                    module: 'agent.orchestration.dynamic_dag_replanner',
                    function: 'replan_from_ts',
                    args: {
                        tasks: tasks.map((t) => ({
                            id: t.id,
                            goal: t.goal,
                            status: t.status,
                            assignedTo: t.assignedTo,
                        })),
                        failed_task_ids: failedTaskIds,
                        reason,
                    },
                }), 'replan-session', 'replan-trace');
                let replanData = null;
                try {
                    replanData = JSON.parse(replanResult.response);
                }
                catch {
                    replanData = null;
                }
                if (replanData && Array.isArray(replanData.tasks)) {
                    const updatedTasks = replanData.tasks.map((t) => ({
                        id: t.id,
                        goal: t.goal || t.description,
                        context: t.context || '',
                        dependencies: t.dependencies || [],
                        priority: t.priority || 5,
                        status: t.status || 'pending',
                        assignedTo: t.assignedTo,
                    }));
                    Logger_1.Logger.info(`🔄 P1-8: 动态重规划完成: ${tasks.length} → ${updatedTasks.length} 个任务`, 'OrchestratorAgent');
                    return updatedTasks;
                }
            }
            Logger_1.Logger.warn('P1-8: PythonBridge 不可用或重规划返回空，使用本地降级重规划', 'OrchestratorAgent');
        }
        catch (err) {
            Logger_1.Logger.warn(`P1-8: 动态重规划桥接失败: ${err.message}，使用本地降级`, 'OrchestratorAgent');
        }
        return this.localFallbackReplan(tasks, failedTaskIds);
    }
    /**
     * P1-8: 本地降级重规划（PythonBridge 不可用时）
     *
     * 简单策略：将失败任务重置为 pending，降低优先级
     */
    localFallbackReplan(tasks, failedTaskIds) {
        const failedSet = new Set(failedTaskIds);
        return tasks.map((t) => {
            if (failedSet.has(t.id)) {
                return {
                    ...t,
                    status: 'pending',
                    priority: Math.max(1, t.priority - 2),
                };
            }
            return t;
        });
    }
}
exports.OrchestratorAgent = OrchestratorAgent;
