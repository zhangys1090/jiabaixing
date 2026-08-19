/**
 * ContextWindowManager - 上下文系统辅助组件
 *
 * 【架构定位】
 * 上下文系统辅助组件，负责循环级上下文窗口管理
 *
 * 【核心职责】
 * - Token 预算管理：根据模型上下文窗口动态调整
 * - 工具结果截断：防止 shell_exec 等工具输出撑爆上下文
 * - 动态上下文压缩：基于重要性的优先级排序，智能压缩
 * - 上下文窗口控制：确保不超过模型最大上下文限制
 *
 * 【与 ContextManager 的分工】
 * - ContextManager: 会话级上下文构建（宪法prompt + 记忆注入 + 初始历史）
 * - ContextWindowManager（本文件）: 循环级上下文窗口管理（token预算 + 工具结果截断 + 动态压缩）
 *
 * 【在整体架构中的位置】
 * ConstitutionPromptBuilder + 对话历史 → ContextWindowManager（本文件）→ 最终 Prompt
 *
 * 【优先级排序（高→低）】
 * 1. 系统 prompt（宪法 + 工具提示 + 守卫指令）
 * 2. 最近 N 轮对话（assistant + tool_calls + 工具结果）
 * 3. 工具结果（截断后）
 * 4. 早期历史（压缩为摘要）
 *
 * 【使用场景】
 * - 主循环每轮的上下文窗口管理
 * - 工具执行结果的截断与压缩
 * - 不同模型的上下文窗口适配
 */

import { Logger } from '../../utils/Logger';
import type { ChatMessage } from '../types';

/** 上下文窗口管理配置 */
export interface ContextWindowConfig {
  /** 模型最大上下文窗口（tokens） */
  maxContextTokens: number;
  /** 压缩触发阈值（占 maxContextTokens 的比例，默认 0.8） */
  compressionThreshold: number;
  /** 保留最近消息条数（不压缩） */
  keepRecentMessages: number;
  /** 单个工具结果最大 token 数（超过则截断） */
  maxToolResultTokens: number;
  /** 为 LLM 响应预留的 token 数 */
  reservedForCompletion: number;
}

/** 默认配置（适配 8K 上下文窗口模型） */
export const DEFAULT_WINDOW_CONFIG: ContextWindowConfig = {
  maxContextTokens: 8000,
  compressionThreshold: 0.8,
  keepRecentMessages: 6,
  maxToolResultTokens: 2000,
  reservedForCompletion: 1024,
};

/** 工具结果截断结果 */
export interface TruncatedToolResult {
  content: string;
  truncated: boolean;
  originalLength: number;
  truncatedLength: number;
}

/** 上下文压缩结果 */
export interface WindowCompressionResult {
  messages: ChatMessage[];
  originalTokenCount: number;
  compressedTokenCount: number;
  compressionRatio: number;
  strategy: string;
}

/**
 * 上下文窗口管理器
 *
 * 在 Executor 循环中每次 LLM 调用前调用 manageWindow()
 * 确保 messages 不超过模型上下文窗口
 */
export class ContextWindowManager {
  private config: ContextWindowConfig;

  constructor(config: Partial<ContextWindowConfig> = {}) {
    this.config = { ...DEFAULT_WINDOW_CONFIG, ...config };
  }

  /**
   * 更新配置（运行时动态调整）
   */
  updateConfig(partial: Partial<ContextWindowConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * 获取当前配置
   */
  getConfig(): ContextWindowConfig {
    return { ...this.config };
  }

  /**
   * 主入口：管理上下文窗口
   *
   * 检查 token 预算，超阈值时自动压缩
   *
   * @param messages - 当前消息列表
   * @returns 管理后的消息列表（可能被压缩）
   */
  manageWindow(messages: ChatMessage[]): ChatMessage[] {
    const threshold = Math.floor(
      this.config.maxContextTokens * this.config.compressionThreshold
    );

    let managed = [...messages];
    let tokenCount = this.estimateTokens(managed);

    // 未超阈值，直接返回
    if (tokenCount <= threshold) {
      return managed;
    }

    Logger.info(
      `📊 上下文窗口管理: ${tokenCount} tokens 超阈值 ${threshold}，开始压缩`,
      'ContextWindowManager'
    );

    // 阶段1: 截断所有超长工具结果
    managed = this.truncateAllToolResults(managed);
    tokenCount = this.estimateTokens(managed);

    if (tokenCount <= threshold) {
      Logger.info(
        `📊 阶段1(工具结果截断)后: ${tokenCount} tokens`,
        'ContextWindowManager'
      );
      return managed;
    }

    // 阶段2: 压缩早期历史
    const result = this.compressHistory(managed);
    Logger.info(
      `📊 阶段2(历史压缩)后: ${result.compressedTokenCount} tokens (压缩比 ${result.compressionRatio.toFixed(2)})`,
      'ContextWindowManager'
    );

    return result.messages;
  }

  /**
   * 截断单个工具结果
   *
   * 策略: 保留头部 + 尾部 + 中间省略提示
   * 头部: 前 40% token
   * 尾部: 后 40% token
   * 中间: "[...已截断 N 字符...]" 提示
   *
   * @param content - 工具结果内容
   * @param toolName - 工具名（用于日志）
   * @returns 截断结果
   */
  truncateToolResult(content: string, toolName?: string): TruncatedToolResult {
    if (!content) {
      return {
        content: '',
        truncated: false,
        originalLength: 0,
        truncatedLength: 0,
      };
    }

    const originalTokens = this.estimateTextTokens(content);
    const maxTokens = this.config.maxToolResultTokens;

    if (originalTokens <= maxTokens) {
      return {
        content,
        truncated: false,
        originalLength: content.length,
        truncatedLength: content.length,
      };
    }

    // 按比例截断：头部 40% + 中间提示 + 尾部 40%
    const headRatio = 0.4;
    const tailRatio = 0.4;
    const headChars = Math.floor(
      (content.length * maxTokens * headRatio) / originalTokens
    );
    const tailChars = Math.floor(
      (content.length * maxTokens * tailRatio) / originalTokens
    );

    const head = content.substring(0, headChars);
    const tail = content.substring(content.length - tailChars);
    const omittedChars = content.length - headChars - tailChars;

    const truncatedContent = `${head}\n\n[...已截断 ${omittedChars} 字符...]\n\n${tail}`;

    Logger.debug(
      `✂️ 工具结果截断${toolName ? ` (${toolName})` : ''}: ${originalTokens} → ~${this.estimateTextTokens(truncatedContent)} tokens`,
      'ContextWindowManager'
    );

    return {
      content: truncatedContent,
      truncated: true,
      originalLength: content.length,
      truncatedLength: truncatedContent.length,
    };
  }

  /**
   * 截断消息列表中所有超长工具结果
   */
  private truncateAllToolResults(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((msg) => {
      if (msg.role !== 'tool' || !msg.content) return msg;

      const tokenCount = this.estimateTextTokens(msg.content);
      if (tokenCount <= this.config.maxToolResultTokens) return msg;

      const truncated = this.truncateToolResult(msg.content, msg.name);
      return {
        ...msg,
        content: truncated.content,
      };
    });
  }

  /**
   * 压缩历史消息
   *
   * 策略:
   *   1. 分离 system / non-system 消息
   *   2. 保留最近 N 条 non-system 消息（确保 assistant+tool_calls/tool 配对完整）
   *   3. 早期消息压缩为摘要
   *   4. 合并 system + 摘要 + 近期消息
   */
  compressHistory(messages: ChatMessage[]): WindowCompressionResult {
    const originalTokenCount = this.estimateTokens(messages);

    if (messages.length <= this.config.keepRecentMessages) {
      return {
        messages,
        originalTokenCount,
        compressedTokenCount: originalTokenCount,
        compressionRatio: 1.0,
        strategy: 'no-op',
      };
    }

    const systemMessages: ChatMessage[] = [];
    const nonSystemMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        nonSystemMessages.push(msg);
      }
    }

    if (nonSystemMessages.length <= this.config.keepRecentMessages) {
      return {
        messages,
        originalTokenCount,
        compressedTokenCount: originalTokenCount,
        compressionRatio: 1.0,
        strategy: 'no-op',
      };
    }

    // 确定切点，保持 assistant+tool_calls/tool 配对完整
    let cutIndex = nonSystemMessages.length - this.config.keepRecentMessages;
    while (cutIndex > 0 && nonSystemMessages[cutIndex]?.role === 'tool') {
      cutIndex--;
    }
    if (
      cutIndex > 0 &&
      nonSystemMessages[cutIndex]?.role === 'assistant' &&
      (nonSystemMessages[cutIndex] as { tool_calls?: unknown[] }).tool_calls
    ) {
      let j = cutIndex + 1;
      while (
        j < nonSystemMessages.length &&
        nonSystemMessages[j]?.role === 'tool'
      ) {
        j++;
      }
      if (j <= nonSystemMessages.length - this.config.keepRecentMessages) {
        cutIndex = j;
      }
    }

    const keptMessages = nonSystemMessages.slice(cutIndex);
    const removedMessages = nonSystemMessages.slice(0, cutIndex);

    // 生成摘要
    const summaryParts: string[] = [];
    for (const msg of removedMessages) {
      if (msg.role === 'user' && msg.content) {
        summaryParts.push(`用户: ${msg.content.substring(0, 100)}`);
      } else if (msg.role === 'assistant' && msg.content) {
        summaryParts.push(`助手: ${msg.content.substring(0, 100)}`);
      } else if (msg.role === 'tool' && msg.name) {
        const content = (msg.content || '').substring(0, 80);
        summaryParts.push(`工具[${msg.name}]: ${content}`);
      }
    }

    const result: ChatMessage[] = [];

    // 合并 system 消息
    const systemContent = systemMessages
      .map((m) => m.content || '')
      .filter(Boolean)
      .join('\n\n');
    if (systemContent) {
      result.push({ role: 'system', content: systemContent });
    }

    // 添加历史摘要
    if (summaryParts.length > 0) {
      result.push({
        role: 'system',
        content: `【历史摘要（已压缩 ${removedMessages.length} 条消息）】\n${summaryParts.join('\n')}`,
      });
    }

    result.push(...keptMessages);

    const compressedTokenCount = this.estimateTokens(result);
    const compressionRatio =
      originalTokenCount > 0 ? compressedTokenCount / originalTokenCount : 1.0;

    return {
      messages: result,
      originalTokenCount,
      compressedTokenCount,
      compressionRatio,
      strategy: 'history-summary',
    };
  }

  /**
   * 估算消息列表的 token 数
   */
  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // 每条消息固定开销
      if (msg.content) {
        total += this.estimateTextTokens(msg.content);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls as Array<{
          function: { name: string; arguments: string };
        }>) {
          total += 4;
          if (tc.function?.name) {
            total += this.estimateTextTokens(tc.function.name);
          }
          if (tc.function?.arguments) {
            total += this.estimateTextTokens(tc.function.arguments);
          }
        }
      }
      if (msg.name) {
        total += this.estimateTextTokens(msg.name);
      }
    }
    return Math.ceil(total);
  }

  /**
   * 估算文本的 token 数
   *
   * 区分中英文:
   *   - 中文（CJK）: 约 2 字符 ≈ 1 token
   *   - 英文: 约 4 字符 ≈ 1 token
   *   - 数字/符号: 约 3 字符 ≈ 1 token
   */
  estimateTextTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    let cjkChars = 0;
    let otherChars = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3000 && code <= 0x30ff)
      ) {
        cjkChars++;
      } else {
        otherChars++;
      }
    }

    return Math.ceil(cjkChars / 2 + otherChars / 4);
  }

  /**
   * 检查是否需要压缩
   */
  needsCompression(messages: ChatMessage[]): boolean {
    const threshold = Math.floor(
      this.config.maxContextTokens * this.config.compressionThreshold
    );
    return this.estimateTokens(messages) > threshold;
  }

  /**
   * 获取当前上下文使用情况
   */
  getUsage(messages: ChatMessage[]): {
    used: number;
    total: number;
    ratio: number;
    needsCompression: boolean;
  } {
    const used = this.estimateTokens(messages);
    const total = this.config.maxContextTokens;
    return {
      used,
      total,
      ratio: used / total,
      needsCompression: used > total * this.config.compressionThreshold,
    };
  }

  /**
   * P1-3: 注入跨会话记忆到上下文窗口
   *
   * 在构建上下文时主动召回长期记忆（用户偏好、历史模式、
   * 相关知识片段），而非仅靠 LLM 主动调用 memory_recall 工具。
   *
   * 策略：
   * 1. 从 crossSessionMemory 提取与当前输入相关的记忆
   * 2. 按重要性排序，截断到 token 预算内
   * 3. 注入为 system 消息，确保 LLM 在推理时能利用
   *
   * @param messages - 当前消息列表
   * @param crossSessionMemory - 跨会话记忆条目
   * @param currentInput - 当前用户输入（用于相关性排序）
   * @returns 注入记忆后的消息列表
   */
  injectCrossSessionMemory(
    messages: ChatMessage[],
    crossSessionMemory: CrossSessionMemoryEntry[],
    currentInput?: string
  ): ChatMessage[] {
    if (!crossSessionMemory || crossSessionMemory.length === 0) {
      return messages;
    }

    const rawRatio = parseFloat(process.env['MEMORY_INJECT_RATIO'] || '0.1');
    const memRatio = Number.isFinite(rawRatio) ? rawRatio : 0.1;
    const maxMemoryTokens = Math.floor(this.config.maxContextTokens * memRatio);

    const sorted = [...crossSessionMemory].sort((a, b) => {
      const scoreA = a.importance * a.recency;
      const scoreB = b.importance * b.recency;
      return scoreB - scoreA;
    });

    const selected: CrossSessionMemoryEntry[] = [];
    let usedTokens = 0;

    for (const entry of sorted) {
      const entryTokens = this.estimateTextTokens(entry.content);
      if (usedTokens + entryTokens > maxMemoryTokens) break;
      selected.push(entry);
      usedTokens += entryTokens;
    }

    if (selected.length === 0) return messages;

    const memoryLines = selected.map(
      (e) => `- [${e.type}] ${e.content.substring(0, 200)}`
    );
    const memoryBlock = [
      '【跨会话记忆】以下是从长期记忆中召回的相关信息：',
      ...memoryLines,
      '请在推理时参考以上记忆，但以当前对话上下文为准。',
    ].join('\n');

    const result: ChatMessage[] = [
      ...messages.slice(0, 1),
      { role: 'system', content: memoryBlock },
      ...messages.slice(1),
    ];

    Logger.info(
      `🧠 P1-3: 注入跨会话记忆 ${selected.length} 条 (${usedTokens} tokens)`,
      'ContextWindowManager'
    );

    return result;
  }
}

/** P1-3: 跨会话记忆条目 */
export interface CrossSessionMemoryEntry {
  /** 记忆类型（preference/pattern/knowledge/snapshot） */
  type: string;
  /** 记忆内容 */
  content: string;
  /** 重要性 0-1 */
  importance: number;
  /** 时效性 0-1（越近越高） */
  recency: number;
  /** 来源会话 ID */
  sessionId?: string;
  /** 创建时间 */
  createdAt?: number;
}
