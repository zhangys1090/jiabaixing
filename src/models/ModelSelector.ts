import { ModelInput } from '../core/ModelInterface';
import {
  RegisteredModel,
  RoutingResult,
  RoutingStrategy,
} from './types';

export class ModelSelector {
  private static instance: ModelSelector | null = null;
  private roundRobinIndex: number = 0;

  private constructor() {}

  public static getInstance(): ModelSelector {
    if (!ModelSelector.instance) {
      ModelSelector.instance = new ModelSelector();
    }
    return ModelSelector.instance;
  }

  public static reset(): void {
    ModelSelector.instance = null;
  }

  public route(
    availableModels: RegisteredModel[],
    input: ModelInput,
    strategy: RoutingStrategy
  ): RoutingResult {
    if (availableModels.length === 0) {
      throw new Error('没有可用的模型');
    }

    let selectedModel: RegisteredModel;
    let reason: string;

    switch (strategy) {
      case RoutingStrategy.PRIORITY:
        selectedModel = this.routeByPriority(availableModels);
        reason = '优先级最高';
        break;
      case RoutingStrategy.CAPABILITY:
        selectedModel = this.routeByCapability(availableModels, input);
        reason = '能力最匹配';
        break;
      case RoutingStrategy.LATENCY:
        selectedModel = this.routeByLatency(availableModels);
        reason = '延迟最低';
        break;
      case RoutingStrategy.ROUND_ROBIN:
        selectedModel = this.routeByRoundRobin(availableModels);
        reason = '轮询';
        break;
      case RoutingStrategy.RANDOM:
        selectedModel = this.routeByRandom(availableModels);
        reason = '随机';
        break;
      default:
        selectedModel = this.routeByPriority(availableModels);
        reason = '默认优先级';
    }

    const fallbackChain = availableModels
      .filter((m) => m.id !== selectedModel.id)
      .sort((a, b) => a.priority - b.priority)
      .map((m) => m.id);

    return {
      modelId: selectedModel.id,
      modelName: selectedModel.name,
      reason,
      fallbackChain,
    };
  }

  public routeByPriority(models: RegisteredModel[]): RegisteredModel {
    return [...models].sort((a, b) => a.priority - b.priority)[0];
  }

  public routeByCapability(
    models: RegisteredModel[],
    input: ModelInput
  ): RegisteredModel {
    let bestModel = models[0];
    let bestScore = 0;

    for (const model of models) {
      let score = 0;

      if (input.images && input.images.length > 0) {
        score += model.capabilities.visionScore * 2;
      }

      if (input.prompt && this.isCodingPrompt(input.prompt)) {
        score += model.capabilities.codingScore * 2;
      }

      score += model.capabilities.reasoningScore;
      score += model.capabilities.speedScore;

      if (score > bestScore) {
        bestScore = score;
        bestModel = model;
      }
    }

    return bestModel;
  }

  public routeByLatency(models: RegisteredModel[]): RegisteredModel {
    return [...models].sort(
      (a, b) => a.health.averageLatencyMs - b.health.averageLatencyMs
    )[0];
  }

  public routeByRoundRobin(models: RegisteredModel[]): RegisteredModel {
    const model = models[this.roundRobinIndex % models.length];
    this.roundRobinIndex++;
    return model;
  }

  public routeByRandom(models: RegisteredModel[]): RegisteredModel {
    return models[Math.floor(Math.random() * models.length)];
  }

  public isCodingPrompt(prompt: string): boolean {
    const codingKeywords = [
      'code',
      '编程',
      '程序',
      '函数',
      'class',
      'import',
      'def ',
      'const ',
      'let ',
      'var ',
      'function ',
      '代码',
      'bug',
      'debug',
      'error',
      'exception',
    ];
    return codingKeywords.some((keyword) =>
      prompt.toLowerCase().includes(keyword.toLowerCase())
    );
  }
}
