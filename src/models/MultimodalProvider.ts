/**
 * MultimodalProvider - 多模态服务
 *
 * 从 LLMProvider 拆分而出，专注于多模态场景：
 *   - multimodalChat: 多模态对话（含图片）
 *   - multimodalCodeAnalysis: 多模态代码分析（图片+代码）
 *
 * 保持与原 LLMProvider 中这些方法相同的逻辑。
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model, ModelInput } from './ModelInterface';
import { LLMResponseCache } from './LLMResponseCache';
import { RequestQueue } from './RequestQueue';
import { PromptOptimizer } from './PromptOptimizer';
import { getPromptTemplate } from '../llm/prompt-templates';

export class MultimodalProvider {
  private model: Model;
  private modelName: string;
  private maxRetries: number = 2;
  private baseRetryInterval: number = 1000;

  private responseCache: LLMResponseCache;
  private requestQueue: RequestQueue;

  private localUnavailable: boolean = false;

  private static readonly CONNECTION_ERRORS = [
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
    Logger.info(
      `🔌 MultimodalProvider 已初始化（模型: ${modelName}）`,
      'MultimodalProvider'
    );
  }

  /**
   * 多模态对话（含图片）
   * @param message - 用户消息文本
   * @param images - 图片数组（base64 或 URL）
   * @param history - 历史对话记录
   * @returns 模型生成的响应文本
   * @throws {Error} 当本地模型不可用或模型返回错误时抛出
   */
  async multimodalChat(
    message: string,
    images?: string[],
    history: Array<{ role: string; content: string }> = []
  ): Promise<string> {
    if (this.localUnavailable) {
      throw new Error('本地模型已标记不可用');
    }

    const systemPrompt = injectPreferences(getPromptTemplate('multimodalChat'));

    const compressedHistory = PromptOptimizer.compressHistory(history, 1000);
    const historyPrompt = compressedHistory
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');
    const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
    const optimizedPrompt = PromptOptimizer.optimizePrompt(humanPrompt, 2000);

    const cacheKey = this.responseCache.generateKey(
      optimizedPrompt + (images?.length || 0).toString(),
      systemPrompt
    );
    const cached = this.responseCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const operation = async () => {
      const input = {
        prompt: optimizedPrompt,
        systemPrompt,
        temperature: 0.8,
        maxTokens: 1024,
      } as Record<string, unknown>;

      if (images && images.length > 0) {
        input.images = images;
      }

      const response = await this.model.generate(
        input as unknown as Parameters<typeof this.model.generate>[0]
      );

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
        this.executeWithRetry(operation, 'LLM多模态聊天')
      );
    } catch (error) {
      Logger.error(`⚠️ LLM多模态聊天失败`, error as Error, 'MultimodalProvider');
      throw error;
    }
  }

  /**
   * 多模态代码分析（图片+代码）
   * @param userQuery - 用户问题
   * @param images - 图片数组（base64 或 URL）
   * @param filePath - 相关文件路径（可选）
   * @returns 模型生成的分析结果
   * @throws {Error} 当模型返回错误时抛出
   */
  async multimodalCodeAnalysis(
    userQuery: string,
    images: string[],
    filePath?: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(
      getPromptTemplate('multimodalCodeAnalysis')
    );

    const humanPrompt = filePath
      ? `用户问题：${userQuery}\n相关文件：${filePath}\n请分析图片并给出建议。`
      : `用户问题：${userQuery}\n请分析图片并给出建议。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt,
        temperature: 0.7,
        maxTokens: 2048,
        images,
      } as ModelInput);

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, 'LLM多模态代码分析');
    } catch (error) {
      Logger.error(
        `⚠️ LLM多模态代码分析失败`,
        error as Error,
        'MultimodalProvider'
      );
      throw error;
    }
  }

  /**
   * 带重试的执行操作
   * @param operation - 要执行的操作
   * @param operationName - 操作名称（用于日志）
   * @param maxRetries - 最大重试次数
   * @returns 操作执行结果
   * @throws {Error} 重试耗尽后抛出最后一次错误
   */
  private async executeWithRetry<T>(
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

        const isConnectionError = MultimodalProvider.CONNECTION_ERRORS.some(
          (e) => errorMsg.includes(e)
        );

        const isAuthError =
          errorMsg.includes('401') ||
          errorMsg.includes('invalid') ||
          errorMsg.includes('authentication');

        if (isConnectionError || isAuthError) {
          Logger.warn(
            `🚫 ${operationName} ${
              isAuthError ? '认证失败' : '连接错误'
            }，跳过重试: ${lastError.message}`,
            'MultimodalProvider'
          );
          break;
        }

        if (attempt < maxRetries) {
          const delay = this.baseRetryInterval * Math.pow(2, attempt - 1);
          Logger.warn(
            `${operationName} 第${attempt}次失败，${delay}ms后重试: ${lastError.message}`,
            'MultimodalProvider'
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
}
