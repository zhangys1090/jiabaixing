/**
 * Harness Layer 3: Context - 上下文管理器
 *
 * 可组合的上下文管道，替代 JiabaixingCore 中的硬编码 prompt 拼接
 */

import { injectPreferences } from '../../memory/PreferenceInjector';
import { Logger } from '../../utils/Logger';
import type { ChatMessage, ContextEntry, TokenAllocation, UserInput } from '../types';
import { TokenBudgetAllocator } from './TokenBudgetAllocator';

/** 上下文压缩结果 */
export interface ContextCompressionResult {
  compressed: ChatMessage[];
  originalTokenCount: number;
  compressedTokenCount: number;
  compressionRatio: number;
  strategy: string;
}

/** 上下文摘要结果 */
export interface ContextSummaryResult {
  summary: ChatMessage;
  originalCount: number;
  summaryLength: number;
  keyPoints: string[];
}

/** 上下文卸荷策略 */
export type OffloadStrategy =
  | 'oldest_first'
  | 'least_relevant'
  | 'compress_and_summarize';

/** ContextManager 依赖 */
export interface ContextManagerDeps {
  /** 宪法 Prompt 构建器 */
  constitutionalBuilder: {
    buildConstitutionPrompt(userId?: string): Promise<string>;
  };
  /** 记忆注入器 */
  memoryInjector: {
    autoRetrieveMemories(input: string, userId?: string): Promise<string[]>;
  };
  /** 动态上下文提供者 */
  dynamicContext: {
    getDynamicContext(): string;
  };
  /** 对话历史提供者 */
  historyProvider: {
    getRecentHistory(limit: number): ChatMessage[];
    getAllHistory(): ChatMessage[];
  };
  /** 人格核心（进化闭环：语气参数注入 system prompt） */
  personaCore?: {
    buildPersonaSummary(): string;
    buildSceneToneInstruction(scene: string): string;
    getToneForScene(scene: string): {
      temperature: number;
      formality: number;
      verbosity: number;
      emojiFrequency: number;
      proactive: boolean;
    };
  };
  /** 场景识别器（用于匹配语气参数到当前场景） */
  sceneRecognizer?: {
    recognizeSceneFromInput(input: string): string;
  };
}

export class ContextManager {
  private deps: ContextManagerDeps;
  private allocator: TokenBudgetAllocator;
  private entries: ContextEntry[] = [];
  private offloadedHistory: ChatMessage[] = [];

  constructor(deps: ContextManagerDeps, totalBudget: number = 8000) {
    this.deps = deps;
    this.allocator = new TokenBudgetAllocator(totalBudget);
  }

  /**
   * 构建完整的上下文消息
   */
  async buildContext(input: UserInput): Promise<ChatMessage[]> {
    this.entries = [];
    const allocation = this.allocator.allocate();
    const messages: ChatMessage[] = [];

    // 1. Constitutional Prompt (priority: 10)
    try {
      const constitutional = await this.deps.constitutionalBuilder.buildConstitutionPrompt(input.userId);
      const enrichedConstitutional = injectPreferences(constitutional);
      const truncated = this.allocator.truncateToBudget(enrichedConstitutional, allocation.systemPrompt);
      messages.push({ role: 'system', content: truncated });
      this.entries.push({
        id: 'constitutional',
        type: 'system',
        content: truncated,
        priority: 10,
        tokenEstimate: this.allocator.estimateTokens(truncated),
        source: 'ConstitutionalBuilder',
      });
    } catch (err) {
      Logger.warn(`宪法 Prompt 构建失败: ${(err as Error).message}`, 'ContextManager');
    }

    // 2. Persona Tone Instruction (priority: 9) — 进化闭环：语气参数真实注入
    if (this.deps.personaCore) {
      try {
        const scene = this.deps.sceneRecognizer
          ? this.deps.sceneRecognizer.recognizeSceneFromInput(input.text)
          : this.inferSceneFromInput(input.text);
        const toneInstruction = this.deps.personaCore.buildSceneToneInstruction(scene);
        if (toneInstruction) {
          const personaSummary = this.deps.personaCore.buildPersonaSummary();
          const personaContent = `${personaSummary}\n\n${toneInstruction}`;
          const truncated = this.allocator.truncateToBudget(personaContent, allocation.dynamicContext);
          messages.push({ role: 'system', content: truncated });
          this.entries.push({
            id: 'persona_tone',
            type: 'dynamic',
            content: truncated,
            priority: 9,
            tokenEstimate: this.allocator.estimateTokens(truncated),
            source: 'PersonaCore',
          });
          Logger.info(
            `🎭 进化闭环: 语气指令已注入 [scene=${scene}]`,
            'ContextManager'
          );
        }
      } catch (err) {
        Logger.warn(`人格语气注入失败: ${(err as Error).message}`, 'ContextManager');
      }
    }

    // 3. Dynamic Context (priority: 9) — 时间/场景
    try {
      const dynamic = this.deps.dynamicContext.getDynamicContext();
      if (dynamic) {
        const truncated = this.allocator.truncateToBudget(dynamic, allocation.dynamicContext);
        messages.push({ role: 'system', content: truncated });
        this.entries.push({
          id: 'dynamic',
          type: 'dynamic',
          content: truncated,
          priority: 9,
          tokenEstimate: this.allocator.estimateTokens(truncated),
          source: 'DynamicContext',
        });
      }
    } catch {
      // 动态上下文失败不影响主流程
    }

    // 4. Auto Memories (priority: 7)
    try {
      const memories = await this.deps.memoryInjector.autoRetrieveMemories(
        input.text,
        input.userId
      );
      if (memories.length > 0) {
        const memoryText = memories.join('\n');
        const truncated = this.allocator.truncateToBudget(memoryText, allocation.memory);
        messages.push({ role: 'system', content: `【相关记忆】\n${truncated}` });
        this.entries.push({
          id: 'memories',
          type: 'memory',
          content: truncated,
          priority: 7,
          tokenEstimate: this.allocator.estimateTokens(truncated),
          source: 'MemoryInjector',
        });
      }
    } catch {
      // 记忆注入失败不影响主流程
    }

    // 5. Conversation History (priority: 5)
    try {
      const history = this.deps.historyProvider.getRecentHistory(10);
      const budgetChars = allocation.history * 2;
      let usedChars = 0;
      const truncatedHistory: ChatMessage[] = [];

      for (const msg of history) {
        const msgChars = (msg.content || '').length + 10;
        if (usedChars + msgChars > budgetChars) break;
        truncatedHistory.push(msg);
        usedChars += msgChars;
      }

      messages.push(...truncatedHistory);
      this.entries.push({
        id: 'history',
        type: 'history',
        content: `${truncatedHistory.length} 条历史消息`,
        priority: 5,
        tokenEstimate: this.allocator.estimateTokens(
          truncatedHistory.map((m) => m.content || '').join('')
        ),
        source: 'HistoryProvider',
      });
    } catch {
      // 历史加载失败不影响主流程
    }

    // 6. User Input
    messages.push({ role: 'user', content: input.text });

    Logger.info(
      `📋 上下文构建完成: ${messages.length} 条消息, ${this.entries.length} 个上下文条目`,
      'ContextManager'
    );

    return messages;
  }

  /**
   * 获取上下文条目
   */
  getEntries(): ContextEntry[] {
    return [...this.entries];
  }

  /**
   * 获取 Token 预算分配
   */
  getAllocation(): TokenAllocation {
    return this.allocator.allocate();
  }

  /**
   * 从用户输入推断场景（当 sceneRecognizer 不可用时使用）
   * 进化闭环：场景推断 → 匹配语气参数 → 注入 system prompt
   */
  private inferSceneFromInput(input: string): string {
    const text = input.toLowerCase();

    if (/代码|编程|开发|调试|bug|函数|接口|api|重构|部署/.test(text)) return 'development';
    if (/工作|项目|排期|会议|汇报|方案|需求|上线/.test(text)) return 'work';
    if (/难过|烦|累|焦虑|压力|不开心|心情|崩溃/.test(text)) return 'comfort';
    if (/你好|早上好|晚安|嗨|hello|hi/.test(text)) return 'greeting';
    if (/简报|总结|日报|周报|进度/.test(text)) return 'briefing';

    return 'daily';
  }

  // ==================== 新增功能: 上下文压缩、摘要、卸荷 ====================

  /**
   * 上下文压缩: 减少消息长度但保留核心语义
   */
  compressContext(
    messages: ChatMessage[],
    targetTokenCount: number
  ): ContextCompressionResult {
    const originalTokens = this.estimateMessageTokens(messages);
    if (originalTokens <= targetTokenCount) {
      return {
        compressed: [...messages],
        originalTokenCount: originalTokens,
        compressedTokenCount: originalTokens,
        compressionRatio: 1.0,
        strategy: 'none_needed',
      };
    }

    const compressed: ChatMessage[] = [];
    let currentTokens = 0;

    // 优先保留 system 消息
    const systemMessages = messages.filter((m) => m.role === 'system');
    for (const msg of systemMessages) {
      const msgTokens = this.estimateMessageTokens([msg]);
      if (currentTokens + msgTokens <= targetTokenCount) {
        compressed.push(msg);
        currentTokens += msgTokens;
      } else {
        // 对 system 消息进行截断
        const truncated = this.truncateMessage(msg, targetTokenCount - currentTokens);
        compressed.push(truncated);
        currentTokens = targetTokenCount;
        break;
      }
    }

    // 处理对话历史（保留最新消息）
    const historyMessages = messages.filter(
      (m) => m.role !== 'system'
    ).reverse();

    for (const msg of historyMessages) {
      const msgTokens = this.estimateMessageTokens([msg]);
      if (currentTokens + msgTokens <= targetTokenCount) {
        compressed.push(msg);
        currentTokens += msgTokens;
      } else {
        // 尝试压缩这条消息
        const compressedMsg = this.compressSingleMessage(msg);
        const compressedTokens = this.estimateMessageTokens([compressedMsg]);
        if (currentTokens + compressedTokens <= targetTokenCount) {
          compressed.push(compressedMsg);
          currentTokens += compressedTokens;
        }
      }
    }

    // 重新排序
    compressed.sort((a, b) => {
      if (a.role === 'system' && b.role !== 'system') return -1;
      if (b.role === 'system' && a.role !== 'system') return 1;
      return 0;
    });

    const finalTokens = this.estimateMessageTokens(compressed);
    return {
      compressed,
      originalTokenCount: originalTokens,
      compressedTokenCount: finalTokens,
      compressionRatio: finalTokens / originalTokens,
      strategy: 'truncate_and_compress',
    };
  }

  /**
   * 上下文摘要: 生成对话历史的摘要
   */
  summarizeContext(
    messages: ChatMessage[],
    maxSummaryLength: number = 1000
  ): ContextSummaryResult {
    const keyPoints: string[] = [];
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    // 提取关键点
    for (const msg of userMessages.slice(-10)) {
      if (msg.content && msg.content.length > 0) {
        keyPoints.push(`用户: ${msg.content.substring(0, 100)}`);
      }
    }

    // 构建摘要
    const summaryContent = `【对话摘要】
本次会话共 ${messages.length} 条消息
- 用户消息: ${userMessages.length} 条
- 助手回复: ${assistantMessages.length} 条
- 对话时间跨度: ${this.estimateTimeSpan(messages)}

关键主题:
${keyPoints.slice(-5).join('\n')}`;

    const truncatedSummary = summaryContent.substring(0, maxSummaryLength);

    return {
      summary: {
        role: 'system',
        content: truncatedSummary,
      },
      originalCount: messages.length,
      summaryLength: truncatedSummary.length,
      keyPoints,
    };
  }

  /**
   * 上下文卸荷: 将旧消息移动到 "卸荷" 存储
   */
  offloadOldMessages(
    messages: ChatMessage[],
    keepCount: number = 10,
    strategy: OffloadStrategy = 'oldest_first'
  ): {
    active: ChatMessage[];
    offloaded: ChatMessage[];
  } {
    // 提取所有非系统消息
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemMessages = messages.filter((m) => m.role === 'system');

    let activeNonSystem: ChatMessage[];
    let offloaded: ChatMessage[];

    switch (strategy) {
      case 'oldest_first':
        activeNonSystem = nonSystemMessages.slice(-keepCount);
        offloaded = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
        break;

      case 'least_relevant':
        // 简单实现：保留最新的，其余卸荷
        activeNonSystem = nonSystemMessages.slice(-keepCount);
        offloaded = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
        break;

      case 'compress_and_summarize':
        // 保留最新的，其他先压缩然后生成摘要
        const toOffload = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
        activeNonSystem = nonSystemMessages.slice(-keepCount);
        offloaded = toOffload;
        break;

      default:
        activeNonSystem = nonSystemMessages.slice(-keepCount);
        offloaded = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
    }

    // 存储卸荷的消息
    this.offloadedHistory.push(...offloaded);

    Logger.info(
      `📦 上下文卸荷完成: 保留 ${activeNonSystem.length} 条, 卸荷 ${offloaded.length} 条`,
      'ContextManager'
    );

    return {
      active: [...systemMessages, ...activeNonSystem],
      offloaded,
    };
  }

  /**
   * 从卸荷存储中检索消息
   */
  retrieveOffloadedMessages(
    keywords?: string[],
    limit: number = 20
  ): ChatMessage[] {
    let result = [...this.offloadedHistory].reverse();

    if (keywords && keywords.length > 0) {
      result = result.filter((msg) =>
        keywords.some((kw) =>
          msg.content?.toLowerCase().includes(kw.toLowerCase())
        )
      );
    }

    return result.slice(0, limit);
  }

  // ==================== 辅助方法 ====================

  /**
   * 估算消息的 token 数
   */
  private estimateMessageTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => {
      return total + this.allocator.estimateTokens(msg.content || '');
    }, 0);
  }

  /**
   * 截断单条消息
   */
  private truncateMessage(msg: ChatMessage, maxTokens: number): ChatMessage {
    const charLimit = maxTokens * 2;
    const content = msg.content || '';
    if (content.length <= charLimit) return msg;
    return {
      ...msg,
      content: content.substring(0, charLimit) + '...(内容已截断)',
    };
  }

  /**
   * 压缩单条消息
   */
  private compressSingleMessage(msg: ChatMessage): ChatMessage {
    const content = msg.content || '';
    // 简单压缩：移除多余空格，截断长内容
    const compressed = content
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, Math.max(100, content.length / 2));

    return {
      ...msg,
      content:
        compressed.length < content.length
          ? `${compressed}...(已压缩)`
          : compressed,
    };
  }

  /**
   * 估算对话的时间跨度
   */
  private estimateTimeSpan(messages: ChatMessage[]): string {
    // 简单实现：返回 "未知"
    return '未知';
  }
}
