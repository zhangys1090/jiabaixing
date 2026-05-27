/**
 * Harness Layer 1: Loop - Evaluator 节点
 *
 * 使用独立评估服务的适配器
 * 保持向后兼容的接口，内部委托给 IndependentEvaluationService
 *
 * P0 核心功能：Evaluator 独立化完成
 */

import { Logger } from '../../utils/Logger';
import { StepEvaluator } from '../evaluation/StepEvaluator';
import { 
  IndependentEvaluationService,
  type EvaluationInput,
  type IndependentEvaluationResult
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
  private stepEvaluator: StepEvaluator;
  private independentEvaluationService: IndependentEvaluationService;
  private replanCount = 0;
  private readonly MAX_REPLAN = 1;

  constructor(deps: EvaluatorDeps) {
    this.deps = deps;
    this.stepEvaluator = new StepEvaluator();
    this.independentEvaluationService = new IndependentEvaluationService({
      llm: deps.llm,
      enableLLMEvaluation: deps.enableLLMEvaluation ?? false,
    });
  }

  /**
   * 评估目标达成度（原有接口，保持向后兼容）
   */
  async evaluate(input: UserInput, context: LoopContext): Promise<EvaluatorOutput> {
    const budget = context.budget;

    // 预算硬限制检查（保留原有快速检查）
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

    // 检查最终回复
    const lastAssistantMsg = this.findLastAssistantMessage(context.messages);
    if (lastAssistantMsg && !lastAssistantMsg.tool_calls?.length) {
      return {
        goalProgress: 1.0,
        suggestedAction: 'continue',
        reason: 'LLM 已生成最终回复',
      };
    }

    // Step evaluation（保留）
    if (context.stepResults.size > 0) {
      const stepEvalResult = this.evaluateSteps(context);
      if (stepEvalResult.goalProgress === 0) {
        return {
          goalProgress: 0,
          suggestedAction: 'abort',
          reason: `所有工具调用失败: ${stepEvalResult.failedSteps} 个失败步骤`,
        };
      }
      if (stepEvalResult.goalProgress === 0.5) {
        if (this.replanCount < this.MAX_REPLAN) {
          this.replanCount++;
          return {
            goalProgress: 0.5,
            suggestedAction: 'replan',
            reason: `部分工具调用失败: ${stepEvalResult.failedSteps}/${stepEvalResult.totalSteps} 失败`,
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

    // 使用新的独立评估服务
    const fullEval = await this.evaluateFull(input.text, context.messages, context.trace);
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
    // 构建评估输入
    const evalInput: EvaluationInput = {
      userInput,
      conversationHistory: messages,
      executionTrace: {
        totalToolCalls: trace.totalToolCalls,
        totalDuration: trace.totalDuration,
        loopRounds: trace.budgetState?.roundsUsed || 0,
      },
    };

    // 委托给独立评估服务
    const result = await this.independentEvaluationService.evaluate(evalInput);

    // 转换为向后兼容的格式
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
   * 评估步骤（保留用于快速检查）
   */
  private evaluateSteps(context: LoopContext): { goalProgress: number; totalSteps: number; failedSteps: number } {
    let totalSteps = 0;
    let failedSteps = 0;

    for (const [stepId, stepResult] of context.stepResults) {
      const evalResult = this.stepEvaluator.evaluateStep({
        stepId,
        toolName: stepResult.toolName || 'unknown',
        args: {},
        result: {
          success: stepResult.success,
          output: stepResult.output,
          error: stepResult.error,
        },
        timestamp: Date.now(),
      });

      totalSteps++;
      if (!evalResult.passed) {
        failedSteps++;
        Logger.debug(
          `步骤 ${stepId} 评估失败: score=${evalResult.score} issues=${evalResult.issues.map(i => i.type).join(', ')}`,
          'Evaluator'
        );
      }
    }

    let goalProgress: number;
    if (failedSteps === 0) {
      goalProgress = 1.0;
    } else if (failedSteps < totalSteps * 0.5) {
      goalProgress = 0.5;
    } else {
      goalProgress = 0;
    }

    return { goalProgress, totalSteps, failedSteps };
  }

  /**
   * 查找最后一条 assistant 消息
   */
  private findLastAssistantMessage(
    messages: Array<{ role: string; content?: string | null; tool_calls?: unknown[] }>
  ): { role: string; content?: string | null; tool_calls?: unknown[] } | undefined {
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
