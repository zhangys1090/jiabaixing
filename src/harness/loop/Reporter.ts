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

    // accuracy: 基于工具执行成功率 — 工具调用是否成功完成
    const stepFailures = [...(context.stepResults?.values() || [])].filter(
      (s) => !s.success
    ).length;
    const stepTotal = context.stepResults?.size || 1;
    const stepSuccessRate = (stepTotal - stepFailures) / stepTotal;
    const accuracy = Math.max(0.1, overall * (0.5 + 0.5 * stepSuccessRate));

    // usefulness: 基于响应内容质量 — 是否包含有用信息而非错误/空回复
    const responseText = this.extractResponse(context.messages);
    const hasError = /抱歉|无法|失败|错误|sorry|error|failed/i.test(responseText.substring(0, 100));
    const isEmpty = responseText.length < 10;
    const hasActionableContent = /已|完成|找到|创建|修改|删除|更新|成功|可以|建议|推荐/i.test(responseText.substring(0, 200));
    let usefulness = overall * 0.8;
    if (hasError) usefulness -= 0.2;
    if (isEmpty) usefulness -= 0.3;
    if (hasActionableContent) usefulness += 0.1;
    usefulness = Math.max(0.1, Math.min(1.0, usefulness));

    // friendliness: 基于人格一致性 — 是否包含温暖/自然的表达
    const hasGreeting = /~|😊|好的|没问题|当然|可以|嗯|哦|呢|吧/i.test(responseText.substring(0, 200));
    const isTerse = responseText.length < 15 && !hasGreeting;
    const hasPersonality = /主人|亲爱的|宝贝/i.test(responseText) === false; // 不用这些称呼 = 符合人格
    let friendliness = 0.7;
    if (hasGreeting) friendliness += 0.15;
    if (isTerse) friendliness -= 0.2;
    if (hasPersonality) friendliness += 0.05;
    friendliness = Math.max(0.1, Math.min(1.0, friendliness));

    return {
      overall,
      accuracy,
      usefulness,
      friendliness,
      efficiency,
      details: `轮次=${budget.roundsUsed} 工具=${budget.toolCallsUsed} 时长=${duration}ms 步骤成功率=${(stepSuccessRate * 100).toFixed(0)}%`,
    };
  }

}
