/**
 * LLM Provider - 统一使用 OpenAI 兼容接口
 * 支持重试机制和健康检查，增强连接稳定性
 * v2: 支持多模型热切换和自动故障转移
 *
 * 迁移说明：LLM 核心（chat / chatWithTools / healthCheck / getModelName /
 * markLocalUnavailable / resetAvailability）已归属 Python agent/llm。
 * 当 AGENT_BACKEND=python（默认）且 PythonAgentBridge 可用时，上述方法
 * 经 bridgeRegistry 代理到 Python FastAPI (:3112) 的 /v1/llm/* 端点。
 * AGENT_BACKEND=local 降级时仍走 TS 本地实现。
 * 多模态 / 代码助手 / 多模型路由策略暂留 TS（第二批迁移）。
 */

import { getActivePythonBridge } from '../ide/bridgeRegistry';
import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { ChatProvider } from './ChatProvider';
import { CodeProvider } from './CodeProvider';
import { LLMResponseCache } from './LLMResponseCache';
import { MessageSanitizer } from './MessageSanitizer';
import { Model, ModelInput } from './ModelInterface';
import { MultimodalProvider } from './MultimodalProvider';
import { OpenAICompatibleModel } from './OpenAICompatibleModel';
import { getPromptTemplate } from './prompt-templates';
import { PromptOptimizer } from './PromptOptimizer';
import { PythonBackedModel } from './PythonBackedModel';
import { RequestQueue } from './RequestQueue';

/**
 * @deprecated LLM 核心（chat / chatWithTools / healthCheck / multimodal / code /
 * devGenerateCode / mark-unavailable / reset）已迁移 Python agent/llm，经
 * PythonAgentBridge 代理 /v1/llm/* 端点。此类保留为兼容桥接实现：bridge 优先，
 * bridge 为 null（AGENT_BACKEND=local）时回落本地 ChatProvider/CodeProvider/
 * MultimodalProvider。原路径 src/models/LLMProvider.ts 已改为 re-export 壳。
 */
export class LLMProviderBridge {
  private model: Model;
  private modelName: string;
  private maxRetries: number = 2;
  private baseRetryInterval: number = 1000;
  private serviceAvailable: boolean = false;

  private responseCache: LLMResponseCache;
  private requestQueue: RequestQueue;

  // v5.1 Task 7: 门面模式委托给子 Provider
  private chatProvider!: ChatProvider;
  private codeProvider!: CodeProvider;
  private multimodalProvider!: MultimodalProvider;

  private zhipuModel: OpenAICompatibleModel | null = null;

  private localUnavailable: boolean = false;
  private localUnavailableSince: number = 0;
  private static readonly RECOVERY_INTERVAL_MS = 5 * 60 * 1000; // 5分钟后自动恢复

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
    // v5.1: 优先使用 ProviderManager 配置
    const pmPrimary = (() => {
      try {
        const { getProviderManager } = require('./ProviderManager');
        const pm = getProviderManager();
        const pk = pm.getPrimary();
        return pk
          ? {
              key: pk.apiKey,
              base: pk.baseUrl,
              model: pk.model,
              name: pk.name,
              extra: pk.extra,
            }
          : null;
      } catch {
        return null;
      }
    })();

    if (model) {
      this.model = model;
      this.modelName = modelName || 'external';
      Logger.info('🔌 使用外部注入的模型实例', 'LLMProvider');
    } else if (getActivePythonBridge()) {
      // Python 后端模式（AGENT_BACKEND=python）：不实例化 TS 本地 LLM 客户端（§0.1 收口）。
      // 所有真实调用经 PythonAgentBridge 委派 Python agent.llm；此处仅放置占位模型满足 Model 契约。
      this.modelName = modelName || process.env.LLM_MODEL || 'python-backend';
      this.model = new PythonBackedModel(this.modelName);
      this.zhipuModel = null;
      this.serviceAvailable = true;
      Logger.info(
        '🐍 使用 Python 后端 LLM（桥接模式，TS 本地客户端已禁用）',
        'LLMProvider'
      );
    } else {
      // 优先使用 ProviderManager 主模型
      if (pmPrimary) {
        this.modelName = pmPrimary.model;
        Logger.info(
          `🔌 使用 ProviderManager 主模型: ${pmPrimary.name} (${pmPrimary.model})`,
          'LLMProvider'
        );
        this.model = new OpenAICompatibleModel({
          baseUrl: pmPrimary.base,
          apiKey: pmPrimary.key,
          modelName: pmPrimary.model,
          timeout: 90000,
          maxTokens: 8192,
          temperature: 0.7,
          topP: 0.9,
          thinkingMode: ((pmPrimary.extra?.thinkingMode as string) ||
            'disabled') as 'enabled' | 'disabled',
          reasoningEffort:
            (pmPrimary.extra?.reasoningEffort as 'high' | 'max') || undefined,
        });
      } else {
        this.modelName =
          modelName || process.env.LLM_MODEL || 'deepseek-v4-flash';
        Logger.info('🔌 使用 OpenAI 兼容模式', 'LLMProvider');
        this.model = new OpenAICompatibleModel({
          baseUrl:
            process.env.OPENAI_API_BASE ||
            process.env.LLM_BASE_URL ||
            'https://api.deepseek.com',
          apiKey:
            process.env.OPENAI_API_KEY ||
            process.env.LLM_API_KEY ||
            'not-needed',
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
    }

    this.responseCache = new LLMResponseCache();
    this.requestQueue = new RequestQueue(2);

    // v5.1 Task 7: 初始化三个子 Provider（门面模式）
    this.chatProvider = new ChatProvider(this.model, this.modelName);
    this.codeProvider = new CodeProvider(this.model, this.modelName);
    this.multimodalProvider = new MultimodalProvider(
      this.model,
      this.modelName
    );
  }

  /**
   * 根据输入复杂度选择合适的模型
   * 简单任务（问候/短查询）→ 主模型
   * 复杂任务（代码/分析）→ 主模型（能力最强）
   * 如果主模型不可用，降级到备用模型
   */
  selectModel(_input: string): Model {
    if (this.localUnavailable || !this.serviceAvailable) {
      // 自动恢复：如果已过恢复间隔，重置标志并重试主模型
      if (
        this.localUnavailable &&
        this.localUnavailableSince > 0 &&
        Date.now() - this.localUnavailableSince >
          LLMProviderBridge.RECOVERY_INTERVAL_MS
      ) {
        Logger.info('🔄 主模型恢复间隔已过，重新尝试使用主模型', 'LLMProvider');
        this.localUnavailable = false;
        this.localUnavailableSince = 0;
        return this.model;
      }

      if (this.zhipuModel) {
        Logger.info('🚀 主模型不可用，使用降级模型', 'LLMProvider');
        return this.zhipuModel;
      }
      // 没有降级模型时，仍然返回主模型让调用方处理（而非直接抛异常阻塞所有请求）
      Logger.warn(
        '⚠️ 主模型不可用且无降级模型，仍尝试使用主模型',
        'LLMProvider'
      );
      return this.model;
    }

    // 检查主模型熔断状态
    if (this.model && typeof this.model.isCircuitOpen === 'function') {
      if (this.model.isCircuitOpen!()) {
        Logger.warn('⚠️ 主模型熔断中，切换到降级模型', 'LLMProvider');
        if (this.zhipuModel) return this.zhipuModel;
      }
    }

    // 当前主模型可用，直接用
    return this.model;
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
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmHealthCheck();
    }

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
      this.localUnavailableSince = Date.now();
      return { available: false, message: 'LLM 服务响应异常' };
    } catch (error) {
      this.serviceAvailable = false;
      this.localUnavailable = true;
      this.localUnavailableSince = Date.now();
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

  async multimodalChat(
    message: string,
    images?: string[],
    history: Array<{ role: string; content: string }> = []
  ): Promise<string> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmMultimodalChat(message, images ?? [], history);
    }
    if (this.localUnavailable) {
      throw new Error('本地模型已标记不可用');
    }
    return this.multimodalProvider.multimodalChat(message, images, history);
  }

  async multimodalCodeAnalysis(
    userQuery: string,
    images: string[],
    filePath?: string
  ): Promise<string> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmMultimodalCodeAnalysis(userQuery, images, filePath);
    }
    return this.multimodalProvider.multimodalCodeAnalysis(
      userQuery,
      images,
      filePath
    );
  }

  async analyzeCode(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmCodeAnalyze(filePath, content, userQuery);
    }
    return this.codeProvider.analyzeCode(filePath, content, userQuery);
  }

  async generateModificationPlan(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmCodeModificationPlan(filePath, content, userQuery);
    }
    return this.codeProvider.generateModificationPlan(
      filePath,
      content,
      userQuery
    );
  }

  async generateModifiedFileContent(
    filePath: string,
    currentContent: string,
    userRequest: string,
    fileExists: boolean
  ): Promise<string> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmCodeModifiedContent(
        filePath,
        currentContent,
        userRequest,
        fileExists
      );
    }
    return this.codeProvider.generateModifiedFileContent(
      filePath,
      currentContent,
      userRequest,
      fileExists
    );
  }

  async chat(
    message: string,
    history: Array<{ role: string; content: string }> = [],
    systemPromptOverride?: string
  ): Promise<string> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmChat(message, history, systemPromptOverride);
    }

    // v5.1 Task 7: 委托给 ChatProvider，保留门面中的 zhipuModel 降级逻辑
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

    // 委托给 ChatProvider 执行主调用
    try {
      return await this.chatProvider.chat(
        message,
        history,
        systemPromptOverride
      );
    } catch (error) {
      Logger.warn(
        `⚠️ 主模型 LLM聊天失败: ${(error as Error).message}`,
        'LLMProvider'
      );

      this.localUnavailable = true;
      this.localUnavailableSince = Date.now();
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
   * v5.1 Task 7: 委托给 ChatProvider，保留门面中的 zhipuModel 降级逻辑
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
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmChatWithTools(messages, tools, maxTokens, toolChoice);
    }

    // 如果本地模型不可用，直接走智谱降级
    if ((this.localUnavailable || !this.serviceAvailable) && this.zhipuModel) {
      Logger.info(
        '🚀 chatWithTools 主模型不可用，直接降级到智谱模型',
        'LLMProvider'
      );
      try {
        const sanitizedMessages = this.sanitizeMessagesForAPI(messages);
        const response = await this.zhipuModel.generate({
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
      } catch (zhipuError) {
        Logger.error(
          `❌ 智谱降级也失败: ${(zhipuError as Error).message}`,
          zhipuError as Error,
          'LLMProvider'
        );
        throw zhipuError;
      }
    }

    // 委托给 ChatProvider 执行主调用
    try {
      return await this.chatProvider.chatWithTools(
        messages,
        tools,
        maxTokens,
        toolChoice
      );
    } catch (error) {
      Logger.warn(
        `⚠️ chatWithTools 主模型失败: ${(error as Error).message}`,
        'LLMProvider'
      );
      this.localUnavailable = true;
      this.localUnavailableSince = Date.now();

      // Zhipu/DeepSeek fallback
      if (this.zhipuModel) {
        Logger.info('🚀 chatWithTools 降级到智谱模型', 'LLMProvider');
        try {
          const sanitizedMessages = this.sanitizeMessagesForAPI(messages);
          const response = await this.zhipuModel.generate({
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
        } catch (zhipuError) {
          Logger.error(
            `❌ 智谱降级也失败: ${(zhipuError as Error).message}`,
            zhipuError as Error,
            'LLMProvider'
          );
        }
      }

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
   *
   * 已委托给 MessageSanitizer.sanitizeMessagesForAPI 统一实现。
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
    return MessageSanitizer.sanitizeMessages(messages);
  }

  /**
   * 开发副驾专用：专业代码生成（无人设，无"亲爱的主人"等强制称呼）
   * 使用专业开发者 system prompt，直接生成可执行代码
   * v5.1 Task 7: 委托给 CodeProvider
   */
  async devGenerateCode(
    userRequest: string,
    filePath?: string,
    existingContent?: string
  ): Promise<string> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return bridge.llmDevGenerateCode(userRequest, filePath, existingContent);
    }
    return this.codeProvider.devGenerateCode(
      userRequest,
      filePath,
      existingContent
    );
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
    const bridge = getActivePythonBridge();
    if (bridge) {
      return this.modelName || 'python-backend';
    }
    return this.modelName;
  }

  /** 永久标记本地模型不可用（供外部调用，如启动时健康检查失败） */
  markLocalUnavailable(reason?: string): void {
    const bridge = getActivePythonBridge();
    if (bridge) {
      bridge.llmMarkUnavailable(reason).catch((err: Error) => {
        Logger.warn(
          `Python markUnavailable 失败: ${err.message}`,
          'LLMProvider'
        );
      });
      this.localUnavailable = true;
      this.localUnavailableSince = Date.now();
      this.serviceAvailable = false;
      return;
    }
    this.localUnavailable = true;
    this.localUnavailableSince = Date.now();
    this.serviceAvailable = false;
    Logger.warn(
      `🚫 本地模型已标记不可用${reason ? `: ${reason}` : ''}`,
      'LLMProvider'
    );
  }

  /** 重置可用性标志（供外部调用，如用户手动切换回本地模型） */
  resetAvailability(): void {
    const bridge = getActivePythonBridge();
    if (bridge) {
      bridge.llmResetAvailability().catch((err: Error) => {
        Logger.warn(
          `Python resetAvailability 失败: ${err.message}`,
          'LLMProvider'
        );
      });
      this.localUnavailable = false;
      this.serviceAvailable = true;
      return;
    }
    this.localUnavailable = false;
    this.serviceAvailable = true;
    Logger.info('🔄 本地模型可用性已重置', 'LLMProvider');
  }
}
