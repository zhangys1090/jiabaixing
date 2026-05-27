/**
 * jiabaixing 统一接口定义
 * 定义所有模块间的接口规范和数据格式
 */

// ====================== 核心推理引擎接口 ======================

/**
 * 目标结构体
 */
export interface TargetStructure {
  coreTarget: string; // 核心目标
  requirements: string[]; // 任务要求
  constraints: string[]; // 约束条件
  deliveryStandard: string; // 交付标准
  priority: number; // 优先级 (1-5)
  expectedTime: number; // 预计耗时（秒）
}

/**
 * 情绪标签
 */
export interface EmotionTag {
  type: string; // 情绪类型（开心/烦躁/疲惫/焦虑等）
  intensity: number; // 情绪强度 (1-10)
  potentialNeeds: string[]; // 潜在情感需求
}

/**
 * 统一场景类型枚举（全项目使用）
 */
export enum PersonaScene {
  DEVELOPMENT = 'development',
  DAILY = 'daily',
  COMFORT = 'comfort',
  WORK = 'work',
  GREETING = 'greeting',
  BRIEFING = 'briefing',
  IDLE = 'idle',
  LEISURE = 'leisure',
  MEETING = 'meeting',
  DRIVING = 'driving',
}

/**
 * 场景标签
 */
export interface SceneTag {
  type: PersonaScene; // 场景类型
  context: string; // 场景上下文
  interactionMode: string; // 交互模式（语音/文本/静默等）
}

/**
 * 任务执行结果
 */
export interface ExecutionResult {
  success: boolean; // 执行是否成功
  data?: unknown; // 执行结果数据
  error?: {
    message: string; // 错误消息
    code?: string; // 错误代码
    stack?: string; // 错误堆栈
  };
}

/**
 * 工具执行结果（用于反馈采集）
 */
export interface ToolExecutionResult {
  success: boolean;
  intent?: string;
  toolsUsed?: string[];
  error?: string;
}

// ====================== 记忆引擎接口 ======================

/**
 * 记忆类型枚举
 */
export enum MemoryType {
  INSTANT = 'instant', // 瞬时记忆（工作记忆）
  SHORT_TERM = 'short_term', // 短期记忆（近端记忆）
  LONG_TERM = 'long_term', // 长期记忆（永久记忆）
}

export type MemoryContent = string | Record<string, unknown> | unknown[];

export function isStringContent(content: MemoryContent): content is string {
  return typeof content === 'string';
}

export function isObjectContent(
  content: MemoryContent
): content is Record<string, unknown> {
  return (
    typeof content === 'object' && content !== null && !Array.isArray(content)
  );
}

export function isArrayContent(content: MemoryContent): content is unknown[] {
  return Array.isArray(content);
}

/**
 * 记忆项接口
 */
export interface MemoryItem {
  id: string; // 记忆ID
  type: MemoryType; // 记忆类型
  content: MemoryContent; // 记忆内容（支持字符串、对象、数组）
  timestamp: Date; // 记忆时间戳
  scene?: string; // 记忆场景
  emotion?: string; // 记忆情绪
  relevanceScore?: number; // 相关性分数（用于检索排序）
}

/**
 * 记忆检索参数
 */
export interface MemoryRetrievalParams {
  query: string;
  limit?: number;
  memoryTypes?: MemoryType[];
  timeRange?: {
    start?: Date;
    end?: Date;
  };
  includeBehaviorPatterns?: boolean;
  timeDecayFactor?: number;
}

/**
 * 用户行为模式
 */
export interface BehaviorPattern {
  pattern: string;
  frequency: number;
  lastOccurred: Date;
  timeDecayWeight: number;
  confidence: number;
  relatedIntent?: string;
  relatedTopic?: string;
}

/**
 * 用户偏好设置
 */
export interface UserPreferences {
  [key: string]:
    | string
    | number
    | boolean
    | string[]
    | number[]
    | boolean[]
    | object
    | null
    | undefined;
}

/**
 * 用户行为记录
 */
export interface UserBehaviorRecord {
  [key: string]: string | number | boolean | Date | object | null | undefined;
}

/**
 * 用户画像接口
 */
export interface UserProfile {
  userId: string; // 用户ID
  basicInfo: {
    name: string; // 用户名
    age?: number; // 年龄
    gender?: string; // 性别
    birthday?: Date; // 生日
  };
  preferences: UserPreferences; // 用户偏好
  behaviorHistory: {
    [key: string]: UserBehaviorRecord[]; // 用户行为历史
  };
  emotionalProfile: {
    [key: string]: number; // 情绪特征
  };
}

// ====================== 交互引擎接口 ======================

/**
 * 交互计划
 */
export interface InteractionPlan {
  estimatedTime: number; // 预计时间
  needEmotionSupport: boolean; // 是否需要情绪支持
  progressUpdateFrequency: number; // 进度更新频率
  emotionSupportContent: string; // 情绪支持内容
}

/**
 * 交互响应
 */
export interface InteractionResponse {
  content: string; // 响应内容
  emotion?: EmotionTag; // 响应情绪
  scene?: SceneTag; // 响应场景
  responseType: 'text' | 'voice' | 'multimodal'; // 响应类型
}

// ====================== 工具执行接口 ======================

/**
 * 工具参数基础类型（所有工具参数应继承此类型）
 */
export interface ToolParams {
  [key: string]: string | number | boolean | object | null | undefined;
}

/**
 * 工具定义
 */
export interface ToolDefinition {
  name: string; // 工具名称
  description: string; // 工具描述
  parameters: {
    [key: string]: {
      type: string; // 参数类型
      description: string; // 参数描述
      required: boolean; // 是否必填
    };
  };
  execute: (params: ToolParams) => Promise<ExecutionResult>; // 执行函数
}

/**
 * 工具执行请求
 */
export interface ToolExecutionRequest {
  toolName: string; // 工具名称
  parameters: ToolParams; // 工具参数
}

// ====================== 多模态输入输出接口 ======================

/**
 * 多模态输入类型
 */
export enum MultimodalInputType {
  TEXT = 'text', // 文本输入
  VOICE = 'voice', // 语音输入
  IMAGE = 'image', // 图像输入
  VIDEO = 'video', // 视频输入
  FILE = 'file', // 文件输入
}

/**
 * 多模态输入数据
 */
export interface MultimodalInputData {
  type: MultimodalInputType; // 输入类型
  content: unknown; // 输入内容
  metadata?: {
    [key: string]: unknown; // 元数据
  };
}

/**
 * 多模态输出类型
 */
export enum MultimodalOutputType {
  TEXT = 'text', // 文本输出
  VOICE = 'voice', // 语音输出
  IMAGE = 'image', // 图像输出
  VIDEO = 'video', // 视频输出
  FILE = 'file', // 文件输出
}

/**
 * 多模态输出数据
 */
export interface MultimodalOutputData {
  type: MultimodalOutputType; // 输出类型
  content: unknown; // 输出内容
  metadata?: {
    [key: string]: unknown; // 元数据
  };
}

// ====================== 安全与权限接口 ======================

/**
 * 用户身份信息
 */
export interface UserIdentity {
  userId: string; // 用户ID
  username: string; // 用户名
  roles: string[]; // 用户角色
  permissions: string[]; // 用户权限
}

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
  allowed: boolean; // 是否允许
  reason?: string; // 不允许的原因
  requiredPermission?: string; // 缺失的权限
}

// ====================== 推理引擎共享类型 ======================

/**
 * 任务复杂度
 */
export enum TaskComplexity {
  SIMPLE = 'simple',
  NORMAL = 'normal',
  COMPLEX = 'complex',
}

/**
 * 工具执行记录
 */
export interface ToolExecutionRecord {
  toolName: string;
  params: Record<string, unknown>;
  success: boolean;
  executionTime: number;
  error?: string;
  retryCount: number;
}

/**
 * 反馈记录
 */
export interface FeedbackRecord {
  traceId: string;
  taskId: string;
  inputText: string;
  scene: string;
  emotion: string;
  isSuccess: boolean;
  loopCount: number;
  totalExecutionTime: number;
  toolExecutions: ToolExecutionRecord[];
  failureReasons: string[];
  reflection: {
    successFactors?: string[];
    failureReasons?: string[];
    improvementOpportunities?: string[];
    strategyChanges?: unknown;
    newInsights?: unknown;
    behaviorAdjustments?: unknown;
    [key: string]: unknown;
  } | null;
  timestamp: number;
}

/**
 * 启发式建议
 */
export interface HeuristicSuggestion {
  target: 'toolTimeoutMs' | 'maxRetryCount' | 'parallelExecutionLimit';
  toolId?: string;
  oldValue: number;
  newValue: number;
  reason: string;
  confidence: number;
}

// ====================== 路由层公共API接口 ======================

/**
 * 自我修复历史条目
 */
export interface HealingHistoryEntry {
  success: boolean;
  problem: string;
  solution: string;
  filesModified: string[];
  testsPassed: boolean;
  rollbackNeeded: boolean;
}

/**
 * 重构改进指标
 */
export interface RefactorImprovements {
  reducedLines: number;
  reducedComplexity: number;
  eliminatedDuplicates: number;
}

/**
 * 自我重构历史条目
 */
export interface RefactorHistoryEntry {
  success: boolean;
  filesModified: string[];
  testsPassed: boolean;
  improvements: RefactorImprovements;
}

/**
 * 进化编排器接口
 */
export interface OrchestratorAPI {
  getHealingHistory?: () => HealingHistoryEntry[];
  getRefactorHistory?: () => RefactorHistoryEntry[];
  runSelfHealing?: () => Promise<unknown[]>;
  runSelfRefactor?: () => Promise<unknown>;
  runSelfEnhancement?: () => Promise<unknown[]>;
  runFullEvolutionCycle?: () => Promise<{
    healing: unknown[];
    refactor: unknown;
    enhancement: unknown[];
  }>;
}

/**
 * 进化引擎统计
 */
export interface EvolutionStats {
  _optimizationCount?: number;
  _feedbackCount?: number;
  _successRate?: number;
  _averageImprovement?: number;
  _lastOptimization?: Date | string | null;
  _nextOptimization?: string;
  _version?: string;
}

/**
 * 进化引擎接口
 */
export interface EvolutionEngineAPI {
  getStats?: () => Promise<EvolutionStats>;
  triggerOptimization?: (reason: string) => Promise<void>;
  getRecentLogs?: (limit?: number) => Promise<unknown[]>;
  recordUserCorrection?: (data: unknown) => Promise<void>;
}

/**
 * 安全审计器接口
 */
export interface SecurityAuditorAPI {
  getRecentLogs?: (limit: number) => Promise<unknown[]>;
}

/**
 * 记忆引擎公共接口（路由层使用）
 */
export interface MemoryEnginePublicAPI {
  getStats?: () => Record<string, unknown>;
}

/**
 * JiaBaiXing 公共API接口（用于路由层访问内部模块）
 * 路由层通过此接口安全地访问 JiaBaiXing 实例的可选子模块，
 * 避免使用 as unknown as 双重断言。
 */
export interface JiabaixingCorePublicAPI {
  memoryEngine?: MemoryEnginePublicAPI;
  orchestrator?: OrchestratorAPI;
  evolutionEngine?: EvolutionEngineAPI;
  securityAuditor?: SecurityAuditorAPI;
}
