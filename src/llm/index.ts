/**
 * LLM模块统一导出
 * 大模型适配架构核心组件
 */

export {
  PromptTemplateEngine,
  promptTemplateEngine,
} from './PromptTemplateEngine';
export type {
  PromptTemplate,
  TemplateVariable,
  TemplateSection,
  RenderContext,
  RenderedPrompt,
} from './PromptTemplateEngine';

export { TokenBudgetManager, tokenBudgetManager } from './TokenBudgetManager';
export type {
  TokenBudgetConfig,
  TokenAllocation,
  TokenUsage,
} from './TokenBudgetManager';

export {
  ModelCapabilityDetector,
  modelCapabilityDetector,
} from './ModelCapabilityDetector';
export type { ModelCapabilities } from './ModelCapabilityDetector';

export {
  StreamingResponseHandler,
  streamingResponseHandler,
} from './StreamingResponseHandler';
export type {
  StreamChunk,
  StreamOptions,
  StreamResult,
} from './StreamingResponseHandler';

import { Logger } from '../utils/Logger';
import { promptTemplateEngine } from './PromptTemplateEngine';
import { tokenBudgetManager } from './TokenBudgetManager';
import { modelCapabilityDetector } from './ModelCapabilityDetector';
import { streamingResponseHandler } from './StreamingResponseHandler';

export class LLMIntegration {
  private static instance: LLMIntegration | null = null;

  private constructor() {
    Logger.info('🚀 LLM集成模块初始化完成', 'LLMIntegration');
  }

  public static getInstance(): LLMIntegration {
    if (!LLMIntegration.instance) {
      LLMIntegration.instance = new LLMIntegration();
    }
    return LLMIntegration.instance;
  }

  public get templateEngine() {
    return promptTemplateEngine;
  }

  public get budgetManager() {
    return tokenBudgetManager;
  }

  public get capabilityDetector() {
    return modelCapabilityDetector;
  }

  public get streaming() {
    return streamingResponseHandler;
  }

  public preparePrompt(
    templateId: string,
    variables: Record<string, unknown>,
    memories?: Array<{ content: string; timestamp: string; relevance: number }>
  ) {
    const inputLength = JSON.stringify(variables).length;
    const allocation = this.budgetManager.allocate(inputLength);

    const truncatedMemories = memories
      ? this.budgetManager.truncateMemories(memories, allocation.memories)
      : [];

    const context: import('./PromptTemplateEngine').RenderContext = {
      variables,
      memories: truncatedMemories.map((m) => ({
        content: m.content,
        timestamp: new Date().toISOString(),
        relevance: m.relevance,
      })),
      maxTokens: allocation.userInput,
    };

    const rendered = this.templateEngine.render(templateId, context);

    return {
      prompt: rendered,
      allocation,
      memoriesUsed: truncatedMemories.length,
    };
  }

  public adaptForModel(modelId: string) {
    const capabilities = this.capabilityDetector.getCapabilities(modelId);

    return {
      useStreaming: capabilities.streaming,
      useFunctionCalling: capabilities.functionCalling,
      useVision: capabilities.vision,
      promptStyle: capabilities.preferredPromptStyle,
      maxTokens: capabilities.maxTokens,
      contextWindow: capabilities.contextWindow,
      supportsSystemPrompt: capabilities.supportsSystemPrompt,
      toolFormat: capabilities.functionCalling ? 'native' : 'react',
    };
  }
}

export const llmIntegration = LLMIntegration.getInstance();
