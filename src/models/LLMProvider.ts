/**
 * LLM Provider - 统一使用 OpenAI 兼容接口
 * 支持重试机制和健康检查，增强连接稳定性
 * v2: 支持多模型热切换和自动故障转移
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model, ModelInput } from './ModelInterface';
import { OpenAICompatibleModel } from './OpenAICompatibleModel';
import { LLMResponseCache } from './LLMResponseCache';
import { RequestQueue } from './RequestQueue';
import { PromptOptimizer } from './PromptOptimizer';
import { getPromptTemplate } from '../llm/prompt-templates';

export class LLMProvider {
  private model: Model;
  private modelName: string;
  private maxRetries: number = 2;
  private baseRetryInterval: number = 1000;
  private serviceAvailable: boolean = false;

  private responseCache: LLMResponseCache;
  private requestQueue: RequestQueue;

  private zhipuModel: OpenAICompatibleModel | null = null;

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

  constructor(modelName?: string, model?: Model) {
    if (model) {
      this.model = model;
      this.modelName = modelName || 'external';
      Logger.info('🔌 使用外部注入的模型实例', 'LLMProvider');
    } else {
      this.modelName = modelName || process.env.LLM_MODEL || 'deepseek-chat';
      Logger.info('🔌 使用 OpenAI 兼容模式', 'LLMProvider');
      this.model = new OpenAICompatibleModel({
        baseUrl:
          process.env.OPENAI_API_BASE ||
          process.env.LLM_BASE_URL ||
          'https://api.deepseek.com',
        apiKey:
          process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || 'not-needed',
        modelName: this.modelName,
        thinkingMode:
          (process.env.DEEPSEEK_THINKING_MODE as 'enabled' | 'disabled') ||
          'disabled',
        reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT as
          | 'high'
          | 'max'
          | undefined,
      });

      if (process.env.ZHIPU_API_KEY) {
        this.zhipuModel = new OpenAICompatibleModel({
          baseUrl:
            process.env.ZHIPU_BASE_URL ||
            'https://open.bigmodel.cn/api/paas/v4',
          apiKey: process.env.ZHIPU_API_KEY,
          modelName: process.env.ZHIPU_MODEL || 'glm-4.5-air',
          timeout: 60000,
        });
        Logger.info(
          `✅ LLMProvider 已加载智谱降级模型: ${process.env.ZHIPU_MODEL || 'glm-4.5-air'}`,
          'LLMProvider'
        );
      } else {
        Logger.info(
          'ℹ️ 未配置 ZHIPU_API_KEY，不加载智谱降级模型',
          'LLMProvider'
        );
      }
    }

    this.responseCache = new LLMResponseCache();
    this.requestQueue = new RequestQueue(2);
  }

  async initialize(): Promise<void> {
    try {
      await this.model.initialize();
      this.serviceAvailable = true;
    } catch (error) {
      Logger.warn(
        `⚠️ LLM 初始化失败: ${(error as Error).message}`,
        'LLMProvider'
      );
      this.serviceAvailable = false;
    }
    if (this.zhipuModel) {
      try {
        await this.zhipuModel.initialize();
        Logger.info('✅ 智谱降级模型初始化完成', 'LLMProvider');
      } catch (zError) {
        Logger.warn(
          `⚠️ 智谱降级模型初始化失败: ${(zError as Error).message}`,
          'LLMProvider'
        );
      }
    }
  }

  async healthCheck(): Promise<{ available: boolean; message: string }> {
    try {
      const baseUrl =
        process.env.OPENAI_API_BASE ||
        process.env.LLM_BASE_URL ||
        'https://api.deepseek.com';
      const apiKey =
        process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || 'not-needed';

      Logger.info(`🔍 执行健康检查: baseUrl=${baseUrl}`, 'LLMProvider');
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      } as RequestInit);

      if (response.ok) {
        this.serviceAvailable = true;
        this.localUnavailable = false;
        Logger.info(`✅ 健康检查通过: ${baseUrl}`, 'LLMProvider');
        return {
          available: true,
          message: `LLM 服务可用，模型 ${this.modelName}`,
        };
      }

      // 401 通常是 API key 认证问题，但模型调用仍可能成功
      if (response.status === 401) {
        this.serviceAvailable = true;
        this.localUnavailable = false;
        return {
          available: true,
          message: `LLM 服务可用（/models 返回 401，但模型调用正常），模型 ${this.modelName}`,
        };
      }

      this.serviceAvailable = false;
      this.localUnavailable = true;
      return { available: false, message: 'LLM 服务响应异常' };
    } catch (error) {
      this.serviceAvailable = false;
      this.localUnavailable = true;
      Logger.warn(
        `🚫 本地 LLM 不可用，已标记: ${(error as Error).message}`,
        'LLMProvider'
      );
      return {
        available: false,
        message: `无法连接到 LLM 服务: ${(error as Error).message}`,
      };
    }
  }

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

        const isConnectionError = LLMProvider.CONNECTION_ERRORS.some((e) =>
          errorMsg.includes(e)
        );

        if (isConnectionError) {
          Logger.warn(
            `🚫 ${operationName} 连接错误，跳过重试: ${lastError.message}`,
            'LLMProvider'
          );
          break;
        }

        if (attempt < maxRetries) {
          const delay = this.baseRetryInterval * Math.pow(2, attempt - 1);
          Logger.warn(
            `${operationName} 第${attempt}次失败，${delay}ms后重试: ${lastError.message}`,
            'LLMProvider'
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
      Logger.error(`⚠️ LLM多模态聊天失败`, error as Error, 'LLMProvider');
      throw error;
    }
  }

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
      Logger.error(`⚠️ LLM多模态代码分析失败`, error as Error, 'LLMProvider');
      throw error;
    }
  }

  async analyzeCode(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(getPromptTemplate('analyzeCode'));

    const humanPrompt = `用户问题：${userQuery}
文件路径：${filePath}
文件内容：
\`\`\`
${content}
\`\`\`
请分析并给出专业、温柔的回答。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.7,
        maxTokens: 2048,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, 'LLM分析代码');
    } catch (error) {
      Logger.error(`⚠️ LLM分析失败`, error as Error, 'LLMProvider');
      throw error;
    }
  }

  async generateModificationPlan(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(
      getPromptTemplate('generateModificationPlan')
    );

    const humanPrompt = `用户需求：${userQuery}
文件路径：${filePath}
当前文件内容：
\`\`\`
${content}
\`\`\`
请给出修改方案。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.7,
        maxTokens: 2048,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, 'LLM生成修改方案');
    } catch (error) {
      Logger.error(`⚠️ LLM生成修改方案失败`, error as Error, 'LLMProvider');
      throw error;
    }
  }

  async generateModifiedFileContent(
    filePath: string,
    currentContent: string,
    userRequest: string,
    fileExists: boolean
  ): Promise<string> {
    const rawPrompt = getPromptTemplate('generateModifiedFileContent');
    const systemPrompt = injectPreferences(
      rawPrompt.replace('{{fileState}}', fileExists ? '' : '（文件当前不存在）')
    );

    const humanPrompt = `用户需求：${userRequest}
文件路径：${filePath}
当前文件内容：${fileExists ? currentContent : '（文件不存在）'}
请给出修改后的完整文件内容。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.7,
        maxTokens: 4096,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, 'LLM生成修改文件内容');
    } catch (error) {
      Logger.error(`⚠️ 生成修改文件内容失败`, error as Error, 'LLMProvider');
      throw error;
    }
  }

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

    // 如果本地模型已被标记为不可用，直接走智谱降级
    if (this.localUnavailable || !this.serviceAvailable) {
      if (this.zhipuModel) {
        Logger.info(
          '🚀 本地模型已标记不可用，直接使用智谱降级模型',
          'LLMProvider'
        );
        try {
          const zhipuResponse = await this.zhipuModel.generate({
            prompt: optimizedPrompt,
            systemPrompt: systemPrompt,
            temperature: 0.8,
            maxTokens: 1024,
          });
          if (zhipuResponse.text) {
            this.responseCache.set(cacheKey, zhipuResponse.text);
            return zhipuResponse.text;
          }
        } catch (zhipuError) {
          Logger.error(`❌ 智谱降级也失败`, zhipuError as Error, 'LLMProvider');
        }
      }
      throw new Error('所有模型均不可用');
    }

    const operation = async () => {
      const response = await this.model.generate({
        prompt: optimizedPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.8,
        maxTokens: 1024,
      });

      if (response.isFallback) {
        Logger.warn('⚠️ 使用降级回复', 'LLMProvider');
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
      Logger.warn(
        `⚠️ 主模型 LLM聊天失败: ${(error as Error).message}`,
        'LLMProvider'
      );

      this.localUnavailable = true;
      Logger.info(
        '🚫 本地模型已标记为不可用，后续请求将直接使用智谱降级',
        'LLMProvider'
      );

      if (this.zhipuModel) {
        try {
          const zhipuResponse = await this.zhipuModel.generate({
            prompt: optimizedPrompt,
            systemPrompt: systemPrompt,
            temperature: 0.8,
            maxTokens: 1024,
          });
          if (zhipuResponse.text) {
            Logger.info(
              `✅ 智谱降级模型回复成功 (${zhipuResponse.text.length} 字符)`,
              'LLMProvider'
            );
            return zhipuResponse.text;
          }
        } catch (zhipuError) {
          Logger.error(`❌ 智谱降级也失败`, zhipuError as Error, 'LLMProvider');
        }
      }
      Logger.error(`⚠️ LLM聊天失败`, error as Error, 'LLMProvider');
      throw error;
    }
  }

  /**
   * 使用 Function Calling 调用 LLM
   * v3: LLM 原生架构核心方法，支持工具调用循环
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
    const targetModel = this.model;

    if (!targetModel) {
      throw new Error('没有可用的 LLM 模型');
    }

    const sanitizedMessages = this.sanitizeMessagesForAPI(messages);

    try {
      const response = await targetModel.generate({
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
    } catch (error) {
      Logger.error(
        `❌ Function Calling 失败: ${(error as Error).message}`,
        error as Error,
        'LLMProvider'
      );
      throw error;
    }
  }

  /**
   * F0-04: 规范化 tool_calls，确保所有必需字段存在
   * 防止 DeepSeek 等模型返回格式异常的 tool_calls 导致下游崩溃
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
   * v3: 清理 messages 数组，确保符合 OpenAI API 规范
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
    // 1. 合并所有 system 消息
    const systemParts: string[] = [];
    const nonSystemMessages: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg.content) {
          systemParts.push(msg.content);
        }
      } else {
        const sanitized: Record<string, unknown> = { role: msg.role };

        // assistant 消息：有 tool_calls 时 content 可以为 null
        if (msg.role === 'assistant') {
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            sanitized.tool_calls = msg.tool_calls;
            sanitized.content = msg.content || '';
          } else if (msg.content) {
            sanitized.content = msg.content;
          } else {
            continue; // 跳过空 assistant 消息
          }
        } else if (msg.role === 'tool') {
          // tool 消息前面必须有 assistant+tool_calls，否则 DeepSeek 等 API 会报错
          // 检查上一条非 tool 消息是否为 assistant+tool_calls
          const lastNonTool = [...nonSystemMessages]
            .reverse()
            .find((m) => m.role !== 'tool');
          if (lastNonTool?.role !== 'assistant' || !lastNonTool?.tool_calls) {
            Logger.warn(
              `⚠️ tool 消息前无 assistant+tool_calls，跳过（tool_call_id=${msg.tool_call_id?.substring(0, 20)}）`,
              'LLMProvider'
            );
            continue;
          }
          // tool 消息必须有 tool_call_id 和 content
          sanitized.tool_call_id = msg.tool_call_id || '';
          sanitized.content = msg.content || '';
          // 某些 API 需要 name 字段
          if (msg.name) {
            sanitized.name = msg.name;
          }
        } else {
          // user 消息
          sanitized.content = msg.content || '';
        }

        nonSystemMessages.push(sanitized);
      }
    }

    // 2. 构建最终消息数组：一条 system + 其余消息
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
   * 开发副驾专用：专业代码生成（无人设，无"亲爱的主人"等强制称呼）
   * 使用专业开发者 system prompt，直接生成可执行代码
   */
  async devGenerateCode(
    userRequest: string,
    filePath?: string,
    existingContent?: string
  ): Promise<string> {
    const systemPrompt = getPromptTemplate('devGenerateCode');

    const fileContext = filePath ? `\n目标文件路径：${filePath}` : '';
    const existingCodeContext = existingContent
      ? `\n\n当前文件内容：\n${existingContent}`
      : '\n（新文件，当前不存在）';

    const humanPrompt = `用户需求：${userRequest}${fileContext}${existingCodeContext}\n\n请生成代码。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt,
        temperature: 0.3,
        maxTokens: 4096,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, '开发副驾代码生成');
    } catch (error) {
      Logger.error('开发副驾代码生成失败', error as Error, 'LLMProvider');
      throw error;
    }
  }

  isAvailable(): boolean {
    return (
      this.model !== null && this.serviceAvailable && !this.localUnavailable
    );
  }

  isServiceAvailable(): boolean {
    return this.serviceAvailable && !this.localUnavailable;
  }

  getModelName(): string {
    return this.modelName;
  }

  /** 永久标记本地模型不可用（供外部调用，如启动时健康检查失败） */
  markLocalUnavailable(reason?: string): void {
    this.localUnavailable = true;
    this.serviceAvailable = false;
    Logger.warn(
      `🚫 本地模型已标记不可用${reason ? `: ${reason}` : ''}`,
      'LLMProvider'
    );
  }

  /** 重置可用性标志（供外部调用，如用户手动切换回本地模型） */
  resetAvailability(): void {
    this.localUnavailable = false;
    this.serviceAvailable = true;
    Logger.info('🔄 本地模型可用性已重置', 'LLMProvider');
  }
}
