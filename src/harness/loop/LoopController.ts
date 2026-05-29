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

/** 默认预算 */
const DEFAULT_BUDGET: BudgetState = {
  roundsUsed: 0,
  softRoundLimit: 4,
  hardRoundLimit: 8,
  tokensUsed: 0,
  tokenWarningLimit: 4500,
  tokenHardLimit: 6000,
  startTime: 0,
  maxDurationMs: 60000,
  toolCallsUsed: 0,
  maxToolCalls: 20,
};

export class LoopController {
  private state: LoopState = LoopState.COMPLETED;
  private deps: LoopControllerDeps;
  private aborted = false;

  constructor(deps: LoopControllerDeps) {
    this.deps = deps;
  }

  /**
   * 运行 Plan-Execute-Evaluate 循环 (支持多轮迭代)
   */
  async run(
    input: UserInput,
    initialMessages: ChatMessage[]
  ): Promise<AgentResult> {
    this.aborted = false;
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

    // 初始化循环上下文
    const context: LoopContext = {
      messages: [...initialMessages],
      plan: null,
      currentStepIndex: 0,
      stepResults: new Map(),
      budget: { ...DEFAULT_BUDGET, startTime: Date.now() },
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
    };

    Logger.info(`🔄 LoopController 启动 [${traceId}]`, 'LoopController');

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

          await this.executeHook(LifecycleEvent.ON_PLAN_CREATED, context, {
            plan: plan.steps,
          });
        }

        // ─── Phase 2: EXECUTING ───
        this.transition(LoopState.EXECUTING, context);
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

        // ─── Phase 3: EVALUATING ───
        this.transition(LoopState.EVALUATING, context);
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
   * 状态转换
   */
  // Fix: valid state transitions — blocks impossible transitions
  private static readonly VALID_TRANSITIONS: Map<LoopState, LoopState[]> = new Map([
    [LoopState.PLANNING, [LoopState.EXECUTING, LoopState.FAILED, LoopState.ABORTED]],
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
}
