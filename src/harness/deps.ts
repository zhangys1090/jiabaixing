import type { RoutingResult, RoutingStrategy } from '../models/types';
import type { OrchestratorAgent } from './orchestration/OrchestratorAgent';
import type { PersistenceServiceDeps } from './persistence/PersistenceService';
import type { HarnessToolDeps } from './tools/registerHarnessTools';
import type { ChatMessage } from './types';
import type { OutputGuardrailEngine } from './verification/OutputGuardrailEngine';

export interface LLMProviderDeps {
  chatWithTools(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    maxTokens?: number,
    toolChoice?: string
  ): Promise<{
    content: string | null;
    toolCalls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }>;
  chat(prompt: string, systemPrompt?: string): Promise<string>;
  /** 设置 ModelRouter 路由的首选模型 */
  setPreferredModel?(modelName: string): void;
}

export interface ModelRouterDeps {
  route(
    input: { prompt?: string; images?: string[] },
    strategy?: RoutingStrategy
  ): RoutingResult;
  getAvailableModels(): Array<{ id: string; name: string; priority: number }>;
  getModelHealth(modelId: string): {
    available: boolean;
    averageLatencyMs: number;
    successRate: number;
  } | null;
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
  generateSkill(params: {
    input: string;
    response: string;
    toolsUsed: string[];
    totalDuration: number;
    qualityScore: number;
    traceId: string;
  }): string | null;
  nudgeKnowledgePersistence(input: string, toolsUsed: string[]): string | null;
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

export interface EvolutionToolWeightsDeps {
  getToolWeights(): Record<string, number>;
}

export interface EnvironmentSensorDeps {
  getEnvironmentContext(): string;
}

export interface ContextReferenceResolverDeps {
  resolve(input: string): Promise<{
    hasReferences: boolean;
    resolvedContent: string;
    references: Array<{
      type: string;
      target: string;
      content: string;
      error?: string;
      charCount: number;
    }>;
    cleanedInput: string;
  }>;
}

/** FeedbackLoops 依赖 — 反馈收集器接口 */
export interface FeedbackCollectorDeps {
  analyzeUserInput(
    currentInput: string,
    previousResponse: string,
    userId?: string,
    scene?: string
  ): {
    type: string;
    input?: string;
    response?: string;
    [key: string]: unknown;
  } | null;
  recordToolFailure(
    toolName: string,
    errorMessage: string,
    input: string,
    userId?: string
  ): void;
  recordLowQuality(
    input: string,
    response: string,
    qualityScore: number,
    userId?: string,
    scene?: string
  ): void;
}

/** FeedbackLoops 依赖 — 记忆助手接口 */
export interface MemoryAssistantDeps {
  autoExtractKnowledge(
    input: string,
    response: string,
    userId?: string
  ): Promise<void>;
}

export interface RequiredHarnessDeps {
  llm: LLMProviderDeps;
  constitutionalBuilder: ConstitutionalBuilderDeps;
  memoryInjector: MemoryInjectorDeps;
  dynamicContext: DynamicContextDeps;
  historyProvider: HistoryProviderDeps;
}

export interface OptionalHarnessDeps {
  modelRouter?: ModelRouterDeps;
  memoryStore?: MemoryStoreDeps;
  toolDeps?: HarnessToolDeps;
  skillRegistry?: SkillRegistryDeps;
  persistenceDeps?: PersistenceServiceDeps;
  evolutionEngine?: EvolutionEngineDeps;
  personaCore?: PersonaCoreDeps;
  evolutionExamples?: EvolutionExamplesDeps;
  evolutionToolWeights?: EvolutionToolWeightsDeps;
  /** 知识图谱注入器 — 提供关联实体和推理链，增强 Planner 规划能力 */
  knowledgeInjector?: {
    getRelatedEntities(
      input: string
    ): Promise<Array<{ name: string; type: string; relations: string[] }>>;
    getInferenceChain(input: string): Promise<string[]>;
    identifyGaps(): Array<{
      entity: string;
      gapType: string;
      suggestedQuery: string;
      priority: number;
    }>;
  };
  /** P2.2: 知识图谱提取器 — 从工具结果/对话中提取实体和关系，激活知识图谱 */
  knowledgeExtractor?: {
    extractAndStore(text: string, source: string): Promise<void>;
  };
  environmentSensor?: EnvironmentSensorDeps;
  contextReferenceResolver?: ContextReferenceResolverDeps;
  orchestratorAgent?: OrchestratorAgent;
  outputGuardrails?: OutputGuardrailEngine;
  auxiliaryRouter?: {
    resolve(task: string): {
      model: string;
      baseUrl: string;
      apiKey: string;
      providerName: string;
    };
  };
  memoryRefresher?: {
    refreshFrozenSnapshot(): void;
  };
  reflectionEngine?: ReflectionEngineDeps;
  /** 事件总线 — 用于学习信号等事件的发布/订阅 */
  eventBus?: {
    on(event: string, handler: (payload: unknown) => void): void;
    emit(event: string, payload: unknown): void;
  };
  /** FeedbackLoops 闭环服务依赖 — 反馈收集器 */
  feedbackCollector?: FeedbackCollectorDeps;
  /** FeedbackLoops 闭环服务依赖 — 记忆助手（自动知识提取） */
  memoryAssistant?: MemoryAssistantDeps;
  /** P2: CausalModeler — 已迁移到 Python agent/loop/causal.py */
  causalModeler?: never;
  /** P1: EvaluationPipeline — 多阶段评估流水线 */
  evaluationPipeline?: {
    run(context: unknown): Promise<unknown>;
    addStage?(stage: unknown): void;
  };
  /** P3: TrajectoryFlywheel — 轨迹飞轮引擎，分析执行模式并生成优化建议 */
  trajectoryFlywheel?: {
    analyze(
      executionId?: string
    ): import('./persistence/TrajectoryFlywheel').TrajectoryAnalysis;
  };
  /** 工作区根 URI — 用于 LSP 集成层配置工作区 */
  workspaceRootUri?: string;
}

export interface HarnessDeps extends RequiredHarnessDeps, OptionalHarnessDeps {}

const REQUIRED_DEPS_KEYS: ReadonlyArray<keyof RequiredHarnessDeps> = [
  'llm',
  'constitutionalBuilder',
  'memoryInjector',
  'dynamicContext',
  'historyProvider',
] as const;

export function validateHarnessDeps(deps: Partial<HarnessDeps>): { valid: boolean; missing: string[] } {
  const missing = REQUIRED_DEPS_KEYS.filter(key => deps[key] === undefined || deps[key] === null);
  return { valid: missing.length === 0, missing: missing as string[] };
}

export interface ReflectionEngineDeps {
  reflect(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    context: { traceId: string; loopCount: number }
  ): Promise<{
    rootCause: string;
    correctedArgs: Record<string, unknown> | null;
    alternativeTool: string | null;
    shouldRetry: boolean;
  }>;
  deepReflect(
    userInput: string,
    trajectory: Array<{
      toolName: string;
      success: boolean;
      error?: string;
      output?: string;
    }>,
    evalResult: {
      goalProgress: number;
      suggestedAction: string;
      reason: string;
    }
  ): Promise<{
    diagnosis: string;
    rootCause: string;
    fixStrategy: string;
    correctedPlan?: Array<{
      stepDescription: string;
      toolName?: string;
      args?: Record<string, unknown>;
    }>;
  }>;
  recordExperience(entry: {
    toolName: string;
    args: Record<string, unknown>;
    error: string;
    rootCause: string;
    resolution: string;
    success: boolean;
  }): void;
  getRelevantExperiences(
    toolName: string,
    error?: string,
    limit?: number
  ): Array<{
    toolName: string;
    error: string;
    rootCause: string;
    resolution: string;
    success: boolean;
  }>;
  /** P4-3: 获取任务级反思经验（供 Planner 注入） */
  getTaskReflectionExperiences?(): Array<{
    userInput: string;
    taskGoal: string;
    taskDiagnosis: string;
    rootCause: string;
    strategyAdjustment: string;
    lessonsLearned: string;
    confidence: number;
    success: boolean;
    timestamp: number;
  }>;
}
