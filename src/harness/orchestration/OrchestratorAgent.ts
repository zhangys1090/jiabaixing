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

import { TaskComplexityAnalyzer } from '../../core/TaskComplexityAnalyzer';
import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';
import { Logger } from '../../utils/Logger';
import { AgentFactory } from '../agents/AgentFactory';
import { QualityScorer, ScorerMetadata } from '../evaluation/QualityScorer';
import { StepEvaluator } from '../evaluation/StepEvaluator';
import { AgentRegistry } from './AgentRegistry';
import { ResultAggregator, type AggregatedResult } from './ResultAggregator';
import { SubAgentFanout, type FanoutConfig } from './SubAgentFanout';
import {
  TaskDispatcher,
  type TaskExecutor,
  type TaskNode,
} from './TaskDispatcher';

/** LLM 接口（遵循现有系统风格） */
export interface OrchestratorLLM {
  /**
   * 将用户目标拆解为DAG任务列表
   * @param userGoal - 用户目标
   * @param context - 上下文
   * @returns 解析后的任务节点数组
   */
  decomposeGoal(userGoal: string, context?: string): Promise<TaskNode[]>;
}

/** OrchestratorAgent 配置 */
export interface OrchestratorConfig {
  /** 是否启用多Agent编排，默认 true */
  enableMultiAgent: boolean;
  /** 触发多Agent的复杂度阈值，默认 'complex' */
  complexityThreshold: 'simple' | 'medium' | 'complex' | 'very_complex';
  /** 最大子Agent数，默认 5 */
  maxSubAgents: number;
  /** 扇出配置 */
  fanoutConfig?: Partial<FanoutConfig>;
}

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enableMultiAgent: true,
  complexityThreshold: 'complex',
  maxSubAgents: 5,
};

/** OrchestratorAgent 依赖 */
export interface OrchestratorAgentDeps {
  /** Agent注册中心 */
  registry: AgentRegistry;
  /** LLM 接口 */
  llm: OrchestratorLLM;
  /** 任务执行器（可选，用于实际执行任务） */
  executor?: TaskExecutor;
  /** 配置（可选） */
  config?: Partial<OrchestratorConfig>;
  /** Chat LLM 接口（可选，用于冲突仲裁） */
  chatLLM?: { chat(prompt: string, systemPrompt?: string): Promise<string> };
}

const COMPLEXITY_ORDER: Record<string, number> = {
  simple: 0,
  medium: 1,
  complex: 2,
  very_complex: 3,
};

export class OrchestratorAgent {
  private dispatcher: TaskDispatcher;
  private aggregator: ResultAggregator;
  private fanout: SubAgentFanout;
  private llm: OrchestratorLLM;
  private chatLLM?: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
  private qualityScorer: QualityScorer;
  private stepEvaluator: StepEvaluator;
  private complexityAnalyzer: TaskComplexityAnalyzer;
  private config: OrchestratorConfig;
  private registry: AgentRegistry;

  constructor(deps: OrchestratorAgentDeps) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...deps.config };
    this.registry = deps.registry;
    this.dispatcher = new TaskDispatcher(deps.registry, deps.executor);
    this.aggregator = new ResultAggregator();
    this.fanout = new SubAgentFanout(
      deps.registry,
      deps.executor,
      this.config.fanoutConfig
    );
    this.llm = deps.llm;
    this.chatLLM = deps.chatLLM;
    this.qualityScorer = new QualityScorer();
    this.stepEvaluator = new StepEvaluator();
    this.complexityAnalyzer = new TaskComplexityAnalyzer();
  }

  /**
   * 处理用户目标 — 复杂度分析 → 拆解 → 扇出 → 聚合
   *
   * P10增强：
   * - 简单任务直通单Agent路径
   * - 复杂任务走多Agent编排路径
   * - LLM不可用时降级到TaskComplexityAnalyzer拆解
   */
  async processGoal(
    userGoal: string,
    context?: string
  ): Promise<AggregatedResult> {
    const startTime = Date.now();
    Logger.info(
      `🎯 OrchestratorAgent 处理目标: ${userGoal.substring(0, 80)}`,
      'OrchestratorAgent'
    );

    try {
      // Step 0: 复杂度分析
      const complexityResult =
        this.complexityAnalyzer.analyzeComplexity(userGoal);
      Logger.info(
        `📊 复杂度分析: ${complexityResult.complexity} | 预估步骤=${complexityResult.estimatedSteps} | 可并行=${complexityResult.parallelizable}`,
        'OrchestratorAgent'
      );

      // 简单任务直通
      if (
        !this.config.enableMultiAgent ||
        !this.shouldUseMultiAgent(complexityResult.complexity)
      ) {
        Logger.info('⚡ 简单任务，走单Agent直通路径', 'OrchestratorAgent');
        return this.processSimpleGoal(userGoal, context, startTime);
      }

      // Step 1: 调用LLM拆解目标为DAG任务
      Logger.info('🧠 正在拆解用户目标...', 'OrchestratorAgent');
      let tasks: TaskNode[];

      try {
        tasks = await this.llm.decomposeGoal(userGoal, context);
      } catch (llmError) {
        Logger.warn(
          `⚠️ LLM拆解失败，降级到TaskComplexityAnalyzer: ${(llmError as Error).message}`,
          'OrchestratorAgent'
        );
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

      Logger.info(
        `📋 目标拆解完成: ${tasks.length} 个任务`,
        'OrchestratorAgent'
      );

      // 动态角色分配 — P0-4: 将分配结果实际写入 TaskNode，消除空转
      try {
        const roleAssignments = await this.assignDynamicRoles(tasks);
        if (roleAssignments.length > 0) {
          Logger.info(
            `🎭 动态角色分配完成: ${roleAssignments.length}/${tasks.length} 个任务已分配角色`,
            'OrchestratorAgent'
          );
          // P0-4: 将角色分配结果写入 TaskNode，影响后续执行路径
          for (const assignment of roleAssignments) {
            const task = tasks.find(t => t.id === assignment.taskId);
            if (task) {
              task.assignedTo = assignment.agentId;
              task.metadata = {
                ...task.metadata,
                assignedRole: assignment.role,
                assignedCapability: assignment.capability,
              };
              Logger.debug(
                `  → 任务 ${assignment.taskId} → Agent ${assignment.agentId} (角色: ${assignment.role})`,
                'OrchestratorAgent'
              );
            }
          }
        }
      } catch (roleError) {
        Logger.warn(
          `⚠️ 动态角色分配失败（不影响执行）: ${(roleError as Error).message}`,
          'OrchestratorAgent'
        );
      }

      // Step 2: 判断是否需要扇出执行
      if (tasks.length > 1 && complexityResult.parallelizable) {
        Logger.info(
          `🔀 使用 Sub-Agent 扇出执行 (${tasks.length} 个子任务)`,
          'OrchestratorAgent'
        );
        const fanoutResult = await this.fanout.fanout(
          `parent_${Date.now()}`,
          tasks,
          { maxFanout: this.config.maxSubAgents }
        );

        const results = new Map<string, unknown>();
        for (const sub of fanoutResult.subResults) {
          results.set(
            sub.taskId,
            sub.success ? sub.result : { error: sub.error }
          );
        }

        const aggregated = this.aggregator.aggregate(results, tasks);

        // 置信度合并
        this.mergeResultsWithConsensus(results, tasks);

        const finalResult: AggregatedResult = {
          ...aggregated,
          duration: Date.now() - startTime,
          summary: fanoutResult.allSucceeded
            ? `✅ 目标完成(扇出): ${userGoal.substring(0, 60)}`
            : `⚠️ 目标部分完成(扇出): ${userGoal.substring(0, 60)} (${fanoutResult.failedCount} 个子任务失败)`,
        };

        // 冲突仲裁（在 finalResult 创建后调用，确保仲裁文本附加到最终摘要）
        await this.resolveConflictsIfAny(finalResult);

        const qualityScore = this.evaluateExecution(
          tasks,
          finalResult,
          userGoal,
          finalResult.duration
        );
        finalResult.qualityScore = qualityScore;
        this.recordToEvolution(userGoal, finalResult, finalResult.duration);

        return finalResult;
      }

      // Step 3: DAG分发执行（有依赖关系的任务）
      Logger.info('🚀 使用 DAG 分发执行...', 'OrchestratorAgent');
      const results = await this.dispatcher.dispatch(tasks);

      // 失败任务重平衡
      const failedTasks = tasks.filter((t) => t.status === 'failed');
      if (failedTasks.length > 0) {
        Logger.info(
          `🔄 检测到 ${failedTasks.length} 个失败任务，尝试重平衡...`,
          'OrchestratorAgent'
        );

        // P1-8: 优先尝试动态重规划（Python端9种动作）
        try {
          const replannedTasks = await this.dynamicReplan(
            tasks,
            failedTasks.map((t) => t.id),
            `${failedTasks.length} 个子任务执行失败`
          );
          if (replannedTasks !== tasks) {
            Logger.info(
              `🔄 P1-8: 动态重规划产出新任务图，重新执行...`,
              'OrchestratorAgent'
            );
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
        } catch (replanErr) {
          Logger.warn(
            `⚠️ 动态重规划执行失败，回退到角色重平衡: ${(replanErr as Error).message}`,
            'OrchestratorAgent'
          );
        }
        try {
          const roleAssignments = await this.assignDynamicRoles(tasks);
          const rebalanced = await this.rebalanceRoles(tasks, roleAssignments);
          const rebalancedCount = rebalanced.filter(
            (r, i) => r.agentId !== roleAssignments[i]?.agentId
          ).length;
          if (rebalancedCount > 0) {
            Logger.info(
              `🔄 重平衡: ${rebalancedCount} 个任务已重新分配`,
              'OrchestratorAgent'
            );
          }
        } catch (rebalanceError) {
          Logger.warn(
            `⚠️ 重平衡失败（不影响结果）: ${(rebalanceError as Error).message}`,
            'OrchestratorAgent'
          );
        }
      }

      // Step 4: 聚合结果
      Logger.info('📊 聚合执行结果...', 'OrchestratorAgent');
      const aggregated = this.aggregator.aggregate(results, tasks);

      const actualDuration = Date.now() - startTime;
      const finalResult: AggregatedResult = {
        ...aggregated,
        duration: actualDuration,
        summary: aggregated.success
          ? `✅ 目标完成: ${userGoal.substring(0, 60)}`
          : `⚠️ 目标部分完成: ${userGoal.substring(0, 60)}`,
      };

      // 冲突仲裁（在 finalResult 创建后调用，确保仲裁文本附加到最终摘要）
      await this.resolveConflictsIfAny(finalResult);

      const qualityScore = this.evaluateExecution(
        tasks,
        finalResult,
        userGoal,
        actualDuration
      );
      finalResult.qualityScore = qualityScore;

      this.recordToEvolution(userGoal, finalResult, actualDuration);

      Logger.info(
        `🏁 OrchestratorAgent 完成 | 耗时=${actualDuration}ms | 成功=${finalResult.completedTasks}/${finalResult.totalTasks} | 质量=${qualityScore.overall}`,
        'OrchestratorAgent'
      );

      return finalResult;
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      Logger.error(
        'OrchestratorAgent 处理失败',
        err as Error,
        'OrchestratorAgent'
      );

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
  private async processSimpleGoal(
    userGoal: string,
    context: string | undefined,
    startTime: number
  ): Promise<AggregatedResult> {
    // 尝试选择专业化 Agent 执行
    try {
      const agent = AgentFactory.selectAgentByGoal(userGoal);
      if (agent && agent.isReady) {
        Logger.info(
          `🤖 使用专业化 Agent: ${agent.name} 执行简单任务`,
          'OrchestratorAgent'
        );
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
                status: 'completed' as const,
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
    } catch (agentError) {
      Logger.warn(
        `⚠️ 专业化 Agent 执行失败，降级到通用执行器: ${(agentError as Error).message}`,
        'OrchestratorAgent'
      );
    }

    // 降级：通用执行器
    const singleTask: TaskNode = {
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
  private decomposeWithAnalyzer(userGoal: string): TaskNode[] {
    const decomposition = this.complexityAnalyzer.decomposeTask(userGoal);
    return decomposition.subTasks.map((sub, index) => ({
      id: sub.id,
      goal: sub.description,
      context: `子任务 ${index + 1}/${decomposition.subTasks.length}`,
      dependencies: sub.dependencies,
      priority:
        sub.complexity === 'very_complex'
          ? 8
          : sub.complexity === 'complex'
            ? 6
            : 4,
      tools: sub.tools,
      status: 'pending' as const,
    }));
  }

  /**
   * 判断是否需要多Agent编排
   */
  private shouldUseMultiAgent(complexity: string): boolean {
    const threshold = COMPLEXITY_ORDER[this.config.complexityThreshold] ?? 2;
    const current = COMPLEXITY_ORDER[complexity] ?? 0;
    return current >= threshold;
  }

  /**
   * 获取底层的 TaskDispatcher
   */
  getDispatcher(): TaskDispatcher {
    return this.dispatcher;
  }

  /**
   * 获取底层的 ResultAggregator
   */
  getAggregator(): ResultAggregator {
    return this.aggregator;
  }

  /**
   * 获取 SubAgentFanout
   */
  getFanout(): SubAgentFanout {
    return this.fanout;
  }

  /**
   * 获取 Chat LLM 接口（用于冲突仲裁）
   * 优先使用显式传入的 chatLLM，否则检查 llm 是否也实现了 chat 方法
   * @returns Chat LLM 接口，不可用时返回 null
   */
  private getChatLLM(): {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  } | null {
    if (this.chatLLM) return this.chatLLM;
    // 鸭子类型检查：llm 是否也实现了 chat 方法
    const llm = this.llm as unknown as {
      chat?: (prompt: string, systemPrompt?: string) => Promise<string>;
    };
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
  private async resolveConflictsIfAny(
    aggregated: AggregatedResult
  ): Promise<void> {
    if (!aggregated.conflicts || aggregated.conflicts.length === 0) return;

    Logger.warn(
      `⚠️ 检测到 ${aggregated.conflicts.length} 个结果冲突，启动 LLM 仲裁...`,
      'OrchestratorAgent'
    );

    try {
      const chatLLM = this.getChatLLM();
      if (!chatLLM) {
        Logger.debug('Chat LLM 不可用，跳过冲突仲裁', 'OrchestratorAgent');
        return;
      }

      const resolutions = await this.aggregator.resolveConflictsWithLLM(
        aggregated.conflicts,
        chatLLM
      );

      for (const res of resolutions) {
        Logger.info(
          `🔧 冲突仲裁: ${res.conflict.description} → 获胜: ${res.winnerTaskId}`,
          'OrchestratorAgent'
        );
      }

      aggregated.summary += `\n🔧 已仲裁 ${resolutions.length} 个冲突`;
    } catch (err) {
      Logger.warn(
        `⚠️ 冲突仲裁失败: ${(err as Error).message}`,
        'OrchestratorAgent'
      );
    }
  }

  /**
   * 置信度合并 — 当多个结果包含置信度时，选择最高置信度结果
   * @param results - 任务结果映射
   * @param tasks - 任务节点列表
   */
  private mergeResultsWithConsensus(
    results: Map<string, unknown>,
    tasks: TaskNode[]
  ): void {
    const resultsWithConfidence: Array<{
      taskId: string;
      result: unknown;
      confidence: number;
      agentId: string;
    }> = [];

    for (const [taskId, result] of results) {
      if (result && typeof result === 'object' && 'confidence' in result) {
        const confidence = (result as { confidence: number }).confidence;
        if (typeof confidence === 'number') {
          resultsWithConfidence.push({
            taskId,
            result,
            confidence,
            agentId:
              tasks.find((t) => t.id === taskId)?.assignedTo || 'unknown',
          });
        }
      }
    }

    if (resultsWithConfidence.length > 1) {
      const consensus = this.aggregator.mergeWithConsensus(
        resultsWithConfidence
      );
      Logger.info(
        `📊 置信度合并: 选择任务 ${consensus.selectedTaskId} (平均置信度: ${consensus.averageConfidence.toFixed(2)})`,
        'OrchestratorAgent'
      );
    }
  }

  /**
   * 动态角色分配 — 根据任务需求和能力匹配为 Agent 分配角色
   * @param tasks - 待分配的任务列表
   * @returns 角色分配结果
   */
  async assignDynamicRoles(tasks: TaskNode[]): Promise<
    Array<{
      agentId: string;
      role: string;
      taskId: string;
      capability: string;
    }>
  > {
    const assignments: Array<{
      agentId: string;
      role: string;
      taskId: string;
      capability: string;
    }> = [];

    for (const task of tasks) {
      const requiredTools = task.tools || [];
      if (requiredTools.length === 0) continue;

      const bestAgent = this.registry.findBestAgent(requiredTools[0]);
      if (!bestAgent) continue;

      const matchingCap = bestAgent.capabilities.find((c) =>
        requiredTools.some((t) => c.tools.includes(t))
      );
      const role = this.inferRoleFromCapability(
        matchingCap?.name || 'execution'
      );

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
  async rebalanceRoles(
    tasks: TaskNode[],
    previousAssignments: Array<{
      agentId: string;
      role: string;
      taskId: string;
      capability: string;
    }>
  ): Promise<
    Array<{
      agentId: string;
      role: string;
      taskId: string;
      capability: string;
    }>
  > {
    const rebalanced: Array<{
      agentId: string;
      role: string;
      taskId: string;
      capability: string;
    }> = [];

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
  private inferRoleFromCapability(capabilityName: string): string {
    const roleMap: Record<string, string> = {
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
  private evaluateExecution(
    tasks: TaskNode[],
    result: AggregatedResult,
    userGoal: string,
    duration: number
  ): import('../evaluation/QualityScorer').QualityScore {
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

    const stepResults = stepParams.map((p) =>
      this.stepEvaluator.evaluateStep(p)
    );

    const scorerMetadata: ScorerMetadata = {
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

    Logger.info(
      `📊 自动评估完成 | 综合=${qualityScore.overall} | 准确=${qualityScore.dimensions.accuracy} 效率=${qualityScore.dimensions.efficiency} 安全=${qualityScore.dimensions.safety} 人设=${qualityScore.dimensions.persona} 稳定=${qualityScore.dimensions.stability}`,
      'OrchestratorAgent'
    );

    return qualityScore;
  }

  /**
   * 记录执行结果到进化编排器
   */
  private recordToEvolution(
    userGoal: string,
    result: AggregatedResult,
    duration: number
  ): void {
    try {
      const qualityScore = result.qualityScore?.overall || 0;
      const bridge = getActivePythonBridge();
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
            toolCalls: Array.from(result.details.entries()).map(
              ([taskId, detail]) => {
                const d = detail as unknown as Record<string, unknown>;
                return {
                  toolName: (d.agentId as string) || taskId,
                  success: d.success !== false,
                  executionTime: 0,
                };
              }
            ),
              scene: 'orchestration',
          })
          .catch((err) =>
            Logger.warn('记录编排执行结果到进化引擎失败', err as Error, 'OrchestratorAgent')
          );
        Logger.debug('已记录编排执行结果到 Python 后端进化引擎', 'OrchestratorAgent');
        return;
      }
      const orchestrator = EvolutionOrchestrator.getInstance();
      orchestrator.recordInteraction({
        traceId: `orch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        input: userGoal,
        response: result.summary || '',
        success: result.success && result.failedTasks === 0,
        qualityScore: qualityScore / 100,
        executionDuration: duration,
        toolCalls: Array.from(result.details.entries()).map(
          ([taskId, detail]) => {
            const d = detail as unknown as Record<string, unknown>;
            return {
              toolName: (d.agentId as string) || taskId,
              success: d.success !== false,
              executionTime: 0,
            };
          }
        ),
        scene: 'orchestration',
      });

      Logger.debug('已记录编排执行结果到进化编排器', 'OrchestratorAgent');
    } catch (error) {
      Logger.debug(
        `记录到进化编排器失败（非关键）: ${(error as Error).message}`,
        'OrchestratorAgent'
      );
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
  async dynamicReplan(
    tasks: TaskNode[],
    failedTaskIds: string[],
    reason: string
  ): Promise<TaskNode[]> {
    Logger.info(
      `🔄 P1-8: 请求动态重规划 (${failedTaskIds.length} 个失败任务): ${reason}`,
      'OrchestratorAgent'
    );

    try {
      const bridge = getActivePythonBridge();
      if (bridge) {
        const replanResult = await bridge.callPython({
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
        });

        if (replanResult && Array.isArray(replanResult.tasks)) {
          const updatedTasks = replanResult.tasks.map(
            (t: Record<string, unknown>) =>
              ({
                id: t.id,
                goal: t.goal || t.description,
                context: t.context || '',
                dependencies: (t.dependencies as string[]) || [],
                priority: (t.priority as number) || 5,
                status: (t.status as TaskNode['status']) || 'pending',
                assignedTo: t.assignedTo as string | undefined,
              }) as TaskNode
          );

          Logger.info(
            `🔄 P1-8: 动态重规划完成: ${tasks.length} → ${updatedTasks.length} 个任务`,
            'OrchestratorAgent'
          );
          return updatedTasks;
        }
      }

      Logger.warn(
        'P1-8: PythonBridge 不可用或重规划返回空，使用本地降级重规划',
        'OrchestratorAgent'
      );
    } catch (err) {
      Logger.warn(
        `P1-8: 动态重规划桥接失败: ${(err as Error).message}，使用本地降级`,
        'OrchestratorAgent'
      );
    }

    return this.localFallbackReplan(tasks, failedTaskIds);
  }

  /**
   * P1-8: 本地降级重规划（PythonBridge 不可用时）
   *
   * 简单策略：将失败任务重置为 pending，降低优先级
   */
  private localFallbackReplan(
    tasks: TaskNode[],
    failedTaskIds: string[]
  ): TaskNode[] {
    const failedSet = new Set(failedTaskIds);
    return tasks.map((t) => {
      if (failedSet.has(t.id)) {
        return { ...t, status: 'pending' as const, priority: Math.max(1, t.priority - 2) };
      }
      return t;
    });
  }
}
