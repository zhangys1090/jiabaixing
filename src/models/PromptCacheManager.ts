/**
 * Prompt 缓存管理器
 *
 * 通用持久化 LLM 响应缓存，跨会话有效。
 * 支持 exact-match（全量响应缓存）和 prefix-match（前缀感知）。
 * 对所有 OpenAI 兼容提供商生效，透明集成到 LLMProvider。
 *
 * 设计：
 *   - 缓存 key = hash(normalized(systemPrompt + messages + model + temp))
 *   - SQLite 持久化（跨会话）
 *   - 智能 TTL：不同内容类型不同过期时间
 *   - 命中率监控 + 自动淘汰
 *
 * @deprecated 已迁移到 Python agent/llm/prompt_cache.py。当 AGENT_BACKEND=python（默认）时不再使用此文件。
 *   回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现。
 *   迁移日期：2026-06-22
 */

import crypto from 'crypto';
import { Logger } from '../utils/Logger';
import { SqliteCacheStore } from './SqliteCacheStore';

/** 缓存策略 */
export interface CacheStrategy {
  /** 是否启用精确匹配缓存 */
  exactMatch: boolean;
  /** 精确匹配的 TTL（毫秒） */
  exactMatchTTL: number;
  /** 是否启用前缀匹配检测（仅统计，不返回部分结果） */
  prefixAware: boolean;
  /** 最小 system prompt 长度才触发缓存 */
  minSystemPromptLength: number;
  /** 最小 messages 长度才触发缓存 */
  minMessagesLength: number;
}

/** 缓存结果 */
export interface CacheResult {
  hit: boolean;
  value: string | null;
  /** 匹配类型：exact | prefix_miss | semantic | none */
  matchType: 'exact' | 'prefix_miss' | 'semantic' | 'none';
  /** 缓存延迟（毫秒） */
  latencyMs: number;
  /** 关联的元数据 */
  metadata?: {
    /** 缓存 key */
    key?: string;
    /** 前缀匹配时的覆盖比例 */
    prefixCoverage?: number;
  };
}

/** 缓存配置 */
export interface CacheConfig {
  /** 数据库路径 */
  dbPath?: string;
  /** 默认缓存 TTL（毫秒） */
  defaultTTL: number;
  /** 每种内容类型的 TTL 覆盖 */
  ttlOverrides?: Record<string, number>;
  /** 最大缓存条目数 */
  maxEntries?: number;
  /** 是否启用 */
  enabled?: boolean;
}

const DEFAULT_CONFIG: CacheConfig = {
  defaultTTL: 30 * 60 * 1000, // 30 分钟
  ttlOverrides: {
    // 简单聊天可短些（用户常重复问同样问题）
    chat: 10 * 60 * 1000, // 10 分钟
    // 代码生成可长些（相同代码模式会反复出现）
    code: 60 * 60 * 1000, // 1 小时
    // 工具调用结果缓存稍短
    tool: 5 * 60 * 1000, // 5 分钟
    // 多模态分析缓存较长
    multimodal: 30 * 60 * 1000,
  },
  maxEntries: 5000,
  enabled: true,
};

const DEFAULT_STRATEGY: CacheStrategy = {
  exactMatch: true,
  exactMatchTTL: 30 * 60 * 1000,
  prefixAware: true,
  minSystemPromptLength: 20,
  minMessagesLength: 10,
};

/** 语义缓存配置 */
export interface SemanticCacheConfig {
  /** 是否启用语义缓存（基于词集合相似度） */
  enabled: boolean;
  /** Jaccard 相似度阈值（0-1），高于此值视为命中 */
  similarityThreshold: number;
  /** 参与匹配的最小词数（过短的输入不参与语义匹配） */
  minWordCount: number;
}

const DEFAULT_SEMANTIC_CONFIG: SemanticCacheConfig = {
  enabled: true,
  similarityThreshold: 0.7,
  minWordCount: 4,
};

export class PromptCacheManager {
  private store: SqliteCacheStore;
  private config: CacheConfig;
  private strategy: CacheStrategy;
  private semanticConfig: SemanticCacheConfig;

  /** 缓存命中统计（会话级） */
  private sessionHits = 0;
  private sessionMisses = 0;
  /** 前缀匹配统计 */
  private prefixHits = 0;
  private prefixChecked = 0;
  /** 语义匹配统计 */
  private semanticHits = 0;
  private semanticChecked = 0;

  constructor(
    config?: Partial<CacheConfig>,
    strategy?: Partial<CacheStrategy>,
    semanticConfig?: Partial<SemanticCacheConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.strategy = { ...DEFAULT_STRATEGY, ...strategy };
    this.semanticConfig = { ...DEFAULT_SEMANTIC_CONFIG, ...semanticConfig };

    this.store = new SqliteCacheStore(this.config.dbPath, {
      maxEntries: this.config.maxEntries,
    });
  }

  /** 是否启用 */
  get enabled(): boolean {
    return this.config.enabled ?? true;
  }

  set enabled(val: boolean) {
    this.config.enabled = val;
  }

  // ==================== 缓存 Key 生成 ====================

  /**
   * 生成精确匹配的缓存 key
   *
   * 包含：systemPrompt, messages, modelName, temperature, tools 的规范化 hash
   */
  generateExactKey(params: {
    systemPrompt?: string | null;
    messages?: Array<Record<string, unknown>>;
    modelName?: string;
    temperature?: number;
    tools?: unknown[];
  }): string {
    const normalized = this.normalizeForCache(params);
    return 'exact:' + crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * 生成前缀匹配 key
   *
   * 仅包含：systemPrompt + 消息前缀（不含最后一条用户消息）+ modelName
   * 用于检测不同请求是否共享相同上下文前缀
   */
  generatePrefixKey(params: {
    systemPrompt?: string | null;
    messages?: Array<Record<string, unknown>>;
    modelName?: string;
  }): { prefixKey: string; lastUserMessage?: string } {
    const msgs = params.messages ?? [];
    // 找到最后一条 user 消息作为"当前输入"，前面所有消息作为"前缀"
    const lastUserIdx = this.findLastUserMessageIndex(msgs);

    let prefixMessages: Array<Record<string, unknown>>;
    let lastUserMessage: string | undefined;

    if (lastUserIdx >= 0) {
      prefixMessages = msgs.slice(0, lastUserIdx);
      const lastMsg = msgs[lastUserIdx];
      lastUserMessage =
        typeof lastMsg.content === 'string' ? lastMsg.content : undefined;
    } else {
      prefixMessages = msgs;
    }

    const parts: string[] = [];
    if (params.systemPrompt) {
      parts.push('sys:' + params.systemPrompt.trim());
    }
    if (prefixMessages.length > 0) {
      parts.push('msgs:' + JSON.stringify(prefixMessages));
    }
    if (params.modelName) {
      parts.push('model:' + params.modelName);
    }

    const hash = crypto
      .createHash('md5')
      .update(parts.join('||'))
      .digest('hex');

    return {
      prefixKey: 'prefix:' + hash,
      lastUserMessage,
    };
  }

  /**
   * 重新构建带工具定义的完整缓存 key（用于 chatWithTools）
   */
  generateToolKey(params: {
    systemPrompt?: string | null;
    messages?: Array<Record<string, unknown>>;
    modelName?: string;
    temperature?: number;
    tools?: unknown[];
  }): string {
    // 工具调用：关键输入是 system + 首条 user message + 工具 schema
    // 经过工具调用后，后续消息包含 tool_results，不再适合缓存
    const base = this.normalizeForCache({
      systemPrompt: params.systemPrompt,
      messages: params.messages?.slice(0, 1), // 只取第一条消息
      modelName: params.modelName,
      temperature: params.temperature,
    });

    // 工具 schema 规范化排序
    let toolsHash = '';
    if (params.tools && params.tools.length > 0) {
      toolsHash =
        '|tools:' +
        crypto
          .createHash('md5')
          .update(JSON.stringify(this.sortTools(params.tools)))
          .digest('hex');
    }

    return (
      'tool:' +
      crypto
        .createHash('md5')
        .update(base + toolsHash)
        .digest('hex')
    );
  }

  // ==================== 缓存操作 ====================

  /**
   * 尝试获取精确匹配缓存
   *
   * @returns CacheResult — hit=true 且 value 非空时命中
   */
  tryGetExact(params: {
    systemPrompt?: string | null;
    messages?: Array<Record<string, unknown>>;
    modelName?: string;
    temperature?: number;
    tools?: unknown[];
    kind?: string;
  }): CacheResult {
    if (!this.config.enabled) {
      return { hit: false, value: null, matchType: 'none', latencyMs: 0 };
    }

    const start = Date.now();
    const key = this.generateExactKey(params);
    const entry = this.store.getEntry(key);

    if (entry) {
      this.sessionHits++;
      const latency = Date.now() - start;
      // 解析缓存值：可能是 JSON 格式（含 userInput）或纯文本
      const responseValue = this.parseCacheValue(entry.value);
      Logger.debug(
        `🎯 缓存命中 (exact): key=${key.substring(0, 16)}..., latency=${latency}ms, hits=${entry.hitCount}`,
        'PromptCacheManager'
      );
      return {
        hit: true,
        value: responseValue,
        matchType: 'exact',
        latencyMs: latency,
        metadata: { key },
      };
    }

    this.sessionMisses++;
    const latency = Date.now() - start;

    // 如果启用了前缀感知，检查是否为前缀可匹配的 miss
    let matchType: 'exact' | 'prefix_miss' | 'semantic' | 'none' = 'none';
    if (this.strategy.prefixAware) {
      const prefixResult = this.generatePrefixKey(params);
      const prefixEntry = this.store.getEntry(prefixResult.prefixKey);
      if (prefixEntry) {
        matchType = 'prefix_miss';
        this.prefixHits++;

        // 语义缓存：当前缀匹配时，尝试用 Jaccard 相似度匹配用户输入
        if (this.semanticConfig.enabled && prefixResult.lastUserMessage) {
          const semanticResult = this.trySemanticMatch(
            prefixResult.prefixKey,
            prefixResult.lastUserMessage
          );
          if (semanticResult) {
            this.semanticHits++;
            Logger.debug(
              `🎯 语义缓存命中: similarity=${semanticResult.similarity.toFixed(2)}, key=${semanticResult.key.substring(0, 16)}...`,
              'PromptCacheManager'
            );
            return {
              hit: true,
              value: semanticResult.value,
              matchType: 'semantic',
              latencyMs: Date.now() - start,
              metadata: {
                key: semanticResult.key,
                prefixCoverage: semanticResult.similarity,
              },
            };
          }
          this.semanticChecked++;
        }
      }
      this.prefixChecked++;
    }

    return {
      hit: false,
      value: null,
      matchType,
      latencyMs: latency,
      metadata: { key },
    };
  }

  /**
   * 存储精确匹配缓存
   */
  storeExact(
    params: {
      systemPrompt?: string | null;
      messages?: Array<Record<string, unknown>>;
      modelName?: string;
      temperature?: number;
      tools?: unknown[];
      kind?: string;
    },
    response: string
  ): void {
    if (!this.config.enabled || !this.strategy.exactMatch) return;

    // 短响应不缓存（可能是错误或打招呼）
    if (response.length < 5) return;

    const key = this.generateExactKey(params);
    const ttl = this.resolveTTL(params.kind || 'response');

    // 提取用户输入，编码到缓存值中用于语义匹配
    const userInput = this.extractLastUserMessage(params.messages);
    const storeValue = userInput
      ? JSON.stringify({ response, userInput })
      : response;

    this.store.set(key, storeValue, ttl, 'response');
    Logger.debug(
      `💾 缓存已存储 (exact): key=${key.substring(0, 16)}..., size=${response.length}B, ttl=${ttl}ms`,
      'PromptCacheManager'
    );

    // 同时存储前缀 key（用于后续前缀匹配检测）
    if (this.strategy.prefixAware) {
      const prefixResult = this.generatePrefixKey(params);
      const prefixTtl = Math.min(ttl, 5 * 60 * 1000); // 前缀缓存 TTL 较短
      this.store.set(prefixResult.prefixKey, '1', prefixTtl, 'prefix');
    }
  }

  /**
   * 尝试获取工具调用缓存（仅第一条消息）
   */
  tryGetToolCall(params: {
    systemPrompt?: string | null;
    messages?: Array<Record<string, unknown>>;
    modelName?: string;
    temperature?: number;
    tools?: unknown[];
  }): CacheResult {
    if (!this.config.enabled) {
      return { hit: false, value: null, matchType: 'none', latencyMs: 0 };
    }

    const start = Date.now();
    const key = this.generateToolKey(params);
    const entry = this.store.getEntry(key);

    if (entry) {
      this.sessionHits++;
      const latency = Date.now() - start;
      const responseValue = this.parseCacheValue(entry.value);
      Logger.debug(
        `🎯 缓存命中 (tool): key=${key.substring(0, 16)}..., latency=${latency}ms`,
        'PromptCacheManager'
      );
      return {
        hit: true,
        value: responseValue,
        matchType: 'exact',
        latencyMs: latency,
        metadata: { key },
      };
    }

    this.sessionMisses++;
    return {
      hit: false,
      value: null,
      matchType: 'none',
      latencyMs: Date.now() - start,
      metadata: { key },
    };
  }

  /**
   * 存储工具调用缓存
   */
  storeToolCall(
    params: {
      systemPrompt?: string | null;
      messages?: Array<Record<string, unknown>>;
      modelName?: string;
      temperature?: number;
      tools?: unknown[];
    },
    response: string
  ): void {
    if (!this.config.enabled || !this.strategy.exactMatch) return;
    if (response.length < 5) return;

    const key = this.generateToolKey(params);
    const ttl = this.config.ttlOverrides?.tool ?? this.config.defaultTTL;
    this.store.set(key, response, ttl, 'response');
  }

  // ==================== 统计 ====================

  /** 获取会话级统计 */
  getSessionStats() {
    const total = this.sessionHits + this.sessionMisses;
    return {
      hits: this.sessionHits,
      misses: this.sessionMisses,
      hitRate: total === 0 ? 0 : this.sessionHits / total,
      prefixHits: this.prefixHits,
      prefixChecked: this.prefixChecked,
      prefixHitRate:
        this.prefixChecked === 0 ? 0 : this.prefixHits / this.prefixChecked,
      semanticHits: this.semanticHits,
      semanticChecked: this.semanticChecked,
      semanticHitRate:
        this.semanticChecked === 0
          ? 0
          : this.semanticHits / this.semanticChecked,
    };
  }

  /** 获取持久化存储统计 */
  getStoreStats() {
    return this.store.getStats();
  }

  /** 获取完整统计报告 */
  getFullStats() {
    const session = this.getSessionStats();
    const store = this.getStoreStats();
    return {
      session,
      store,
      config: {
        enabled: this.config.enabled,
        defaultTTL: this.config.defaultTTL,
        maxEntries: this.config.maxEntries,
        exactMatch: this.strategy.exactMatch,
        prefixAware: this.strategy.prefixAware,
      },
      status: this.config.enabled ? 'active' : 'disabled',
    };
  }

  // ==================== 管理操作 ====================

  /** 清空缓存 */
  clear(kind?: string): number {
    if (kind) {
      return this.store.clearByKind(kind);
    }
    return this.store.clear();
  }

  /** 关闭 */
  close(): void {
    this.store.close();
  }

  // ==================== 内部方法 ====================

  /**
   * 规范化缓存输入，确保相同语义输入生成相同 key
   */
  private normalizeForCache(params: {
    systemPrompt?: string | null;
    messages?: Array<Record<string, unknown>>;
    modelName?: string;
    temperature?: number;
    tools?: unknown[];
  }): string {
    const parts: string[] = [];

    // system prompt
    if (params.systemPrompt) {
      parts.push('sys:' + params.systemPrompt.trim().replace(/\s+/g, ' '));
    }

    // messages
    if (params.messages && params.messages.length > 0) {
      parts.push(
        'msgs:' + JSON.stringify(this.normalizeMessages(params.messages))
      );
    }

    // model name
    if (params.modelName) {
      parts.push('model:' + params.modelName);
    }

    // temperature
    if (params.temperature !== undefined) {
      parts.push('temp:' + params.temperature.toFixed(1));
    }

    // tools schema (sort for deterministic order)
    if (params.tools && params.tools.length > 0) {
      parts.push('tools:' + JSON.stringify(this.sortTools(params.tools)));
    }

    return parts.join('||');
  }

  /** 规范化消息：统一字段顺序、消除噪音 */
  private normalizeMessages(
    messages: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      const normalized: Record<string, unknown> = { role: msg.role };

      // content 统一为 string，并压缩内部空白
      if (msg.content !== undefined && msg.content !== null) {
        normalized.content =
          typeof msg.content === 'string'
            ? msg.content.trim().replace(/\s+/g, ' ')
            : JSON.stringify(msg.content);
      } else {
        normalized.content = '';
      }

      // tool_calls 按函数名排序
      if (msg.tool_calls) {
        const calls = msg.tool_calls as Array<Record<string, unknown>>;
        normalized.tool_calls = [...calls].sort((a, b) => {
          const fnA =
            ((a.function as Record<string, unknown>)?.name as string) || '';
          const fnB =
            ((b.function as Record<string, unknown>)?.name as string) || '';
          return fnA.localeCompare(fnB);
        });
      }

      // tool_call_id
      if (msg.tool_call_id) {
        normalized.tool_call_id = msg.tool_call_id;
      }

      return normalized;
    });
  }

  /** 工具定义排序（保证 schema 顺序一致） */
  private sortTools(tools: unknown[]): unknown[] {
    return [...tools].sort((a, b) => {
      const nameA =
        (((a as Record<string, unknown>).function as Record<string, unknown>)
          ?.name as string) || '';
      const nameB =
        (((b as Record<string, unknown>).function as Record<string, unknown>)
          ?.name as string) || '';
      return nameA.localeCompare(nameB);
    });
  }

  /** 找到最后一条 user 消息的索引 */
  private findLastUserMessageIndex(
    messages: Array<Record<string, unknown>>
  ): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  }

  /** 提取最后一条用户消息文本 */
  private extractLastUserMessage(
    messages?: Array<Record<string, unknown>>
  ): string | null {
    if (!messages || messages.length === 0) return null;
    const idx = this.findLastUserMessageIndex(messages);
    if (idx < 0) return null;
    const content = messages[idx].content;
    return typeof content === 'string' ? content : null;
  }

  /** 解析缓存值：兼容 JSON 格式（含 userInput）和纯文本 */
  private parseCacheValue(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.response === 'string'
      ) {
        return parsed.response;
      }
    } catch {
      // 不是 JSON，直接返回原始值
    }
    return raw;
  }

  /** 根据内容类型解析 TTL */
  private resolveTTL(kind: string): number {
    return this.config.ttlOverrides?.[kind] ?? this.config.defaultTTL;
  }

  // ==================== 语义缓存 ====================

  /**
   * 基于 Jaccard 词集合相似度的语义匹配
   * 在前缀匹配命中的前提下，比较当前用户输入与缓存中已有输入的相似度
   * @param prefixKey 前缀匹配的缓存 key
   * @param currentUserInput 当前用户输入文本
   * @returns 匹配结果，包含缓存值和相似度；未匹配返回 null
   */
  private trySemanticMatch(
    prefixKey: string,
    currentUserInput: string
  ): { key: string; value: string; similarity: number } | null {
    const currentWords = this.tokenize(currentUserInput);
    if (currentWords.length < this.semanticConfig.minWordCount) {
      return null;
    }

    // 扫描同一前缀下的所有缓存条目，找到最相似的
    let bestMatch: { key: string; value: string; similarity: number } | null =
      null;

    // 从 store 中获取前缀相关的所有条目
    const candidates = this.store.getByPrefix(
      prefixKey.replace('prefix:', 'exact:')
    );
    for (const entry of candidates) {
      // 从缓存值中解析原始用户输入
      let entryUserInput: string | undefined;
      try {
        const parsed = JSON.parse(entry.value);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.userInput === 'string'
        ) {
          entryUserInput = parsed.userInput;
        }
      } catch {
        // 纯文本缓存，无法提取 userInput
        continue;
      }
      if (!entryUserInput) continue;

      const cachedWords = this.tokenize(entryUserInput);
      if (cachedWords.length < this.semanticConfig.minWordCount) continue;

      const similarity = this.jaccardSimilarity(currentWords, cachedWords);
      if (
        similarity >= this.semanticConfig.similarityThreshold &&
        (!bestMatch || similarity > bestMatch.similarity)
      ) {
        bestMatch = {
          key: entry.key,
          value: this.parseCacheValue(entry.value),
          similarity,
        };
      }
    }

    return bestMatch;
  }

  /**
   * 分词：将文本拆分为小写词集合
   * 中文按字拆分，英文按空格拆分
   */
  private tokenize(text: string): string[] {
    // 统一转小写
    const lower = text.toLowerCase().trim();
    // 中文字符逐字拆分，英文按空格拆分
    const tokens: string[] = [];
    // 匹配中文字符或英文单词
    const pattern = /[\u4e00-\u9fff]|[a-z0-9]+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      tokens.push(match[0]);
    }
    return tokens;
  }

  /**
   * 计算 Jaccard 相似度：|A ∩ B| / |A ∪ B|
   */
  private jaccardSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
