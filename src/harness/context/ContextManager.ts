/**
 * Harness Layer 3: Context - 上下文管理器
 *
 * 可组合的上下文管道，替代 JiabaixingCore 中的硬编码 prompt 拼接
 *
 * Phase 2 增强:
 *   - compressHistory(): 自动上下文压缩，当 Token 预算超阈值时合并早期对话
 *   - summarizeHistory(): LLM 驱动的对话摘要，回退到规则引擎
 *   - offloadHistory(): LRU 策略 + 文件系统卸荷索引
 */

import fs from 'fs';
import path from 'path';
import { injectPreferences } from '../../memory/PreferenceInjector';
import { Logger } from '../../utils/Logger';
import type {
  ChatMessage,
  ContextEntry,
  TokenAllocation,
  UserInput,
} from '../types';
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

/** 卸荷索引条目 */
interface OffloadIndexEntry {
  messageId: string;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  filePath: string;
  keywords: string[];
}

/** 压缩触发阈值配置 */
export interface CompressionThresholdConfig {
  /** Token 使用率阈值 (0-1)，超过则触发压缩 */
  tokenUsageThreshold: number;
  /** 历史消息条数阈值，超过则触发压缩 */
  historyCountThreshold: number;
  /** 压缩后保留的最少历史条数 */
  minRetainedHistory: number;
}

const DEFAULT_COMPRESSION_THRESHOLD: CompressionThresholdConfig = {
  tokenUsageThreshold: 0.85,
  historyCountThreshold: 30,
  minRetainedHistory: 6,
};

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
  /** 桌面环境感知注入 */
  environmentSensor?: {
    getEnvironmentContext(): string;
  };
  /** 进化纠错示例 */
  evolutionExamples?: {
    getPromptExamples(): Array<{
      trigger: string;
      correction: string;
      example: string;
      frequency: number;
    }>;
  };
  /** LLM 提供者（用于摘要生成） */
  llm?: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
  /** 长期记忆存储（用于保存摘要） */
  longTermMemory?: {
    store(content: string, metadata?: Record<string, unknown>): Promise<void>;
  };
  /** 卸荷文件目录 */
  offloadDir?: string;
}

export class ContextManager {
  private deps: ContextManagerDeps;
  private allocator: TokenBudgetAllocator;
  private entries: ContextEntry[] = [];
  private offloadedHistory: ChatMessage[] = [];
  private offloadIndex: OffloadIndexEntry[] = [];
  private compressionConfig: CompressionThresholdConfig;
  private lruAccessMap: Map<string, number> = new Map();

  constructor(deps: ContextManagerDeps, totalBudget: number = 8000) {
    this.deps = deps;
    this.allocator = new TokenBudgetAllocator(totalBudget);
    this.compressionConfig = DEFAULT_COMPRESSION_THRESHOLD;
    if (this.deps.offloadDir) {
      this.loadOffloadIndex();
    }
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
      const constitutional =
        await this.deps.constitutionalBuilder.buildConstitutionPrompt(
          input.userId
        );
      const enrichedConstitutional = injectPreferences(constitutional);
      const truncated = this.allocator.truncateToBudget(
        enrichedConstitutional,
        allocation.systemPrompt
      );
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
      Logger.warn(
        `宪法 Prompt 构建失败: ${(err as Error).message}`,
        'ContextManager'
      );
    }

    // 2. Persona Tone Instruction (priority: 9) — 进化闭环：语气参数真实注入
    if (this.deps.personaCore) {
      try {
        const scene = this.deps.sceneRecognizer
          ? this.deps.sceneRecognizer.recognizeSceneFromInput(input.text)
          : this.inferSceneFromInput(input.text);
        const toneInstruction =
          this.deps.personaCore.buildSceneToneInstruction(scene);
        if (toneInstruction) {
          const personaSummary = this.deps.personaCore.buildPersonaSummary();
          const personaContent = `${personaSummary}\n\n${toneInstruction}`;
          const truncated = this.allocator.truncateToBudget(
            personaContent,
            allocation.dynamicContext
          );
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
        Logger.warn(
          `人格语气注入失败: ${(err as Error).message}`,
          'ContextManager'
        );
      }
    }

    // 3. Dynamic Context (priority: 9) — 时间/场景
    try {
      const dynamic = this.deps.dynamicContext.getDynamicContext();
      if (dynamic) {
        const truncated = this.allocator.truncateToBudget(
          dynamic,
          allocation.dynamicContext
        );
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
        const truncated = this.allocator.truncateToBudget(
          memoryText,
          allocation.memory
        );
        messages.push({
          role: 'system',
          content: `【相关记忆】\n${truncated}`,
        });
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

    // 4.5 桌面环境感知 (priority: 6)
    try {
      const envContext = this.deps.environmentSensor?.getEnvironmentContext?.();
      if (envContext) {
        const truncated = this.allocator.truncateToBudget(
          envContext,
          allocation.dynamicContext
        );
        messages.push({
          role: 'system',
          content: `【当前环境】\n${truncated}`,
        });
        this.entries.push({
          id: 'environment',
          type: 'dynamic',
          content: truncated,
          priority: 6,
          tokenEstimate: this.allocator.estimateTokens(truncated),
          source: 'EnvironmentSensor',
        });
      }
    } catch {
      // 环境感知失败不影响主流程
    }

    // 4.6 进化纠错提示 (priority: 6)
    try {
      const examples = this.deps.evolutionExamples?.getPromptExamples?.();
      if (examples && examples.length > 0) {
        const top = examples
          .sort((a, b) => b.frequency - a.frequency)
          .slice(0, 2);
        const hintText = top
          .map(
            (e, i) =>
              `${i + 1}. 当用户说"${e.trigger}" → 正确做法: ${e.correction}`
          )
          .join('\n');
        messages.push({
          role: 'system',
          content: `【进化经验】\n以下是从历史交互中学习的经验：\n${hintText}`,
        });
      }
    } catch {
      // 进化提示注入失败不影响主流程
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

      const historyTokens = this.estimateMessageTokens(truncatedHistory);
      const historyBudget = allocation.history;
      if (
        historyTokens >
        historyBudget * this.compressionConfig.tokenUsageThreshold
      ) {
        Logger.info(
          `🗜️ Token 使用率超阈值 (${((historyTokens / historyBudget) * 100).toFixed(0)}%)，触发自动压缩`,
          'ContextManager'
        );
        const compressionResult = this.compressHistory(messages, historyBudget);
        const historyIdx = messages.findIndex(
          (m) => m.role !== 'system' && m.role !== 'user'
        );
        if (historyIdx !== -1) {
          const systemMsgs = messages.filter((m) => m.role === 'system');
          const userInputMsg = messages.find(
            (m) => m.role === 'user' && m.content === input.text
          );
          messages.length = 0;
          messages.push(...systemMsgs);
          messages.push(
            ...compressionResult.compressed.filter((m) => m.role !== 'system')
          );
          if (userInputMsg) {
            const existingUser = messages.find(
              (m) => m.role === 'user' && m.content === input.text
            );
            if (!existingUser) {
              messages.push(userInputMsg);
            }
          }
        }
      }
    } catch {
      // 历史加载失败不影响主流程
    }

    // 6. User Input (skip if already added by compression path above)
    const userInputAlreadyAdded = messages.some(
      (m) => m.role === 'user' && m.content === input.text
    );
    if (!userInputAlreadyAdded) {
      messages.push({ role: 'user', content: input.text });
    }

    Logger.info(
      `📋 上下文构建完成: ${messages.length} 条消息, ${this.entries.length} 个上下文条目`,
      'ContextManager'
    );

    return messages;
  }

  /**
   * H2: 按阶段构建优化上下文——每个阶段只注入所需信息，避免token浪费
   *
   * - planning: 宪法 + 最近对话 + 输入（不含环境、语气、记忆）
   * - execution: 宪法 + 语气 + 环境 + 记忆 + 完整对话（含进化经验）
   */
  async buildPhaseContext(
    input: UserInput,
    phase: 'planning' | 'execution'
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    this.entries.length = 0;

    // Constitution prompt (both phases)
    if (this.deps.constitutionalBuilder) {
      try {
        const constitution =
          await this.deps.constitutionalBuilder.buildConstitutionPrompt();
        messages.push({ role: 'system', content: constitution });
      } catch {
        messages.push({ role: 'system', content: '你是一个智能助手。' });
      }
    } else {
      messages.push({ role: 'system', content: '你是一个智能助手。' });
    }

    if (phase === 'execution') {
      // Persona summary (only for execution, not planning)
      if (this.deps.personaCore) {
        try {
          const persona = this.deps.personaCore.buildPersonaSummary();
          if (persona) {
            messages.push({ role: 'system', content: `[语气基调]\n${persona}` });
          }
        } catch {
          // non-critical
        }
      }

      // Environment context (only for execution)
      if (this.deps.dynamicContext) {
        try {
          const env = this.deps.dynamicContext.getDynamicContext();
          if (env) {
            messages.push({ role: 'system', content: `[当前环境]\n${env}` });
          }
        } catch {
          // non-critical
        }
      }

      // Evolution examples (only for execution)
      if (this.deps.evolutionExamples) {
        try {
          const examples = this.deps.evolutionExamples.getPromptExamples();
          if (examples?.length) {
            const text = examples
              .slice(0, 2)
              .map((e) => `- 触发: ${e.trigger} → 修正: ${e.correction}`)
              .join('\n');
            if (text) {
              messages.push({ role: 'system', content: `[进化经验]\n${text}` });
            }
          }
        } catch {
          // non-critical
        }
      }

      // Memory injection (only for execution)
      if (this.deps.memoryInjector) {
        try {
          const memories = await this.deps.memoryInjector.autoRetrieveMemories(
            input.text
          );
          if (memories?.length) {
            const memoryContext = memories.slice(0, 5).join('\n');
            if (memoryContext) {
              messages.push({
                role: 'system',
                content: `[相关记忆]\n${memoryContext}`,
              });
            }
          }
        } catch {
          // non-critical
        }
      }
    }

    // Conversation history (planning=less, execution=more)
    if (this.deps.historyProvider) {
      try {
        const history =
          phase === 'planning'
            ? this.deps.historyProvider.getRecentHistory(3)
            : this.deps.historyProvider.getRecentHistory(10);
        if (history?.length) {
          messages.push(...history);
        }
      } catch {
        // non-critical
      }
    }

    // User input
    messages.push({ role: 'user', content: input.text });

    // 自动缩减：当消息超过阈值时触发压缩
    const totalTokens = this.estimateMessageTokens(messages);
    const budget = this.allocator.allocate();
    const totalBudget = budget.systemPrompt + budget.dynamicContext + budget.memory + budget.history + budget.reserve;

    if (totalTokens > totalBudget * this.compressionConfig.tokenUsageThreshold) {
      Logger.info(
        `🗜️ buildPhaseContext Token 超阈值 (${totalTokens} > ${Math.round(totalBudget * this.compressionConfig.tokenUsageThreshold)})，触发自动缩减`,
        'ContextManager'
      );
      const compressionResult = this.compressHistory(messages, totalBudget);
      if (compressionResult.compressed.length < messages.length ||
          compressionResult.compressedTokenCount < totalTokens) {
        messages.length = 0;
        messages.push(...compressionResult.compressed);

        // 确保用户输入仍在
        const hasUserInput = messages.some(
          (m) => m.role === 'user' && m.content === input.text
        );
        if (!hasUserInput) {
          messages.push({ role: 'user', content: input.text });
        }
      }
    }

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

    if (/代码|编程|开发|调试|bug|函数|接口|api|重构|部署/.test(text))
      return 'development';
    if (/工作|项目|排期|会议|汇报|方案|需求|上线/.test(text)) return 'work';
    if (/难过|烦|累|焦虑|压力|不开心|心情|崩溃/.test(text)) return 'comfort';
    if (/你好|早上好|晚安|嗨|hello|hi/.test(text)) return 'greeting';
    if (/简报|总结|日报|周报|进度/.test(text)) return 'briefing';

    return 'daily';
  }

  // ==================== Phase 2: 上下文压缩、摘要、卸荷 ====================

  /**
   * 上下文压缩: 当 Token 预算超阈值时自动合并早期对话为摘要
   *
   * @param messages - 当前消息列表
   * @param targetTokenCount - 目标 Token 数
   * @returns 压缩结果
   */
  compressHistory(
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

    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const systemTokens = this.estimateMessageTokens(systemMessages);
    const availableForHistory = targetTokenCount - systemTokens;

    if (availableForHistory <= 0) {
      const truncatedSystem = systemMessages.map((m) =>
        this.truncateMessage(
          m,
          Math.floor(targetTokenCount / systemMessages.length)
        )
      );
      const finalTokens = this.estimateMessageTokens(truncatedSystem);
      return {
        compressed: truncatedSystem,
        originalTokenCount: originalTokens,
        compressedTokenCount: finalTokens,
        compressionRatio: finalTokens / originalTokens,
        strategy: 'system_only_truncated',
      };
    }

    const retainedCount = Math.max(
      this.compressionConfig.minRetainedHistory,
      Math.floor(nonSystemMessages.length * 0.3)
    );
    const recentMessages = nonSystemMessages.slice(-retainedCount);
    const oldMessages = nonSystemMessages.slice(
      0,
      nonSystemMessages.length - retainedCount
    );

    let summaryMessage: ChatMessage | null = null;
    if (oldMessages.length > 0) {
      const summaryResult = this.summarizeContext(
        oldMessages,
        availableForHistory * 2
      );
      summaryMessage = summaryResult.summary;
    }

    const compressed: ChatMessage[] = [...systemMessages];
    if (summaryMessage) {
      compressed.push(summaryMessage);
    }
    compressed.push(...recentMessages);

    const finalTokens = this.estimateMessageTokens(compressed);
    return {
      compressed,
      originalTokenCount: originalTokens,
      compressedTokenCount: finalTokens,
      compressionRatio: finalTokens / originalTokens,
      strategy: 'compress_early_keep_recent',
    };
  }

  /**
   * 上下文摘要: LLM 驱动的对话摘要，回退到规则引擎
   *
   * @param messages - 需要摘要的消息列表
   * @param maxSummaryLength - 摘要最大长度
   * @returns 摘要结果
   */
  async summarizeHistory(
    messages: ChatMessage[],
    maxSummaryLength: number = 1000
  ): Promise<ContextSummaryResult> {
    if (this.deps.llm) {
      try {
        const conversationText = messages
          .map((m) => `${m.role}: ${m.content || ''}`)
          .join('\n');

        const prompt = `请对以下对话历史生成简洁的摘要，保留关键信息和决策点。摘要应包含：
1. 用户的主要需求
2. 已完成的关键操作
3. 重要的中间结果
4. 待解决的问题

对话历史:
${conversationText.substring(0, 4000)}

请直接输出摘要内容，不要包含其他格式。`;

        const llmSummary = await this.deps.llm.chat(prompt);
        const truncatedSummary = llmSummary.substring(0, maxSummaryLength);

        const keyPoints = this.extractKeyPoints(messages);

        if (this.deps.longTermMemory) {
          try {
            await this.deps.longTermMemory.store(truncatedSummary, {
              type: 'conversation_summary',
              messageCount: messages.length,
              timestamp: Date.now(),
            });
            Logger.info('📝 对话摘要已存储到长期记忆', 'ContextManager');
          } catch (err) {
            Logger.warn(
              `摘要存储失败: ${(err as Error).message}`,
              'ContextManager'
            );
          }
        }

        return {
          summary: {
            role: 'system',
            content: `【对话摘要(LLM)】\n${truncatedSummary}`,
          },
          originalCount: messages.length,
          summaryLength: truncatedSummary.length,
          keyPoints,
        };
      } catch (err) {
        Logger.warn(
          `LLM 摘要生成失败，回退到规则引擎: ${(err as Error).message}`,
          'ContextManager'
        );
      }
    }

    return this.summarizeContext(messages, maxSummaryLength);
  }

  /**
   * 上下文卸荷: LRU 策略 + 文件系统卸荷索引
   *
   * @param messages - 需要卸荷的消息列表
   * @param keepCount - 保留的消息条数
   * @param strategy - 卸荷策略
   * @returns 活跃消息和卸荷消息
   */
  offloadHistory(
    messages: ChatMessage[],
    keepCount: number = 10,
    strategy: OffloadStrategy = 'oldest_first'
  ): {
    active: ChatMessage[];
    offloaded: ChatMessage[];
  } {
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemMessages = messages.filter((m) => m.role === 'system');

    let activeNonSystem: ChatMessage[];
    let offloaded: ChatMessage[];

    switch (strategy) {
      case 'oldest_first':
        activeNonSystem = nonSystemMessages.slice(-keepCount);
        offloaded = nonSystemMessages.slice(
          0,
          nonSystemMessages.length - keepCount
        );
        break;

      case 'least_relevant':
        activeNonSystem = this.selectByLruRelevance(
          nonSystemMessages,
          keepCount
        );
        offloaded = nonSystemMessages.filter(
          (m) => !activeNonSystem.includes(m)
        );
        break;

      case 'compress_and_summarize': {
        const toOffload = nonSystemMessages.slice(
          0,
          nonSystemMessages.length - keepCount
        );
        activeNonSystem = nonSystemMessages.slice(-keepCount);
        offloaded = toOffload;
        break;
      }

      default:
        activeNonSystem = nonSystemMessages.slice(-keepCount);
        offloaded = nonSystemMessages.slice(
          0,
          nonSystemMessages.length - keepCount
        );
    }

    this.offloadedHistory.push(...offloaded);

    if (this.deps.offloadDir) {
      this.persistOffloadedMessages(offloaded);
    }

    Logger.info(
      `📦 上下文卸荷完成: 保留 ${activeNonSystem.length} 条, 卸荷 ${offloaded.length} 条`,
      'ContextManager'
    );

    return {
      active: [...systemMessages, ...activeNonSystem],
      offloaded,
    };
  }

  // ==================== 原有功能: 上下文压缩、摘要、卸荷 ====================

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

    const systemMessages = messages.filter((m) => m.role === 'system');
    for (const msg of systemMessages) {
      const msgTokens = this.estimateMessageTokens([msg]);
      if (currentTokens + msgTokens <= targetTokenCount) {
        compressed.push(msg);
        currentTokens += msgTokens;
      } else {
        const truncated = this.truncateMessage(
          msg,
          targetTokenCount - currentTokens
        );
        compressed.push(truncated);
        currentTokens = targetTokenCount;
        break;
      }
    }

    const historyMessages = messages
      .filter((m) => m.role !== 'system')
      .reverse();

    for (const msg of historyMessages) {
      const msgTokens = this.estimateMessageTokens([msg]);
      if (currentTokens + msgTokens <= targetTokenCount) {
        compressed.push(msg);
        currentTokens += msgTokens;
      } else {
        const compressedMsg = this.compressSingleMessage(msg);
        const compressedTokens = this.estimateMessageTokens([compressedMsg]);
        if (currentTokens + compressedTokens <= targetTokenCount) {
          compressed.push(compressedMsg);
          currentTokens += compressedTokens;
        }
      }
    }

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
   * 上下文摘要: 生成对话历史的摘要（规则引擎版本）
   */
  summarizeContext(
    messages: ChatMessage[],
    maxSummaryLength: number = 1000
  ): ContextSummaryResult {
    const keyPoints = this.extractKeyPoints(messages);
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

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
   * 上下文卸荷: 将旧消息移动到 "卸荷" 存储（兼容旧接口）
   */
  offloadOldMessages(
    messages: ChatMessage[],
    keepCount: number = 10,
    strategy: OffloadStrategy = 'oldest_first'
  ): {
    active: ChatMessage[];
    offloaded: ChatMessage[];
  } {
    return this.offloadHistory(messages, keepCount, strategy);
  }

  /**
   * 从卸荷存储中检索消息（支持 LRU 访问更新）
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

      for (const kw of keywords) {
        for (const entry of this.offloadIndex) {
          if (
            entry.keywords.some((k) =>
              k.toLowerCase().includes(kw.toLowerCase())
            )
          ) {
            entry.accessCount++;
            entry.lastAccessed = Date.now();
            this.lruAccessMap.set(entry.messageId, entry.lastAccessed);
          }
        }
      }
    }

    if (this.deps.offloadDir && this.offloadIndex.length > 0) {
      const fromDisk = this.retrieveFromDisk(keywords, limit);
      if (fromDisk.length > 0) {
        result = [...result, ...fromDisk];
      }
    }

    return result.slice(0, limit);
  }

  /**
   * 设置压缩阈值配置
   */
  setCompressionConfig(config: Partial<CompressionThresholdConfig>): void {
    this.compressionConfig = { ...this.compressionConfig, ...config };
  }

  /**
   * 获取卸荷索引
   */
  getOffloadIndex(): OffloadIndexEntry[] {
    return [...this.offloadIndex];
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
  private estimateTimeSpan(_messages: ChatMessage[]): string {
    return '未知';
  }

  /**
   * 从消息中提取关键点
   */
  private extractKeyPoints(messages: ChatMessage[]): string[] {
    const keyPoints: string[] = [];
    const userMessages = messages.filter((m) => m.role === 'user');

    for (const msg of userMessages.slice(-10)) {
      if (msg.content && msg.content.length > 0) {
        keyPoints.push(`用户: ${msg.content.substring(0, 100)}`);
      }
    }

    return keyPoints;
  }

  /**
   * LRU 相关性选择：根据访问频率和最近访问时间选择保留消息
   */
  private selectByLruRelevance(
    messages: ChatMessage[],
    keepCount: number
  ): ChatMessage[] {
    if (messages.length <= keepCount) return [...messages];

    const scored = messages.map((msg, idx) => {
      const content = msg.content || '';
      const accessCount = Array.from(this.lruAccessMap.entries()).filter(
        ([, time]) => time > 0
      ).length;
      const recencyScore = idx / messages.length;
      const lengthScore = Math.min(content.length / 500, 1);
      const accessScore = accessCount > 0 ? 0.3 : 0;
      const totalScore = recencyScore * 0.5 + lengthScore * 0.2 + accessScore;

      return { msg, score: totalScore };
    });

    scored.sort((a, b) => b.score - a.score);

    const selectedIndices = new Set(
      scored.slice(0, keepCount).map((s) => messages.indexOf(s.msg))
    );

    return messages.filter((_, idx) => selectedIndices.has(idx));
  }

  /**
   * 将卸荷消息持久化到文件系统
   */
  private persistOffloadedMessages(messages: ChatMessage[]): void {
    const offloadDir = this.deps.offloadDir;
    if (!offloadDir) return;

    try {
      if (!fs.existsSync(offloadDir)) {
        fs.mkdirSync(offloadDir, { recursive: true });
      }

      for (const msg of messages) {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const filePath = path.join(offloadDir, `${messageId}.json`);
        const keywords = this.extractKeywords(msg.content || '');

        fs.writeFileSync(filePath, JSON.stringify(msg, null, 2), 'utf-8');

        this.offloadIndex.push({
          messageId,
          timestamp: Date.now(),
          accessCount: 0,
          lastAccessed: Date.now(),
          filePath,
          keywords,
        });

        this.lruAccessMap.set(messageId, Date.now());
      }

      this.saveOffloadIndex();
    } catch (err) {
      Logger.error(
        `卸荷消息持久化失败: ${(err as Error).message}`,
        err as Error,
        'ContextManager'
      );
    }
  }

  /**
   * 从磁盘检索卸荷消息
   */
  private retrieveFromDisk(
    keywords?: string[],
    limit: number = 20
  ): ChatMessage[] {
    const results: ChatMessage[] = [];

    let indexEntries = [...this.offloadIndex];
    if (keywords && keywords.length > 0) {
      indexEntries = indexEntries.filter((entry) =>
        keywords.some((kw) =>
          entry.keywords.some((k) => k.toLowerCase().includes(kw.toLowerCase()))
        )
      );
    }

    indexEntries.sort((a, b) => b.lastAccessed - a.lastAccessed);

    for (const entry of indexEntries.slice(0, limit)) {
      try {
        if (fs.existsSync(entry.filePath)) {
          const raw = fs.readFileSync(entry.filePath, 'utf-8');
          const msg = JSON.parse(raw) as ChatMessage;
          results.push(msg);

          entry.accessCount++;
          entry.lastAccessed = Date.now();
          this.lruAccessMap.set(entry.messageId, entry.lastAccessed);
        }
      } catch {
        // 单个文件读取失败不影响整体
      }
    }

    return results;
  }

  /**
   * 从消息内容提取关键词
   */
  private extractKeywords(content: string): string[] {
    const keywords: string[] = [];
    const stopWords = new Set([
      '的',
      '了',
      '是',
      '在',
      '我',
      '你',
      '他',
      '她',
      '它',
      '们',
      '这',
      '那',
      '有',
      '不',
      '就',
      '也',
      '都',
      '而',
      '及',
      '与',
      '或',
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'can',
      'shall',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'out',
      'off',
      'over',
      'under',
      'again',
      'further',
      'then',
      'once',
      'and',
      'but',
      'or',
      'nor',
      'not',
      'so',
      'if',
      'it',
      'its',
    ]);

    const words = content.split(/[\s,，。.!！?？;；:：、\n]+/);
    for (const word of words) {
      const trimmed = word.trim().toLowerCase();
      if (trimmed.length >= 2 && !stopWords.has(trimmed)) {
        keywords.push(trimmed);
      }
    }

    return [...new Set(keywords)].slice(0, 20);
  }

  /**
   * 保存卸荷索引到磁盘
   */
  private saveOffloadIndex(): void {
    const offloadDir = this.deps.offloadDir;
    if (!offloadDir) return;

    try {
      if (!fs.existsSync(offloadDir)) {
        fs.mkdirSync(offloadDir, { recursive: true });
      }
      const indexPath = path.join(offloadDir, 'offload-index.json');
      fs.writeFileSync(
        indexPath,
        JSON.stringify(this.offloadIndex, null, 2),
        'utf-8'
      );
    } catch (err) {
      Logger.error(
        `卸荷索引保存失败: ${(err as Error).message}`,
        err as Error,
        'ContextManager'
      );
    }
  }

  /**
   * 从磁盘加载卸荷索引
   */
  private loadOffloadIndex(): void {
    const offloadDir = this.deps.offloadDir;
    if (!offloadDir) return;

    try {
      const indexPath = path.join(offloadDir, 'offload-index.json');
      if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, 'utf-8');
        this.offloadIndex = JSON.parse(raw) as OffloadIndexEntry[];
        for (const entry of this.offloadIndex) {
          this.lruAccessMap.set(entry.messageId, entry.lastAccessed);
        }
        Logger.info(
          `📦 已加载 ${this.offloadIndex.length} 条卸荷索引`,
          'ContextManager'
        );
      }
    } catch {
      // 索引加载失败不影响主流程
    }
  }
}
