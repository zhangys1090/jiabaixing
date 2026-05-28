import type { ChatMessage } from './types';
import type { HarnessToolDeps } from './tools/registerHarnessTools';
import type { PersistenceServiceDeps } from './persistence/PersistenceService';
import type { OrchestratorAgent } from './orchestration/OrchestratorAgent';

export interface LLMProviderDeps {
  chatWithTools(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>
  ): Promise<{
    content: string | null;
    toolCalls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }>;
  chat(prompt: string, systemPrompt?: string): Promise<string>;
}

export interface ConstitutionalBuilderDeps {
  buildConstitutionPrompt(userId?: string): Promise<string>;
}

export interface MemoryInjectorDeps {
  autoRetrieveMemories(input: string, userId?: string): Promise<string[]>;
}

export interface MemoryStoreDeps {
  storeConversation(
    input: string,
    response: string,
    metadata: Record<string, unknown>
  ): Promise<void>;
}

export interface DynamicContextDeps {
  getDynamicContext(): string;
}

export interface HistoryProviderDeps {
  getRecentHistory(limit: number): ChatMessage[];
  getAllHistory(): ChatMessage[];
}

export interface SkillRegistryDeps {
  registerInfrastructureTool(tool: {
    name: string;
    description: string;
    parameters: Array<{
      name: string;
      type: string;
      required: boolean;
      description: string;
    }>;
    execute: (
      args: Record<string, unknown>,
      context?: unknown
    ) => Promise<{
      success: boolean;
      output: unknown;
      error?: string;
      metadata?: Record<string, unknown>;
    }>;
  }): void;
}

export interface EvolutionEngineDeps {
  collectFeedback(
    input: string,
    response: string,
    result: {
      success: boolean;
      intent?: string;
      toolsUsed?: string[];
      error?: string;
    },
    scene?: string
  ): void;
  assessQuality(
    traceId: string,
    success: boolean,
    qualityScore: number,
    duration: number
  ): void;
}

export interface PersonaCoreDeps {
  buildPersonaSummary(): string;
  buildSceneToneInstruction(scene: string): string;
  getToneForScene(scene: string): {
    temperature: number;
    formality: number;
    verbosity: number;
    emojiFrequency: number;
    proactive: boolean;
  };
}

export interface EvolutionExamplesDeps {
  getPromptExamples(): Array<{
    trigger: string;
    correction: string;
    example: string;
    frequency: number;
  }>;
}

export interface HarnessDeps {
  llm: LLMProviderDeps;
  constitutionalBuilder: ConstitutionalBuilderDeps;
  memoryInjector: MemoryInjectorDeps;
  memoryStore?: MemoryStoreDeps;
  dynamicContext: DynamicContextDeps;
  historyProvider: HistoryProviderDeps;
  toolDeps?: HarnessToolDeps;
  skillRegistry?: SkillRegistryDeps;
  persistenceDeps?: PersistenceServiceDeps;
  evolutionEngine?: EvolutionEngineDeps;
  personaCore?: PersonaCoreDeps;
  evolutionExamples?: EvolutionExamplesDeps;
  orchestratorAgent?: OrchestratorAgent;
}
