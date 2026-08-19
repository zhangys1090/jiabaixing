/**
 * 统一模型接口定义
 * 全系统唯一的模型接口标准定义
 * 整合了原有的 core 和 models 两套接口
 */

import { OpenAICompatibleModel } from '../models/OpenAICompatibleModel';
import { PythonBackedModel } from '../models/PythonBackedModel';
import { getActivePythonBridge } from '../ide/bridgeRegistry';
import { Logger } from '../utils/Logger';

/**
 * 模型配置接口
 */
export interface ModelConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  timeout: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

/**
 * 模型输入接口（支持多模态 + Function Calling）
 */
export interface ModelInput {
  prompt?: string;
  text?: string;
  images?: string[];
  audio?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  stream?: boolean;
  /** OpenAI Function Calling 工具定义 */
  tools?: Array<Record<string, unknown>>;
  /** OpenAI Function Calling tool_choice 参数 */
  toolChoice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } };
  /** 直接传入消息数组（用于 Function Calling 循环，替代 prompt 构造） */
  messages?: Array<{
    role: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
    tool_call_id?: string;
    name?: string;
  }>;
}

/**
 * 模型输出接口
 */
export interface ModelOutput {
  text: string;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
  error?: string;
  timestamp?: number;
  modelName?: string;
  confidence?: number;
  /** 是否为降级回复 */
  isFallback?: boolean;
  /** OpenAI Function Calling 返回的工具调用 */
  toolCalls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  /** 模型响应元数据（如推理内容等） */
  metadata?: Record<string, unknown>;
}

/**
 * 模型状态接口
 */
export interface ModelStatus {
  modelName: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  version?: string;
  capabilities: string[];
  performance: {
    averageResponseTime: number;
    requestCount: number;
    errorCount: number;
    successRate: number;
  };
}

/**
 * 认证信息接口
 */
export interface AuthConfig {
  type: 'api_key' | 'oauth' | 'none';
  apiKey?: string;
  oauthToken?: string;
  endpoint?: string;
}

/**
 * 模型接口（标准接口定义）
 */
export interface Model {
  initialize(): Promise<void>;
  generate(input: ModelInput): Promise<ModelOutput>;
  stream(input: ModelInput): AsyncGenerator<string>;
  getModelInfo(): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
  getName(): string;
  isCircuitOpen?(): boolean;
}

/**
 * 模型管理器接口
 */
export interface ModelManagerInterface {
  registerModel(name: string, model: Model): void;
  getModel(name: string): Model | null;
  listModels(): string[];
  generate(modelName: string, input: ModelInput): Promise<ModelOutput>;
  shutdown(): Promise<void>;
}

/**
 * 模型抽象基类（提供通用功能实现）
 */
export abstract class AbstractModel implements Model {
  protected modelName: string;
  protected authConfig: AuthConfig;
  protected performanceMetrics: {
    responseTimes: number[];
    requestCount: number;
    errorCount: number;
  };

  constructor(modelName: string, authConfig: AuthConfig = { type: 'none' }) {
    this.modelName = modelName;
    this.authConfig = authConfig;
    this.performanceMetrics = {
      responseTimes: [],
      requestCount: 0,
      errorCount: 0,
    };
  }

  public async generate(input: ModelInput): Promise<ModelOutput> {
    const startTime = Date.now();
    this.performanceMetrics.requestCount++;

    try {
      const output = await this._generate(input);
      const endTime = Date.now();
      const responseTime = (endTime - startTime) / 1000;
      this.performanceMetrics.responseTimes.push(responseTime);

      if (this.performanceMetrics.responseTimes.length > 100) {
        this.performanceMetrics.responseTimes.shift();
      }

      return output;
    } catch (error) {
      this.performanceMetrics.errorCount++;
      Logger.error(`模型生成失败: ${error}`);
      throw error;
    }
  }

  public getName(): string {
    return this.modelName;
  }

  protected abstract _generate(input: ModelInput): Promise<ModelOutput>;

  public abstract initialize(): Promise<void>;
  public abstract stream(input: ModelInput): AsyncGenerator<string>;
  public abstract getModelInfo(): Promise<Record<string, unknown>>;
  public abstract shutdown(): Promise<void>;

  public getPerformanceMetrics(): {
    averageResponseTime: number;
    requestCount: number;
    errorCount: number;
    successRate: number;
  } {
    const avgResponseTime =
      this.performanceMetrics.responseTimes.length > 0
        ? this.performanceMetrics.responseTimes.reduce(
            (sum, time) => sum + time,
            0
          ) / this.performanceMetrics.responseTimes.length
        : 0;

    const successRate =
      this.performanceMetrics.requestCount > 0
        ? (this.performanceMetrics.requestCount -
            this.performanceMetrics.errorCount) /
          this.performanceMetrics.requestCount
        : 0;

    return {
      averageResponseTime: avgResponseTime,
      requestCount: this.performanceMetrics.requestCount,
      errorCount: this.performanceMetrics.errorCount,
      successRate,
    };
  }

  public getModelName(): string {
    return this.modelName;
  }

  public abstract isReady(): Promise<boolean>;
}

/**
 * 模型工厂类
 */
export class ModelFactory {
  public static createModel(
    modelType: string,
    config: {
      modelName: string;
      baseUrl?: string;
      apiKey?: string;
      apiEndpoint?: string;
    }
  ): Model {
    switch (modelType) {
      case 'openai':
      case 'openai_compatible': {
        // P2-3 C: AGENT_BACKEND=python 模式下桥壳化 — 经 PythonAgentBridge 委派，
        // 不再实例化 TS 本地 LLM 客户端（OpenAICompatibleModel）。
        if (getActivePythonBridge()) {
          return new PythonBackedModel(config.modelName);
        }
        return new OpenAICompatibleModel(config);
      }
      default:
        throw new Error(`未知模型类型: ${modelType}`);
    }
  }
}

/**
 * 模型管理器实现已迁移至 src/models/ModelManager.ts
 * 此处仅保留接口和抽象类定义
 */
