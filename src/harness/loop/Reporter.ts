/**
 * Harness Layer 1: Loop - Reporter 节点
 *
 * 生成最终响应 + 质量评分
 */

import { Logger } from '../../utils/Logger';
import type { LoopContext, QualityScore } from '../types';
import type { ReporterOutput } from './LoopController';

export class Reporter {
  /**
   * 生成最终响应和质量评分
   */
  async report(context: LoopContext): Promise<ReporterOutput> {
    // 查找最后一条 assistant 消息作为响应
    const response = this.extractResponse(context.messages);
    const quality = this.computeQuality(context);

    Logger.info(
      `📊 质量评分: ${quality.overall.toFixed(2)} (准确=${quality.accuracy.toFixed(2)} 有用=${quality.usefulness.toFixed(2)} 效率=${quality.efficiency.toFixed(2)})`,
      'Reporter'
    );

    return { response, quality };
  }

  /**
   * 从消息中提取最终响应
   */
  private extractResponse(
    messages: Array<{ role: string; content?: string | null }>
  ): string {
    // 从后往前找最后一条 assistant 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content) {
        return messages[i].content!;
      }
    }

    // 降级：返回最后一条非 system 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'system' && messages[i].content) {
        return messages[i].content!;
      }
    }

    return '抱歉，我无法处理您的请求。';
  }

  /**
   * 计算质量评分
   */
  private computeQuality(context: LoopContext): QualityScore {
    const budget = context.budget;
    const trace = context.trace;

    // 基础分
    let overall = 1.0;
    let efficiency = 1.0;

    // 惩罚过多轮次
    if (budget.roundsUsed > 3) {
      const penalty = 0.1 * (budget.roundsUsed - 3);
      overall -= penalty;
      efficiency -= penalty;
    }

    // 惩罚过多工具调用（提高阈值，工具调用往往是必要的）
    if (budget.toolCallsUsed > 10) {
      const penalty = 0.05 * (budget.toolCallsUsed - 10);
      efficiency -= penalty;
    }

    // 惩罚总时长
    const duration = Date.now() - budget.startTime;
    if (duration > 15000) efficiency -= 0.1;
    if (duration > 30000) efficiency -= 0.2;

    // 自然完成加分
    const completedNaturally =
      trace.state !== 'budget_exceeded' && trace.state !== 'failed';
    if (!completedNaturally) {
      overall -= 0.3;
    }

    // 限制范围
    overall = Math.max(0.1, Math.min(1.0, overall));
    efficiency = Math.max(0.1, Math.min(1.0, efficiency));

    // Fix: quality dimensions now have independent signals instead of being pure derivatives
    // accuracy: penalized by tool failures in stepResults
    const stepFailures = [...(context.stepResults?.values() || [])].filter(
      (s) => !s.success
    ).length;
    const stepTotal = context.stepResults?.size || 1;
    const stepSuccessRate = (stepTotal - stepFailures) / stepTotal;

    // friendliness: penalized if response is very short (likely terse/error)
    const responseText = this.extractResponse(context.messages);
    const friendlinessFactor =
      responseText.length < 50
        ? 0.3
        : responseText.length < 100
          ? 0.6
          : 0.8;

    return {
      overall,
      accuracy: Math.max(0.1, overall * (0.5 + 0.5 * stepSuccessRate)),
      usefulness: Math.max(0.1, overall * (0.5 + 0.5 * stepSuccessRate)),
      friendliness: Math.max(0.1, Math.min(1.0, friendlinessFactor)),
      efficiency,
      details: `轮次=${budget.roundsUsed} 工具=${budget.toolCallsUsed} 时长=${duration}ms 步骤成功率=${(stepSuccessRate * 100).toFixed(0)}%`,
    };
  }

}
