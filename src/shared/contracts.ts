/**
 * 前后端共享契约层
 *
 * 本文件是前后端唯一的"真相来源"(Single Source of Truth)。
 * 所有 API 端点、WebSocket 事件、请求/响应数据模型均在此定义。
 * 后端路由和前端 API 服务层必须引用此文件，禁止硬编码。
 */

// ====================== 通用类型 ======================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  traceId?: string;
}

// ====================== API 端点契约 ======================

export const API_ENDPOINTS = {
  HEALTH: '/api/health',
  MODELS: '/api/models',
  MODELS_STATUS: '/api/models/status',
  MODELS_HEALTH: '/api/models/health',
  MODELS_SWITCH: '/api/models/switch',
  PROCESS: '/api/process',
  CORRECT: '/api/correct',
  LOGS_SSE: '/api/logs',
  LOGS_QUERY: '/api/logs',
  LOGS_ERRORS: '/api/logs/errors',

  EVOLUTION: '/api/evolution',
  EVOLUTION_STATUS: '/api/evolution/status',
  EVOLUTION_METRICS: '/api/evolution/metrics',
  EVOLUTION_INSIGHTS: '/api/evolution/insights',
  EVOLUTION_TRIGGER: '/api/evolution/trigger',
  EVOLUTION_CYCLE: '/api/evolution/cycle',
  EVOLUTION_HEALING: '/api/evolution/healing',
  EVOLUTION_REFACTOR: '/api/evolution/refactor',
  EVOLUTION_ENHANCE: '/api/evolution/enhance',
  ORCHESTRATOR_METRICS: '/api/orchestrator/metrics',
  ORCHESTRATOR_OPTIMIZE: '/api/orchestrator/optimize',

  MEMORY_STORE: '/api/memory/store',
  MEMORY_SEARCH: '/api/memory/search',
  MEMORY_PROFILE: '/api/memory/profile',
  MEMORY_PREFERENCES: '/api/memory/preferences',
  MEMORY_STATS: '/api/memory/stats',

  SECURITY_LOGS: '/api/security/logs',
  SECURITY_EVENTS: '/api/security/events',
  SECURITY_REPORT: '/api/security/report',
  SECURITY_VALIDATE: '/api/security/validate',
  SECURITY_AUDIT: '/api/security/audit',

  SKILLS_EXECUTE: '/api/skills/execute',
  SKILLS_LIST: '/api/skills/list',

  PERFORMANCE_SNAPSHOT: '/api/performance/snapshot',
  PERFORMANCE_METRICS: '/api/performance/metrics',
  PERFORMANCE_ERRORS: '/api/performance/errors',
  LLM_PERFORMANCE: '/api/llm/performance',

  SYSTEM_RESOURCES: '/api/system/resources',
  SYSTEM_INTEGRITY: '/api/system/integrity',
  SYSTEM_METRICS: '/api/metrics',
  SYSTEM_CONFIG: '/api/config',

  AUTOMATION_TASKS: '/api/automation/tasks',
  AUTOMATION_TRIGGERS: '/api/automation/triggers',
  AUTOMATION_PATTERNS: '/api/automation/patterns',

  TASKS_CREATE: '/api/tasks/create',
  TASKS_LIST: '/api/tasks/list',
  TASKS_CANCEL: '/api/tasks/:id/cancel',
  TASKS_PAUSE: '/api/tasks/:id/pause',
  TASKS_RESUME: '/api/tasks/:id/resume',
  TASKS_HARNESS_STATUS: '/api/tasks/harness/status',

  INTEGRATION: '/api/integration',
  INTEGRATION_PLATFORMS: '/api/integration/platforms',
  INTEGRATION_CONNECT: '/api/integration/:platform/connect',
  INTEGRATION_DISCONNECT: '/api/integration/:platform/disconnect',
  INTEGRATION_STATUS: '/api/integration/:platform/status',
  INTEGRATION_WEBHOOK: '/api/integration/:platform/webhook',
  INTEGRATION_SEND: '/api/integration/:platform/send',

  SIMULATE_TASK: '/api/simulate_task',
  CONVERSATIONS: '/api/conversations',
  USER_BEHAVIOR_EVENTS: '/api/user-behavior/events',
  RECOMMENDATIONS: '/api/recommendations',
  PERFORMANCE_METRICS_POST: '/api/performance/metrics',
  ERROR_MONITORING: '/api/error/monitoring',
  OPTIMIZATION_PROCESS: '/api/optimization/process',
  OPTIMIZATION_HISTORY: '/api/optimization/history',
} as const;

export type ApiEndpoint = (typeof API_ENDPOINTS)[keyof typeof API_ENDPOINTS];

// ====================== 全局系统常量 ======================
/**
 * 全局系统常量（前后端共用）
 */
export const SYSTEM_CONSTANTS = {
  /** 用户输入最大长度（字符数） */
  MAX_INPUT_LENGTH: 2000,
  /** WebSocket 去重缓存容量上限 */
  MAX_DEDUP_CACHE_SIZE: 1000,
  /** 活跃任务自动清理超时（毫秒） */
  ACTIVE_TASK_TIMEOUT_MS: 10 * 60 * 1000, // 10分钟
  /** 图片上传最大大小（字节，10MB） */
  MAX_IMAGE_SIZE_BYTES: 10 * 1024 * 1024,
  /** 允许的图片类型 */
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  /** 对话历史保存 debounce 时间 */
  HISTORY_SAVE_DEBOUNCE_MS: 2000,
  /** WebSocket 重连初始延迟 */
  WS_RECONNECT_INITIAL_DELAY_MS: 1000,
  /** WebSocket 最大重连延迟 */
  WS_RECONNECT_MAX_DELAY_MS: 30000,
};

// ====================== WebSocket 事件定义 ======================

// --- Health ---

export interface HealthResponse {
  status: string;
  timestamp: string;
  uptime: number;
  model: string;
  autoOptimize: boolean;
  llm: {
    available: boolean;
    message: string;
  };
}

// --- Process ---

export interface ProcessRequest {
  input: string;
  images?: string[];
  userId?: string;
}

export interface ProcessResponse {
  response: string;
  traceId: string;
  intent: string;
}

// --- Models ---

export interface ModelInfo {
  id: string;
  name: string;
  status: string;
  version: string;
  description: string;
}

export interface ModelStatus {
  currentModel: string | null;
  availableModels: string[];
  switchHistory: ModelSwitchEvent[];
}

export interface ModelSwitchEvent {
  from: string;
  to: string;
  reason: string;
  timestamp: string;
}

export interface ModelSwitchRequest {
  targetModel: string;
  reason?: string;
}

export interface ModelHealth {
  name: string;
  available: boolean;
  latency: number;
  lastCheck: string;
  errorCount: number;
  successCount: number;
}

// --- Memory ---

export interface MemoryStoreRequest {
  content: string;
  userId?: string;
  importance?: string;
  tags?: string[];
  emotion?: string;
  scene?: string;
}

export interface MemoryStoreResponse {
  id: string;
  content: string;
  timestamp: string;
  importance: string;
}

export interface MemorySearchRequest {
  query: string;
  userId?: string;
  limit?: number;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  importance: string;
  timestamp: string;
  similarity: number;
}

export interface MemorySearchResponse {
  query: string;
  results: MemorySearchResult[];
  total: number;
}

export interface MemoryProfileResponse {
  basicInfo: Record<string, unknown>;
  developmentHabits: Record<string, unknown>;
  lifePreferences: Record<string, unknown>;
  emotionalPatterns: Record<string, unknown>;
  taskPreferences: Record<string, unknown>;
}

export interface MemoryStatsResponse {
  timestamp: string;
  totalRecords: number;
  typeDistribution: Record<string, number>;
  databaseSize: number;
  databaseSizeMB: number;
  engineStats: Record<string, unknown> | null;
}

// --- Evolution ---

export interface EvolutionCycleStatus {
  healing: {
    total: number;
    success: number;
    recent: HealingResult[];
  };
  refactor: {
    total: number;
    success: number;
    recent: RefactoringResult[];
  };
  enhancement: {
    total: number;
    success: number;
    recent: EnhancementResult[];
  };
  lastCycleTime?: string | null;
  nextCycleTime?: string | null;
}

export interface HealingResult {
  success: boolean;
  problem: string;
  solution: string;
  filesModified: string[];
  testsPassed: boolean;
  rollbackNeeded: boolean;
  timestamp?: string;
}

export interface RefactoringResult {
  success: boolean;
  filesModified: string[];
  testsPassed: boolean;
  improvements: {
    reducedLines: number;
    reducedComplexity: number;
    eliminatedDuplicates: number;
  };
  timestamp?: string;
}

export interface EnhancementResult {
  success: boolean;
  featureName: string;
  description: string;
  filesCreated: string[];
  integrated: boolean;
  timestamp?: string;
}

export interface EvolutionTriggerRequest {
  reason?: string;
}

export interface EvolutionTriggerResponse {
  id: string;
  reason: string;
}

export interface EvolutionCycleResponse {
  success: boolean;
  message: string;
  duration: string;
  summary: {
    healingCount: number;
    refactorSuccess: boolean;
    enhancementCount: number;
  };
  timestamp: string;
}

// --- Security ---

export interface SecurityValidateRequest {
  input: string;
}

export interface SecurityValidateResponse {
  valid: boolean;
  errors: string[];
  warnings: string[];
  riskLevel: 'low' | 'high';
}

// --- Skills ---

export interface SkillExecuteRequest {
  skillName: string;
  params?: Record<string, unknown>;
  userId?: string;
}

export interface SkillExecuteResponse {
  success: boolean;
  output?: unknown;
  error?: string;
  metadata: {
    duration: number;
    [key: string]: unknown;
  };
}

export interface SkillListResponse {
  skills: Array<Record<string, unknown>>;
  count: number;
}

// --- Performance ---

export interface PerformanceSnapshotResponse {
  timestamp: string;
  avgResponseTime: number;
  totalRequests: number;
  errorRate: number;
  memoryUsage: number;
  [key: string]: unknown;
}

// --- System ---

export interface SystemResourcesResponse {
  timestamp: string;
  process: {
    pid: number;
    uptime: number;
    version: string;
    platform: string;
    arch: string;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
    systemTotal: number;
    systemFree: number;
    usagePercent: number;
  };
  cpu: {
    loadAverage: number[];
    userTime: number;
    systemTime: number;
    count: number;
  };
  disk: {
    free: number;
    total: number;
    used: number;
  };
}

// --- Automation ---

export interface AutomationTask {
  id: string;
  name: string;
  description: string;
  schedule: string;
  priority: number;
  enabled: boolean;
  executionCount: number;
  successCount: number;
  averageExecutionTime: number;
  lastRun?: string;
}

export interface AutomationTrigger {
  type: string;
  reason: string;
  priority: number;
  suggestedAction?: string;
  timestamp: number;
}

export interface AutomationPattern {
  activeHours: number[];
  frequentTopics: string[];
  taskCompletionRate: number;
  lastActiveTime: number;
  averageSessionDuration: number;
  preferredCommunicationStyle: string;
}

// --- Correct ---

export interface CorrectRequest {
  toolId?: string;
  tool_name?: string;
  correctionType?: string;
  type?: string;
  reason?: string;
  message?: string;
  severity?: number;
  traceId?: string;
}

// ====================== WebSocket 事件契约 ======================

export const WS_EVENTS = {
  // 前端 → 后端
  CLIENT: {
    USER_INPUT: 'user_input',
    COMMAND: 'command',
    GET_STATUS: 'get_status',
    CLARIFICATION_RESPONSE: 'clarification_response',
    EXECUTION_CONFIRM: 'execution_confirm',
    CANCEL_TASK: 'cancel_task',
  },

  // 后端 → 前端
  SERVER: {
    CONNECTED: 'connected',
    RESPONSE_READY: 'response_ready',
    RESPONSE: 'response',
    ERROR: 'error',
    STATUS: 'status',
    PROACTIVE_MESSAGE: 'proactive_message',
    WEIGHT_UPDATE: 'weight_update',
    AGENT_EXECUTION_UPDATE: 'agent_execution_update',
    PERCEPTION_UPDATE: 'perception_update',
    BRAIN_STAGE_UPDATE: 'brain_stage_update',
    SKILL_EXECUTION_UPDATE: 'skill_execution_update',
    EVOLUTION_EVENT: 'evolution_event',
    CLARIFICATION_REQUEST: 'clarification_request',
    EXECUTION_PREVIEW: 'execution_preview',
    FILE_MODIFIED: 'file_modified',
    FILE_ROLLBACK: 'file_rollback',
    MULTI_FILE_MODIFIED: 'multi_file_modified',
    TOOL_TRACE: 'tool_trace',
    SERVER_LOG: 'server_log',
    USER_CORRECTION: 'user_correction',
    THINKING: 'thinking',
    PROCESSING_STATUS: 'processing_status',
    TASK_CANCELLED: 'task_cancelled',
    ASR_RESULT: 'asr_result',
    TTS_CHUNK: 'tts_chunk',
    DIALOG_STATE: 'dialog_state',
    CANCEL: 'cancel',
    ENVIRONMENT_UPDATE: 'environment_update',
    PROJECT_CHANGE: 'project_change',
    GIT_STATUS: 'git_status',
  },
} as const;

// ====================== WebSocket 消息类型 ======================

export type WsClientEventType =
  (typeof WS_EVENTS.CLIENT)[keyof typeof WS_EVENTS.CLIENT];
export type WsServerEventType =
  (typeof WS_EVENTS.SERVER)[keyof typeof WS_EVENTS.SERVER];

export interface WsMessage<T extends WsServerEventType = WsServerEventType> {
  type: T;
  data?: Record<string, unknown>;
  traceId?: string;
  timestamp?: number;
}

// --- 前端→后端 消息 ---

export interface WsUserInputMessage {
  type: 'user_input';
  payload: {
    input: string;
    userId: string;
  };
  traceId?: string;
}

export interface WsClarificationResponseMessage {
  type: 'clarification_response';
  response: string;
  traceId?: string;
}

export interface WsExecutionConfirmMessage {
  type: 'execution_confirm';
  confirmed: boolean;
  traceId?: string;
}

// --- 后端→前端 消息 ---

export interface WsConnectedData {
  message: string;
  model: string;
  status: string;
  timestamp: string;
}

export interface WsResponseReadyData {
  response: string;
  traceId: string;
}

export interface WsErrorData {
  message: string;
  traceId?: string;
}

export interface WsStatusData {
  status: string;
  model: string;
  uptime: number;
  clients: number;
}

export interface WsProactiveMessageData {
  message: string;
  reason: string;
  scene?: string;
  timestamp: number;
}

export interface WsAgentExecutionUpdateData {
  traceId: string;
  phase: string;
  status: string;
  result?: unknown;
  timestamp: string;
}

export interface WsPerceptionUpdateData {
  traceId: string;
  modality: 'voice' | 'image' | 'text' | 'sensor' | 'fusion';
  status: 'started' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: unknown;
  confidence?: number;
  error?: string;
  timestamp: string;
}

export interface WsBrainStageUpdateData {
  traceId: string;
  stage:
    | 'intent_recognition'
    | 'task_decomposition'
    | 'scene_recognition'
    | 'memory_retrieval'
    | 'llm_generation'
    | 'persona_adjustment'
    | 'function_calling';
  status: 'started' | 'completed' | 'failed';
  duration?: number;
  result?: unknown;
  timestamp: string;
}

export interface WsSkillExecutionUpdateData {
  traceId: string;
  skillName: string;
  step: 'started' | 'retry' | 'fallback' | 'completed' | 'failed';
  attempt?: number;
  maxRetries?: number;
  duration?: number;
  error?: string;
  timestamp: string;
}

export interface WsEvolutionEventData {
  type:
    | 'quality_assessed'
    | 'micro_optimization'
    | 'deep_optimization'
    | 'strategy_updated'
    | 'threshold_adjusted';
  traceId?: string;
  score?: number;
  description: string;
  metrics?: Record<string, number>;
  timestamp: string;
}

export interface WsClarificationRequestData {
  traceId: string;
  question: string;
  options: string[];
  context: string;
  timestamp: string;
}

export interface WsExecutionPreviewData {
  traceId: string;
  summary: string;
  changes: Array<{
    type: 'file' | 'command' | 'api';
    target: string;
    action: string;
    risk: 'low' | 'medium' | 'high';
    preview?: string;
  }>;
  estimatedTime?: number;
  timestamp: string;
}

export interface WsFileModifiedData {
  traceId: string;
  filePath: string;
  changeType: 'created' | 'modified' | 'deleted';
  edits?: Array<{ description: string; found: boolean }>;
  timestamp: string;
}

export interface WsFileRollbackData {
  traceId: string;
  filePath: string;
  success: boolean;
  timestamp: string;
}

export interface WsMultiFileModifiedData {
  traceId: string;
  files: Array<{
    path: string;
    changeType: 'created' | 'modified' | 'deleted';
  }>;
  timestamp: string;
}

export interface WsToolTraceData {
  timestamp: string;
  traceId: string;
  toolCallId: string;
  toolName: string;
  status: 'started' | 'completed' | 'failed';
  duration: number;
  success: boolean | null;
  errorMessage: string | null;
}

export interface WsWeightUpdateData {
  weights?: Record<string, number>;
  toolId?: string;
  oldWeight?: number;
  newWeight?: number;
  reason?: string;
  timestamp?: number;
  updateType?: 'full' | 'single';
}

export interface WsServerLogData {
  timestamp: string;
  level: string;
  message: string;
  module?: string;
  traceId?: string;
}

export interface WsEnvironmentUpdateData {
  timestamp: string;
  activeEnv: string;
  foregroundWindow: { title: string; process: string } | null;
}

export interface WsProjectChangeData {
  type: string;
  repo: string;
  detail: string;
  timestamp: string;
}

export interface WsGitStatusData {
  timestamp: string;
  repos: Array<Record<string, unknown>>;
}

// ====================== EventBus → WebSocket 桥接映射 ======================

export const EVENTBUS_TO_WS_MAP: Record<string, WsServerEventType> = {
  response_ready: 'response_ready',
  agent_execution_update: 'agent_execution_update',
  proactive_interaction: 'proactive_message',
  weight_update: 'weight_update',
  weight_changed: 'weight_update',
  user_correction: 'user_correction',
  perception_update: 'perception_update',
  brain_stage_update: 'brain_stage_update',
  skill_execution_update: 'skill_execution_update',
  evolution_event: 'evolution_event',
  clarification_request: 'clarification_request',
  execution_preview: 'execution_preview',
  file_modified: 'file_modified',
  file_rollback: 'file_rollback',
  multi_file_modified: 'multi_file_modified',
  tool_trace: 'tool_trace',
  environment_update: 'environment_update',
  project_change: 'project_change',
  git_status: 'git_status',
};

// ====================== 连接状态 ======================

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

export type DialogStateValue = 'idle' | 'listening' | 'processing' | 'speaking';

// ====================== 集成平台类型 ======================

export type IntegrationPlatform = 'wechat' | 'feishu' | 'dingtalk' | 'qq';

export interface PlatformConfig {
  /** 连接模式: qr=扫码登录个人微信, official=公众号/企业微信 */
  mode?: 'qr' | 'official';
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  /** Mirai HTTP API 地址，如 http://localhost:8080 */
  miraiHttpHost?: string;
  /** Mirai HTTP API 端口 */
  miraiHttpPort?: string;
  /** Mirai verifyKey */
  miraiVerifyKey?: string;
  /** QQ 账号 */
  qqAccount?: string;
  /** QQ 机器人密码（可选，用于自动登录） */
  qqPassword?: string;
  [key: string]: string | undefined;
}

export interface IntegrationStatus {
  platform: IntegrationPlatform;
  connected: boolean;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  lastConnectedAt?: string;
  error?: string;
}

export interface IntegrationPlatformInfo {
  id: IntegrationPlatform;
  name: string;
  icon: string;
  description: string;
  enabled: boolean;
  available: boolean;
  status?: IntegrationStatus;
  features?: string[];
}

export interface ConnectRequest {
  platform: IntegrationPlatform;
  config: PlatformConfig;
}

export interface SendMessageRequest {
  platform: IntegrationPlatform;
  message: string;
  to?: string;
  imageUrls?: string[];
  mentions?: string[];
}

export interface IncomingMessageEvent {
  platform: IntegrationPlatform;
  type: 'text' | 'image' | 'event';
  content: string;
  from?: string;
  fromName?: string;
  timestamp?: string;
  rawData?: Record<string, unknown>;
}

export interface WebhookPayload {
  platform: IntegrationPlatform;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface IntegrationStatusResponse {
  platforms: IntegrationPlatformInfo[];
}

export interface PlatformConnectResponse {
  success: boolean;
  platform: IntegrationPlatform;
  status: string;
}

export interface PlatformDisconnectResponse {
  success: boolean;
  platform: IntegrationPlatform;
}

export interface SendMessageResponse {
  success: boolean;
  messageId?: string;
  timestamp?: string;
  error?: string;
}
