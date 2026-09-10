/**
 * OpenAI 兼容多模态 LLM 适配器
 * 支持通过 OpenAI API 格式调用本地多模态模型（如 qwen2.5-vl）
 * 支持文本+图像的多模态输入
 * 增强功能：指数退避重试、超时熔断、降级回复
 *
 * 架构: 本类负责生命周期管理（重试/熔断/降级），
 *        请求/响应格式转换委托给 ChatCompletionsTransport
 */

import { Logger } from '../utils/Logger';
import { Model, ModelInput, ModelOutput } from './ModelInterface';
import type { TransportResponse } from './transports/BaseTransport';
import { BaseTransport } from './transports/BaseTransport';
import { TransportFactory } from './transports/TransportFactory';

/**
 * OpenAI 兼容模型的配置
 */
export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  timeout: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  maxRetries?: number;
  retryDelayBase?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerRecoveryMs?: number;
  thinkingMode?: 'enabled' | 'disabled';
  reasoningEffort?: 'high' | 'max';
  /** 传输层类型: 'openai_compatible' | 'openai_responses' | 'anthropic' */
  transportType?: string;
}

/**
 * 多模态消息内容
 */
export interface MultimodalMessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
  };
}

/**
 * OpenAI 格式的聊天消息
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MultimodalMessageContent[];
}

/**
 * 多模态输入扩展
 */
export interface MultimodalInput extends ModelInput {
  images?: string[];
}

/**
 * OpenAI 兼容多模态 LLM 实现
 */
/**
 * 降级回复模板
 */
const FALLBACK_RESPONSES = [
  '抱歉，我暂时无法连接到大模型，让我用本地知识来回答你...',
  '服务暂时繁忙，我先给你一个简要的回复...',
  '网络连接有些不稳定，让我尝试用备用方案...',
];

type ResolvedConfig = Omit<
  Required<OpenAICompatibleConfig>,
  'thinkingMode' | 'reasoningEffort' | 'transportType'
> &
  Pick<
    OpenAICompatibleConfig,
    'thinkingMode' | 'reasoningEffort' | 'transportType'
  >;

/**
 * @deprecated TS 本地 LLM 客户端（AGENT_BACKEND=local 回退实现）。
 * AGENT_BACKEND=python（默认）时，真实 LLM 调用由 PythonAgentBridge 经 /v1/llm/*
 * 委派 Python agent.llm；LLMProviderBridge 在 python 模式使用 PythonBackedModel 占位壳，
 * 不再实例化本类。本类仅在 local 模式使用，禁止在新代码中直接实例化。
 */
export class OpenAICompatibleModel implements Model {
  private config: ResolvedConfig;
  private initialized: boolean = false;
  /** 传输层 — 负责 Provider 协议格式的请求/响应转换 */
  private transport: BaseTransport;
  /** 连续失败次数 */
  private consecutiveFailures: number = 0;
  /** 连接错误导致的连续失败次数（连接错误不再自动恢复） */
  private consecutiveConnectionFailures: number = 0;
  /** 熔断状态 */
  private circuitOpen: boolean = false;
  /** 熔断恢复时间 */
  private circuitOpenUntil: number = 0;
  /** 最后成功时间 */
  private lastSuccessTime: number = 0;
  /** 连接错误导致的永久熔断 - 不再自动恢复 */
  private permanentlyDisabled: boolean = false;

  constructor(config: Partial<OpenAICompatibleConfig> = {}) {
    this.config = {
      baseUrl:
        config.baseUrl ||
        process.env.OPENAI_API_BASE ||
        'http://127.0.0.1:8000/v1',
      apiKey: config.apiKey || process.env.OPENAI_API_KEY || 'not-needed',
      modelName:
        config.modelName || process.env.LLM_MODEL || 'deepseek-v4-flash',
      timeout: config.timeout || 30000,
      maxTokens: config.maxTokens || 4096,
      temperature: config.temperature || 0.7,
      topP: config.topP || 0.9,
      maxRetries: config.maxRetries ?? 3,
      retryDelayBase: config.retryDelayBase ?? 1000,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitBreakerRecoveryMs: config.circuitBreakerRecoveryMs ?? 60000,
      thinkingMode: config.thinkingMode,
      reasoningEffort: config.reasoningEffort,
    };

    this.transport = TransportFactory.fromProviderConfig({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.modelName,
      timeout: this.config.timeout,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
      extra: {
        thinkingMode: this.config.thinkingMode,
        reasoningEffort: this.config.reasoningEffort,
        transport: config.transportType,
      },
    });
  }

  async initialize(): Promise<void> {
    try {
      Logger.info(
        `🔌 正在连接 OpenAI 兼容服务: ${this.config.baseUrl}`,
        'OpenAICompatibleModel'
      );

      const response = await this.fetchWithTimeout(
        `${this.config.baseUrl}/models`,
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        }
      );

      if (response.ok) {
        const responseText = await response.text();
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error(
            `API 响应 JSON 解析失败 (${response.status}): ${responseText.substring(0, 200)}`
          );
        }
        const models =
          (data.data as Array<Record<string, string>> | undefined) || [];
        const modelNames =
          models.map((m: Record<string, string>) => m.id).join(', ') || '未知';

        this.initialized = true;
        Logger.info(
          `✅ OpenAI 兼容服务已初始化 - 模型: ${this.config.modelName}, 可用模型: ${modelNames}`,
          'OpenAICompatibleModel'
        );
      } else if (response.status === 401) {
        this.initialized = true;
        Logger.warn(
          `⚠️ OpenAI 兼容服务 /models 端点返回 401 (认证失败)，请检查 API_KEY 配置，模型仍会尝试使用`,
          'OpenAICompatibleModel'
        );
      } else {
        this.initialized = true;
        Logger.warn(
          `⚠️ OpenAI 兼容服务 /models 端点返回 ${response.status}，但模型仍可尝试使用`,
          'OpenAICompatibleModel'
        );
      }
    } catch (error) {
      this.initialized = true;
      Logger.warn(
        `⚠️ OpenAI 兼容模型初始化检查失败: ${(error as Error).message}，模型仍将尝试运行`,
        'OpenAICompatibleModel'
      );
    }
  }

  async generate(input: ModelInput | MultimodalInput): Promise<ModelOutput> {
    if (!this.initialized) {
      return {
        text: '',
        error: 'OpenAI 兼容模型未初始化',
      };
    }

    // 永久禁用检查 - 但暂时禁用这个严格限制，让系统可以重试
    if (this.permanentlyDisabled) {
      Logger.warn(
        '⚠️ 模型曾被禁用，但允许重试（连接错误）',
        'OpenAICompatibleModel'
      );
      // 重置永久禁用状态，允许重试
      this.permanentlyDisabled = false;
    }

    // 检查熔断状态
    if (this.isCircuitOpen()) {
      Logger.warn('⚠️ 熔断器开启，跳过此模型', 'OpenAICompatibleModel');
      throw new Error('熔断器开启，模型暂时不可用');
    }

    let lastError: Error | undefined;

    // 本次尝试是否应跳过重试（连接错误直接失败）
    let skipRetry = false;

    // 指数退避重试
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.executeGenerate(input);
        // 成功：重置失败计数
        this.consecutiveFailures = 0;
        this.consecutiveConnectionFailures = 0;
        this.lastSuccessTime = Date.now();
        return result;
      } catch (error) {
        lastError = error as Error;
        this.consecutiveFailures++;

        const errorMsg = lastError.message.toLowerCase();
        const isConnectionError =
          errorMsg.includes('econnrefused') ||
          errorMsg.includes('econnreset') ||
          errorMsg.includes('enetunreach') ||
          errorMsg.includes('connection refused') ||
          errorMsg.includes('fetch failed') ||
          errorMsg.includes('abort');

        // 401 认证错误：立即失败，不重试（让上层 LLMProvider 降级）
        const isAuthError =
          errorMsg.includes('401') ||
          errorMsg.includes('invalid api') ||
          errorMsg.includes('invalid_key');
        if (isAuthError) {
          Logger.warn(
            `🔒 认证失败(401)，跳过重试让上层降级: ${lastError.message}`,
            'OpenAICompatibleModel'
          );
          skipRetry = true;
          // 不要 break，让循环自然结束到 throw
        }

        if (isConnectionError) {
          this.consecutiveConnectionFailures++;
          Logger.warn(
            `⚠️ 连接错误 (第${this.consecutiveConnectionFailures}次)，继续重试: ${lastError.message}`,
            'OpenAICompatibleModel'
          );
          // 连接错误也继续重试，不要跳过重试
          skipRetry = false;
          // 降低熔断门槛
          if (this.consecutiveConnectionFailures >= 5) {
            this.openCircuit(true);
            Logger.warn(
              `⚠️ 连续连接错误触发临时熔断，稍后将自动恢复`,
              'OpenAICompatibleModel'
            );
          }
          // 不再永久禁用模型
        }

        // 检查是否达到熔断阈值
        if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
          this.openCircuit(false);
          Logger.error(
            `🔥 连续失败${this.consecutiveFailures}次，触发熔断`,
            undefined,
            'OpenAICompatibleModel'
          );
          break;
        }

        if (attempt < this.config.maxRetries && !skipRetry) {
          const delay = this.config.retryDelayBase * Math.pow(2, attempt);
          Logger.warn(
            `⚠️ LLM调用失败 (${attempt + 1}/${this.config.maxRetries + 1})，${delay}ms后重试: ${lastError?.message || '未知错误'}`,
            'OpenAICompatibleModel'
          );
          await this.sleep(delay);
        }
      }
    }

    // 所有重试失败，抛出错误让 MultiModelLLMProvider 处理降级
    Logger.error(
      `❌ LLM调用最终失败: ${lastError?.message || '未知错误'}`,
      undefined,
      'OpenAICompatibleModel'
    );
    throw lastError || new Error('LLM调用失败');
  }

  /**
   * 执行实际生成请求 — 委托 transport 层构建请求和解析响应
   */
  private async executeGenerate(
    input: ModelInput | MultimodalInput
  ): Promise<ModelOutput> {
    const multimodalInput = input as MultimodalInput;
    // 构建消息（含多模态支持）— 保留在 Model 层因涉及 images 处理
    const messages =
      input.messages && input.messages.length > 0
        ? input.messages
        : this.buildMessages(input, multimodalInput.images);

    // 委托 transport 层转换工具定义
    const tools = this.transport.convertTools(
      input.tools as Array<Record<string, unknown>> | undefined
    );

    // 委托 transport 层构建完整 HTTP 请求
    const request = this.transport.buildRequest(input, messages, tools);

    if (tools && (tools as unknown[]).length > 0) {
      Logger.info(
        `🔧 Function Calling: ${(tools as unknown[]).length}个工具可用, tool_choice=${input.toolChoice || 'auto'}`,
        'OpenAICompatibleModel'
      );
    }

    Logger.info(
      `🚀 发起LLM请求: ${request.url}, model=${this.config.modelName}`,
      'OpenAICompatibleModel'
    );

    // 执行 HTTP 请求（超时控制仍由 Model 层管理）
    const response = await this.fetchWithTimeout(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });

    const responseText = await response.text();

    // 构造 TransportResponse 交给 transport 层解析
    const transportResponse: TransportResponse = {
      status: response.status,
      ok: response.ok,
      text: responseText,
    };

    if (!response.ok) {
      Logger.error(
        `❌ LLM API请求失败: status=${response.status}, body=${responseText.substring(0, 200)}`,
        undefined,
        'OpenAICompatibleModel'
      );
    } else {
      Logger.debug(
        `📨 LLM API响应: 长度=${responseText.length}字符`,
        'OpenAICompatibleModel'
      );
    }

    // 委托 transport 层解析响应为 ModelOutput
    return this.transport.normalizeResponse(transportResponse);
  }

  /**
   * F0-04: 规范化 tool_calls，确保所有必需字段存在
   * DeepSeek V4 Flash 等模型可能返回缺失 id/type 字段的 tool_calls
   */
  private normalizeToolCalls(
    rawToolCalls: Array<Record<string, unknown>>
  ): Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> {
    return rawToolCalls.map((tc, index) => {
      const fn = tc.function as Record<string, unknown> | undefined;
      let args = '';
      if (fn) {
        if (typeof fn.arguments === 'string') {
          args = fn.arguments;
        } else if (fn.arguments !== undefined && fn.arguments !== null) {
          try {
            args = JSON.stringify(fn.arguments);
          } catch {
            args = '{}';
          }
        }
      }

      return {
        id: (tc.id as string) || `tc_${Date.now()}_${index}`,
        type: (tc.type as string) || 'function',
        function: {
          name: (fn?.name as string) || 'unknown',
          arguments: args,
        },
      };
    });
  }

  /**
   * 生成降级回复
   */
  private generateFallbackResponse(
    input: ModelInput,
    error?: Error
  ): ModelOutput {
    const prompt = input.prompt || '';
    const fallbackIndex = Math.min(
      this.consecutiveFailures,
      FALLBACK_RESPONSES.length - 1
    );
    const fallbackPrefix = FALLBACK_RESPONSES[fallbackIndex];

    // 简单的关键词匹配降级回复
    let fallbackText = fallbackPrefix;

    if (prompt.includes('你好') || prompt.includes('hello')) {
      fallbackText += '\n\n你好！我是jiabaixing，很高兴为你服务。';
    } else if (prompt.includes('谢谢') || prompt.includes('感谢')) {
      fallbackText += '\n\n不客气！有什么需要随时告诉我。';
    } else if (prompt.includes('再见') || prompt.includes('拜拜')) {
      fallbackText += '\n\n再见！期待下次为你服务。';
    } else {
      fallbackText += '\n\n你可以尝试重新发送消息，或者稍后再试。';
    }

    return {
      text: fallbackText,
      error: error?.message || '服务暂时不可用',
      isFallback: true,
    };
  }

  /**
   * 检查熔断器是否开启（公开，供 LLMProvider 路由决策用）
   */
  public isCircuitOpen(): boolean {
    if (this.permanentlyDisabled) return true;
    if (!this.circuitOpen) return false;

    // 检查是否已过恢复时间
    if (Date.now() >= this.circuitOpenUntil) {
      this.circuitOpen = false;
      this.consecutiveFailures = 0;
      Logger.info('🔓 熔断器恢复，重新尝试连接', 'OpenAICompatibleModel');
      return false;
    }

    return true;
  }

  /**
   * 开启熔断器
   * @param isConnectionError - 是否为连接错误（连接错误恢复时间更长）
   */
  private openCircuit(isConnectionError: boolean = false): void {
    const recoveryMs = isConnectionError
      ? 30000
      : this.config.circuitBreakerRecoveryMs;
    this.circuitOpen = true;
    this.circuitOpenUntil = Date.now() + recoveryMs;
    Logger.warn(
      `🔒 熔断器已开启，${recoveryMs / 1000}秒后恢复`,
      'OpenAICompatibleModel'
    );
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async *stream(input: ModelInput): AsyncGenerator<string> {
    if (!this.initialized) {
      throw new Error('OpenAI 兼容模型未初始化');
    }

    try {
      const messages = this.buildMessages(input);

      // 委托 transport 层构建流式请求
      const request = this.transport.buildStreamRequest(
        input,
        messages,
        undefined
      );

      const response = await this.fetchWithTimeout(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
      });

      if (!response.ok) {
        throw new Error(`API 请求失败: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('响应体为空');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // 委托 transport 层解析流式 chunk
          const content = this.transport.parseStreamChunk(line);
          if (content) {
            yield content;
          }
        }
      }
    } catch (error) {
      throw new Error(`流式生成失败: ${(error as Error).message}`);
    }
  }

  async getModelInfo(): Promise<Record<string, unknown>> {
    return {
      name: this.config.modelName,
      baseUrl: this.config.baseUrl,
      initialized: this.initialized,
      provider: 'openai_compatible',
    };
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    Logger.info('🔌 OpenAI 兼容模型已关闭', 'OpenAICompatibleModel');
  }

  getName(): string {
    return this.config.modelName;
  }

  /**
   * 构建 OpenAI 格式的消息列表
   */
  private buildMessages(input: ModelInput, images?: string[]): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (input.systemPrompt) {
      messages.push({
        role: 'system',
        content: input.systemPrompt,
      });
    }

    const userContent: MultimodalMessageContent[] = [];

    if (images && images.length > 0) {
      for (const image of images) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url:
              image.startsWith('data:') || image.startsWith('http')
                ? image
                : `data:image/jpeg;base64,${image}`,
          },
        });
      }
    }

    userContent.push({
      type: 'text',
      text: input.prompt,
    });

    messages.push({
      role: 'user',
      content: userContent,
    });

    return messages;
  }

  /**
   * 带超时的 fetch 请求
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      } as RequestInit);
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
