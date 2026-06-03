/**
 * MultiModelProvider — 多模型 LLM 提供者
 * 
 * 替代旧的 LLMProvider，从 ProviderManager 读取配置
 * 支持：
 * - 多 provider 注册
 * - 自动降级 (第一个失败→第二个→...)
 * - 任务复杂度路由 (简单→便宜模型, 复杂→强模型)
 * 
 * 兼容原 LLMProvider 的 chat(), chatWithTools(), generate() 接口
 */

import { Logger } from '../utils/Logger';
import { OpenAICompatibleModel } from './OpenAICompatibleModel';
import { Model, ModelInput, ModelOutput } from './ModelInterface';
import { getProviderManager, ProviderConfig } from './ProviderManager';
import { LLMResponseCache } from './LLMResponseCache';
import { RequestQueue } from './RequestQueue';
import { PromptOptimizer } from './PromptOptimizer';
import { getPromptTemplate } from '../llm/prompt-templates';
import { injectPreferences } from '../memory/PreferenceInjector';
import { perf } from '../monitoring/PerformanceMonitor';

export class MultiModelProvider {
  private instances: Map<string, OpenAICompatibleModel> = new Map();
  private responseCache: LLMResponseCache;
  private requestQueue: RequestQueue;
  private maxRetries: number = 2;
  private baseRetryInterval: number = 1000;
  private serviceAvailable: boolean = false;
  private localUnavailable: boolean = false;

  static readonly CONNECTION_ERRORS = [
    'econnrefused', 'econnreset', 'enetunreach',
    'connection refused', 'connect econnrefused',
    'network error', 'network timeout', 'fetch failed',
    'abort', '超时',
  ];

  constructor() {
    this.responseCache = new LLMResponseCache();
    this.requestQueue = new RequestQueue(2);
    this.initFromProviderManager();
  }

  /** 从 ProviderManager 初始化所有模型实例 */
  private initFromProviderManager(): void {
    const pm = getProviderManager();
    const providers = pm.getAll();

    if (providers.length === 0) {
      Logger.warn('⚠️ 未配置任何 Provider，尝试从 .env 导入', 'MultiModelProvider');
      pm.importFromEnv();
    }

    for (const p of pm.getAll()) {
      try {
        const model = this.createModel(p);
        this.instances.set(p.name, model);
        Logger.info(
          `✅ 已加载模型: ${p.displayName} (${p.model}) @ ${p.baseUrl}`,
          'MultiModelProvider'
        );
      } catch (e) {
        Logger.warn(
          `⚠️ 加载模型失败 ${p.name}: ${(e as Error).message}`,
          'MultiModelProvider'
        );
      }
    }

    if (this.instances.size === 0) {
      Logger.error('❌ 没有任何模型实例可用', new Error('No models'), 'MultiModelProvider');
    } else {
      this.serviceAvailable = true;
    }
  }

  private createModel(config: ProviderConfig): OpenAICompatibleModel {
    return new OpenAICompatibleModel({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      modelName: config.model,
      timeout: 90000,
      maxTokens: 8192,
      temperature: 0.7,
      topP: 0.9,
      thinkingMode: ((config.extra?.thinkingMode as string) || 'disabled') as 'enabled' | 'disabled',
      reasoningEffort: (config.extra?.reasoningEffort as 'high' | 'max') || undefined,
    });
  }

  /** 获取所有可用模型名称列表 */
  getAvailableModels(): { name: string; displayName: string; model: string; healthy?: boolean }[] {
    const pm = getProviderManager();
    return pm.getAll().map(p => ({
      name: p.name,
      displayName: p.displayName,
      model: p.model,
      healthy: p.healthy,
    }));
  }

  /** 根据 ProviderManager 的路由规则获取模型列表（按优先级排序） */
  private getModelsForInput(input: string): { name: string; model: OpenAICompatibleModel }[] {
    const pm = getProviderManager();
    const providers = pm.getProvidersForInput(input);

    const models: { name: string; model: OpenAICompatibleModel }[] = [];
    for (const p of providers) {
      const m = this.instances.get(p.name);
      if (m) models.push({ name: p.name, model: m });
    }

    // 如果路由没有返回模型，fallback 到所有可用实例
    if (models.length === 0) {
      for (const [name, model] of this.instances) {
        models.push({ name, model });
      }
    }

    return models;
  }

  /** 获取单个指定名称的模型 */
  private getModel(name: string): OpenAICompatibleModel | undefined {
    return this.instances.get(name);
  }

  /** 获取主模型 */
  private getPrimaryModel(): OpenAICompatibleModel | undefined {
    const pm = getProviderManager();
    const primary = pm.getPrimary();
    if (primary) return this.instances.get(primary.name);
    return this.instances.values().next().value;
  }

  async initialize(): Promise<void> {
    for (const [name, model] of this.instances) {
      try {
        await model.initialize();
        const pm = getProviderManager();
        pm.updateHealth(name, true);
      } catch (e) {
        Logger.warn(`⚠️ ${name} 初始化失败: ${(e as Error).message}`, 'MultiModelProvider');
        getProviderManager().updateHealth(name, false);
      }
    }
  }

  async healthCheck(): Promise<{ available: boolean; message: string; models: { name: string; available: boolean }[] }> {
    const results: { name: string; available: boolean }[] = [];
    let anyAvailable = false;

    for (const [name, model] of this.instances) {
      try {
        const pm = getProviderManager();
        const config = pm.get(name);
        if (!config) continue;

        const response = await fetch(`${config.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(10000),
        } as RequestInit);

        const available = response.ok || response.status === 401;
        results.push({ name, available });
        pm.updateHealth(name, available);
        if (available) anyAvailable = true;
      } catch {
        results.push({ name, available: false });
        getProviderManager().updateHealth(name, false);
      }
    }

    this.serviceAvailable = anyAvailable;
    return {
      available: anyAvailable,
      message: anyAvailable
        ? `${results.filter(r => r.available).length}/${results.length} 个模型可用`
        : '没有可用的模型',
      models: results,
    };
  }

  /** 带降级的重试执行 */
  private async executeWithFallback<T>(
    operation: (model: OpenAICompatibleModel, name: string) => Promise<T>,
    input: string,
    operationName: string,
  ): Promise<T> {
    if (this.localUnavailable) {
      throw new Error('所有模型已标记不可用');
    }

    const models = this.getModelsForInput(input);
    if (models.length === 0) {
      throw new Error('没有可用的模型');
    }

    let lastError: Error | null = null;

    for (const { name, model } of models) {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const result = await operation(model, name);
          getProviderManager().updateHealth(name, true);
          return result;
        } catch (error) {
          lastError = error as Error;
          const errMsg = lastError.message.toLowerCase();
          const isConnErr = MultiModelProvider.CONNECTION_ERRORS.some(e => errMsg.includes(e));

          if (!isConnErr && attempt < this.maxRetries) {
            const delay = this.baseRetryInterval * Math.pow(2, attempt);
            Logger.warn(
              `${operationName} ${name} 第${attempt + 1}次失败，${delay}ms后重试: ${lastError.message}`,
              'MultiModelProvider'
            );
            await new Promise(r => setTimeout(r, delay));
            continue;
          }

          if (isConnErr) {
            Logger.warn(`${operationName} ${name} 连接错误，切换到下一个模型: ${lastError.message}`, 'MultiModelProvider');
            getProviderManager().updateHealth(name, false);
            break; // 跳出重试循环，尝试下一个模型
          }

          // 非连接错误且重试耗尽
          Logger.warn(`${operationName} ${name} 重试耗尽，切换到下一个模型`, 'MultiModelProvider');
        }
      }
    }

    this.localUnavailable = true;
    throw lastError || new Error(`${operationName} 所有模型均失败`);
  }

  // ═══════════════════════════════════════════════════════════
  // 以下方法与原 LLMProvider 的 public API 保持兼容
  // ═══════════════════════════════════════════════════════════

  async chat(
    message: string,
    history: Array<{ role: string; content: string }> = [],
    systemPromptOverride?: string,
    input?: string,
  ): Promise<string> {
    const defaultPrompt = getPromptTemplate('chat');
    const systemPrompt = injectPreferences(systemPromptOverride || defaultPrompt);

    const compressedHistory = PromptOptimizer.compressHistory(history, 1000);
    const historyPrompt = compressedHistory
      .map(h => `${h.role}: ${h.content}`)
      .join('\n');
    const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
    const optimizedPrompt = PromptOptimizer.optimizePrompt(humanPrompt, 2000);

    const cacheKey = this.responseCache.generateKey(optimizedPrompt, systemPrompt);
    const cached = this.responseCache.get(cacheKey);
    if (cached) return cached;

    const routeInput = input || message;

    const result = await this.executeWithFallback(
      async (model) => {
        const response = await model.generate({
          prompt: optimizedPrompt,
          systemPrompt,
          temperature: 0.8,
          maxTokens: 1024,
        });
        if (response.error) throw new Error(response.error);
        if (!response.text) throw new Error('模型未返回内容');
        return response.text;
      },
      routeInput,
      'chat',
    );

    this.responseCache.set(cacheKey, result);
    return result;
  }

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
    toolChoice: 'none' | 'auto' | 'required' = 'auto',
    input?: string,
  ): Promise<{
    content: string;
    toolCalls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }> {
    const sanitizedMessages = this.sanitizeMessagesForAPI(messages);
    const routeInput = input || (sanitizedMessages[0]?.content as string) || '';

    return await this.executeWithFallback(
      async (model) => {
        const response = await model.generate({
          messages: sanitizedMessages,
          tools,
          maxTokens,
          temperature: 0.8,
          toolChoice,
        } as ModelInput);

        const inputEst = sanitizedMessages.reduce((s, m) => s + ((m.content as string)?.length || 0), 0);
        const outputEst = ((response.text as string)?.length || 0) * 2;
        perf.recordTokenUsage(Math.round(inputEst * 1.3), Math.round(outputEst * 1.3));

        return {
          content: response.text || '',
          toolCalls: response.toolCalls
            ? this.normalizeToolCalls(response.toolCalls)
            : undefined,
        };
      },
      routeInput,
      'chatWithTools',
    );
  }

  async streamChat(
    message: string,
    onChunk: (chunk: string) => void,
    history: Array<{ role: string; content: string }> = [],
    systemPromptOverride?: string,
  ): Promise<string> {
    const defaultPrompt = getPromptTemplate('chat');
    const systemPrompt = injectPreferences(systemPromptOverride || defaultPrompt);

    const compressedHistory = PromptOptimizer.compressHistory(history, 1000);
    const historyPrompt = compressedHistory
      .map(h => `${h.role}: ${h.content}`)
      .join('\n');
    const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
    const optimizedPrompt = PromptOptimizer.optimizePrompt(humanPrompt, 2000);

    // streamChat 用主模型（流式一般比较重，用最强的）
    const primary = this.getPrimaryModel();
    if (!primary) throw new Error('没有可用的模型');

    // TODO: 实现真正的 streaming (目前用非流式模拟)
    const response = await primary.generate({
      prompt: optimizedPrompt,
      systemPrompt,
      temperature: 0.8,
      maxTokens: 1024,
    });

    const text = response.text || '';
    if (text) {
      onChunk(text);
    }
    return text;
  }

  async multimodalChat(
    message: string,
    images?: string[],
    history: Array<{ role: string; content: string }> = [],
  ): Promise<string> {
    const systemPrompt = injectPreferences(getPromptTemplate('multimodalChat'));

    const compressedHistory = PromptOptimizer.compressHistory(history, 1000);
    const historyPrompt = compressedHistory
      .map(h => `${h.role}: ${h.content}`)
      .join('\n');
    const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
    const optimizedPrompt = PromptOptimizer.optimizePrompt(humanPrompt, 2000);

    const cacheKey = this.responseCache.generateKey(
      optimizedPrompt + (images?.length || 0).toString(),
      systemPrompt,
    );
    const cached = this.responseCache.get(cacheKey);
    if (cached) return cached;

    // 多模态用主模型（通常需要视觉能力）
    const primary = this.getPrimaryModel();
    if (!primary) throw new Error('没有可用的模型');

    const response = await primary.generate({
      prompt: optimizedPrompt,
      systemPrompt,
      temperature: 0.7,
      maxTokens: 2048,
      images,
    } as ModelInput);

    if (response.error) throw new Error(response.error);
    if (!response.text) throw new Error('模型未返回内容');

    this.responseCache.set(cacheKey, response.text);
    return response.text;
  }

  /** 兼容原 LLMProvider 的 markLocalUnavailable */
  markLocalUnavailable(message: string): void {
    this.localUnavailable = true;
    Logger.warn(`🚫 标记为不可用: ${message}`, 'MultiModelProvider');
  }

  /** 兼容: 降级时的提示 */
  generateFallbackPrompt(): string {
    return '抱歉，我暂时无法连接到大模型服务。';
  }

  private sanitizeMessagesForAPI(
    messages: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(msg)) {
        if (value !== null && value !== undefined) {
          sanitized[key] = value;
        }
      }
      return sanitized;
    });
  }

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
        if (typeof fn.arguments === 'string') args = fn.arguments;
        else if (fn.arguments !== undefined && fn.arguments !== null) {
          try { args = JSON.stringify(fn.arguments); } catch { args = '{}'; }
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
}
