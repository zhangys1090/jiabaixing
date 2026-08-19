/**
 * Harness Layer Interfaces — 各层标准化接口
 *
 * Phase 2: 配置驱动组合的核心契约
 * 每个层有明确的 Interface，实现可插拔替换。
 * harness.config.yaml 声明各层使用哪个实现，运行时由 HarnessComposer 组装。
 */

// ============ Layer 1: 工具层 ============

export interface IToolLayer {
  readonly layerName: 'tools';
  initialize(deps: IToolLayerDeps): Promise<void>;
  getRegistry(): IToolRegistry;
  shutdown(): Promise<void>;
}

export interface IToolLayerDeps {
  eventBus?: IEventBusPort;
  permissionGuard?: IPermissionGuardPort;
  schemaValidator?: ISchemaValidatorPort;
}

export interface IToolRegistry {
  register(definition: IToolDefinitionPort, executor: IToolExecutorPort): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
  get(name: string): IToolEntryPort | null;
  list(): IToolDefinitionPort[];
  call(name: string, params: Record<string, unknown>, context?: unknown): Promise<IToolResultPort>;
}

export interface IToolDefinitionPort {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, IParamDefPort>;
  requiredParams: string[];
  requiredPermissions: string[];
  riskLevel: string;
  idempotent: boolean;
  timeout: number;
  tags: string[];
}

export interface IParamDefPort {
  type: string;
  description: string;
  default?: unknown;
}

export interface IToolExecutorPort {
  (params: Record<string, unknown>, context?: IToolContextPort): Promise<IToolResultPort>;
}

export interface IToolContextPort {
  sessionId?: string;
  traceId?: string;
  userId?: string;
  agentId?: string;
}

export interface IToolResultPort {
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
  validated?: boolean;
}

export interface IToolEntryPort {
  definition: IToolDefinitionPort;
  executor: IToolExecutorPort;
}

export interface IPermissionGuardPort {
  check(permission: string, context?: Record<string, unknown>): boolean;
}

export interface ISchemaValidatorPort {
  validate(schema: Record<string, unknown>, data: unknown): { valid: boolean; errors?: string[] };
}

// ============ Layer 2: 上下文层 ============

export interface IContextLayer {
  readonly layerName: 'context';
  initialize(deps: IContextLayerDeps): Promise<void>;
  buildContext(input: IContextInputPort): Promise<IContextOutputPort>;
  shutdown(): Promise<void>;
}

export interface IContextLayerDeps {
  memoryEngine?: IMemoryEnginePort;
  historyProvider?: IHistoryProviderPort;
  personaCore?: IPersonaCorePort;
  eventBus?: IEventBusPort;
}

export interface IContextInputPort {
  text: string;
  userId?: string;
  traceId?: string;
  scene?: string;
  metadata?: Record<string, unknown>;
}

export interface IContextOutputPort {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export interface IMemoryEnginePort {
  retrieveContext(input: string, userId?: string): Promise<{
    memories: Array<{ type: string; relevance: number; content: string }>;
    preferences: Record<string, string[]>;
  }>;
  storeMemory(content: string, options?: Record<string, unknown>): Promise<string>;
}

export interface IHistoryProviderPort {
  getRecentHistory(limit: number): Array<{ role: string; content: string }>;
  getAllHistory(): Array<{ role: string; content: string }>;
}

export interface IPersonaCorePort {
  getPersonaSettings(): {
    tone: string;
    formality: number;
    verbosity: number;
    emojiFrequency: number;
    proactive: boolean;
  };
}

// ============ Layer 3: 持久化层 ============

export interface IPersistenceLayer {
  readonly layerName: 'persistence';
  initialize(deps: IPersistenceLayerDeps): Promise<void>;
  getEventStore(): IEventStorePort | null;
  getSessionReplay(): ISessionReplayPort | null;
  shutdown(): Promise<void>;
}

export interface IPersistenceLayerDeps {
  eventBus?: IEventBusPort;
  dataDir?: string;
}

export interface IEventStorePort {
  append(event: Omit<IEventStoreEventPort, 'sequenceNum' | 'timestamp'>): IEventStoreEventPort;
  query(query: IEventQueryPort): IEventStoreEventPort[];
  project<T>(sessionId: string, reducer: (state: T, event: IEventStoreEventPort) => T, initialState: T): { state: T; lastSequenceNum: number; eventCount: number };
  getEventCount(sessionId?: string): number;
  deleteSession(sessionId: string): boolean;
  initialize(): void;
  destroy(): void;
}

export interface IEventStoreEventPort {
  eventId: string;
  sessionId: string;
  sequenceNum: number;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export interface IEventQueryPort {
  sessionId?: string;
  eventTypes?: string[];
  fromSequence?: number;
  toSequence?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  offset?: number;
}

export interface ISessionReplayPort {
  replaySession(sessionId: string, options?: Record<string, unknown>): unknown;
  diff(sessionId: string, seqA: number, seqB: number): unknown;
  exportTrajectory(sessionId: string, options: Record<string, unknown>): string[];
  getSessionSummary(sessionId: string): unknown;
}

// ============ Layer 4: 验证层 ============

export interface IVerificationLayer {
  readonly layerName: 'verification';
  initialize(deps: IVerificationLayerDeps): Promise<void>;
  verify(input: string, output: string, context?: Record<string, unknown>): Promise<IVerificationResultPort>;
  shutdown(): Promise<void>;
}

export interface IVerificationLayerDeps {
  llm?: ILLMPort;
  eventBus?: IEventBusPort;
}

export interface IVerificationResultPort {
  passed: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
}

// ============ Layer 5: 约束层 ============

export interface IConstraintsLayer {
  readonly layerName: 'constraints';
  initialize(deps: IConstraintsLayerDeps): Promise<void>;
  checkConstraints(input: string, context?: Record<string, unknown>): IConstraintsResultPort;
  shutdown(): Promise<void>;
}

export interface IConstraintsLayerDeps {
  eventBus?: IEventBusPort;
  config?: Record<string, unknown>;
}

export interface IConstraintsResultPort {
  allowed: boolean;
  violations: string[];
  warnings: string[];
}

// ============ Layer 6: 循环层 ============

export interface ILoopLayer {
  readonly layerName: 'loop';
  initialize(deps: ILoopLayerDeps): Promise<void>;
  run(input: ILoopInputPort): Promise<ILoopResultPort>;
  shutdown(): Promise<void>;
}

export interface ILoopLayerDeps {
  toolRegistry?: IToolRegistry;
  contextLayer?: IContextLayer;
  verificationLayer?: IVerificationLayer;
  constraintsLayer?: IConstraintsLayer;
  persistenceLayer?: IPersistenceLayer;
  llm?: ILLMPort;
  eventBus?: IEventBusPort;
}

export interface ILoopInputPort {
  text: string;
  userId?: string;
  traceId?: string;
  images?: Array<{ url: string; mimeType?: string }>;
  metadata?: Record<string, unknown>;
}

export interface ILoopResultPort {
  response: string;
  success: boolean;
  traceId: string;
  state: string;
  toolCalls: Array<{ name: string; success: boolean; duration: number }>;
  totalDuration: number;
  metadata: Record<string, unknown>;
}

// ============ 共享端口 ============

export interface IEventBusPort {
  emit(eventName: string, ...args: unknown[]): boolean;
  on(eventName: string, listener: (...args: unknown[]) => void): unknown;
  off(eventName: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ILLMPort {
  chat(prompt: string, systemPrompt?: string): Promise<string>;
  chatWithTools(
    messages: Array<{ role: string; content: string }>,
    tools: Array<Record<string, unknown>>,
    maxTokens?: number
  ): Promise<{
    content: string | null;
    toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  }>;
}

// ============ 层注册表 ============

export type LayerName = 'tools' | 'context' | 'persistence' | 'verification' | 'constraints' | 'loop';

export interface ILayerRegistry {
  registerLayer(name: LayerName, layer: ILayerPort): void;
  getLayer<T extends ILayerPort>(name: LayerName): T | null;
  listLayers(): Array<{ name: LayerName; layer: ILayerPort }>;
  shutdownAll(): Promise<void>;
}

export interface ILayerPort {
  readonly layerName: LayerName;
  initialize(deps: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;
}
