/**
 * Harness Layer 1: Loop - Evaluator 节点
 *
 * 纯适配器模式：完全委托给 IndependentEvaluationService
 * 不再直接依赖 StepEvaluator，所有评估逻辑统一走独立评估服务
 *
 * P0 核心功能：Evaluator 独立化完成
 */

import {
  IndependentEvaluationService,
  type EvaluationInput,
  type IndependentEvaluationResult,
} from '../evaluation/IndependentEvaluationService';
import type { UserInput, LoopContext, LoopTrace, ChatMessage } from '../types';
import type { EvaluatorOutput } from './LoopController';

/** 完整评估结果（向后兼容） */
export interface FullEvaluationResult {
  /** 任务完成情况 */
  taskCompletion: {
    completed: boolean;
    confidence: number;
    reason: string;
  };
  /** 数据 groundedness */
  dataGroundedness: {
    grounded: boolean;
    confidence: number;
    reason: string;
  };
  /** 安全检查 */
  safety: {
    safe: boolean;
    riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
    violations: string[];
  };
  /** 整体建议 */
  overall: {
    suggestedAction: 'continue' | 'replan' | 'abort';
    goalProgress: number;
    summary: string;
  };
}

/** Evaluator 依赖 */
export interface EvaluatorDeps {
  /** LLM 判断目标达成度 */
  llm?: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
  /** 是否启用 LLM 深度评估 */
  enableLLMEvaluation?: boolean;
}

export class Evaluator {
  private deps: EvaluatorDeps;
  private independentEvaluationService: IndependentEvaluationService;
  private replanCount = 0;
  private readonly MAX_REPLAN = 1;

  constructor(deps: EvaluatorDeps) {
    this.deps = deps;
    this.independentEvaluationService = new IndependentEvaluationService({
      llm: deps.llm,
      enableLLMEvaluation: deps.enableLLMEvaluation ?? false,
    });
  }

  /**
   * 评估目标达成度（原有接口，保持向后兼容）
   */
  async evaluate(
    input: UserInput,
    context: LoopContext
  ): Promise<EvaluatorOutput> {
    const budget = context.budget;

    if (budget.roundsUsed >= budget.hardRoundLimit) {
      return {
        goalProgress: 0.5,
        suggestedAction: 'abort',
        reason: `轮次已达硬限制 ${budget.hardRoundLimit}`,
      };
    }

    if (budget.toolCallsUsed >= budget.maxToolCalls) {
      return {
        goalProgress: 0.5,
        suggestedAction: 'abort',
        reason: `工具调用已达上限 ${budget.maxToolCalls}`,
      };
    }

    const lastAssistantMsg = this.findLastAssistantMessage(context.messages);
    if (lastAssistantMsg && !lastAssistantMsg.tool_calls?.length) {
      const wasRequired = context.metadata.toolCallMode === 'required';
      if (wasRequired) {
        return {
          goalProgress: 0.2,
          suggestedAction: 'replan',
          reason: '需要工具调用但 LLM 未调任何工具',
        };
      }
      return {
        goalProgress: 1.0,
        suggestedAction: 'continue',
        reason: 'LLM 已生成最终回复',
      };
    }

    if (context.stepResults.size > 0) {
      const stepSummary = this.summarizeStepResults(context);
      if (stepSummary.allFailed) {
        return {
          goalProgress: 0,
          suggestedAction: 'abort',
          reason: `所有工具调用失败: ${stepSummary.failedCount} 个失败步骤`,
        };
      }
      if (stepSummary.hasFailures) {
        if (this.replanCount < this.MAX_REPLAN) {
          this.replanCount++;
          return {
            goalProgress: 0.5,
            suggestedAction: 'replan',
            reason: `部分工具调用失败: ${stepSummary.failedCount}/${stepSummary.totalCount} 失败`,
          };
        } else {
          return {
            goalProgress: 0.5,
            suggestedAction: 'abort',
            reason: '已达到最大重新规划次数',
          };
        }
      }
    }

    const fullEval = await this.evaluateFull(
      input.text,
      context.messages,
      context.trace
    );
    return {
      goalProgress: fullEval.overall.goalProgress,
      suggestedAction: fullEval.overall.suggestedAction,
      reason: fullEval.overall.summary,
    };
  }

  /**
   * 独立评估完整执行结果（委托给独立评估服务）
   */
  async evaluateFull(
    userInput: string,
    messages: ChatMessage[],
    trace: LoopTrace
  ): Promise<FullEvaluationResult> {
    const stepResults: Array<{
      toolName: string;
      success: boolean;
      output?: unknown;
      error?: string;
    }> = [];
    // trace.trajectory 中提取工具结果
    for (const step of trace.trajectory) {
      if (step.type === 'tool_result' && step.toolResult) {
        stepResults.push({
          toolName: step.toolName || 'unknown',
          success: step.toolResult.success,
          output: step.toolResult.output,
          error: step.toolResult.error,
        });
      }
    }

    const evalInput: EvaluationInput = {
      userInput,
      conversationHistory: messages,
      executionTrace: {
        totalToolCalls: trace.totalToolCalls,
        totalDuration: trace.totalDuration,
        loopRounds: trace.budgetState?.roundsUsed || 0,
        toolResults: stepResults,
      },
    };

    const result = await this.independentEvaluationService.evaluate(evalInput);

    return this.adaptToLegacyFormat(result);
  }

  /**
   * 转换为向后兼容的格式
   */
  private adaptToLegacyFormat(
    result: IndependentEvaluationResult
  ): FullEvaluationResult {
    return {
      taskCompletion: result.taskCompletion,
      dataGroundedness: result.dataGroundedness,
      safety: {
        safe: result.safety.safe,
        riskLevel: result.safety.riskLevel,
        violations: result.safety.violations,
      },
      overall: result.overall,
    };
  }

  /**
   * 汇总步骤结果（替代直接依赖 StepEvaluator）
   */
  private summarizeStepResults(context: LoopContext): {
    allFailed: boolean;
    hasFailures: boolean;
    failedCount: number;
    totalCount: number;
  } {
    let totalCount = 0;
    let failedCount = 0;

    for (const [, stepResult] of context.stepResults) {
      totalCount++;
      if (!stepResult.success) {
        failedCount++;
      }
    }

    const majorityFailed = totalCount > 0 && failedCount > totalCount * 0.5;

    return {
      allFailed:
        majorityFailed || (failedCount === totalCount && totalCount > 0),
      hasFailures: failedCount > 0,
      failedCount,
      totalCount,
    };
  }

  /**
   * 查找最后一条 assistant 消息
   */
  private findLastAssistantMessage(
    messages: Array<{
      role: string;
      content?: string | null;
      tool_calls?: unknown[];
    }>
  ):
    | { role: string; content?: string | null; tool_calls?: unknown[] }
    | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return messages[i];
      }
    }
    return undefined;
  }

  /**
   * 获取独立评估服务实例（用于外部直接调用）
   */
  getIndependentEvaluationService(): IndependentEvaluationService {
    return this.independentEvaluationService;
  }
}
