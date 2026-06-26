/**
 * TokenBudgetAllocator - 上下文系统辅助组件（已废弃）
 *
 * 【架构定位】
 * 上下文系统辅助组件，负责 Token 预算分配
 *
 * 【核心职责】
 * - 按优先级和比例分配 Token 预算
 * - 估算文本的 Token 数（区分中英文）
 * - 按预算截断文本
 *
 * 【在整体架构中的位置】
 * ContextManager → TokenBudgetAllocator（本文件）→ 各组件 Token 分配
 *
 * @deprecated 已迁移到 Python agent/core/context_pipeline.py。
 *
 * 废弃状态说明：
 * - 废弃版本：V5.0
 * - 迁移日期：2026-06-22
 * - 预计移除版本：V6.0（约 2026-09）
 * - 替代方案：Python 端 context_pipeline 中的预算分配
 * - 回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现（不推荐）
 * - 维护状态：仅安全修复，不再新增功能
 *
 * 注意：当 AGENT_BACKEND=python（默认）时，此文件不会被使用。
 *       仅当显式设置 AGENT_BACKEND=local 时才会使用此 TS 实现。
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
    const chineseRegex =
      /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u3400-\u4dbf]/g;

    const chineseMatches = text.match(chineseRegex) || [];

    // 计算中文字符数
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
