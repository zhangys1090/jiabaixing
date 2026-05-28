/**
 * 模型管理器 - MultiModelManager适配器
 * 统一使用 MultiModelManager 实现，保持向后兼容
 */

import { Logger } from '../utils/Logger';
import {
  Model,
  ModelInput,
  ModelManagerInterface,
  ModelOutput,
} from './ModelInterface';
import { OpenAICompatibleModel } from './OpenAICompatibleModel';

/** 模型配置（原 MultiModelManager 已删除，本地定义） */
interface ModelConfig {
  id?: string;
  name: string;
  displayName?: string;
  priority?: number;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  maxTokens?: number;
  temperature?: number;
  enabled?: boolean;
}

/** MultiModelManager 存根（原模块已删除） */
class MultiModelManager {
  private static instance: MultiModelManager;
  private currentModelName: string = 'default';
  static getInstance(): MultiModelManager {
    if (!MultiModelManager.instance) {
      MultiModelManager.instance = new MultiModelManager();
    }
    return MultiModelManager.instance;
  }
  private models: Map<string, ModelConfig> = new Map();
  async initializeAll(): Promise<void> {}
  getAvailableModels(): string[] {
    return [];
  }
  selectModel(_task: string): string {
    return 'default';
  }
  addModel(_config: ModelConfig): void {}
  removeModel(_id: string): void {}
  getModel(_id: string): ModelConfig | undefined {
    return undefined;
  }
  listModels(): ModelConfig[] {
    return [];
  }
  registerModel(_config: ModelConfig): void {}
  getCurrentModelName(): string {
    return this.currentModelName;
  }
}

export class ModelManager implements ModelManagerInterface {
  private models: Map<string, Model> = new Map();
  private initialized: boolean = false;
  private multiModelManager: MultiModelManager;

  constructor() {
    this.multiModelManager = MultiModelManager.getInstance();
  }

  public async initialize(): Promise<void> {
    try {
      await this.registerDefaultModels();
      await this.multiModelManager.initializeAll();
      this.initialized = true;
      Logger.info(
        '✅ 模型管理器初始化成功（使用MultiModelManager）',
        'ModelManager'
      );
    } catch (error) {
      Logger.error('❌ 模型管理器初始化失败:', error as Error, 'ModelManager');
      throw error;
    }
  }

  private async registerDefaultModels(): Promise<void> {
    const llmModel = process.env.LLM_MODEL || 'deepseek-chat';
    const baseUrl = process.env.OPENAI_API_BASE || 'http://127.0.0.1:8001/v1';
    const apiKey = process.env.OPENAI_API_KEY || 'not-needed';

    const defaultConfig: ModelConfig = {
      name: 'default',
      displayName: 'Default Model',
      priority: 1,
      baseUrl: baseUrl,
      apiKey: apiKey,
      modelName: llmModel,
      enabled: true,
    };

    this.multiModelManager.registerModel(defaultConfig);

    const openaiModel = new OpenAICompatibleModel({
      baseUrl: baseUrl,
      apiKey: apiKey,
      modelName: llmModel,
    });

    try {
      await openaiModel.initialize();
      this.models.set('openai_compatible', openaiModel);
      this.models.set('default', openaiModel);
      Logger.info('✅ OpenAI 兼容模型注册成功', 'ModelManager');
    } catch (error) {
      Logger.warn(
        `⚠️ 初始化 LLM.Server 模型失败: ${(error as Error).message}`,
        'ModelManager'
      );
      Logger.warn('⚠️ 没有可用的大模型，使用占位模型', 'ModelManager');
      const placeholder = new PlaceholderModel();
      this.models.set('placeholder', placeholder);
      this.models.set('default', placeholder);
    }
  }

  public registerModel(name: string, model: Model): void {
    this.models.set(name, model);
    Logger.info(`➕ 注册模型: ${name}`, 'ModelManager');
  }

  public getModel(name: string): Model | null {
    this.ensureInitialized();
    return this.models.get(name) || null;
  }

  public getDefaultModel(): Model | null {
    this.ensureInitialized();

    const currentModelName = this.multiModelManager.getCurrentModelName();
    if (currentModelName) {
      const model = this.models.get(currentModelName);
      if (model) return model;
    }

    return this.models.get('default') || null;
  }

  public listModels(): string[] {
    this.ensureInitialized();
    const multiModelNames = this.multiModelManager.getAvailableModels();
    const localNames = Array.from(this.models.keys());
    return [...new Set([...multiModelNames, ...localNames])];
  }

  public async generate(
    modelName: string,
    input: ModelInput
  ): Promise<ModelOutput> {
    this.ensureInitialized();

    const model = this.getModel(modelName);
    if (!model) {
      throw new Error(`模型 ${modelName} 不存在`);
    }

    return await model.generate(input);
  }

  public async shutdown(): Promise<void> {
    if (this.initialized) {
      Logger.info('🔌 关闭所有模型', 'ModelManager');
      for (const [name, model] of this.models.entries()) {
        try {
          await model.shutdown();
          Logger.info(`✅ 关闭模型: ${name}`, 'ModelManager');
        } catch (error) {
          Logger.error(
            `❌ 关闭模型 ${name} 失败:`,
            error as Error,
            'ModelManager'
          );
        }
      }
      this.models.clear();
      this.initialized = false;
      Logger.info('✅ 模型管理器关闭完成', 'ModelManager');
    }
  }

  public getMultiModelManager(): MultiModelManager {
    return this.multiModelManager;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('模型管理器未初始化！请先调用initialize方法。');
    }
  }
}

class PlaceholderModel implements Model {
  public async initialize(): Promise<void> {}

  public async generate(input: ModelInput): Promise<ModelOutput> {
    const promptText = input.prompt || '';
    return {
      text: `[占位模型] 收到提示：${promptText.substring(0, 50)}...`,
      error: '没有可用的大模型，请检查 OPENAI_API_BASE 配置',
    };
  }

  public async *stream(input: ModelInput): AsyncGenerator<string> {
    const promptText = input.prompt || '';
    yield '[占位模型] 收到提示：';
    yield promptText.substring(0, 50);
    yield '...';
    yield '\n[错误] 没有可用的大模型，请检查 OPENAI_API_BASE 配置';
  }

  public async getModelInfo(): Promise<Record<string, unknown>> {
    return {
      name: 'placeholder',
      details: '占位模型，当没有可用模型时使用',
    };
  }

  public async shutdown(): Promise<void> {}

  public getName(): string {
    return 'placeholder';
  }
}
