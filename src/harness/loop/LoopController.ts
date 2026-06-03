/**
 * Harness Layer 1: Loop - 循环控制器
 *
 * Plan-Execute-Evaluate 状态机
 * 替代 JiabaixingCore.executeFCLoop 的单层 FC 循环
 */

import { Logger } from '../../utils/Logger';
import { perf } from '../../monitoring/PerformanceMonitor';
import { LoopState, LifecycleEvent } from '../types';
import { EventBus } from '../../shared/EventBus';
import { TaskComplexityAnalyzer } from '../../core/TaskComplexityAnalyzer';
import { skillUsageTracker } from '../../evolution/SkillUsageTracker';
import type { EvolutionEngine } from '../../evolution/EvolutionEngine';
import type {
  ChatMessage,
  UserInput,
  AgentResult,
  LoopContext,
  LoopTrace,
  BudgetState,
  BudgetCheckResult,
  ExecutionPlan,
  StepResult,
  QualityScore,
  HookContext,
  HookResult,
} from '../types';
import type { VerificationService } from '../verification/VerificationService';
import type { PersistenceService } from '../persistence/PersistenceService';
import type { TrajectoryDatabase } from '../persistence/TrajectoryDatabase';
import type { OrchestratorAgent } from '../orchestration/OrchestratorAgent';
import type { AggregatedResult } from '../orchestration/ResultAggregator';

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
    debate(plan: ExecutionPlan, input: UserInput, context: LoopContext): Promise<DebaterOutput>;
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
    nudgeKnowledgePersistence(input: string, toolsUsed: string[]): string | null;
    collectFeedback(
      input: string,
      response: string,
      result: { success: boolean; intent?: string; toolsUsed?: string[]; error?: string },
      scene?: string
    ): void;
    assessQuality(traceId: string, success: boolean, qualityScore: number, duration: number, scene?: string): void;
    generateSkill(params: {
      input: string;
      response: string;
      toolsUsed: string[];
      totalDuration: number;
      qualityScore: number;
      traceId: string;
    }): string | null;
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

  constructor(deps: LoopControllerDeps) {
    this.deps = deps;
    this.complexityAnalyzer = new TaskComplexityAnalyzer();
  }

  /**
   * 获取 EvolutionEngine 实例（延迟初始化）
   * 通过延迟初始化避免 AgentHarness 和 EvolutionEngine 之间的循环依赖
   */
  private get evolutionEngine(): EvolutionEngine | null {
    if (this._evolutionEngine === null && this.deps.evolutionEngine) {
      // 使用 deps.evolutionEngine 作为兼容接口
      // 实际类型是 EvolutionEngineDeps 适配器，来自 initHarness.ts
      this._evolutionEngine = this.deps.evolutionEngine as unknown as EvolutionEngine;
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
    const complexityResult = this.complexityAnalyzer.analyzeComplexity(input.text);
    Logger.info(
      `📊 任务复杂度分析: ${complexityResult.complexity}, 预估步骤: ${complexityResult.estimatedSteps}, 可并行: ${complexityResult.parallelizable}`,
      'LoopController'
    );

    // 如果是复杂任务且有 OrchestratorAgent，走多Agent编排路径
    if (this.deps.orchestratorAgent && this.isComplexTask(complexityResult.complexity)) {
      Logger.info(
        `🤖 检测到复杂任务，使用 OrchestratorAgent 处理`,
        'LoopController'
      );
      return this.runWithOrchestrator(input, initialMessages, traceId);
    }

    // 初始化循环上下文 — 根据任务复杂度自适应调整预算
    const adaptiveBudget = this.resolveAdaptiveBudget(complexityResult.complexity);
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
    };

    Logger.info(`🔄 LoopController 启动 [${traceId}]`, 'LoopController');

    // Harness Engineering: 启动全链路追踪
    EventBus.startFullTrace(traceId);

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

            this.recordSnapshot(context, 'debating', context.budget.roundsUsed, {
              debatePassed: debateResult.passed,
              debateQuality: debateResult.qualityScore,
              debateRounds: debateResult.debateRounds,
              vulnerabilities: debateResult.vulnerabilities,
              improvements: debateResult.improvements,
            });

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
                  content: `【辩论反馈】计划存在以下问题：\n` +
                    debateResult.vulnerabilities.map((v, i) => `${i + 1}. ${v}`).join('\n') +
                    '\n\n改进建议：\n' +
                    debateResult.improvements.map((imp, i) => `${i + 1}. ${imp}`).join('\n') +
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
        const executorOutput = await perf.measure(
          'executor.execute',
          () => this.deps.executor.execute(plan!, context),
          'loop'
        );
        Logger.info(
          `✅ Phase 2: 执行完成 (工具调用=${executorOutput.toolCallsCount}次, 消息数=${executorOutput.messages.length})`,
          'LoopController'
        );

        // Harness Engineering: 记录执行阶段完成 + Token/工具调用追踪
        EventBus.completeTracePhase(traceId, 'executing', true);
        if (executorOutput.estimatedTokens) {
          EventBus.recordTokenUsage(traceId, 'default', executorOutput.estimatedTokens, 0);
        }
        EventBus.recordToolCall(traceId, 'batch', executorOutput.toolCallsCount > 0, executorOutput.toolDuration);

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
        evalResult = await perf.measure(
          'evaluator.evaluate',
          () => this.deps.evaluator.evaluate(input, context),
          'loop'
        );

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

        // 根据评估结果决定下一步
        switch (evalResult.suggestedAction) {
          case 'continue':
            // 继续下一轮迭代，检查是否需要重新规划
            if (evalResult.goalProgress >= 0.9) {
              // 目标基本达成，结束循环
              shouldContinueLoop = false;
              Logger.info('✅ 目标已基本达成，结束循环', 'LoopController');
            } else if (
              context.budget.roundsUsed >= context.budget.softRoundLimit
            ) {
              // 接近软限制，检查是否还有显著进展
              if (evalResult.goalProgress < 0.3) {
                // 进展缓慢且接近限制，强制结束
                shouldContinueLoop = false;
                Logger.info(
                  '⚠️ 进展缓慢且接近轮次限制，强制结束',
                  'LoopController'
                );
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
              } else {
                replanNeeded = true;
                Logger.info(
                  '🔄 可重试错误已达最大重试次数，重新规划',
                  'LoopController'
                );
              }
            } else {
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
              input: context.metadata.input as string || '',
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
        for (const tc of msg.tool_calls as Array<{ function?: { name?: string } }>) {
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
  private static readonly VALID_TRANSITIONS: Map<LoopState, LoopState[]> = new Map([
    [LoopState.PLANNING, [LoopState.DEBATING, LoopState.EXECUTING, LoopState.FAILED, LoopState.ABORTED]],
    [LoopState.DEBATING, [LoopState.PLANNING, LoopState.EXECUTING, LoopState.FAILED, LoopState.ABORTED]],
    [LoopState.EXECUTING, [LoopState.EVALUATING, LoopState.FAILED, LoopState.ABORTED]],
    [LoopState.EVALUATING, [LoopState.REPORTING, LoopState.PLANNING, LoopState.ABORTED, LoopState.BUDGET_EXCEEDED]],
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
    if (this.deps.constraintsService && 'resolveAdaptiveBudget' in this.deps.constraintsService) {
      const adaptive = (this.deps.constraintsService as unknown as {
        resolveAdaptiveBudget(l: string, c: boolean): import('../types').BudgetAllocation;
      }).resolveAdaptiveBudget(level, false);
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
    });

    try {
      const contextText = initialMessages
        .map(m => `${m.role}: ${m.content}`)
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
        friendliness: orchestratorResult.qualityScore?.dimensions?.stability ?? 0.7,
        efficiency: orchestratorResult.qualityScore?.dimensions?.efficiency ?? 0.7,
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
  private llm: { chat(params: { messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> } | null;
  private readonly MAX_DEBATE_ROUNDS = 3;
  private readonly QUALITY_THRESHOLD = 0.7;

  constructor(llm?: unknown) {
    this.llm = (llm && typeof llm === 'object' && 'chat' in llm)
      ? llm as { chat(params: { messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> }
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
      .map((s, i) => `${i + 1}. ${s.description}${s.toolName ? ` (工具: ${s.toolName})` : ''}`)
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
          passed: parsed.passed ?? parsed.qualityScore >= this.QUALITY_THRESHOLD,
          vulnerabilities: parsed.vulnerabilities || [],
          improvements: parsed.improvements || [],
          qualityScore: parsed.qualityScore ?? 0.5,
          debateRounds: 1,
        };
      }
    } catch (err) {
      Logger.warn(`LLM 辩论失败，降级到规则分析: ${(err as Error).message}`, 'DefaultDebater');
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
      (s) => !s.toolName && !s.description.includes('分析') && !s.description.includes('思考')
    );
    if (stepsWithoutTool.length > 0 && plan.steps.length > 2) {
      improvements.push(`步骤 "${stepsWithoutTool[0].description}" 没有指定工具，建议明确使用什么工具`);
      qualityScore -= 0.05;
    }

    // 检查3: 输入和计划的相关性
    const inputKeywords = input.text.toLowerCase().split(/\s+/);
    const planText = plan.steps.map((s) => s.description.toLowerCase()).join(' ');
    const relevance = inputKeywords.filter((kw) => kw.length > 2 && planText.includes(kw)).length;
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
      passed: qualityScore >= this.QUALITY_THRESHOLD && vulnerabilities.length === 0,
      vulnerabilities,
      improvements,
      qualityScore,
      debateRounds: 1,
    });
  }
}
