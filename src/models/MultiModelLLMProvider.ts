import { ModelConfig, ModelInput, ModelOutput } from '../core/ModelInterface';
import { Logger } from '../utils/Logger';
import { OpenAICompatibleModel } from './OpenAICompatibleModel';
import { ModelSelector } from './ModelSelector';
import {
  ModelCapabilityProfile,
  ModelHealthStatus,
  MultiModelConfig,
  RegisteredModel,
  RoutingResult,
  RoutingStrategy,
} from './types';

export type {
  ModelCapabilityProfile,
  ModelHealthStatus,
  MultiModelConfig,
  RegisteredModel,
  RoutingResult,
} from './types';

export { RoutingStrategy } from './types';

export class MultiModelLLMProvider {
  private static instance: MultiModelLLMProvider | null = null;
  private models: Map<string, RegisteredModel> = new Map();
  private config: Required<MultiModelConfig>;
  private initialized: boolean = false;
  private healthCheckTimer?: NodeJS.Timeout;
  private modelSelector: ModelSelector;

  private constructor(config: MultiModelConfig = {}) {
    this.config = {
      defaultStrategy: config.defaultStrategy || RoutingStrategy.PRIORITY,
      healthCheckIntervalMs: config.healthCheckIntervalMs || 30000,
      maxConsecutiveFailures: config.maxConsecutiveFailures || 3,
      requestTimeoutMs: config.requestTimeoutMs || 30000,
      enableHealthCheck: config.enableHealthCheck ?? true,
    };
    this.modelSelector = ModelSelector.getInstance();
  }

  public static getInstance(config?: MultiModelConfig): MultiModelLLMProvider {
    if (!MultiModelLLMProvider.instance) {
      MultiModelLLMProvider.instance = new MultiModelLLMProvider(config);
    }
    return MultiModelLLMProvider.instance;
  }

  public static reset(): void {
    if (MultiModelLLMProvider.instance) {
      MultiModelLLMProvider.instance.cleanup();
    }
    MultiModelLLMProvider.instance = null;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.registerDefaultModels();

    if (this.config.enableHealthCheck) {
      this.startHealthCheck();
    }

    this.initialized = true;
    Logger.info(
      `✅ MultiModelLLMProvider 初始化完成，已注册 ${this.models.size} 个模型`,
      'MultiModelLLMProvider'
    );
  }

  private async registerDefaultModels(): Promise<void> {
    /* 本地模型已注释 - 日志报错本地模型不可用
    const localBaseUrl =
      process.env.OPENAI_API_BASE ||
      process.env.LLM_BASE_URL ||
      'http://127.0.0.1:8001/v1';
    const localApiKey =
      process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || 'not-needed';
    const localModelName = process.env.LLM_MODEL || 'deepseek-chat';

    await this.registerModel(
      'local-llm',
      localModelName,
      {
        name: localModelName,
        baseUrl: localBaseUrl,
        apiKey: localApiKey,
        timeout: 30000,
        maxTokens: 4096,
        temperature: 0.7,
        topP: 0.9,
        frequencyPenalty: 0,
        presencePenalty: 0,
      },
      {
        visionScore: 60,
        codingScore: 50,
        reasoningScore: 50,
        speedScore: 90,
        contextLength: 8192,
        features: ['chat', 'code'],
      },
      10
    );
    Logger.info(
      `✅ 已注册本地模型: ${localModelName} @ ${localBaseUrl}`,
      'MultiModelLLMProvider'
    );
    */

    const zhipuApiKey = process.env.ZHIPU_API_KEY;
    const zhipuBaseUrl =
      process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    const zhipuModelName = process.env.ZHIPU_MODEL || 'glm-4.5-air';

    if (zhipuApiKey) {
      await this.registerModel(
        'zhipu',
        zhipuModelName,
        {
          name: zhipuModelName,
          baseUrl: zhipuBaseUrl,
          apiKey: zhipuApiKey,
          timeout: 60000,
          maxTokens: 4096,
          temperature: 0.7,
          topP: 0.9,
          frequencyPenalty: 0,
          presencePenalty: 0,
        },
        {
          visionScore: 70,
          codingScore: 80,
          reasoningScore: 85,
          speedScore: 70,
          contextLength: 128000,
          features: ['chat', 'code', 'analysis', 'review'],
        },
        20
      );
      Logger.info(
        `✅ 已注册智谱模型: ${zhipuModelName} @ ${zhipuBaseUrl}`,
        'MultiModelLLMProvider'
      );
    } else {
      Logger.info(
        'ℹ️ 未配置 ZHIPU_API_KEY，跳过智谱模型注册',
        'MultiModelLLMProvider'
      );
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MultiModelLLMProvider 未初始化，请先调用 initialize()');
    }
  }

  public async registerModel(
    id: string,
    name: string,
    config: ModelConfig,
    capabilities: ModelCapabilityProfile,
    priority: number = 10
  ): Promise<void> {
    const model = new OpenAICompatibleModel({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      modelName: name,
    });

    try {
      await model.initialize();
    } catch (err) {
      Logger.warn(
        `⚠️ 模型 ${name} 初始化失败: ${(err as Error).message}`,
        'MultiModelLLMProvider'
      );
    }

    const registeredModel: RegisteredModel = {
      id,
      name,
      model,
      config,
      capabilities,
      health: {
        available: true,
        averageLatencyMs: 0,
        successRate: 1,
        lastCheckTime: Date.now(),
        consecutiveFailures: 0,
      },
      priority,
      enabled: true,
    };

    this.models.set(id, registeredModel);
  }

  public unregisterModel(id: string): boolean {
    this.ensureInitialized();

    const model = this.models.get(id);
    if (!model) {
      Logger.warn(`⚠️ 模型未找到: ${id}`, 'MultiModelLLMProvider');
      return false;
    }

    this.models.delete(id);
    return true;
  }

  public listModels(): RegisteredModel[] {
    return Array.from(this.models.values());
  }

  public getModel(id: string): RegisteredModel | undefined {
    return this.models.get(id);
  }

  public getModels(): Map<string, RegisteredModel> {
    return this.models;
  }

  public setModelPriority(id: string, priority: number): void {
    const model = this.models.get(id);
    if (model) {
      model.priority = priority;
    }
  }

  public setModelEnabled(id: string, enabled: boolean): void {
    const model = this.models.get(id);
    if (model) {
      model.enabled = enabled;
      Logger.info(
        `${enabled ? '✅' : '❌'} 模型 ${model.name} 已${enabled ? '启用' : '禁用'}`,
        'MultiModelLLMProvider'
      );
    }
  }

  public route(input: ModelInput, strategy?: RoutingStrategy): RoutingResult {
    this.ensureInitialized();

    const activeStrategy = strategy || this.config.defaultStrategy;
    const availableModels = this.getAvailableModels();

    return this.modelSelector.route(availableModels, input, activeStrategy);
  }

  public async generate(
    input: ModelInput,
    strategy?: RoutingStrategy
  ): Promise<ModelOutput> {
    this.ensureInitialized();

    const routingResult = this.route(input, strategy);
    const fallbackChain = [
      routingResult.modelId,
      ...routingResult.fallbackChain,
    ];

    let lastError: Error | undefined;

    for (const modelId of fallbackChain) {
      const model = this.models.get(modelId);
      if (!model || !model.enabled) {
        continue;
      }

      if (!model.health.available) {
        Logger.info(
          `⏭️ 跳过不可用模型 ${model.name}（上次失败: ${model.health.lastError || '未知'}）`,
          'MultiModelLLMProvider'
        );
        continue;
      }

      try {
        Logger.info(
          `🎯 使用模型: ${model.name} (原因: ${routingResult.reason})`,
          'MultiModelLLMProvider'
        );

        const startTime = Date.now();
        const output = await this.executeWithTimeout(model, input);
        const latency = Date.now() - startTime;

        if (!output.text) {
          throw new Error('模型返回空内容');
        }

        this.updateHealthStatus(model, true, latency);

        output.modelName = model.name;
        output.isFallback = modelId !== routingResult.modelId;

        Logger.info(
          `✅ 模型 ${model.name} 生成成功 (${latency}ms)`,
          'MultiModelLLMProvider'
        );
        return output;
      } catch (error) {
        lastError = error as Error;
        this.updateHealthStatus(model, false, 0, (error as Error).message);
        Logger.warn(
          `⚠️ 模型 ${model.name} 失败，尝试降级: ${(error as Error).message}`,
          'MultiModelLLMProvider'
        );

        const errorMsg = (error as Error).message.toLowerCase();
        if (
          errorMsg.includes('econnrefused') ||
          errorMsg.includes('econnreset') ||
          errorMsg.includes('connection refused') ||
          errorMsg.includes('fetch failed') ||
          errorMsg.includes('abort')
        ) {
          model.health.available = false;
          Logger.warn(
            `🚫 连接错误，立即禁用模型 ${model.name}`,
            'MultiModelLLMProvider'
          );
        }
      }
    }

    throw new Error(`所有模型均失败: ${lastError?.message || '未知错误'}`);
  }

  public async *stream(
    input: ModelInput,
    strategy?: RoutingStrategy
  ): AsyncGenerator<string> {
    this.ensureInitialized();

    const routingResult = this.route(input, strategy);
    const model = this.models.get(routingResult.modelId);

    if (!model) {
      throw new Error('路由失败：模型未找到');
    }

    yield* model.model.stream(input);
  }

  public async benchmarkModel(
    modelId: string
  ): Promise<ModelCapabilityProfile> {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`模型未找到: ${modelId}`);
    }

    Logger.info(`📊 开始评估模型: ${model.name}`, 'MultiModelLLMProvider');

    const speedScore = await this.testSpeed(model);
    const codingScore = await this.testCoding(model);
    const reasoningScore = await this.testReasoning(model);
    const visionScore = model.capabilities.features.includes('vision')
      ? await this.testVision(model)
      : 0;

    const profile: ModelCapabilityProfile = {
      visionScore,
      codingScore,
      reasoningScore,
      speedScore,
      contextLength: model.capabilities.contextLength,
      features: model.capabilities.features,
    };

    model.capabilities = profile;

    Logger.info(
      `📊 模型 ${model.name} 评估完成: 速度=${speedScore}, 代码=${codingScore}, 推理=${reasoningScore}, 视觉=${visionScore}`,
      'MultiModelLLMProvider'
    );

    return profile;
  }

  public getModelName(): string {
    const availableModels = this.getAvailableModels();
    if (availableModels.length === 0) {
      return '无可用模型';
    }
    const best = this.modelSelector.routeByPriority(availableModels);
    return best.name;
  }

  public isAvailable(): boolean {
    return this.getAvailableModels().length > 0;
  }

  public async healthCheck(): Promise<{ available: boolean; message: string }> {
    if (!this.initialized) {
      return { available: false, message: 'MultiModelLLMProvider 未初始化' };
    }

    const availableModels = this.getAvailableModels();
    if (availableModels.length === 0) {
      return { available: false, message: '没有可用模型' };
    }

    const modelNames = availableModels.map((m) => m.name).join(', ');
    return {
      available: true,
      message: `多模型Provider可用，活跃模型: ${modelNames}`,
    };
  }

  public async chat(
    message: string,
    history: Array<{ role: string; content: string }> = [],
    systemPromptOverride?: string
  ): Promise<string> {
    this.ensureInitialized();

    const defaultPrompt = `你是家百星，28岁私人秘书。成熟、专业、从容。
回复要求：
1. 语气成熟自然，像有经验的专业人士
2. 简洁高效，不啰嗦，不堆砌空洞的关心
3. 如果是技术问题，要专业严谨
4. 如果是闲聊，要保持温暖但不过度
5. 不使用"～""哦""呢""呀"等幼化语气词`;

    const systemPrompt = systemPromptOverride || defaultPrompt;
    const historyPrompt = history
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');
    const fullPrompt = `${historyPrompt}\n\n用户: ${message}`;

    const routingResult = this.route(
      { prompt: fullPrompt, systemPrompt, maxTokens: 1024, temperature: 0.8 },
      RoutingStrategy.PRIORITY
    );

    const fallbackChain = [
      routingResult.modelId,
      ...routingResult.fallbackChain,
    ];

    let lastError: Error | undefined;

    for (const modelId of fallbackChain) {
      const registeredModel = this.models.get(modelId);
      if (
        !registeredModel ||
        !registeredModel.enabled ||
        !registeredModel.health.available
      ) {
        continue;
      }

      try {
        const startTime = Date.now();
        const output = await this.executeWithTimeout(registeredModel, {
          prompt: fullPrompt,
          systemPrompt,
          temperature: 0.8,
          maxTokens: 1024,
        });
        const latency = Date.now() - startTime;

        this.updateHealthStatus(registeredModel, true, latency);

        if (!output.text) {
          throw new Error('模型未返回内容');
        }

        return output.text;
      } catch (error) {
        lastError = error as Error;
        this.updateHealthStatus(
          registeredModel,
          false,
          0,
          (error as Error).message
        );
        Logger.warn(
          `⚠️ 模型 ${registeredModel.name} chat失败，尝试降级: ${(error as Error).message}`,
          'MultiModelLLMProvider'
        );
      }
    }

    throw new Error(`所有模型chat均失败: ${lastError?.message || '未知错误'}`);
  }

  public async analyzeCode(
    filePath: string,
    content: string,
    input: string
  ): Promise<string> {
    const prompt = `分析代码文件: ${filePath}\n\n代码内容:\n${content}\n\n用户查询: ${input}\n\n请分析代码并提供详细说明。`;
    return this.chat(prompt);
  }

  public async generateModifiedFileContent(
    filePath: string,
    content: string,
    instruction: string,
    fileExists: boolean = true
  ): Promise<string> {
    const existsHint = fileExists
      ? '请直接输出修改后的完整文件内容'
      : '文件不存在，请生成新的完整文件内容';
    const prompt = `文件: ${filePath}\n\n原始内容:\n${content}\n\n修改指令: ${instruction}\n\n${existsHint}，不要添加额外说明。`;
    return this.chat(prompt);
  }

  public async devGenerateCode(
    userRequest: string,
    filePath?: string,
    existingContent?: string
  ): Promise<string> {
    const systemPrompt = `你是一名专业的软件开发工程师助手。请根据用户需求生成高质量、规范、可运行的代码。

要求：
- 代码必须完整，包含所有必要的导入（import）和类型定义
- 使用现代最佳实践和语言最新特性
- 代码要规范、易读、有适当的注释
- 如果是修改现有文件，保持原有代码风格
- 如果是新文件，生成完整的文件内容
- 直接输出可用的代码，不要包含解释性文字
- 代码块不要用 markdown 代码块包裹`;

    const fileContext = filePath ? `\n目标文件路径：${filePath}` : '';
    const existingCodeContext = existingContent
      ? `\n\n当前文件内容：\n${existingContent}`
      : '\n（新文件，当前不存在）';

    const prompt = `用户需求：${userRequest}${fileContext}${existingCodeContext}\n\n请生成代码。`;

    const output = await this.generate(
      { prompt, systemPrompt, temperature: 0.3, maxTokens: 4096 },
      RoutingStrategy.CAPABILITY
    );

    if (!output.text) {
      throw new Error('模型未返回内容');
    }

    return output.text;
  }

  public getHealthStatus(): Record<string, ModelHealthStatus> {
    const status: Record<string, ModelHealthStatus> = {};
    this.models.forEach((model, id) => {
      status[id] = { ...model.health };
    });
    return status;
  }

  public async shutdown(): Promise<void> {
    this.cleanup();
    Logger.info('🛑 MultiModelLLMProvider 已关闭', 'MultiModelLLMProvider');
  }

  public async checkAllModelsHealth(): Promise<void> {
    await this.checkModelsHealth();
  }

  public getAvailableModels(): RegisteredModel[] {
    return Array.from(this.models.values()).filter(
      (m) => m.enabled && m.health.available
    );
  }

  private async executeWithTimeout(
    model: RegisteredModel,
    input: ModelInput
  ): Promise<ModelOutput> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`请求超时 (${this.config.requestTimeoutMs}ms)`));
      }, this.config.requestTimeoutMs);

      model.model
        .generate(input)
        .then((output) => {
          clearTimeout(timeout);
          resolve(output);
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  private updateHealthStatus(
    model: RegisteredModel,
    success: boolean,
    latency: number,
    error?: string
  ): void {
    if (success) {
      model.health.consecutiveFailures = 0;
      model.health.successRate = model.health.successRate * 0.9 + 0.1;
      if (latency > 0) {
        model.health.averageLatencyMs =
          model.health.averageLatencyMs * 0.9 + latency * 0.1;
      }
    } else {
      model.health.consecutiveFailures++;
      model.health.successRate = model.health.successRate * 0.9;
      model.health.lastError = error;

      if (
        model.health.consecutiveFailures >= this.config.maxConsecutiveFailures
      ) {
        model.health.available = false;
        Logger.warn(
          `🚫 模型 ${model.name} 连续失败 ${model.health.consecutiveFailures} 次，已标记为不可用`,
          'MultiModelLLMProvider'
        );
      }
    }

    model.health.lastCheckTime = Date.now();
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      void this.checkModelsHealth();
    }, this.config.healthCheckIntervalMs);
  }

  private async checkModelsHealth(): Promise<void> {
    for (const [, model] of this.models) {
      if (!model.enabled) continue;

      try {
        const startTime = Date.now();
        await model.model.generate({
          prompt: '你好',
          maxTokens: 5,
        });
        const latency = Date.now() - startTime;
        this.updateHealthStatus(model, true, latency);
      } catch (error) {
        this.updateHealthStatus(model, false, 0, (error as Error).message);
      }
    }
  }

  private cleanup(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    this.models.clear();
    this.initialized = false;
  }

  private async testSpeed(model: RegisteredModel): Promise<number> {
    try {
      const startTime = Date.now();
      await model.model.generate({
        prompt: 'Hello',
        maxTokens: 10,
      });
      const latency = Date.now() - startTime;
      return Math.max(0, Math.min(100, 100 - latency / 10));
    } catch {
      return 0;
    }
  }

  private async testCoding(model: RegisteredModel): Promise<number> {
    try {
      const output = await model.model.generate({
        prompt: 'Write a function to calculate factorial in Python',
        maxTokens: 100,
      });
      const hasCode =
        output.text.includes('def ') && output.text.includes('return');
      return hasCode ? 80 + Math.random() * 20 : 40 + Math.random() * 20;
    } catch {
      return 0;
    }
  }

  private async testReasoning(model: RegisteredModel): Promise<number> {
    try {
      const output = await model.model.generate({
        prompt:
          'If it takes 5 machines 5 minutes to make 5 widgets, how long does it take 100 machines to make 100 widgets?',
        maxTokens: 50,
      });
      const correct =
        output.text.includes('5 minutes') || output.text.includes('5分钟');
      return correct ? 90 + Math.random() * 10 : 50 + Math.random() * 20;
    } catch {
      return 0;
    }
  }

  private async testVision(model: RegisteredModel): Promise<number> {
    return model.capabilities.visionScore || 50;
  }
}
