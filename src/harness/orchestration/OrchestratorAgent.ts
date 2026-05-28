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

import { Logger } from '../../utils/Logger';
import {
  TaskDispatcher,
  type TaskNode,
  type TaskExecutor,
} from './TaskDispatcher';
import { ResultAggregator, type AggregatedResult } from './ResultAggregator';
import { AgentRegistry } from './AgentRegistry';
import { SubAgentFanout, type FanoutConfig } from './SubAgentFanout';
import { QualityScorer, ScorerMetadata } from '../evaluation/QualityScorer';
import { StepEvaluator } from '../evaluation/StepEvaluator';
import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { TaskComplexityAnalyzer } from '../../core/TaskComplexityAnalyzer';

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
  private qualityScorer: QualityScorer;
  private stepEvaluator: StepEvaluator;
  private complexityAnalyzer: TaskComplexityAnalyzer;
  private config: OrchestratorConfig;

  constructor(deps: OrchestratorAgentDeps) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...deps.config };
    this.dispatcher = new TaskDispatcher(deps.registry, deps.executor);
    this.aggregator = new ResultAggregator();
    this.fanout = new SubAgentFanout(
      deps.registry,
      deps.executor,
      this.config.fanoutConfig
    );
    this.llm = deps.llm;
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
        const finalResult: AggregatedResult = {
          ...aggregated,
          duration: Date.now() - startTime,
          summary: fanoutResult.allSucceeded
            ? `✅ 目标完成(扇出): ${userGoal.substring(0, 60)}`
            : `⚠️ 目标部分完成(扇出): ${userGoal.substring(0, 60)} (${fanoutResult.failedCount} 个子任务失败)`,
        };

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
      const orchestrator = EvolutionOrchestrator.getInstance();
      const qualityScore = result.qualityScore?.overall || 0;

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
}
