/**
 * ChatProvider - 对话服务
 * 从 LLMProvider 中提取的对话相关方法：chat / chatWithTools / executeWithRetry
 * 专注于文本对话和工具调用，不含模型选择/降级逻辑
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model, ModelInput } from './ModelInterface';
import { LLMResponseCache } from './LLMResponseCache';
import { RequestQueue } from './RequestQueue';
import { PromptOptimizer } from './PromptOptimizer';
import { getPromptTemplate } from '../llm/prompt-templates';

export class ChatProvider {
  private model: Model;
  private modelName: string;
  private maxRetries: number = 2;
  private baseRetryInterval: number = 1000;
  private responseCache: LLMResponseCache;
  private requestQueue: RequestQueue;

  private static readonly CONNECTION_ERRORS: ReadonlyArray<string> = [
    'econnrefused',
    'econnreset',
    'enetunreach',
    'connection refused',
    'connect econnrefused',
    'network error',
    'network timeout',
    'fetch failed',
    'abort',
    '超时',
  ];

  constructor(model: Model, modelName: string) {
    this.model = model;
    this.modelName = modelName;
    this.responseCache = new LLMResponseCache();
    this.requestQueue = new RequestQueue(2);
  }

  /**
   * 带重试的操作执行器
   * 认证错误（401/invalid/authentication）不重试，直接抛出
   * 连接错误和其他可重试错误按指数退避策略重试
   * @param operation - 要执行的操作
   * @param operationName - 操作名称（用于日志）
   * @param maxRetries - 最大重试次数，默认为 this.maxRetries
   * @returns 操作返回的结果
   * @throws {Error} 当所有重试均失败或遇到认证错误时抛出
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = this.maxRetries
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const errorMsg = lastError.message.toLowerCase();

        const isAuthError =
          errorMsg.includes('401') ||
          errorMsg.includes('invalid') ||
          errorMsg.includes('authentication');

        // 认证错误不重试，直接跳出
        if (isAuthError) {
          Logger.warn(
            `🚫 ${operationName} 认证失败，跳过重试: ${lastError.message}`,
            'ChatProvider'
          );
          break;
        }

        // 连接错误或其他错误：按指数退避重试
        if (attempt < maxRetries) {
          const delay = this.baseRetryInterval * Math.pow(2, attempt - 1);
          Logger.warn(
            `${operationName} 第${attempt}次失败，${delay}ms后重试: ${lastError.message}`,
            'ChatProvider'
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const errorMessage = lastError
      ? `${operationName}失败: ${lastError.message}`
      : `${operationName}失败，请检查 LLM 服务是否运行`;

    throw new Error(errorMessage);
  }

  /**
   * 日常对话方法
   * 支持历史记录压缩、缓存、重试
   * @param message - 用户消息
   * @param history - 历史对话记录
   * @param systemPromptOverride - 自定义 system prompt（可选）
   * @returns LLM 生成的回复文本
   * @throws {Error} 当 LLM 调用失败时抛出
   */
  async chat(
    message: string,
    history: Array<{ role: string; content: string }> = [],
    systemPromptOverride?: string
  ): Promise<string> {
    const defaultPrompt = getPromptTemplate('chat');
    const systemPrompt = injectPreferences(
      systemPromptOverride || defaultPrompt
    );

    const compressedHistory = PromptOptimizer.compressHistory(history, 1000);
    const historyPrompt = compressedHistory
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');
    const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
    const optimizedPrompt = PromptOptimizer.optimizePrompt(humanPrompt, 2000);

    const cacheKey = this.responseCache.generateKey(
      optimizedPrompt,
      systemPrompt
    );
    const cached = this.responseCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const operation = async () => {
      const response = await this.model.generate({
        prompt: optimizedPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.8,
        maxTokens: 1024,
      });

      if (response.isFallback) {
        Logger.warn('⚠️ 使用降级回复', 'ChatProvider');
        return response.text;
      }

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      this.responseCache.set(cacheKey, response.text);
      return response.text;
    };

    try {
      return await this.requestQueue.enqueue(() =>
        this.executeWithRetry(operation, 'LLM聊天')
      );
    } catch (error) {
      Logger.error(`⚠️ LLM聊天失败`, error as Error, 'ChatProvider');
      throw error;
    }
  }

  /**
   * 使用 Function Calling 调用 LLM
   * 支持工具调用循环，返回带 toolCalls 的结果
   * @param messages - 消息数组（OpenAI 格式）
   * @param tools - 工具定义数组
   * @param maxTokens - 最大生成 token 数
   * @param toolChoice - 工具选择策略
   * @returns 包含 content 和可选 toolCalls 的结果
   * @throws {Error} 当 LLM 调用失败时抛出
   */
  async chatWithTools(
    messages: Array<{
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
      name?: string;
    }>,
    tools: Array<Record<string, unknown>>,
    maxTokens: number = 4096,
    toolChoice: 'none' | 'auto' | 'required' = 'auto'
  ): Promise<{
    content: string;
    toolCalls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }> {
    const sanitizedMessages = this.sanitizeMessagesForAPI(messages);

    const tryGenerate = async (): Promise<{
      content: string;
      toolCalls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    }> => {
      const response = await this.model.generate({
        messages: sanitizedMessages,
        tools,
        maxTokens,
        temperature: 0.8,
        toolChoice,
      } as ModelInput);

      return {
        content: response.text || '',
        toolCalls: response.toolCalls
          ? this.normalizeToolCalls(response.toolCalls)
          : undefined,
      };
    };

    return await this.executeWithRetry(tryGenerate, 'LLM工具聊天');
  }

  /**
   * 规范化 tool_calls，确保所有必需字段存在
   * 防止模型返回格式异常的 tool_calls 导致下游崩溃
   */
  private normalizeToolCalls(
    toolCalls: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>
  ): Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> {
    return toolCalls.map((tc, index) => ({
      id: tc.id || `tc_${Date.now()}_${index}`,
      type: tc.type || 'function',
      function: {
        name: tc.function?.name || 'unknown',
        arguments: tc.function?.arguments || '{}',
      },
    }));
  }

  /**
   * 清理 messages 数组，确保符合 OpenAI API 规范
   * - 合并多条 system 消息为一条
   * - 为 tool 消息添加 name 字段
   * - 移除空 content 的 assistant 消息（除非有 tool_calls）
   */
  private sanitizeMessagesForAPI(
    messages: Array<{
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
      name?: string;
    }>
  ): Array<Record<string, unknown>> {
    const systemParts: string[] = [];
    const nonSystemMessages: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg.content) {
          systemParts.push(msg.content);
        }
      } else {
        const sanitized: Record<string, unknown> = { role: msg.role };

        if (msg.role === 'assistant') {
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            sanitized.tool_calls = msg.tool_calls;
            sanitized.content = msg.content || '';
          } else if (msg.content) {
            sanitized.content = msg.content;
          } else {
            continue;
          }
        } else if (msg.role === 'tool') {
          const lastNonTool = [...nonSystemMessages]
            .reverse()
            .find((m) => m.role !== 'tool');
          if (lastNonTool?.role !== 'assistant' || !lastNonTool?.tool_calls) {
            Logger.warn(
              `⚠️ tool 消息前无 assistant+tool_calls，跳过（tool_call_id=${msg.tool_call_id?.substring(0, 20)}）`,
              'ChatProvider'
            );
            continue;
          }
          sanitized.tool_call_id = msg.tool_call_id || '';
          sanitized.content = msg.content || '';
          if (msg.name) {
            sanitized.name = msg.name;
          }
        } else {
          sanitized.content = msg.content || '';
        }

        nonSystemMessages.push(sanitized);
      }
    }

    const result: Array<Record<string, unknown>> = [];
    if (systemParts.length > 0) {
      result.push({
        role: 'system',
        content: systemParts.join('\n\n'),
      });
    }
    result.push(...nonSystemMessages);

    return result;
  }

  /**
   * 获取模型名称
   * @returns 当前模型名称
   */
  getModelName(): string {
    return this.modelName;
  }
}
