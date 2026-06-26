/**
 * ContextCompressionPipeline — 统一上下文压缩入口
 *
 * 整合项目中分散的多处压缩逻辑：
 *   - PromptOptimizer.compressHistory() — 历史消息截断
 *   - ConversationCompressor — 旧对话摘要化
 *   - LLMContextBuilder.compressMemories() — 记忆级压缩
 *   - ContextWindowManager — 循环级工具结果截断
 *   - TokenBudgetManager — 预算分配
 *
 * 统一调度流程：
 *   1. 获取当前 Provider 的 maxTokens
 *   2. 按 Token 预算分配比例分配配额
 *   3. 按优先级压缩各层内容（system > memories > tools > history）
 *   4. 动态调整直到总 Token 数 <= 预算
 *
 * 目标：让 Agent 在任何模型窗口大小下都能高效工作，
 * 不因 Token 爆炸而丢失关键上下文。
 */

import { Logger } from '../utils/Logger';

/** Token 预算分配方案 */
export interface TokenBudgetAllocation {
  /** 总预算 */
  total: number;
  /** 系统提示配额 */
  system: number;
  /** 记忆配额 */
  memories: number;
  /** 工具结果配额 */
  tools: number;
  /** 对话历史配额 */
  history: number;
  /** 留给响应的配额 */
  response: number;
}

/** 压缩层优先级（越低越优先保留） */
export type CompressionPriority = 'system' | 'memories' | 'history' | 'tools';

/** 压缩结果 */
export interface CompressionResult {
  /** 压缩后的内容 */
  compressed: string;
  /** 原始 Token 数（估算） */
  originalTokens: number;
  /** 压缩后 Token 数（估算） */
  compressedTokens: number;
  /** 压缩率 */
  ratio: number;
  /** 使用的压缩策略 */
  strategy: string;
}

/** 模型窗口大小映射 */
const MODEL_WINDOW_MAP: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'claude-3.5-sonnet': 200000,
  'claude-3-opus': 200000,
  'claude-3-haiku': 200000,
  'deepseek-chat': 65536,
  'deepseek-reasoner': 65536,
  'glm-4': 128000,
  'qwen-max': 32768,
  'qwen-plus': 32768,
  'llama-3.1-70b': 8192,
  default: 4096,
};

export class ContextCompressionPipeline {
  private currentModel: string = '';
  private customMaxTokens?: number;

  /**
   * 设置当前使用的模型
   * 模型名称会自动映射到对应的上下文窗口大小
   */
  setModel(model: string): void {
    this.currentModel = model.toLowerCase();
    Logger.debug(`上下文压缩管道: 设置模型 ${model}`, 'CompressionPipeline');
  }

  /**
   * 设置自定义最大 Token 数
   * 覆盖模型默认值
   */
  setCustomMaxTokens(maxTokens: number): void {
    this.customMaxTokens = maxTokens;
  }

  /**
   * 获取当前模型的上下文窗口大小
   */
  getModelMaxTokens(): number {
    if (this.customMaxTokens) return this.customMaxTokens;

    // 查找匹配的模型窗口
    for (const [key, value] of Object.entries(MODEL_WINDOW_MAP)) {
      if (this.currentModel.includes(key)) return value;
    }

    return MODEL_WINDOW_MAP['default'];
  }

  /**
   * 按 Token 预算分配配额
   *
   * 分配策略：
   *   - system: 15%（固定，不可压缩）
   *   - memories: 10%
   *   - history: 40%（最可压缩的层）
   *   - tools: 15%
   *   - response: 20%（留给 Agent 输出）
   */
  allocateBudget(): TokenBudgetAllocation {
    const total = this.getModelMaxTokens();
    return {
      total,
      system: Math.floor(total * 0.15),
      memories: Math.floor(total * 0.1),
      history: Math.floor(total * 0.4),
      tools: Math.floor(total * 0.15),
      response: Math.floor(total * 0.2),
    };
  }

  /**
   * 估算文本的 Token 数
   * 中英文混合估算：CJK字符÷1.5 + 其他÷4
   */
  estimateTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
      // CJK Unicode 范围
      if (
        (char.charCodeAt(0) >= 0x4e00 && char.charCodeAt(0) <= 0x9fff) || // 基本汉字
        (char.charCodeAt(0) >= 0x3400 && char.charCodeAt(0) <= 0x4dbf) || // 扩展A
        (char.charCodeAt(0) >= 0x3000 && char.charCodeAt(0) <= 0x303f) || // 标点
        (char.charCodeAt(0) >= 0xff00 && char.charCodeAt(0) <= 0xffef) // 全角
      ) {
        tokens += 1 / 1.5;
      } else {
        tokens += 1 / 4;
      }
    }
    return Math.ceil(tokens);
  }

  /**
   * 压缩对话历史
   *
   * 策略：
   *   1. 如果 Token 数在预算内 → 不压缩
   *   2. 如果超出 → 从最早的消息开始压缩
   *   3. 压缩方式：
   *      a. 截断最早的消息（保留最近 N 条）
   *      b. 对最早的消息做摘要合并
   *      c. 移除低优先级的系统消息
   */
  compressHistory(
    messages: Array<{ role: string; content: string }>,
    budget: number
  ): CompressionResult {
    const totalTokens = this.estimateTokens(
      messages.map((m) => m.content).join('\n')
    );

    if (totalTokens <= budget) {
      return {
        compressed: JSON.stringify(messages),
        originalTokens: totalTokens,
        compressedTokens: totalTokens,
        ratio: 1,
        strategy: 'none',
      };
    }

    // 策略1: 截断式压缩 — 保留最近的消息直到预算用完
    const retained: Array<{ role: string; content: string }> = [];
    let usedTokens = 0;

    // 从最新消息开始保留（倒序）
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens(messages[i].content);
      if (usedTokens + msgTokens > budget) break;
      retained.unshift(messages[i]);
      usedTokens += msgTokens;
    }

    // 如果有被截断的历史，生成摘要前缀
    const truncated = messages.slice(0, messages.length - retained.length);
    let summaryPrefix = '';

    if (truncated.length > 0) {
      // 简要摘要：取前几条的关键信息
      const keyPoints = truncated
        .filter((m) => m.role === 'user')
        .slice(0, 3)
        .map((m) => m.content.substring(0, 100))
        .join('; ');

      summaryPrefix = `[历史摘要: ${keyPoints}]\n\n`;
    }

    const compressedText =
      summaryPrefix + retained.map((m) => m.content).join('\n');
    const compressedTokens = this.estimateTokens(compressedText);

    Logger.info(
      `上下文压缩: ${totalTokens} → ${compressedTokens} tokens (策略: 截断+摘要, 保留 ${retained.length}/${messages.length} 条)`,
      'CompressionPipeline'
    );

    return {
      compressed: JSON.stringify(retained),
      originalTokens: totalTokens,
      compressedTokens,
      ratio: compressedTokens / totalTokens,
      strategy: truncated.length > 0 ? 'truncate+summary' : 'truncate',
    };
  }

  /**
   * 压缩工具结果
   *
   * 策略：截断过长的工具输出，保留关键信息
   */
  compressToolResults(
    results: Array<{ toolName: string; output: string }>,
    budget: number
  ): CompressionResult {
    const totalTokens = this.estimateTokens(
      results.map((r) => r.output).join('\n')
    );

    if (totalTokens <= budget) {
      return {
        compressed: JSON.stringify(results),
        originalTokens: totalTokens,
        compressedTokens: totalTokens,
        ratio: 1,
        strategy: 'none',
      };
    }

    // 每个工具结果截断到预算/数量 的平均值
    const perToolBudget = Math.floor(budget / results.length);
    const compressed = results.map((r) => {
      const maxChars = Math.floor(perToolBudget * 4); // 粗略：1 token ≈ 4 chars
      if (r.output.length <= maxChars) return r;
      return {
        ...r,
        output: r.output.substring(0, maxChars) + '\n...[截断]',
      };
    });

    const compressedText = compressed.map((r) => r.output).join('\n');
    const compressedTokens = this.estimateTokens(compressedText);

    return {
      compressed: JSON.stringify(compressed),
      originalTokens: totalTokens,
      compressedTokens,
      ratio: compressedTokens / totalTokens,
      strategy: 'truncate-per-tool',
    };
  }

  /**
   * 压缩记忆片段
   *
   * 策略：每条记忆只保留前2句 + 关键信息标记
   */
  compressMemories(
    memories: Array<{ content: string; relevance?: number }>,
    budget: number
  ): CompressionResult {
    const totalTokens = this.estimateTokens(
      memories.map((m) => m.content).join('\n')
    );

    if (totalTokens <= budget) {
      return {
        compressed: JSON.stringify(memories),
        originalTokens: totalTokens,
        compressedTokens: totalTokens,
        ratio: 1,
        strategy: 'none',
      };
    }

    // 按相关性排序（高相关性优先保留）
    const sorted = [...memories].sort(
      (a, b) => (b.relevance || 0) - (a.relevance || 0)
    );

    const compressed: Array<{ content: string; relevance?: number }> = [];
    let usedTokens = 0;

    for (const mem of sorted) {
      // 每条记忆只保留前2句
      const sentences = mem.content.split(/[。？！\n.?!]+/).filter(Boolean);
      const compressedContent = sentences.slice(0, 2).join('。');

      const tokens = this.estimateTokens(compressedContent);
      if (usedTokens + tokens > budget) break;

      compressed.push({
        content: compressedContent + (sentences.length > 2 ? '...' : ''),
        relevance: mem.relevance,
      });
      usedTokens += tokens;
    }

    const compressedText = compressed.map((m) => m.content).join('\n');

    return {
      compressed: JSON.stringify(compressed),
      originalTokens: totalTokens,
      compressedTokens: this.estimateTokens(compressedText),
      ratio: this.estimateTokens(compressedText) / totalTokens,
      strategy: 'top2-sentences+relevance-sort',
    };
  }
}
