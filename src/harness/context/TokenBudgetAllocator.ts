/**
 * Harness Layer 3: Context - Token 预算分配器
 *
 * 按优先级和比例分配 Token 预算
 */

import type { TokenAllocation } from '../types';

/** 分配比例 */
const ALLOCATION_RATIOS = {
  systemPrompt: 0.30,
  memory: 0.15,
  history: 0.25,
  dynamicContext: 0.15,
  toolResults: 0.15,
  reserve: 0.10,
};

export class TokenBudgetAllocator {
  private totalBudget: number;

  constructor(totalBudget: number = 8000) {
    this.totalBudget = totalBudget;
  }

  /**
   * 设置总预算
   */
  setTotalBudget(budget: number): void {
    this.totalBudget = budget;
  }

  /**
   * 分配 Token 预算
   */
  allocate(): TokenAllocation {
    return {
      systemPrompt: Math.floor(this.totalBudget * ALLOCATION_RATIOS.systemPrompt),
      memory: Math.floor(this.totalBudget * ALLOCATION_RATIOS.memory),
      history: Math.floor(this.totalBudget * ALLOCATION_RATIOS.history),
      dynamicContext: Math.floor(this.totalBudget * ALLOCATION_RATIOS.dynamicContext),
      toolResults: Math.floor(this.totalBudget * ALLOCATION_RATIOS.toolResults),
      reserve: Math.floor(this.totalBudget * ALLOCATION_RATIOS.reserve),
    };
  }

  /**
   * 估算文本的 Token 数
   * 粗略估算：中文约 1.5 字/token，英文约 4 字/token，取平均 2 字/token
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 2);
  }

  /**
   * 按预算截断文本
   */
  truncateToBudget(text: string, budget: number): string {
    const maxChars = budget * 2;
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + '\n...[内容已截断以适应Token预算]';
  }
}
