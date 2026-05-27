/**
 * Token预算管理器
 * 动态分配和管理上下文Token预算
 */

import { Logger } from '../utils/Logger';

export interface TokenBudgetConfig {
  maxTotalTokens: number;
  reservedForResponse: number;
  maxForSystemPrompt: number;
  maxForMemories: number;
  maxForTools: number;
  maxForContext: number;
}

export interface TokenAllocation {
  systemPrompt: number;
  memories: number;
  tools: number;
  context: number;
  userInput: number;
  reserved: number;
  total: number;
}

export interface TokenUsage {
  systemPrompt: number;
  memories: number;
  tools: number;
  context: number;
  userInput: number;
  response: number;
  timestamp: Date;
}

const DEFAULT_CONFIG: TokenBudgetConfig = {
  maxTotalTokens: 4096,
  reservedForResponse: 1024,
  maxForSystemPrompt: 500,
  maxForMemories: 800,
  maxForTools: 300,
  maxForContext: 400,
};

export class TokenBudgetManager {
  private config: TokenBudgetConfig;
  private usageHistory: TokenUsage[] = [];
  private readonly MAX_HISTORY = 100;

  constructor(config: Partial<TokenBudgetConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    Logger.info(
      `📊 TokenBudgetManager 初始化，总预算: ${this.config.maxTotalTokens}`,
      'TokenBudgetManager'
    );
  }

  public allocate(inputLength: number): TokenAllocation {
    const availableForInput =
      this.config.maxTotalTokens -
      this.config.reservedForResponse -
      this.config.maxForSystemPrompt -
      this.config.maxForMemories -
      this.config.maxForTools -
      this.config.maxForContext;

    const actualInputTokens = Math.min(inputLength, availableForInput);

    const allocation: TokenAllocation = {
      systemPrompt: this.config.maxForSystemPrompt,
      memories: this.config.maxForMemories,
      tools: this.config.maxForTools,
      context: this.config.maxForContext,
      userInput: actualInputTokens,
      reserved: this.config.reservedForResponse,
      total:
        this.config.maxForSystemPrompt +
        this.config.maxForMemories +
        this.config.maxForTools +
        this.config.maxForContext +
        actualInputTokens +
        this.config.reservedForResponse,
    };

    Logger.debug(
      `💰 Token分配: 系统=${allocation.systemPrompt}, 记忆=${allocation.memories}, 工具=${allocation.tools}, 上下文=${allocation.context}, 输入=${allocation.userInput}, 预留=${allocation.reserved}`,
      'TokenBudgetManager'
    );

    return allocation;
  }

  public countTokens(text: string): number {
    if (!text) return 0;

    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const numbers = (text.match(/\d+/g) || []).length;
    const punctuation = (text.match(/[^\w\s\u4e00-\u9fa5]/g) || []).length;
    const spaces = (text.match(/\s+/g) || []).length;

    return Math.ceil(
      chineseChars * 1.5 +
        englishWords * 1.3 +
        numbers * 0.5 +
        punctuation * 0.3 +
        spaces * 0.1
    );
  }

  public truncateToFit(text: string, maxTokens: number): string {
    const currentTokens = this.countTokens(text);

    if (currentTokens <= maxTokens) {
      return text;
    }

    const ratio = maxTokens / currentTokens;
    const targetLength = Math.floor(text.length * ratio * 0.95);

    let truncated = text.substring(0, targetLength);

    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('。'),
      truncated.lastIndexOf('！'),
      truncated.lastIndexOf('？'),
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?')
    );

    if (lastSentenceEnd > targetLength * 0.7) {
      truncated = truncated.substring(0, lastSentenceEnd + 1);
    }

    Logger.debug(
      `✂️ 文本截断: ${currentTokens} → ${this.countTokens(truncated)} tokens`,
      'TokenBudgetManager'
    );

    return truncated + '\n...(内容已截断)';
  }

  public truncateMemories(
    memories: Array<{ content: string; relevance: number }>,
    maxTokens: number
  ): Array<{ content: string; relevance: number }> {
    const sortedMemories = [...memories].sort(
      (a, b) => b.relevance - a.relevance
    );

    const result: Array<{ content: string; relevance: number }> = [];
    let currentTokens = 0;

    for (const memory of sortedMemories) {
      const memoryTokens = this.countTokens(memory.content);

      if (currentTokens + memoryTokens <= maxTokens) {
        result.push(memory);
        currentTokens += memoryTokens;
      } else if (maxTokens - currentTokens > 50) {
        const truncatedContent = this.truncateToFit(
          memory.content,
          maxTokens - currentTokens - 20
        );
        result.push({ ...memory, content: truncatedContent });
        break;
      } else {
        break;
      }
    }

    Logger.debug(
      `📚 记忆筛选: ${memories.length} → ${result.length} 条, ${currentTokens} tokens`,
      'TokenBudgetManager'
    );

    return result;
  }

  public recordUsage(usage: TokenUsage): void {
    this.usageHistory.push(usage);

    if (this.usageHistory.length > this.MAX_HISTORY) {
      this.usageHistory.shift();
    }
  }

  public getUsageStats(): {
    averageTotal: number;
    averageMemories: number;
    averageResponse: number;
    peakTotal: number;
  } {
    if (this.usageHistory.length === 0) {
      return {
        averageTotal: 0,
        averageMemories: 0,
        averageResponse: 0,
        peakTotal: 0,
      };
    }

    const totals = this.usageHistory.map(
      (u) =>
        u.systemPrompt +
        u.memories +
        u.tools +
        u.context +
        u.userInput +
        u.response
    );
    const memories = this.usageHistory.map((u) => u.memories);
    const responses = this.usageHistory.map((u) => u.response);

    return {
      averageTotal: totals.reduce((a, b) => a + b, 0) / totals.length,
      averageMemories: memories.reduce((a, b) => a + b, 0) / memories.length,
      averageResponse: responses.reduce((a, b) => a + b, 0) / responses.length,
      peakTotal: Math.max(...totals),
    };
  }

  public updateConfig(newConfig: Partial<TokenBudgetConfig>): void {
    this.config = { ...this.config, ...newConfig };
    Logger.info(
      `🔄 Token预算配置已更新: ${JSON.stringify(this.config)}`,
      'TokenBudgetManager'
    );
  }

  public getConfig(): TokenBudgetConfig {
    return { ...this.config };
  }

  public checkBudget(tokens: number): {
    ok: boolean;
    remaining: number;
    percentage: number;
  } {
    const remaining = this.config.maxTotalTokens - tokens;
    const percentage = (tokens / this.config.maxTotalTokens) * 100;

    return {
      ok: tokens <= this.config.maxTotalTokens,
      remaining,
      percentage,
    };
  }
}

export const tokenBudgetManager = new TokenBudgetManager();
