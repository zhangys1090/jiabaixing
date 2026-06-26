/**
 * Harness Layer 1: Loop - 循环控制器
 *
 * Plan-Execute-Evaluate 状态机
 * 替代 JiabaixingCore.executeFCLoop 的单层 FC 循环
 *
 * @deprecated 已迁移到 Python agent/loop/controller.py。
 *
 * 废弃状态说明：
 * - 废弃版本：V5.0
 * - 迁移日期：2026-06-22
 * - 预计移除版本：V6.0（约 2026-09）
 * - 替代方案：使用 Python 后端（AGENT_BACKEND=python，默认）
 * - 回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现（不推荐）
 * - 维护状态：仅安全修复，不再新增功能
 *
 * 注意：当 AGENT_BACKEND=python（默认）时，此文件不会被使用。
 *       仅当显式设置 AGENT_BACKEND=local 时才会使用此 TS 实现。
 */

import { TaskComplexityAnalyzer } from '../../core/TaskComplexityAnalyzer';
import type { EvolutionEngine } from '../../evolution/EvolutionEngine';
import { ImplicitFeedbackCollector } from '../../evolution/ImplicitFeedbackCollector';
import { LearningStatusReporter } from '../../evolution/LearningStatusReporter';
import { skillUsageTracker } from '../../evolution/SkillUsageTracker';
import { perf } from '../../monitoring/PerformanceMonitor';
import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../utils/Logger';
import type { OrchestratorAgent } from '../orchestration/OrchestratorAgent';
import type { PersistenceService } from '../persistence/PersistenceService';
import type { TrajectoryDatabase } from '../persistence/TrajectoryDatabase';
import type {
  AgentResult,
  BudgetCheckResult,
  BudgetState,
  ChatMessage,
  ExecutionPlan,
  HookContext,
  HookResult,
  LoopContext,
  LoopTrace,
  PlanStep,
  QualityScore,
  StepResult,
  UserInput,
} from '../types';
import { LifecycleEvent, LoopState } from '../types';
import type { VerificationService } from '../verification/VerificationService';
import { LoopObserver } from './LoopObserver';

/** 辩论器输出 */
export interface DebaterOutput {
  /** 辩论是否通过（计划是否足够健壮） */
  passed: boolean;
  /** 发现的漏洞列表 */
  vulnerabilities: string[];
  /** 改进建议 */
  improvements: string[];
  /** 质量评分 (0-1) */
  qualityScore: number;
  /** 辩论轮次 */
  debateRounds: number;
}

/** 循环控制器依赖 */
export interface LoopControllerDeps {
  /** 规划器 */
  planner: {
    plan(input: UserInput, context: LoopContext): Promise<ExecutionPlan>;
  };
  /** 执行器 */
  executor: {
    execute(plan: ExecutionPlan, context: LoopContext): Promise<ExecutorOutput>;
    shouldReplan(
      evaluations: Array<{ score: number; isSufficient: boolean }>,
      roundsUsed: number
    ): { shouldReplan: boolean; reason: string; adjustmentHint?: string };
  };
  /** 评估器 */
  evaluator: {
    evaluate(input: UserInput, context: LoopContext): Promise<EvaluatorOutput>;
  };
  /** 报告器 */
  reporter: {
    report(context: LoopContext): Promise<ReporterOutput>;
  };
  /** 辩论器（可选，Plan-Battle-Execute 模式） */
  debater?: {
    debate(
      plan: ExecutionPlan,
      input: UserInput,
      context: LoopContext
    ): Promise<DebaterOutput>;
  };
  /** 约束服务 */
  constraintsService?: {
    checkBudget(state: BudgetState): BudgetCheckResult;
    executeHooks(
      event: LifecycleEvent,
      context: HookContext
    ): Promise<HookResult>;
  };
  /** 验证服务 */
  verificationService?: VerificationService;
  /** 持久化服务 */
  persistenceService?: PersistenceService;
  /** 轨迹数据库 */
  trajectoryDatabase?: TrajectoryDatabase;
  /** OrchestratorAgent（可选，处理复杂任务） */
  orchestratorAgent?: OrchestratorAgent;
  /** 进化引擎（可选，用于闭环反馈） */
  evolutionEngine?: {
    nudgeKnowledgePersistence(
      input: string,
      toolsUsed: string[]
    ): string | null;
    collectFeedback(
      input: string,
      response: string,
      result: {
        success: boolean;
        intent?: string;
        toolsUsed?: string[];
        error?: string;
      },
      scene?: string
    ): void;
    assessQuality(
      traceId: string,
      success: boolean,
      qualityScore: number,
      duration: number,
      scene?: string
    ): void;
    generateSkill(params: {
      input: string;
      response: string;
      toolsUsed: string[];
      totalDuration: number;
      qualityScore: number;
      traceId: string;
    }): string | null;
  };
  /** 反思引擎（可选，阶段3反思纠错） */
  reflectionEngine?: {
    reflect(
      toolName: string,
      args: Record<string, unknown>,
      error: string,
      context: { traceId: string; loopCount: number }
    ): Promise<{
      rootCause: string;
      correctedArgs: Record<string, unknown> | null;
      alternativeTool: string | null;
      shouldRetry: boolean;
    }>;
    recordExperience(entry: {
      toolName: string;
      args: Record<string, unknown>;
      error: string;
      rootCause: string;
      resolution: string;
      success: boolean;
    }): void;
    deepReflect(
      userInput: string,
      trajectory: Array<{
        toolName: string;
        success: boolean;
        error?: string;
        output?: string;
      }>,
      evalResult: {
        goalProgress: number;
        suggestedAction: string;
        reason: string;
      }
    ): Promise<{
      diagnosis: string;
      rootCause: string;
      fixStrategy: string;
      correctedPlan?: Array<{
        stepDescription: string;
        toolName?: string;
        args?: Record<string, unknown>;
      }>;
    }>;
  };
  /** 工具注册表（可选，用于工具发现与检索） */
  toolRegistry?: {
    getRegisteredToolNames(): string[];
    get(name: string): unknown;
    getAll(): unknown[];
  };
  /** 权限守卫（可选，用于工具调用权限检查） */
  permissionGuard?: {
    check(
      toolName: string,
      params?: Record<string, unknown>
    ): {
      allowed: boolean;
      missing: string[];
      reason?: string;
    };
  };
  /** 评估流水线（可选，多阶段评估） */
  evaluationPipeline?: {
    run(context: unknown): Promise<unknown>;
    addStage?(stage: unknown): void;
  };
  /** P5: StrategyAdjuster — 策略自适应调整器，驱动反思深度和重试次数自适应 */
  strategyAdjuster?: {
    recordSignal(signal: {
      signalType: 'positive' | 'negative' | 'task_success' | 'task_failure';
      toolName?: string;
      error?: string;
      quality?: number;
      duration?: number;
      timestamp: number;
    }): void;
    getAdjustedToolPriority(tools: string[]): string[];
    getAdjustedReflectionConfig(): {
      enableDeepReflection: boolean;
      maxRetries: number;
    };
  };
  /** P2: CausalModeler — 因果建模器，识别步骤依赖和并行机会 */
  causalModeler?: {
    buildCausalModel(
      task: string
    ): Promise<import('./CausalModeler').CausalGraph>;
    analyzeDependencies(
      graph: import('./CausalModeler').CausalGraph,
      stepId: string
    ): import('./CausalModeler').DependencyAnalysis;
    findParallelGroups(
      graph: import('./CausalModeler').CausalGraph
    ): string[][];
    getFailureImpact(
      graph: import('./CausalModeler').CausalGraph,
      stepId: string
    ): import('./CausalModeler').FailureImpact;
  };
  /** P3: TrajectoryFlywheel — 轨迹飞轮引擎，分析执行模式并生成优化建议 */
  trajectoryFlywheel?: {
    analyze(
      executionId?: string
    ): import('../persistence/TrajectoryFlywheel').TrajectoryAnalysis;
  };
}

/** 执行器输出 */
export interface ExecutorOutput {
  messages: ChatMessage[];
  toolCallsCount: number;
  toolDuration: number;
  completedNaturally: boolean;
  estimatedTokens?: number;
}

/** 评估器输出 */
export interface EvaluatorOutput {
  goalProgress: number;
  suggestedAction: 'continue' | 'replan' | 'abort';
  reason: string;
}

/** 报告器输出 */
export interface ReporterOutput {
  response: string;
  quality: QualityScore;
}

/** 默认预算 — 与 Executor 限制对齐 */
const DEFAULT_BUDGET: BudgetState = {
  roundsUsed: 0,
  softRoundLimit: 6,
  hardRoundLimit: 12,
  tokensUsed: 0,
  tokenWarningLimit: 6000,
  tokenHardLimit: 6000,
  startTime: 0,
  maxDurationMs: 60000,
  toolCallsUsed: 0,
  maxToolCalls: 20,
};

export class LoopController {
  private state: LoopState = LoopState.COMPLETED;
  private deps: LoopControllerDeps;
  private complexityAnalyzer: TaskComplexityAnalyzer;
  private aborted = false;
  /** 延迟初始化的 EvolutionEngine 实例（避免循环依赖） */
  private _evolutionEngine: EvolutionEngine | null = null;
  /** P5: 上一轮反思结论 — 注入到下一轮Thought阶段 */
  private _lastReflectionInsight: {
    rootCause: string;
    correctedArgs?: Record<string, unknown>;
    shouldRetry: boolean;
    diagnosis?: string;
    fixStrategy?: string;
  } | null = null;
  /** 最近一次 Pipeline 评估结果（用于持久化） */
  private lastPipelineResult: any = null;

  constructor(deps: LoopControllerDeps) {
    this.deps = deps;
    this.complexityAnalyzer = new TaskComplexityAnalyzer();
  }

  /**
   * 构建评估上下文（EvaluationPipeline 集成）
   * @param input - 用户输入
   * @param context - 循环上下文
   * @returns 评估上下文
   */
  private buildEvaluationContext(
    input: { text: string },
    context: LoopContext
  ): {
    stepParams: Array<{
      toolName: string;
      result: { success: boolean; output?: unknown; error?: string };
    }>;
    evalInput: { userInput: string };
    scorerMetadata: Record<string, unknown>;
  } {
    const stepParams: Array<{
      toolName: string;
      result: { success: boolean; output?: unknown; error?: string };
    }> = [];

    for (const [toolName, result] of context.stepResults) {
      stepParams.push({
        toolName,
        result: {
          success: result.success,
          output: result.output,
          error: result.error,
        },
      });
    }

    return {
      stepParams,
      evalInput: { userInput: input.text },
      scorerMetadata: {
        roundsUsed: context.budget?.roundsUsed || 0,
        toolCallsUsed: context.budget?.toolCallsUsed || 0,
        traceId: context.trace?.traceId,
      },
    };
  }

  /**
   * 使用 EvaluationPipeline 评估（Pipeline 集成）
   * @param input - 用户输入
   * @param context - 循环上下文
   * @returns 评估器输出
   */
  private async evaluateWithPipeline(
    input: { text: string; userId?: string; traceId?: string },
    context: LoopContext
  ): Promise<EvaluatorOutput> {
    if (!this.deps.evaluationPipeline) {
      // 无 Pipeline 时降级到 evaluator
      return this.deps.evaluator.evaluate(input as UserInput, context);
    }

    try {
      const evalContext = this.buildEvaluationContext(input, context);
      const result = (await this.deps.evaluationPipeline.run(
        evalContext
      )) as any;
      this.lastPipelineResult = result;

      // 优先使用独立评估结果
      if (result.independentResult?.overall) {
        return {
          goalProgress: result.independentResult.overall.goalProgress ?? 0.5,
          suggestedAction: result.independentResult.overall.suggestedAction,
          reason: result.independentResult.overall.summary || 'Pipeline评估',
        };
      }

      // 根据 overallScore 推断 suggestedAction
      const score = result.overallScore ?? 50;
      let suggestedAction: 'continue' | 'replan' | 'abort';
      if (score >= 60) {
        suggestedAction = 'continue';
      } else if (score >= 30) {
        suggestedAction = 'replan';
      } else {
        suggestedAction = 'abort';
      }

      return {
        goalProgress: Math.max(0, Math.min(1, score / 100)),
        suggestedAction,
        reason: result.passed
          ? 'Pipeline评估通过'
          : `Pipeline评估未通过（得分 ${score}）`,
      };
    } catch (err) {
      Logger.warn(
        `Pipeline评估失败，降级到evaluator: ${(err as Error).message}`,
        'LoopController'
      );
      return this.deps.evaluator.evaluate(input as UserInput, context);
    }
  }

  /**
   * 持久化评估结果到 TrajectoryDB（Pipeline 集成）
   * @param context - 循环上下文
   * @param evalResult - 评估结果
   */
  private persistEvaluationResult(
    context: LoopContext,
    evalResult: EvaluatorOutput
  ): void {
    const db = this.deps.trajectoryDatabase as any;
    if (!db) return;

    const traceId = context.trace?.traceId || 'unknown';
    const phase = context.trace?.state || 'evaluating';

    try {
      db.recordEvaluationResult({
        execution_id: traceId,
        phase,
        goal_progress: evalResult.goalProgress,
        suggested_action: evalResult.suggestedAction,
        reason: evalResult.reason,
        timestamp: Date.now(),
      });

      // 如果有 Pipeline 结果，额外持久化
      if (this.lastPipelineResult) {
        db.recordEvaluationResult({
          execution_id: traceId,
          phase: 'pipeline_quality',
          goal_progress: this.lastPipelineResult.overallScore
            ? this.lastPipelineResult.overallScore / 100
            : evalResult.goalProgress,
          suggested_action: evalResult.suggestedAction,
          reason: 'Pipeline质量评分',
          timestamp: Date.now(),
        });

        if (db.recordPipelineEvaluationResult) {
          db.recordPipelineEvaluationResult({
            executionId: traceId,
            pipelineResult: this.lastPipelineResult,
            suggestions: this.lastPipelineResult.suggestions || [],
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      Logger.warn(
        `持久化评估结果失败: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * 获取 EvolutionEngine 实例（延迟初始化）
   * 通过延迟初始化避免 AgentHarness 和 EvolutionEngine 之间的循环依赖
   */
  private get evolutionEngine(): EvolutionEngine | null {
    if (this._evolutionEngine === null && this.deps.evolutionEngine) {
      // 使用 deps.evolutionEngine 作为兼容接口
      // 实际类型是 EvolutionEngineDeps 适配器，来自 initHarness.ts
      this._evolutionEngine = this.deps
        .evolutionEngine as unknown as EvolutionEngine;
    }
    return this._evolutionEngine;
  }

  /**
   * 运行 Plan-Execute-Evaluate 循环 (支持多轮迭代)
   */
  async run(
    input: UserInput,
    initialMessages: ChatMessage[]
  ): Promise<AgentResult> {
    this.aborted = false;
    this.state = LoopState.COMPLETED; // 重置状态，允许从 COMPLETED 重新开始
    const traceId = input.traceId || `loop-${Date.now()}`;

    if (this.deps.trajectoryDatabase) {
      try {
        this.deps.trajectoryDatabase.recordExecution({
          id: traceId,
          user_id: input.userId,
          input: input.text,
          status: 'in_progress',
          loop_rounds: 0,
          total_tool_calls: 0,
          total_duration: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      } catch (err) {
        Logger.warn(
          `⚠️ 轨迹记录失败: ${(err as Error).message}`,
          'LoopController'
        );
      }
    }

    // 第一步: 复杂度分析
    const complexityResult = this.complexityAnalyzer.analyzeComplexity(
      input.text
    );
    Logger.info(
      `📊 任务复杂度分析: ${complexityResult.complexity}, 预估步骤: ${complexityResult.estimatedSteps}, 可并行: ${complexityResult.parallelizable}`,
      'LoopController'
    );

    // 如果是复杂任务且有 OrchestratorAgent，走多Agent编排路径
    if (
      this.deps.orchestratorAgent &&
      this.isComplexTask(complexityResult.complexity)
    ) {
      Logger.info(
        `🤖 检测到复杂任务，使用 OrchestratorAgent 处理`,
        'LoopController'
      );
      return this.runWithOrchestrator(input, initialMessages, traceId);
    }

    // 初始化循环上下文 — 根据任务复杂度自适应调整预算
    const adaptiveBudget = this.resolveAdaptiveBudget(
      complexityResult.complexity
    );
    const context: LoopContext = {
      messages: [...initialMessages],
      plan: null,
      currentStepIndex: 0,
      stepResults: new Map(),
      budget: { ...adaptiveBudget, startTime: Date.now() },
      trace: {
        traceId,
        state: LoopState.PLANNING,
        stateTransitions: [],
        trajectory: [],
        totalDuration: 0,
        totalToolCalls: 0,
        budgetState: adaptiveBudget,
      },
      metadata: { input: input.text },
      stepOutputs: new Map(),
      dataFlowChannels: [],
      crossStepState: new Map(),
      stepStates: new Map(),
      stepStateHistory: [],
    };

    Logger.info(`🔄 LoopController 启动 [${traceId}]`, 'LoopController');

    // Harness Engineering: 启动全链路追踪
    EventBus.startFullTrace(traceId);

    // ========== 集成：循环可观测性 ==========
    // 【集成点】循环开始时启动观察者
    // 可通过 LOOP_OBSERVER_ENABLED 环境变量控制是否启用
    const loopObserver = LoopObserver.getInstance();
    const observerEnabled =
      process.env.LOOP_OBSERVER_ENABLED === 'true' ||
      (loopObserver as any).enabled === true;
    if (observerEnabled) {
      try {
        if (typeof loopObserver.startLoop === 'function') {
          loopObserver.startLoop(input.text);
        }
        Logger.debug('循环观察者已启动', 'LoopController');
      } catch (obsErr) {
        Logger.warn(
          `循环观察者启动失败，已跳过: ${(obsErr as Error).message}`,
          'LoopController'
        );
      }
    }

    // ========== 集成：隐式反馈收集 ==========
    // 【集成点】用户消息到达时触发隐式反馈收集
    // 可通过 IMPLICIT_FEEDBACK_ENABLED 环境变量控制是否启用
    const feedbackCollector = ImplicitFeedbackCollector.getInstance();
    const feedbackEnabled =
      process.env.IMPLICIT_FEEDBACK_ENABLED === 'true' ||
      (feedbackCollector as any).enabled === true;
    if (feedbackEnabled) {
      try {
        // 异步执行，不阻塞主流程
        setImmediate(() => {
          if (typeof feedbackCollector.onUserMessage === 'function') {
            feedbackCollector.onUserMessage({
              content: input.text,
              userId: input.userId,
              traceId,
            });
          }
        });
      } catch (fbErr) {
        Logger.warn(
          `隐式反馈收集失败，已跳过: ${(fbErr as Error).message}`,
          'LoopController'
        );
      }
    }

    try {
      // Step 2: 保存任务状态 (Phase 1 之前)
      if (this.deps.persistenceService) {
        await this.deps.persistenceService.saveTaskState({
          taskId: traceId,
          userId: input.userId || 'default',
          description: input.text,
          status: 'in_progress',
          currentStepIndex: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      // BEFORE_LOOP 钩子
      await this.executeHook(LifecycleEvent.BEFORE_LOOP, context, {
        input: input.text,
      });

      // ─── 多轮迭代循环 ───
      let plan: import('../types').ExecutionPlan | null = null;
      let evalResult: EvaluatorOutput | null = null;
      let shouldContinueLoop = true;
      let replanNeeded = false;
      const MAX_REPLAN_COUNT = 2;

      while (shouldContinueLoop && !this.aborted) {
        // 检查预算
        const budgetCheck = this.checkBudget(context);
        if (!budgetCheck.withinBudget) {
          Logger.warn(
            `⚠️ 预算超限: ${budgetCheck.warnings.join('; ')}`,
            'LoopController'
          );
          await this.executeHook(LifecycleEvent.ON_BUDGET_EXCEEDED, context, {
            budgetState: context.budget,
          });
          this.transition(LoopState.BUDGET_EXCEEDED, context);
          shouldContinueLoop = false;
          break;
        }

        // ─── Phase 1: PLANNING (仅首次或需要 replan 时) ───
        if (!plan || replanNeeded) {
          const currentReplanCount =
            (context.metadata.replanCount as number) || 0;
          if (replanNeeded && currentReplanCount >= MAX_REPLAN_COUNT) {
            Logger.warn(
              '⚠️ 重新规划次数已达上限，强制结束循环',
              'LoopController'
            );
            shouldContinueLoop = false;
            break;
          }

          this.transition(LoopState.PLANNING, context);
          EventBus.addTracePhase(traceId, 'planning');

          // P0 修复：重规划时收集失败原因，直接传给 Planner
          if (replanNeeded) {
            const failureInfo = this.collectFailureInfoForReplan(context);
            if (failureInfo) {
              context.metadata.replanFailureReason = failureInfo.reason;
              context.metadata.replanFailedSteps = failureInfo.failedSteps;
              Logger.info(
                `🔄 重规划带入失败原因: ${failureInfo.reason.substring(0, 100)}`,
                'LoopController'
              );
            }
          }

          // ========== 集成：循环可观测性 ==========
          // 【集成点】规划阶段开始
          if (observerEnabled) {
            try {
              if (typeof loopObserver.startPhase === 'function') {
                loopObserver.startPhase('planner', input.text.substring(0, 50));
              }
            } catch {
              // 观察者失败不影响主流程
            }
          }

          plan = await perf.measure(
            'planner.plan',
            () => this.deps.planner.plan(input, context),
            'loop'
          );
          context.plan = plan;
          context.metadata.toolCallMode = plan.toolCallMode;
          context.metadata.replanCount =
            currentReplanCount + (replanNeeded ? 1 : 0);
          replanNeeded = false;

          // ========== 集成：循环可观测性 ==========
          // 【集成点】规划阶段结束
          if (loopObserver.isEnabled()) {
            try {
              loopObserver.endPhase(
                'planner',
                true,
                `步骤数: ${plan.steps.length}`
              );
            } catch {
              // 观察者失败不影响主流程
            }
          }

          this.recordSnapshot(context, 'planning', context.budget.roundsUsed, {
            planReasoning: plan.planReasoning?.substring(0, 500),
            stepsCount: plan.steps.length,
            isSimple: plan.simple,
          });

          if (plan.simple) {
            Logger.info('📋 简单任务，跳过规划直接执行', 'LoopController');
          } else {
            Logger.info(
              `📋 规划完成: ${plan.steps.length} 个步骤`,
              'LoopController'
            );
          }

          // F0-02: 将 Planner 的决策注入共享上下文，确保 Executor 和 Evaluator 看到完整规划
          this.injectPlanIntoContext(plan, context);
          EventBus.completeTracePhase(traceId, 'planning', true);

          // P2: CausalModeler — 因果建模分析（识别依赖和并行机会）
          if (!plan.simple && this.deps.causalModeler) {
            try {
              const causalGraph =
                await this.deps.causalModeler.buildCausalModel(input.text);
              if (causalGraph.nodes.length > 0) {
                const parallelGroups =
                  this.deps.causalModeler.findParallelGroups(causalGraph);
                context.metadata.causalGraph = causalGraph;
                context.metadata.parallelGroups = parallelGroups;
                Logger.info(
                  `🔗 因果建模完成: ${causalGraph.nodes.length} 节点, ${causalGraph.edges.length} 依赖, ${parallelGroups.length} 并行组`,
                  'LoopController'
                );
              }
            } catch (causalErr) {
              Logger.warn(
                `因果建模失败（不影响主流程）: ${(causalErr as Error).message}`,
                'LoopController'
              );
            }
          }

          await this.executeHook(LifecycleEvent.ON_PLAN_CREATED, context, {
            plan: plan.steps,
          });

          // ─── Harness Engineering: Plan-Battle-Execute 辩论验证 ───
          // 仅对非简单任务且有 debater 时执行辩论
          if (!plan.simple && this.deps.debater) {
            this.transition(LoopState.DEBATING, context);
            EventBus.addTracePhase(traceId, 'debating');
            Logger.info(
              `⚔️ Phase 1.5: 开始辩论验证 (Plan-Battle-Execute)`,
              'LoopController'
            );

            const debateResult = await perf.measure(
              'debater.debate',
              () => this.deps.debater!.debate(plan!, input, context),
              'loop'
            );

            this.recordSnapshot(
              context,
              'debating',
              context.budget.roundsUsed,
              {
                debatePassed: debateResult.passed,
                debateQuality: debateResult.qualityScore,
                debateRounds: debateResult.debateRounds,
                vulnerabilities: debateResult.vulnerabilities,
                improvements: debateResult.improvements,
              }
            );

            if (debateResult.passed) {
              Logger.info(
                `✅ 辩论通过: quality=${(debateResult.qualityScore * 100).toFixed(0)}% ` +
                  `rounds=${debateResult.debateRounds}`,
                'LoopController'
              );
              EventBus.completeTracePhase(traceId, 'debating', true);
            } else {
              Logger.warn(
                `⚠️ 辩论未通过: quality=${(debateResult.qualityScore * 100).toFixed(0)}% ` +
                  `vulnerabilities=${debateResult.vulnerabilities.length}`,
                'LoopController'
              );
              EventBus.completeTracePhase(traceId, 'debating', false);

              // 如果有改进建议，注入上下文让 Planner 重新规划
              if (debateResult.improvements.length > 0) {
                context.messages.push({
                  role: 'system',
                  content:
                    `【辩论反馈】计划存在以下问题：\n` +
                    debateResult.vulnerabilities
                      .map((v, i) => `${i + 1}. ${v}`)
                      .join('\n') +
                    '\n\n改进建议：\n' +
                    debateResult.improvements
                      .map((imp, i) => `${i + 1}. ${imp}`)
                      .join('\n') +
                    '\n请根据以上反馈重新制定计划。',
                });

                // 重新规划
                replanNeeded = true;
                continue;
              }
            }
          }
        }

        // ─── Phase 2: EXECUTING ───
        this.transition(LoopState.EXECUTING, context);
        EventBus.addTracePhase(traceId, 'executing');
        Logger.info(
          `🏃 Phase 2: 开始执行 (轮次=${context.budget.roundsUsed + 1})`,
          'LoopController'
        );

        // ========== 集成：循环可观测性 ==========
        // 【集成点】执行阶段开始
        if (loopObserver.isEnabled()) {
          try {
            loopObserver.startPhase(
              'executor',
              `轮次: ${context.budget.roundsUsed + 1}`
            );
          } catch {
            // 观察者失败不影响主流程
          }
        }

        // P5: 注入上一轮反思结论到本轮执行上下文（打通 ReAct 循环 Thought 阶段）
        // 反思结论直接影响下一轮 LLM 推理，而非仅作为日志记录
        if (this._lastReflectionInsight) {
          const reflectionHint = this.buildThoughtPrompt({
            userInput: input.text,
            currentStep: {
              tool:
                (plan.steps[context.currentStepIndex]?.toolName as string) ||
                'unknown',
              args:
                (plan.steps[context.currentStepIndex]?.toolParams as Record<
                  string,
                  unknown
                >) || {},
            },
          });
          context.messages.push({
            role: 'system',
            content: reflectionHint,
          });
          // 注入后清除，避免重复注入
          this._lastReflectionInsight = null;
          Logger.info(
            `🔄 P5 反思结论已注入本轮 Thought 阶段`,
            'LoopController'
          );
        }

        let executorOutput: ExecutorOutput;
        try {
          executorOutput = await perf.measure(
            'executor.execute',
            () => this.deps.executor.execute(plan!, context),
            'loop'
          );

          // ========== 集成：循环可观测性 ==========
          // 【集成点】执行阶段结束
          if (loopObserver.isEnabled()) {
            try {
              loopObserver.endPhase(
                'executor',
                true,
                `工具调用: ${executorOutput.toolCallsCount}次`
              );
            } catch {
              // 观察者失败不影响主流程
            }
          }
        } catch (execErr) {
          Logger.warn(
            `⚠️ 执行失败: ${(execErr as Error).message}，尝试反思纠错`,
            'LoopController'
          );

          if (this.deps.reflectionEngine && plan.steps.length > 0) {
            const failedStep = this.findFailedStep(plan, context);
            if (failedStep?.toolName) {
              const toolArgs = failedStep.toolParams ?? {};
              const reflection = await this.deps.reflectionEngine.reflect(
                failedStep.toolName,
                toolArgs,
                (execErr as Error).message,
                {
                  traceId: context.trace.traceId,
                  loopCount: context.budget.roundsUsed,
                }
              );

              Logger.info(
                `🧠 反思结果: 根因=${reflection.rootCause} shouldRetry=${reflection.shouldRetry}`,
                'LoopController'
              );

              this.deps.reflectionEngine.recordExperience({
                toolName: failedStep.toolName,
                args: toolArgs,
                error: (execErr as Error).message,
                rootCause: reflection.rootCause,
                resolution: reflection.correctedArgs
                  ? '修正参数后重试'
                  : reflection.shouldRetry
                    ? '重试'
                    : '不重试',
                success: reflection.shouldRetry,
              });

              if (reflection.shouldRetry && reflection.correctedArgs) {
                failedStep.toolParams = {
                  ...failedStep.toolParams,
                  ...reflection.correctedArgs,
                };
                Logger.info(
                  `🔄 参数已修正，重试执行: ${JSON.stringify(reflection.correctedArgs)}`,
                  'LoopController'
                );
                executorOutput = await perf.measure(
                  'executor.execute',
                  () => this.deps.executor.execute(plan!, context),
                  'loop'
                );
              } else if (reflection.shouldRetry && reflection.alternativeTool) {
                const registeredTools =
                  this.deps.toolRegistry?.getRegisteredToolNames() ?? [];
                if (registeredTools.includes(reflection.alternativeTool)) {
                  Logger.info(
                    `🔄 切换替代工具: ${failedStep.toolName} → ${reflection.alternativeTool}`,
                    'LoopController'
                  );
                  failedStep.toolName = reflection.alternativeTool;
                  executorOutput = await perf.measure(
                    'executor.execute',
                    () => this.deps.executor.execute(plan!, context),
                    'loop'
                  );
                } else {
                  Logger.warn(
                    `⚠️ 替代工具 ${reflection.alternativeTool} 未注册，降级处理`,
                    'LoopController'
                  );
                  throw execErr;
                }
              } else {
                throw execErr;
              }
            } else {
              throw execErr;
            }
          } else {
            throw execErr;
          }
        }
        Logger.info(
          `✅ Phase 2: 执行完成 (工具调用=${executorOutput.toolCallsCount}次, 消息数=${executorOutput.messages.length})`,
          'LoopController'
        );

        // Harness Engineering: 记录执行阶段完成 + Token/工具调用追踪
        EventBus.completeTracePhase(traceId, 'executing', true);
        if (executorOutput.estimatedTokens) {
          EventBus.recordTokenUsage(
            traceId,
            'default',
            executorOutput.estimatedTokens,
            0
          );
        }
        EventBus.recordToolCall(
          traceId,
          'batch',
          executorOutput.toolCallsCount > 0,
          executorOutput.toolDuration
        );

        if (
          !executorOutput.completedNaturally &&
          executorOutput.toolCallsCount === 0
        ) {
          throw new Error('LLM 调用失败，无法生成响应');
        }

        this.recordSnapshot(context, 'executing', context.budget.roundsUsed, {
          toolCallsCount: executorOutput.toolCallsCount,
          toolDuration: executorOutput.toolDuration,
          completedNaturally: executorOutput.completedNaturally,
          newMessagesCount: executorOutput.messages.length,
        });

        // 验证工具结果
        if (this.deps.verificationService) {
          const toolMessages = executorOutput.messages.filter(
            (m) => m.role === 'tool' && m.name
          );
          for (const toolMsg of toolMessages) {
            const toolName = toolMsg.name as string;
            const toolResult = {
              success: !(toolMsg.content as string).startsWith('错误:'),
              output: toolMsg.content,
              duration: 0,
              validated: false,
            };
            const validation = this.deps.verificationService.validateToolResult(
              toolName,
              toolResult
            );
            if (validation.warnings.length > 0) {
              Logger.warn(
                `⚠️ 工具 ${toolName} 验证警告: ${validation.warnings.join('; ')}`,
                'LoopController'
              );
            }
            if (validation.errors.length > 0) {
              Logger.error(
                `❌ 工具 ${toolName} 验证错误: ${validation.errors.join('; ')}`,
                new Error(validation.errors.join('; ')),
                'LoopController'
              );
            }
          }
        }

        // P5: 工具执行失败后触发反思，保存结论供下一轮Thought
        const failedToolMessage = executorOutput.messages.find(
          (m) =>
            m.role === 'tool' &&
            typeof m.content === 'string' &&
            (m.content.startsWith('错误:') || m.content.startsWith('错误'))
        );
        if (failedToolMessage) {
          await this.triggerReflectionIfNeeded({
            userInput: input.text,
            toolResult: {
              success: false,
              error: failedToolMessage.content as string,
              output: failedToolMessage.content,
            },
            loopCount: context.budget.roundsUsed,
          });
        }

        // 更新上下文（含token估算）
        context.messages = executorOutput.messages;
        context.budget.roundsUsed++;
        context.budget.toolCallsUsed += executorOutput.toolCallsCount;
        context.budget.tokensUsed += executorOutput.estimatedTokens || 0;
        context.trace.totalToolCalls += executorOutput.toolCallsCount;

        // 追踪工具使用情况到 SkillUsageTracker
        this.trackToolUsage(executorOutput.messages);

        // ─── Phase 3: EVALUATING ───
        this.transition(LoopState.EVALUATING, context);
        EventBus.addTracePhase(traceId, 'evaluating');

        // ========== 集成：循环可观测性 ==========
        // 【集成点】评估阶段开始
        if (loopObserver.isEnabled()) {
          try {
            loopObserver.startPhase('evaluator', '');
          } catch {
            // 观察者失败不影响主流程
          }
        }

        evalResult = await perf.measure(
          'evaluator.evaluate',
          () => this.deps.evaluator.evaluate(input, context),
          'loop'
        );

        // ========== 集成：循环可观测性 ==========
        // 【集成点】评估阶段结束
        if (loopObserver.isEnabled()) {
          try {
            loopObserver.endPhase(
              'evaluator',
              true,
              `进度: ${(evalResult.goalProgress * 100).toFixed(0)}%`
            );
          } catch {
            // 观察者失败不影响主流程
          }
        }

        this.recordSnapshot(context, 'evaluating', context.budget.roundsUsed, {
          goalProgress: evalResult.goalProgress,
          suggestedAction: evalResult.suggestedAction,
          reason: evalResult.reason,
        });

        Logger.info(
          `📊 第 ${context.budget.roundsUsed} 轮: 进度=${(evalResult.goalProgress * 100).toFixed(0)}% 动作=${evalResult.suggestedAction}`,
          'LoopController'
        );

        // Harness Engineering: 评估阶段完成
        EventBus.completeTracePhase(traceId, 'evaluating', true);

        // P2: 累积评估历史 — 供 shouldReplan 步骤级动态调整使用
        if (!context.metadata.evaluationHistory) {
          context.metadata.evaluationHistory = [];
        }
        (
          context.metadata.evaluationHistory as Array<{
            score: number;
            isSufficient: boolean;
          }>
        ).push({
          score: evalResult.goalProgress,
          isSufficient: evalResult.goalProgress >= 0.9,
        });

        // 根据评估结果决定下一步
        switch (evalResult.suggestedAction) {
          case 'continue':
            if (evalResult.goalProgress >= 0.9) {
              if (
                plan.steps.length > 1 &&
                context.budget.roundsUsed < plan.steps.length
              ) {
                Logger.info(
                  `📊 进度高但仍有未完成步骤 (${context.budget.roundsUsed}/${plan.steps.length})，继续执行`,
                  'LoopController'
                );
              } else {
                shouldContinueLoop = false;
                Logger.info('✅ 目标已基本达成，结束循环', 'LoopController');
              }
            } else if (
              context.budget.roundsUsed >= context.budget.softRoundLimit
            ) {
              if (evalResult.goalProgress < 0.3) {
                shouldContinueLoop = false;
                Logger.info(
                  '⚠️ 进展缓慢且接近轮次限制，强制结束',
                  'LoopController'
                );
              }
            }

            // P2: 步骤级动态调整 — 检查是否需要提前重规划
            if (shouldContinueLoop && !replanNeeded) {
              try {
                const evalHistory = context.metadata.evaluationHistory as
                  | Array<{ score: number; isSufficient: boolean }>
                  | undefined;
                if (evalHistory && evalHistory.length > 0) {
                  const replanDecision = this.deps.executor.shouldReplan(
                    evalHistory,
                    context.budget.roundsUsed
                  );
                  if (replanDecision.shouldReplan) {
                    replanNeeded = true;
                    Logger.info(
                      `🔄 步骤级动态调整触发重规划: ${replanDecision.reason}${replanDecision.adjustmentHint ? ` (${replanDecision.adjustmentHint})` : ''}`,
                      'LoopController'
                    );
                  }
                }
              } catch {
                // shouldReplan 检查失败不影响主流程
              }
            }
            break;

          case 'replan':
            if (this.wasLastFailureRetryable(context)) {
              const lastStepResult = this.getLastFailedStepResult(context);
              const retryCount =
                (lastStepResult?.metadata?.retryCount as number) || 0;
              const maxRetries = 2;
              if (retryCount < maxRetries) {
                Logger.info(
                  `🔄 上次失败为可重试错误(retryCount=${retryCount})，跳过重新规划，重试当前计划`,
                  'LoopController'
                );
                if (lastStepResult && this.deps.reflectionEngine) {
                  await this.reflectOnFailure(lastStepResult, context);
                }
              } else {
                replanNeeded = true;
                Logger.info(
                  '🔄 可重试错误已达最大重试次数，重新规划',
                  'LoopController'
                );
              }
            } else {
              if (this.deps.reflectionEngine && evalResult.goalProgress < 0.5) {
                await this.triggerDeepReflection(input, context, evalResult);
              }
              replanNeeded = true;
              Logger.info('🔄 评估建议重新规划', 'LoopController');
            }
            break;

          case 'abort':
            // 主动中止
            shouldContinueLoop = false;
            Logger.info('🛑 评估建议中止执行', 'LoopController');
            break;

          default:
            // 未知动作，保守处理
            shouldContinueLoop = false;
            Logger.warn(
              `⚠️ 未知评估动作: ${evalResult.suggestedAction}`,
              'LoopController'
            );
        }

        // ON_STEP_COMPLETED 钩子
        await this.executeHook(LifecycleEvent.ON_STEP_COMPLETED, context, {
          goalProgress: evalResult.goalProgress,
          suggestedAction: evalResult.suggestedAction,
          roundsUsed: context.budget.roundsUsed,
        });
      }

      // ─── 循环结束 ───
      // BEFORE_RESPONSE 钩子
      await this.executeHook(LifecycleEvent.BEFORE_RESPONSE, context, {});

      // ─── Phase 4: REPORTING ───
      this.transition(LoopState.REPORTING, context);
      EventBus.addTracePhase(traceId, 'reporting');

      // ========== 集成：循环可观测性 ==========
      // 【集成点】报告阶段开始
      if (loopObserver.isEnabled()) {
        try {
          loopObserver.startPhase('reporter', '');
        } catch {
          // 观察者失败不影响主流程
        }
      }

      const report = await perf.measure(
        'reporter.report',
        () => this.deps.reporter.report(context),
        'loop'
      );

      this.recordSnapshot(context, 'reporting', context.budget.roundsUsed, {
        responseLength: report.response.length,
        qualityOverall: report.quality.overall,
      });

      // 结合验证服务评估质量
      let finalQuality = report.quality;
      if (this.deps.verificationService) {
        const verificationQuality = this.deps.verificationService.scoreQuality({
          loopCount: context.budget.roundsUsed,
          totalToolCalls: context.trace.totalToolCalls,
          totalToolDuration: 0,
          totalDuration: Date.now() - context.budget.startTime,
          completedSuccessfully: true,
        });

        // 合并质量评分，取平均值
        finalQuality = {
          overall: (report.quality.overall + verificationQuality.overall) / 2,
          accuracy:
            (report.quality.accuracy + verificationQuality.accuracy) / 2,
          usefulness:
            (report.quality.usefulness + verificationQuality.usefulness) / 2,
          friendliness:
            (report.quality.friendliness + verificationQuality.friendliness) /
            2,
          efficiency:
            (report.quality.efficiency + verificationQuality.efficiency) / 2,
          details: `${report.quality.details} | ${verificationQuality.details}`,
        };
      }

      // ========== 集成：循环可观测性 ==========
      // 【集成点】报告阶段结束
      if (loopObserver.isEnabled()) {
        try {
          loopObserver.endPhase(
            'reporter',
            true,
            `质量: ${(finalQuality.overall * 100).toFixed(0)}%`
          );
        } catch {
          // 观察者失败不影响主流程
        }
      }

      // 完成
      this.transition(LoopState.COMPLETED, context);
      context.trace.totalDuration = Date.now() - context.budget.startTime;

      // Harness Engineering: 完成全链路追踪
      EventBus.completeTracePhase(traceId, 'reporting', true);
      EventBus.completeFullTrace(traceId, 'completed');

      // 更新任务状态为 completed
      if (this.deps.persistenceService) {
        await this.deps.persistenceService.updateTaskStatus(
          traceId,
          'completed'
        );
      }

      // H3 fix: 轨迹数据库同步更新（before returning response, not fire-and-forget）
      if (this.deps.trajectoryDatabase) {
        try {
          this.deps.trajectoryDatabase.updateExecutionStatus(
            traceId,
            'success',
            report.response
          );
          const exec = this.deps.trajectoryDatabase.getExecution(traceId);
          if (exec) {
            exec.loop_rounds = context.budget.roundsUsed;
            exec.total_tool_calls = context.trace.totalToolCalls;
            exec.total_duration = context.trace.totalDuration;
            exec.quality_overall = finalQuality.overall;
            this.deps.trajectoryDatabase.recordExecution(exec);
          }
        } catch (err) {
          // H3: single retry on failure
          Logger.warn(
            `⚠️ 轨迹更新失败，重试中: ${(err as Error).message}`,
            'LoopController'
          );
          try {
            this.deps.trajectoryDatabase.recordExecution({
              id: traceId,
              input: (context.metadata.input as string) || '',
              response: report.response,
              status: 'success',
              loop_rounds: context.budget.roundsUsed,
              total_tool_calls: context.trace.totalToolCalls,
              total_duration: context.trace.totalDuration,
              quality_overall: finalQuality.overall,
              created_at: Date.now(),
              updated_at: Date.now(),
            });
          } catch (retryErr) {
            Logger.error(
              `❌ 轨迹持久化最终失败: ${(retryErr as Error).message}`,
              retryErr as Error,
              'LoopController'
            );
          }
        }
      }

      // AFTER_RESPONSE 钩子
      await this.executeHook(LifecycleEvent.AFTER_RESPONSE, context, {
        input: input.text,
        response: report.response,
        quality: finalQuality,
        loopRounds: context.budget.roundsUsed,
      });

      // 🧬 进化闭环：在 AFTER_RESPONSE 后触发学习
      await this.triggerEvolution闭环(input, report, finalQuality, context);

      // ========== 集成：循环可观测性 ==========
      // 【集成点】循环结束
      if (loopObserver.isEnabled()) {
        try {
          loopObserver.endLoop(true, null, report.response.substring(0, 100));
        } catch {
          // 观察者失败不影响主流程
        }
      }

      // ========== 集成：隐式反馈收集 ==========
      // 【集成点】AI 回复生成后触发隐式反馈收集
      if (feedbackEnabled) {
        try {
          // 异步执行，不阻塞主流程
          setImmediate(() => {
            if (typeof feedbackCollector.onAiMessage === 'function') {
              feedbackCollector.onAiMessage({
                content: report.response,
                traceId,
                quality: finalQuality.overall,
              });
            }
          });

          // 将收集到的反馈传递给进化引擎
          if (typeof feedbackCollector.getStatistics === 'function') {
            const stats = feedbackCollector.getStatistics();
            if (this.evolutionEngine && stats.totalSignals > 0) {
              try {
                this.evolutionEngine.collectFeedback(
                  input.text,
                  report.response,
                  {
                    success: finalQuality.overall >= 0.6,
                    toolsUsed: [], // 可以从 context 中提取
                  },
                  'implicit'
                );
              } catch {
                // 反馈传递失败不影响主流程
              }
            }
          }
        } catch (fbErr) {
          Logger.warn(
            `隐式反馈收集失败，已跳过: ${(fbErr as Error).message}`,
            'LoopController'
          );
        }
      }

      // ========== 集成：学习效果可视化 ==========
      // 【集成点】循环结束时生成学习状态报告（仅 debug 模式）
      if (process.env.DEBUG_LEARNING_STATUS === 'true') {
        try {
          const report = LearningStatusReporter.generateSummary({
            // 从各数据源获取数据
            summary: {
              totalInteractions: 1,
              totalOptimizations: 0,
              averageQualityScore: finalQuality.overall,
              weeklyImprovement: 0,
              enginesActive: [],
            },
            quality: {
              current: finalQuality.overall,
              trend: 'stable',
              recentScores: [finalQuality.overall],
              failureRate: finalQuality.overall >= 0.6 ? 0 : 1,
            },
            performance: {
              averageResponseTime: context.trace.totalDuration,
              p95ResponseTime: context.trace.totalDuration,
              throughput: 0,
            },
            optimization: {
              lastCycleTime: null,
              cyclesToday: 0,
              totalCycles: 0,
              successRate: 0,
              recentCycles: [],
            },
            evolution: null,
            codeEvolution: null,
            engines: {
              toolWeights: {},
              userProfileConfidence: 0,
              taskAdjustmentCount: 0,
            },
            verification: {
              totalVerifications: 0,
              successRate: 0,
              recentResults: [],
            },
          });
          Logger.debug(`学习状态: ${report}`, 'LoopController');
        } catch {
          // 学习状态报告失败不影响主流程
        }
      }

      Logger.info(
        `✅ LoopController 完成 [${traceId}] 耗时=${context.trace.totalDuration}ms 轮次=${context.budget.roundsUsed} 工具=${context.trace.totalToolCalls}次`,
        'LoopController'
      );

      return {
        response: report.response,
        quality: finalQuality,
        trace: context.trace,
        metadata: {
          loopRounds: context.budget.roundsUsed,
          toolCalls: context.trace.totalToolCalls,
          duration: context.trace.totalDuration,
        },
      };
    } catch (err) {
      this.transition(LoopState.FAILED, context);
      Logger.error('LoopController 失败', err as Error, 'LoopController');

      // Harness Engineering: 失败时完成全链路追踪
      EventBus.completeFullTrace(traceId, 'failed');

      // ========== 集成：循环可观测性 ==========
      // 【集成点】循环失败时结束观察者
      if (observerEnabled) {
        try {
          if (typeof loopObserver.endLoop === 'function') {
            loopObserver.endLoop(false, (err as Error).message, '');
          }
        } catch {
          // 观察者失败不影响主流程
        }
      }

      if (this.deps.persistenceService) {
        await this.deps.persistenceService.updateTaskStatus(
          traceId,
          'failed',
          (err as Error).message
        );
      }

      const lastAssistantMsg = this.getLastAssistantMessage(context);
      if (lastAssistantMsg) {
        Logger.info('⚠️ 返回部分响应（含质量警告）', 'LoopController');
        return {
          response: lastAssistantMsg,
          quality: {
            overall: 0.4,
            accuracy: 0.3,
            usefulness: 0.5,
            friendliness: 0.6,
            efficiency: 0.2,
            details: '部分响应（执行异常降级）',
          },
          trace: context.trace,
          metadata: { error: (err as Error).message, degraded: true },
        };
      }

      return {
        response: `抱歉，处理过程中出现了问题：${(err as Error).message}`,
        quality: {
          overall: 0.1,
          accuracy: 0,
          usefulness: 0,
          friendliness: 0.5,
          efficiency: 0,
          details: '执行失败',
        },
        trace: context.trace,
        metadata: { error: (err as Error).message },
      };
    }
  }

  /**
   * 获取当前状态
   */
  getState(): LoopState {
    return this.state;
  }

  /**
   * 中止循环
   */
  abort(): void {
    this.aborted = true;
    // Fix: notify frontend on abort
    void EventBus.emit('agent_execution_update', {
      traceId: '',
      phase: 'aborted',
      status: 'aborted',
      message: '执行已被中止',
      timestamp: new Date().toISOString(),
    });
    Logger.info('🛑 LoopController 中止', 'LoopController');
  }

  /**
   * 获取追踪信息
   */
  getTrace(context: LoopContext): LoopTrace {
    return context.trace;
  }

  /**
   * 追踪工具使用情况到 SkillUsageTracker
   * @param messages - 执行器返回的消息列表
   */
  private trackToolUsage(messages: ChatMessage[]): void {
    try {
      // 从 tool 消息中提取工具名称
      const toolNames = messages
        .filter((m) => m.role === 'tool' && m.name)
        .map((m) => String(m.name));

      for (const toolName of toolNames) {
        skillUsageTracker.trackUse(toolName);
        Logger.debug(`📊 工具使用追踪: ${toolName}`, 'LoopController');
      }
    } catch (err) {
      Logger.warn(
        `⚠️ SkillUsageTracker 更新失败: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * P5: 构建Thought阶段的Prompt — 深度注入上一轮反思结论
   *
   * Hermes级别要求：反思结论不是简单的系统提示，而是直接影响下一轮的推理过程
   * @param params - 包含用户输入和当前步骤信息
   * @returns 构建好的Thought阶段Prompt字符串
   */
  /**
   * P0 修复：收集失败信息用于重规划
   * 从 stepResults 中提取失败步骤的工具名、错误原因，传给 Planner
   */
  private collectFailureInfoForReplan(context: LoopContext): {
    reason: string;
    failedSteps: Array<{ toolName: string; error: string; stepId: string }>;
  } | null {
    if (context.stepResults.size === 0) return null;

    const failedSteps: Array<{
      toolName: string;
      error: string;
      stepId: string;
    }> = [];
    for (const [stepId, result] of context.stepResults.entries()) {
      if (!result.success) {
        failedSteps.push({
          toolName: result.toolName || `step_${stepId}`,
          error: result.error || '未知错误',
          stepId,
        });
      }
    }

    if (failedSteps.length === 0) return null;

    const reason = failedSteps
      .map((f) => `${f.toolName}(${f.stepId}): ${f.error.substring(0, 80)}`)
      .join('; ');

    return { reason, failedSteps };
  }

  private buildThoughtPrompt(params: {
    userInput: string;
    currentStep: { tool: string; args: Record<string, unknown> };
  }): string {
    const { userInput, currentStep } = params;
    let prompt = `【当前任务】${userInput}\n【当前步骤】工具: ${currentStep.tool}, 参数: ${JSON.stringify(currentStep.args)}`;

    // P5: 深度注入上一轮反思结论
    if (this._lastReflectionInsight) {
      const insight = this._lastReflectionInsight;
      prompt += `\n\n【上一轮反思结论】`;
      prompt += `\n- 根因分析: ${insight.rootCause}`;
      if (insight.diagnosis) {
        prompt += `\n- 诊断: ${insight.diagnosis}`;
      }
      if (insight.fixStrategy) {
        prompt += `\n- 修复策略: ${insight.fixStrategy}`;
      }
      if (insight.correctedArgs) {
        prompt += `\n- 建议参数: ${JSON.stringify(insight.correctedArgs)}`;
      }
      prompt += `\n- 是否重试: ${insight.shouldRetry ? '是' : '否'}`;
      prompt += `\n\n请基于以上反思结论调整当前步骤的执行策略。`;
    }

    return prompt;
  }

  /**
   * P5: 在需要时触发反思并保存结论
   * @param params - 包含用户输入、工具结果和循环计数
   * @returns Promise<void>
   */
  private async triggerReflectionIfNeeded(params: {
    userInput: string;
    toolResult: { success: boolean; error?: string; output?: unknown };
    loopCount: number;
  }): Promise<void> {
    if (!this.deps?.reflectionEngine) return;
    if (params.toolResult.success) return;

    // P5: 基于学习信号自适应调整反思深度和重试次数
    let enableDeepReflection = true;
    let adjustedMaxRetries = 2;
    if (this.deps?.strategyAdjuster) {
      try {
        const config = this.deps.strategyAdjuster.getAdjustedReflectionConfig();
        enableDeepReflection = config.enableDeepReflection;
        adjustedMaxRetries = config.maxRetries;
        Logger.info(
          `📊 P5 策略自适应: 深度反思=${enableDeepReflection}, 最大重试=${adjustedMaxRetries}`,
          'LoopController'
        );
      } catch {
        // 回退到默认配置
      }
    }

    // P5: 高成功率时跳过不必要的反思（策略自适应优化）
    if (!enableDeepReflection && params.loopCount > 1) {
      Logger.debug('P5 策略自适应: 高成功率，跳过深度反思', 'LoopController');
      return;
    }

    try {
      const reflection = await this.deps.reflectionEngine.reflect(
        'unknown',
        {},
        params.toolResult.error || '执行失败',
        { traceId: `loop-${params.loopCount}`, loopCount: params.loopCount }
      );

      // 保存反思结论供下一轮Thought使用
      // 注：reflect() 返回类型不包含 diagnosis/fixStrategy，使用类型断言以兼容扩展字段
      const extendedReflection = reflection as {
        rootCause: string;
        correctedArgs: Record<string, unknown> | null;
        shouldRetry: boolean;
        diagnosis?: string;
        fixStrategy?: string;
      };

      this._lastReflectionInsight = {
        rootCause: extendedReflection.rootCause || '未知根因',
        correctedArgs: extendedReflection.correctedArgs || undefined,
        shouldRetry: extendedReflection.shouldRetry ?? false,
        diagnosis: extendedReflection.diagnosis || undefined,
        fixStrategy: extendedReflection.fixStrategy || undefined,
      };

      // P5: 记录任务级学习信号到 StrategyAdjuster
      if (this.deps?.strategyAdjuster) {
        try {
          this.deps.strategyAdjuster.recordSignal({
            signalType: 'task_failure',
            error: params.toolResult.error,
            timestamp: Date.now(),
          });
        } catch {
          // 忽略
        }
      }

      Logger.info(
        `🔄 P5 反思结论已保存，将注入下一轮Thought: ${this._lastReflectionInsight.rootCause}`,
        'LoopController'
      );
    } catch (err) {
      Logger.debug(
        `P5 反思触发失败: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * 触发进化闭环
   * 在任务完成后调用 EvolutionEngine 的学习相关方法
   */
  private async triggerEvolution闭环(
    input: UserInput,
    report: ReporterOutput,
    finalQuality: QualityScore,
    context: LoopContext
  ): Promise<void> {
    const evo = this.deps.evolutionEngine;
    if (!evo) return;

    try {
      const inputText = input.text;
      const responseText = report.response;
      const traceId = context.trace.traceId;
      const toolsUsed = this.extractToolsUsed(context);
      const totalDuration = context.trace.totalDuration;
      const qualityScore = finalQuality.overall;

      // 1. 调用 nudgeKnowledgePersistence() - 知识持久化提醒
      const nudge = evo.nudgeKnowledgePersistence(inputText, toolsUsed);
      if (nudge) {
        Logger.info(`🧠 知识持久化提醒: ${nudge}`, 'LoopController');
      }

      // 2. 调用 collectFeedback() - 收集反馈
      evo.collectFeedback(inputText, responseText, {
        success: qualityScore >= 0.5,
        toolsUsed,
      });

      // 3. 调用 assessQuality() - 评估质量
      evo.assessQuality(
        traceId,
        qualityScore >= 0.5,
        qualityScore,
        totalDuration
      );

      // P5: 记录任务级学习信号到 StrategyAdjuster（打通学习闭环）
      // 任务成功时记录 task_success，使策略调整器能准确计算整体成功率
      if (this.deps?.strategyAdjuster) {
        try {
          this.deps.strategyAdjuster.recordSignal({
            signalType: 'task_success',
            quality: qualityScore,
            duration: totalDuration,
            timestamp: Date.now(),
          });
          Logger.debug(
            `📊 P5 学习闭环: task_success 信号已记录 (quality=${qualityScore.toFixed(2)})`,
            'LoopController'
          );
        } catch {
          // 忽略策略调整失败
        }
      }

      // 4. 高质量任务触发 generateSkill() - 自动生成技能
      if (qualityScore >= 0.7) {
        const skillPath = evo.generateSkill({
          input: inputText,
          response: responseText,
          toolsUsed,
          totalDuration,
          qualityScore,
          traceId,
        });
        if (skillPath) {
          Logger.info(`🧬 自动生成技能: ${skillPath}`, 'LoopController');
        }
      }

      // P3: TrajectoryFlywheel — 轨迹飞轮分析（生成优化建议）
      if (this.deps.trajectoryFlywheel) {
        try {
          const analysis = this.deps.trajectoryFlywheel.analyze(traceId);
          if (analysis.optimizationSuggestions.length > 0) {
            Logger.info(
              `🔄 轨迹飞轮: ${analysis.optimizationSuggestions.length} 条优化建议`,
              'LoopController'
            );
            for (const suggestion of analysis.optimizationSuggestions.slice(
              0,
              3
            )) {
              Logger.info(
                `  💡 [${suggestion.priority}] ${suggestion.description} (预期改善: ${suggestion.estimatedImprovement}%)`,
                'LoopController'
              );
            }
          }
        } catch (flywheelErr) {
          Logger.debug(
            `轨迹飞轮分析失败（不影响主流程）: ${(flywheelErr as Error).message}`,
            'LoopController'
          );
        }
      }

      Logger.debug(
        `🧬 进化闭环完成: quality=${qualityScore.toFixed(2)} tools=${toolsUsed.length}`,
        'LoopController'
      );
    } catch (err) {
      Logger.warn(
        `⚠️ 进化闭环执行失败: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * 从上下文提取已使用的工具列表
   */
  private extractToolsUsed(context: LoopContext): string[] {
    const tools = new Set<string>();
    for (const msg of context.messages) {
      if (msg.role === 'tool' && msg.name) {
        tools.add(String(msg.name));
      }
      // 也检查 tool_calls
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<{
          function?: { name?: string };
        }>) {
          if (tc.function?.name) {
            tools.add(tc.function.name);
          }
        }
      }
    }
    return Array.from(tools);
  }

  /**
   * 状态转换
   */
  // Fix: valid state transitions — blocks impossible transitions
  private static readonly VALID_TRANSITIONS: Map<LoopState, LoopState[]> =
    new Map([
      [
        LoopState.PLANNING,
        [
          LoopState.DEBATING,
          LoopState.EXECUTING,
          LoopState.FAILED,
          LoopState.ABORTED,
        ],
      ],
      [
        LoopState.DEBATING,
        [
          LoopState.PLANNING,
          LoopState.EXECUTING,
          LoopState.FAILED,
          LoopState.ABORTED,
        ],
      ],
      [
        LoopState.EXECUTING,
        [LoopState.EVALUATING, LoopState.FAILED, LoopState.ABORTED],
      ],
      [
        LoopState.EVALUATING,
        [
          LoopState.REPORTING,
          LoopState.PLANNING,
          LoopState.ABORTED,
          LoopState.BUDGET_EXCEEDED,
        ],
      ],
      [LoopState.REPORTING, [LoopState.COMPLETED, LoopState.FAILED]],
      [LoopState.COMPLETED, []],
      [LoopState.FAILED, []],
      [LoopState.ABORTED, []],
      [LoopState.BUDGET_EXCEEDED, [LoopState.COMPLETED, LoopState.FAILED]],
    ]);

  private transition(newState: LoopState, context: LoopContext): void {
    const prev = this.state;
    if (prev !== LoopState.COMPLETED) {
      const allowed = LoopController.VALID_TRANSITIONS.get(prev);
      if (allowed && !allowed.includes(newState) && allowed.length > 0) {
        Logger.warn(
          `⚠️ 非法状态转换: ${prev} → ${newState}，已阻止`,
          'LoopController'
        );
        return;
      }
    }
    this.state = newState;
    context.trace.state = newState;
    context.trace.stateTransitions.push({
      state: newState,
      timestamp: Date.now(),
    });

    const phaseMap: Record<LoopState, string> = {
      [LoopState.PLANNING]: 'planning',
      [LoopState.DEBATING]: 'debating',
      [LoopState.EXECUTING]: 'executing',
      [LoopState.EVALUATING]: 'evaluating',
      [LoopState.REPORTING]: 'reporting',
      [LoopState.COMPLETED]: 'completed',
      [LoopState.FAILED]: 'failed',
      [LoopState.ABORTED]: 'aborted',
      [LoopState.BUDGET_EXCEEDED]: 'budget_exceeded',
    };

    const phaseName = phaseMap[newState] || 'unknown';
    const statusMap: Record<LoopState, string> = {
      [LoopState.PLANNING]: 'started',
      [LoopState.DEBATING]: 'in_progress',
      [LoopState.EXECUTING]: 'in_progress',
      [LoopState.EVALUATING]: 'in_progress',
      [LoopState.REPORTING]: 'in_progress',
      [LoopState.COMPLETED]: 'completed',
      [LoopState.FAILED]: 'failed',
      [LoopState.ABORTED]: 'aborted',
      [LoopState.BUDGET_EXCEEDED]: 'exceeded',
    };

    const progressMessages: Record<LoopState, string> = {
      [LoopState.PLANNING]: '正在分析任务，制定执行计划...',
      [LoopState.DEBATING]: '正在辩论验证计划，寻找潜在问题...',
      [LoopState.EXECUTING]: `正在执行任务，已完成 ${context.budget.roundsUsed} 轮...`,
      [LoopState.EVALUATING]: '正在验证执行结果...',
      [LoopState.REPORTING]: '正在整理结果，生成回复...',
      [LoopState.COMPLETED]: '任务执行完成',
      [LoopState.FAILED]: '任务执行失败',
      [LoopState.ABORTED]: '任务已中止',
      [LoopState.BUDGET_EXCEEDED]: '资源配额已用尽',
    };

    void EventBus.emit('agent_execution_update', {
      traceId: context.trace.traceId,
      phase: phaseName,
      status: statusMap[newState] || 'unknown',
      roundsUsed: context.budget.roundsUsed,
      toolCallsUsed: context.budget.toolCallsUsed,
      elapsedMs: Date.now() - context.budget.startTime,
      timestamp: new Date().toISOString(),
      message: progressMessages[newState],
    });

    if (this.deps.trajectoryDatabase) {
      try {
        this.deps.trajectoryDatabase.recordStateTransition({
          execution_id: context.trace.traceId,
          from_state: prev,
          to_state: newState,
          created_at: Date.now(),
        });
      } catch (err) {
        Logger.warn(
          `⚠️ 状态转换记录失败: ${(err as Error).message}`,
          'LoopController'
        );
      }
    }

    Logger.debug(`🔄 状态转换: ${prev} → ${newState}`, 'LoopController');
  }

  /**
   * 记录上下文快照到轨迹数据库
   * P0: 全轨迹审计增强 — 每步完整上下文快照
   */
  private recordSnapshot(
    context: LoopContext,
    phase:
      | 'planning'
      | 'debating'
      | 'executing'
      | 'evaluating'
      | 'reporting'
      | 'tool_call'
      | 'tool_result'
      | 'llm_call',
    stepIndex: number,
    extra: Record<string, unknown> = {}
  ): void {
    if (!this.deps.trajectoryDatabase) return;

    try {
      const messagesSnapshot = context.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string' ? m.content.substring(0, 2000) : null,
        tool_calls: m.tool_calls
          ? (m.tool_calls as Array<Record<string, unknown>>).map((tc) => ({
              id: (tc as { id?: string }).id,
              type: (tc as { type?: string }).type,
              function: {
                name:
                  ((tc as { function?: Record<string, unknown> }).function
                    ?.name as string) || 'unknown',
                arguments:
                  typeof (tc as { function?: Record<string, unknown> }).function
                    ?.arguments === 'string'
                    ? (
                        (tc as { function?: Record<string, unknown> }).function
                          ?.arguments as string
                      ).substring(0, 500)
                    : undefined,
              },
            }))
          : undefined,
      }));

      const snapshot = {
        phase,
        stepIndex,
        budget: {
          roundsUsed: context.budget.roundsUsed,
          tokensUsed: context.budget.tokensUsed,
          toolCallsUsed: context.budget.toolCallsUsed,
          elapsedMs: Date.now() - context.budget.startTime,
        },
        messagesCount: context.messages.length,
        messagesSnapshot,
        planSteps:
          context.plan?.steps?.map((s) => ({
            id: s.id,
            description: s.description,
            toolName: s.toolName,
          })) || null,
        stepResultsSummary: Object.fromEntries(
          Array.from(context.stepResults.entries()).map(([k, v]) => [
            k,
            { success: v.success, toolName: v.toolName, error: v.error },
          ])
        ),
        ...extra,
      };

      this.deps.trajectoryDatabase.recordContextSnapshot({
        execution_id: context.trace.traceId,
        phase,
        step_index: stepIndex,
        snapshot_json: JSON.stringify(snapshot),
        token_count: context.budget.tokensUsed,
        duration_ms: Date.now() - context.budget.startTime,
        created_at: Date.now(),
      });
    } catch (err) {
      Logger.warn(
        `⚠️ 上下文快照记录失败: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * 检查最近失败是否为可重试错误
   * @param context - 循环上下文
   * @returns 是否可重试
   */
  private wasLastFailureRetryable(context: LoopContext): boolean {
    const lastStepResult = this.getLastFailedStepResult(context);
    if (!lastStepResult) return false;
    const errorMsg = lastStepResult.error || '';
    const retryablePattern =
      /timeout|network|ECONNREFUSED|ETIMEDOUT|503|429|超时|网络/i;
    return retryablePattern.test(errorMsg);
  }

  /**
   * 获取最近失败的步骤结果
   * @param context - 循环上下文
   * @returns 失败的步骤结果或null
   */
  private getLastFailedStepResult(context: LoopContext): StepResult | null {
    const results = Array.from(context.stepResults.values());
    for (let i = results.length - 1; i >= 0; i--) {
      if (!results[i].success) return results[i];
    }
    return null;
  }

  /**
   * 查找失败的步骤：优先返回最后一个有工具名的步骤（执行器通常按顺序处理，失败发生在当前步骤）
   * @param plan - 执行计划
   * @param context - 循环上下文
   * @returns 失败的步骤或 null
   */
  private findFailedStep(
    plan: ExecutionPlan,
    context: LoopContext
  ): PlanStep | null {
    for (let i = plan.steps.length - 1; i >= 0; i--) {
      const step = plan.steps[i];
      if (!step.toolName) continue;
      const result = context.stepResults.get(step.id);
      if (!result || !result.success) {
        return step;
      }
    }
    const lastStepWithTool = [...plan.steps].reverse().find((s) => s.toolName);
    return lastStepWithTool || null;
  }

  /**
   * 触发深度反思：分析整条执行轨迹，给出修正计划
   */
  private async triggerDeepReflection(
    input: UserInput,
    context: LoopContext,
    evalResult: {
      goalProgress: number;
      suggestedAction: string;
      reason: string;
    }
  ): Promise<void> {
    if (!this.deps.reflectionEngine) return;

    try {
      const trajectory = this.buildTrajectoryFromContext(context);
      const deepResult = await this.deps.reflectionEngine.deepReflect(
        input.text,
        trajectory,
        evalResult
      );

      Logger.info(
        `🧠 深度反思: 诊断=${deepResult.diagnosis} 根因=${deepResult.rootCause}`,
        'LoopController'
      );

      if (deepResult.correctedPlan && deepResult.correctedPlan.length > 0) {
        context.messages.push({
          role: 'system',
          content: `【深度反思修正计划】\n诊断: ${deepResult.diagnosis}\n根因: ${deepResult.rootCause}\n修正策略: ${deepResult.fixStrategy}\n建议步骤:\n${deepResult.correctedPlan.map((s: { stepDescription: string; toolName?: string }, i: number) => `${i + 1}. ${s.stepDescription}${s.toolName ? ` (工具: ${s.toolName})` : ''}`).join('\n')}`,
        });
      }
    } catch (err) {
      Logger.warn(
        `深度反思失败，降级为普通重规划: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * 从上下文构建执行轨迹
   */
  private buildTrajectoryFromContext(context: LoopContext): Array<{
    toolName: string;
    success: boolean;
    error?: string;
    output?: string;
  }> {
    const trajectory: Array<{
      toolName: string;
      success: boolean;
      error?: string;
      output?: string;
    }> = [];

    for (const [, result] of context.stepResults) {
      trajectory.push({
        toolName: result.toolName || 'unknown',
        success: result.success,
        error: result.error,
        output: result.output,
      });
    }

    return trajectory;
  }

  /**
   * 反思失败步骤，分析根因并记录经验（阶段3反思纠错）
   * @param stepResult - 失败的步骤结果
   * @param context - 循环上下文
   */
  private async reflectOnFailure(
    stepResult: StepResult,
    context: LoopContext
  ): Promise<void> {
    if (!this.deps.reflectionEngine || !stepResult.toolName) return;

    try {
      const toolArgs =
        (stepResult.metadata?.args as Record<string, unknown>) ?? {};
      const reflection = await this.deps.reflectionEngine.reflect(
        stepResult.toolName,
        toolArgs,
        stepResult.error || '未知错误',
        {
          traceId: context.trace.traceId,
          loopCount: context.budget.roundsUsed,
        }
      );

      Logger.info(
        `🧠 反思结果: 根因=${reflection.rootCause} shouldRetry=${reflection.shouldRetry}${
          reflection.alternativeTool
            ? ` 替代工具=${reflection.alternativeTool}`
            : ''
        }`,
        'LoopController'
      );

      this.deps.reflectionEngine.recordExperience({
        toolName: stepResult.toolName,
        args: toolArgs,
        error: stepResult.error || '未知错误',
        rootCause: reflection.rootCause,
        resolution: reflection.alternativeTool
          ? `替换为 ${reflection.alternativeTool}`
          : reflection.correctedArgs
            ? '修正参数后重试'
            : reflection.shouldRetry
              ? '重试成功'
              : '不重试',
        success: reflection.shouldRetry,
      });
    } catch (err) {
      Logger.warn(
        `反思引擎调用失败，降级为原有重试逻辑: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * 获取上下文中最后的助手消息
   * @param context - 循环上下文
   * @returns 助手消息内容或null
   */
  private getLastAssistantMessage(context: LoopContext): string | null {
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const msg = context.messages[i];
      if (msg.role === 'assistant' && msg.content) {
        return msg.content;
      }
    }
    return null;
  }

  /**
   * 检查预算 - 委托给 constraintsService
   */
  private checkBudget(context: LoopContext): {
    withinBudget: boolean;
    warnings: string[];
  } {
    if (this.deps.constraintsService) {
      const result = this.deps.constraintsService.checkBudget(context.budget);
      return {
        withinBudget: result.withinBudget,
        warnings: result.warnings,
      };
    }

    // Fallback: 本地实现
    const warnings: string[] = [];
    const budget = context.budget;

    if (budget.roundsUsed >= budget.hardRoundLimit) {
      warnings.push(`轮次超限: ${budget.roundsUsed}/${budget.hardRoundLimit}`);
    }

    if (budget.toolCallsUsed >= budget.maxToolCalls) {
      warnings.push(
        `工具调用超限: ${budget.toolCallsUsed}/${budget.maxToolCalls}`
      );
    }

    const elapsed = Date.now() - budget.startTime;
    if (elapsed >= budget.maxDurationMs) {
      warnings.push(`时间超限: ${elapsed}ms/${budget.maxDurationMs}ms`);
    }

    return { withinBudget: warnings.length === 0, warnings };
  }

  /**
   * 动态重规划检查：执行后立即检查，不等 Evaluate 阶段
   * 基于执行输出判断是否需要重新规划
   * @param executorOutput - Executor 的输出
   * @param context - 循环上下文
   * @returns 重规划决策结果
   */
  private checkDynamicReplan(
    executorOutput: {
      messages: ChatMessage[];
      toolCallsCount: number;
      toolDuration: number;
      completedNaturally: boolean;
    },
    context: LoopContext
  ): { shouldReplan: boolean; reason: string } {
    const plan = context.plan;

    // none 模式不触发动态 replan（纯对话，无工具调用预期）
    if (plan?.toolCallMode === 'none') {
      return { shouldReplan: false, reason: '纯对话模式，无需重规划' };
    }

    const toolMessages = executorOutput.messages.filter(
      (m) => m.role === 'tool'
    );

    // 有工具调用时检查失败情况
    if (toolMessages.length > 0) {
      const failedTools = toolMessages.filter((m) => {
        const content = typeof m.content === 'string' ? m.content : '';
        return content.startsWith('错误') || content.includes('错误:');
      });

      // 全部失败
      if (failedTools.length === toolMessages.length) {
        return {
          shouldReplan: true,
          reason: `工具全部失败（${failedTools.length}/${toolMessages.length}），需要重新规划`,
        };
      }

      // 失败率 > 50%
      const failureRate = failedTools.length / toolMessages.length;
      if (failureRate > 0.5) {
        return {
          shouldReplan: true,
          reason: `工具失败率过高: ${(failureRate * 100).toFixed(0)}%（${failedTools.length}/${toolMessages.length}），需要重新规划`,
        };
      }
    }

    // 执行卡住：无工具调用且未自然完成（且有计划需要执行）
    if (
      executorOutput.toolCallsCount === 0 &&
      !executorOutput.completedNaturally &&
      plan
    ) {
      return {
        shouldReplan: true,
        reason: '执行卡住：无工具调用且未自然完成，需要重新规划',
      };
    }

    return { shouldReplan: false, reason: '执行正常，无需重规划' };
  }

  /**
   * 执行生命周期钩子
   */
  private async executeHook(
    event: LifecycleEvent,
    context: LoopContext,
    extra: Record<string, unknown>
  ): Promise<void> {
    if (!this.deps.constraintsService) return;

    try {
      const hookContext: HookContext = {
        event,
        loopState: this.state,
        budgetState: context.budget,
        metadata: {
          ...context.metadata,
          ...extra,
        },
      };

      const result = await this.deps.constraintsService.executeHooks(
        event,
        hookContext
      );

      if (!result.proceed) {
        Logger.info(
          `🛑 钩子拦截: ${event} - ${result.reason || '未提供原因'}`,
          'LoopController'
        );
      }
    } catch (err) {
      Logger.warn(
        `⚠️ 生命周期钩子执行失败: ${event} - ${(err as Error).message}`,
        'LoopController'
      );
    }
  }

  /**
   * F0-02: 将 Planner 的决策注入共享上下文
   * 确保 Executor 的 LLM 能看到完整的规划推理，而不是只看到步骤列表
   */
  private injectPlanIntoContext(
    plan: ExecutionPlan,
    context: LoopContext
  ): void {
    if (plan.simple || plan.steps.length === 0) return;

    // Fix: remove old plan messages before injecting new plan (enables replan)
    context.messages = context.messages.filter(
      (m) => !(m.role === 'system' && m.content?.startsWith('【执行计划】'))
    );

    const steps = plan.steps
      .map(
        (s, i) =>
          `${i + 1}. ${s.description}${s.toolName ? ` (使用 ${s.toolName})` : ''}`
      )
      .join('\n');

    const parts: string[] = [];
    parts.push('【执行计划】');

    if (plan.planReasoning) {
      parts.push(`任务分析: ${plan.planReasoning.substring(0, 500)}`);
      parts.push('');
    }

    parts.push(`执行步骤:\n${steps}`);
    parts.push('\n你可以根据实际情况调整执行顺序或跳过不需要的步骤。');

    context.messages.push({
      role: 'system',
      content: parts.join('\n'),
    });

    Logger.debug(
      `📋 计划上下文已注入共享消息 (含推理: ${!!plan.planReasoning})`,
      'LoopController'
    );
  }

  /**
   * 判断任务是否复杂
   */
  private isComplexTask(complexity: string): boolean {
    return complexity === 'complex' || complexity === 'very_complex';
  }

  /**
   * 根据任务复杂度解析自适应预算
   *
   * 简单任务用较少预算，复杂任务用较多预算
   * 当 ConstraintsService 提供了自适应配置时使用它，否则用默认值
   */
  private resolveAdaptiveBudget(complexity: string): BudgetState {
    // 映射复杂度到等级
    const level: 'simple' | 'moderate' | 'complex' =
      complexity === 'simple'
        ? 'simple'
        : complexity === 'complex' || complexity === 'very_complex'
          ? 'complex'
          : 'moderate';

    // 尝试使用 ConstraintsService 的自适应预算
    if (
      this.deps.constraintsService &&
      'resolveAdaptiveBudget' in this.deps.constraintsService
    ) {
      const adaptive = (
        this.deps.constraintsService as unknown as {
          resolveAdaptiveBudget(
            l: string,
            c: boolean
          ): import('../types').BudgetAllocation;
        }
      ).resolveAdaptiveBudget(level, false);
      return {
        roundsUsed: 0,
        softRoundLimit: Math.floor(adaptive.maxRounds * 0.5),
        hardRoundLimit: adaptive.maxRounds,
        tokensUsed: 0,
        tokenWarningLimit: Math.floor(adaptive.maxTokens * 0.75),
        tokenHardLimit: adaptive.maxTokens,
        startTime: 0,
        maxDurationMs: adaptive.maxDurationMs,
        toolCallsUsed: 0,
        maxToolCalls: adaptive.maxToolCalls,
      };
    }

    // 降级到默认预算
    return { ...DEFAULT_BUDGET };
  }

  /**
   * 使用 OrchestratorAgent 处理复杂任务
   */
  private async runWithOrchestrator(
    input: UserInput,
    initialMessages: ChatMessage[],
    traceId: string
  ): Promise<AgentResult> {
    const startTime = Date.now();
    this.transition(LoopState.PLANNING, {
      messages: initialMessages,
      plan: null,
      currentStepIndex: 0,
      stepResults: new Map(),
      budget: { ...DEFAULT_BUDGET, startTime },
      trace: {
        traceId,
        state: LoopState.PLANNING,
        stateTransitions: [],
        trajectory: [],
        totalDuration: 0,
        totalToolCalls: 0,
        budgetState: DEFAULT_BUDGET,
      },
      metadata: { input: input.text },
      stepOutputs: new Map(),
      dataFlowChannels: [],
      crossStepState: new Map(),
      stepStates: new Map(),
      stepStateHistory: [],
    });

    try {
      const contextText = initialMessages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const orchestratorResult = await this.deps.orchestratorAgent!.processGoal(
        input.text,
        contextText
      );

      const duration = Date.now() - startTime;
      const quality: QualityScore = {
        overall: orchestratorResult.qualityScore?.overall ?? 0.7,
        accuracy: orchestratorResult.qualityScore?.dimensions?.accuracy ?? 0.7,
        usefulness: orchestratorResult.qualityScore?.dimensions?.persona ?? 0.7,
        friendliness:
          orchestratorResult.qualityScore?.dimensions?.stability ?? 0.7,
        efficiency:
          orchestratorResult.qualityScore?.dimensions?.efficiency ?? 0.7,
        details: `OrchestratorAgent处理完成: ${orchestratorResult.success ? '成功' : '部分成功'}, ${orchestratorResult.completedTasks}/${orchestratorResult.totalTasks}任务完成`,
      };

      if (this.deps.trajectoryDatabase) {
        try {
          this.deps.trajectoryDatabase.updateExecutionStatus(
            traceId,
            orchestratorResult.success ? 'success' : 'partial',
            orchestratorResult.summary
          );
          const exec = this.deps.trajectoryDatabase.getExecution(traceId);
          if (exec) {
            exec.loop_rounds = 1;
            exec.total_tool_calls = orchestratorResult.totalTasks;
            exec.total_duration = duration;
            exec.quality_overall = quality.overall;
            this.deps.trajectoryDatabase.recordExecution(exec);
          }
        } catch {
          // 轨迹更新失败不影响主流程
        }
      }

      Logger.info(
        `✅ OrchestratorAgent 完成 [${traceId}] 耗时=${duration}ms`,
        'LoopController'
      );

      this.transition(LoopState.COMPLETED, {
        messages: initialMessages,
        plan: null,
        currentStepIndex: 0,
        stepResults: new Map(),
        budget: { ...DEFAULT_BUDGET, startTime },
        trace: {
          traceId,
          state: LoopState.COMPLETED,
          stateTransitions: [],
          trajectory: [],
          totalDuration: duration,
          totalToolCalls: orchestratorResult.totalTasks,
          budgetState: DEFAULT_BUDGET,
        },
        metadata: { input: input.text },
        stepOutputs: new Map(),
        dataFlowChannels: [],
        crossStepState: new Map(),
        stepStates: new Map(),
        stepStateHistory: [],
      });

      return {
        response: orchestratorResult.summary,
        quality,
        trace: {
          traceId,
          state: LoopState.COMPLETED,
          stateTransitions: [],
          trajectory: [],
          totalDuration: duration,
          totalToolCalls: orchestratorResult.totalTasks,
          budgetState: DEFAULT_BUDGET,
        },
        metadata: {
          loopRounds: 1,
          toolCalls: orchestratorResult.totalTasks,
          duration,
          orchestratorResult: true,
        },
      };
    } catch (error) {
      Logger.error(
        'OrchestratorAgent 处理失败，降级到常规流程',
        error as Error,
        'LoopController'
      );
      this.aborted = false;
      this.state = LoopState.COMPLETED;
      return this.run(input, initialMessages);
    }
  }
}

/**
 * 默认辩论器 — 基于 LLM 的计划攻击验证
 * Harness Engineering: Plan-Battle-Execute 模式
 *
 * 用另一个视角攻击计划找漏洞，迭代打磨到质量阈值
 * 如果没有 LLM 可用，则使用基于规则的静态分析
 */
export class DefaultDebater {
  private llm: {
    chat(params: {
      messages: Array<{ role: string; content: string }>;
    }): Promise<{ content: string }>;
  } | null;
  private readonly MAX_DEBATE_ROUNDS = 3;
  private readonly QUALITY_THRESHOLD = 0.7;

  constructor(llm?: unknown) {
    this.llm =
      llm && typeof llm === 'object' && 'chat' in llm
        ? (llm as {
            chat(params: {
              messages: Array<{ role: string; content: string }>;
            }): Promise<{ content: string }>;
          })
        : null;
  }

  /**
   * 对执行计划进行辩论验证
   * @param plan - 执行计划
   * @param input - 用户输入
   * @param context - 循环上下文
   * @returns 辩论结果
   */
  async debate(
    plan: ExecutionPlan,
    input: UserInput,
    _context: LoopContext
  ): Promise<DebaterOutput> {
    // 如果有 LLM，使用 LLM 辩论
    if (this.llm) {
      return this.llmDebate(plan, input);
    }
    // 否则使用基于规则的静态分析
    return this.ruleBasedDebate(plan, input);
  }

  /**
   * 基于 LLM 的辩论
   */
  private async llmDebate(
    plan: ExecutionPlan,
    input: UserInput
  ): Promise<DebaterOutput> {
    const steps = plan.steps
      .map(
        (s, i) =>
          `${i + 1}. ${s.description}${s.toolName ? ` (工具: ${s.toolName})` : ''}`
      )
      .join('\n');

    const debatePrompt = `你是一个严格的计划审查员。你的任务是找出以下执行计划中的漏洞和风险。

用户需求: ${input.text}

执行计划:
${steps}

请从以下角度审查:
1. 步骤是否有遗漏？
2. 工具选择是否合理？
3. 是否有潜在的错误路径？
4. 依赖关系是否正确？
5. 是否有更优的执行顺序？

请用JSON格式输出:
{
  "passed": true/false,
  "vulnerabilities": ["漏洞1", "漏洞2"],
  "improvements": ["建议1", "建议2"],
  "qualityScore": 0.0-1.0
}`;

    try {
      const response = await this.llm!.chat({
        messages: [{ role: 'user', content: debatePrompt }],
      });

      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          passed:
            parsed.passed ?? parsed.qualityScore >= this.QUALITY_THRESHOLD,
          vulnerabilities: parsed.vulnerabilities || [],
          improvements: parsed.improvements || [],
          qualityScore: parsed.qualityScore ?? 0.5,
          debateRounds: 1,
        };
      }
    } catch (err) {
      Logger.warn(
        `LLM 辩论失败，降级到规则分析: ${(err as Error).message}`,
        'DefaultDebater'
      );
    }

    // LLM 失败时降级
    return this.ruleBasedDebate(plan, input);
  }

  /**
   * 基于规则的静态分析辩论
   */
  private ruleBasedDebate(
    plan: ExecutionPlan,
    input: UserInput
  ): Promise<DebaterOutput> {
    const vulnerabilities: string[] = [];
    const improvements: string[] = [];
    let qualityScore = 0.8; // 基础分

    // 检查1: 步骤是否太少
    if (plan.steps.length === 0) {
      vulnerabilities.push('计划没有任何步骤');
      qualityScore -= 0.3;
    } else if (plan.steps.length === 1 && !plan.simple) {
      vulnerabilities.push('非简单任务只有1个步骤，可能遗漏了中间步骤');
      qualityScore -= 0.1;
    }

    // 检查2: 是否有步骤缺少工具
    const stepsWithoutTool = plan.steps.filter(
      (s) =>
        !s.toolName &&
        !s.description.includes('分析') &&
        !s.description.includes('思考')
    );
    if (stepsWithoutTool.length > 0 && plan.steps.length > 2) {
      improvements.push(
        `步骤 "${stepsWithoutTool[0].description}" 没有指定工具，建议明确使用什么工具`
      );
      qualityScore -= 0.05;
    }

    // 检查3: 输入和计划的相关性
    const inputKeywords = input.text.toLowerCase().split(/\s+/);
    const planText = plan.steps
      .map((s) => s.description.toLowerCase())
      .join(' ');
    const relevance = inputKeywords.filter(
      (kw) => kw.length > 2 && planText.includes(kw)
    ).length;
    if (relevance < inputKeywords.filter((kw) => kw.length > 2).length * 0.3) {
      vulnerabilities.push('计划与用户需求的相关性较低，可能偏离了目标');
      qualityScore -= 0.15;
    }

    // 检查4: 是否有回退策略
    if (!plan.fallbackStrategy && plan.steps.length > 3) {
      improvements.push('复杂任务建议添加回退策略(fallbackStrategy)');
      qualityScore -= 0.05;
    }

    qualityScore = Math.max(0, Math.min(1, qualityScore));

    return Promise.resolve({
      passed:
        qualityScore >= this.QUALITY_THRESHOLD && vulnerabilities.length === 0,
      vulnerabilities,
      improvements,
      qualityScore,
      debateRounds: 1,
    });
  }
}
