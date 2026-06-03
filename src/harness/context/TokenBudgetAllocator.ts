/**
 * Harness Layer 3: Context - Token 预算分配器
 *
 * 按优先级和比例分配 Token 预算
 */

import type { TokenAllocation } from '../types';

/** 分配比例 */
const ALLOCATION_RATIOS = {
  systemPrompt: 0.3,
  memory: 0.15,
  history: 0.25,
  dynamicContext: 0.15,
  toolResults: 0.15,
  reserve: 0.1,
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
      systemPrompt: Math.floor(
        this.totalBudget * ALLOCATION_RATIOS.systemPrompt
      ),
      memory: Math.floor(this.totalBudget * ALLOCATION_RATIOS.memory),
      history: Math.floor(this.totalBudget * ALLOCATION_RATIOS.history),
      dynamicContext: Math.floor(
        this.totalBudget * ALLOCATION_RATIOS.dynamicContext
      ),
      toolResults: Math.floor(this.totalBudget * ALLOCATION_RATIOS.toolResults),
      reserve: Math.floor(this.totalBudget * ALLOCATION_RATIOS.reserve),
    };
  }

  /**
   * 估算文本的 Token 数
   * 改进算法：区分中英文
   * - 中文约 1.5 字/token
   * - 英文约 4 字/token
   * - 混排时分别计算后求和
   */
  estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    // 中文字符范围 (包括中文标点和CJK统一汉字)
    const chineseRegex = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u3400-\u4dbf]/g;
    // 英文字母、数字、基本标点
    const englishRegex = /[a-zA-Z0-9\s.,!?;:'"()\-—–_+=*\/\\{}[\]@#$%^&~`<>|]/g;

    const chineseMatches = text.match(chineseRegex) || [];
    const englishMatches = text.match(englishRegex) || [];

    // 去除重叠计数（简单起见，从总长度中减去中文字符数，因为它们不包含在englishMatches中）
    const chineseCount = chineseMatches.length;
    // 英文部分长度（不包括已经被计入中文的字符）
    const englishPart = text.replace(chineseRegex, '');
    const englishCount = englishPart.length;

    // 中文: 1.5字 ≈ 1 token; 英文: 4字符 ≈ 1 token
    const chineseTokens = Math.ceil(chineseCount / 1.5);
    const englishTokens = Math.ceil(englishCount / 4);

    return chineseTokens + englishTokens;
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
