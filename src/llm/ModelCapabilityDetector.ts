/**
 * 模型能力探测器
 * 自动检测模型支持的功能和特性
 */

import { Logger } from '../utils/Logger';

export interface ModelCapabilities {
  id: string;
  name: string;
  provider: string;
  streaming: boolean;
  vision: boolean;
  functionCalling: boolean;
  maxTokens: number;
  supportedFormats: string[];
  preferredPromptStyle: 'chat' | 'completion' | 'instruct';
  contextWindow: number;
  supportsSystemPrompt: boolean;
  supportsMultiTurn: boolean;
  detectedAt: Date;
}

export interface ModelCapabilityDetectorConfig {
  cacheResults: boolean;
  cacheTTL: number;
  testTimeout: number;
}

const KNOWN_MODELS: Record<string, Partial<ModelCapabilities>> = {
  'gpt-4': {
    streaming: true,
    vision: false,
    functionCalling: true,
    maxTokens: 8192,
    contextWindow: 8192,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  'gpt-4-turbo': {
    streaming: true,
    vision: true,
    functionCalling: true,
    maxTokens: 4096,
    contextWindow: 128000,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  'gpt-3.5-turbo': {
    streaming: true,
    vision: false,
    functionCalling: true,
    maxTokens: 4096,
    contextWindow: 16385,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  'claude-3-opus': {
    streaming: true,
    vision: true,
    functionCalling: true,
    maxTokens: 4096,
    contextWindow: 200000,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  'claude-3-sonnet': {
    streaming: true,
    vision: true,
    functionCalling: true,
    maxTokens: 4096,
    contextWindow: 200000,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  qwen: {
    streaming: true,
    vision: false,
    functionCalling: false,
    maxTokens: 2048,
    contextWindow: 8192,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  'qwen2.5': {
    streaming: true,
    vision: false,
    functionCalling: false,
    maxTokens: 4096,
    contextWindow: 32768,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  llama: {
    streaming: true,
    vision: false,
    functionCalling: false,
    maxTokens: 2048,
    contextWindow: 4096,
    supportsSystemPrompt: false,
    supportsMultiTurn: true,
    preferredPromptStyle: 'completion',
  },
  mistral: {
    streaming: true,
    vision: false,
    functionCalling: true,
    maxTokens: 4096,
    contextWindow: 32768,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
  deepseek: {
    streaming: true,
    vision: false,
    functionCalling: true,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsSystemPrompt: true,
    supportsMultiTurn: true,
    preferredPromptStyle: 'chat',
  },
};

export class ModelCapabilityDetector {
  private capabilitiesCache: Map<string, ModelCapabilities> = new Map();
  private config: ModelCapabilityDetectorConfig;

  constructor(config: Partial<ModelCapabilityDetectorConfig> = {}) {
    this.config = {
      cacheResults: true,
      cacheTTL: 3600000,
      testTimeout: 10000,
      ...config,
    };

    this.initializeKnownModels();
    Logger.info(
      '🔍 ModelCapabilityDetector 初始化完成',
      'ModelCapabilityDetector'
    );
  }

  private initializeKnownModels(): void {
    for (const [modelId, capabilities] of Object.entries(KNOWN_MODELS)) {
      this.capabilitiesCache.set(modelId, {
        id: modelId,
        name: modelId,
        provider: this.detectProvider(modelId),
        streaming: capabilities.streaming ?? true,
        vision: capabilities.vision ?? false,
        functionCalling: capabilities.functionCalling ?? false,
        maxTokens: capabilities.maxTokens ?? 2048,
        supportedFormats: capabilities.vision ? ['text', 'image'] : ['text'],
        preferredPromptStyle: capabilities.preferredPromptStyle ?? 'chat',
        contextWindow: capabilities.contextWindow ?? 4096,
        supportsSystemPrompt: capabilities.supportsSystemPrompt ?? true,
        supportsMultiTurn: capabilities.supportsMultiTurn ?? true,
        detectedAt: new Date(),
      });
    }
  }

  private detectProvider(modelId: string): string {
    const lowerModelId = modelId.toLowerCase();

    if (lowerModelId.includes('gpt') || lowerModelId.includes('o1')) {
      return 'openai';
    }
    if (lowerModelId.includes('claude')) {
      return 'anthropic';
    }
    if (lowerModelId.includes('qwen') || lowerModelId.includes('通义')) {
      return 'alibaba';
    }
    if (lowerModelId.includes('llama')) {
      return 'meta';
    }
    if (lowerModelId.includes('mistral')) {
      return 'mistral';
    }
    if (lowerModelId.includes('gemini')) {
      return 'google';
    }
    if (lowerModelId.includes('deepseek')) {
      return 'deepseek';
    }
    if (lowerModelId.includes('yi')) {
      return '01ai';
    }

    return 'unknown';
  }

  public getCapabilities(modelId: string): ModelCapabilities {
    const normalizedId = this.normalizeModelId(modelId);

    if (this.capabilitiesCache.has(normalizedId)) {
      return this.capabilitiesCache.get(normalizedId)!;
    }

    const detected = this.detectCapabilities(normalizedId);
    this.capabilitiesCache.set(normalizedId, detected);

    return detected;
  }

  private normalizeModelId(modelId: string): string {
    const lower = modelId.toLowerCase();

    if (lower.includes('qwen2.5') || lower.includes('qwen-2.5')) {
      return 'qwen2.5';
    }
    if (lower.includes('qwen')) {
      return 'qwen';
    }
    if (
      lower.includes('gpt-4-turbo') ||
      lower.includes('gpt-4-1106') ||
      lower.includes('gpt-4-0125')
    ) {
      return 'gpt-4-turbo';
    }
    if (lower.includes('gpt-4')) {
      return 'gpt-4';
    }
    if (lower.includes('gpt-3.5')) {
      return 'gpt-3.5-turbo';
    }
    if (lower.includes('claude-3-opus')) {
      return 'claude-3-opus';
    }
    if (lower.includes('claude-3-sonnet')) {
      return 'claude-3-sonnet';
    }
    if (lower.includes('claude')) {
      return 'claude-3-sonnet';
    }
    if (lower.includes('llama')) {
      return 'llama';
    }
    if (lower.includes('mistral')) {
      return 'mistral';
    }

    return modelId;
  }

  private detectCapabilities(modelId: string): ModelCapabilities {
    const provider = this.detectProvider(modelId);

    const baseCapabilities: ModelCapabilities = {
      id: modelId,
      name: modelId,
      provider,
      streaming: true,
      vision: false,
      functionCalling: false,
      maxTokens: 2048,
      supportedFormats: ['text'],
      preferredPromptStyle: 'chat',
      contextWindow: 4096,
      supportsSystemPrompt: true,
      supportsMultiTurn: true,
      detectedAt: new Date(),
    };

    if (provider === 'openai') {
      baseCapabilities.functionCalling = true;
      baseCapabilities.streaming = true;
    } else if (provider === 'anthropic') {
      baseCapabilities.functionCalling = true;
      baseCapabilities.streaming = true;
      baseCapabilities.contextWindow = 200000;
    } else if (provider === 'alibaba') {
      baseCapabilities.streaming = true;
    } else if (provider === 'google') {
      baseCapabilities.vision = true;
      baseCapabilities.functionCalling = true;
      baseCapabilities.streaming = true;
    } else if (provider === 'deepseek') {
      baseCapabilities.functionCalling = true;
      baseCapabilities.streaming = true;
      baseCapabilities.maxTokens = 8192;
      baseCapabilities.contextWindow = 131072;
    }

    Logger.debug(
      `🔍 检测模型能力: ${modelId} -> ${JSON.stringify(baseCapabilities)}`,
      'ModelCapabilityDetector'
    );

    return baseCapabilities;
  }

  public async testStreaming(
    modelId: string,
    client: unknown
  ): Promise<boolean> {
    try {
      const capabilities = this.getCapabilities(modelId);
      return capabilities.streaming;
    } catch {
      return false;
    }
  }

  public async testFunctionCalling(
    modelId: string,
    client: unknown
  ): Promise<boolean> {
    try {
      const capabilities = this.getCapabilities(modelId);
      return capabilities.functionCalling;
    } catch {
      return false;
    }
  }

  public async testVision(modelId: string, client: unknown): Promise<boolean> {
    try {
      const capabilities = this.getCapabilities(modelId);
      return capabilities.vision;
    } catch {
      return false;
    }
  }

  public updateCapabilities(
    modelId: string,
    updates: Partial<ModelCapabilities>
  ): void {
    const existing = this.capabilitiesCache.get(modelId);
    if (existing) {
      this.capabilitiesCache.set(modelId, { ...existing, ...updates });
      Logger.debug(`🔄 更新模型能力: ${modelId}`, 'ModelCapabilityDetector');
    }
  }

  public listKnownModels(): string[] {
    return Array.from(this.capabilitiesCache.keys());
  }

  public clearCache(): void {
    this.capabilitiesCache.clear();
    this.initializeKnownModels();
    Logger.debug('🧹 模型能力缓存已清空', 'ModelCapabilityDetector');
  }
}

export const modelCapabilityDetector = new ModelCapabilityDetector();
