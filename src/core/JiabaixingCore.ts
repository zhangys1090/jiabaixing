import fs from 'fs';
import path from 'path';
import { EvolutionOrchestrator } from '../evolution/EvolutionOrchestrator';
import { FeedbackCollector } from '../evolution/FeedbackCollector';
import { getActivePythonBridge } from '../ide/bridgeRegistry';
import type { PythonAgentBridge } from '../ide/PythonAgentBridge';
import { LLMProvider } from '../models/LLMProvider';
import { PerformanceMonitor } from '../monitoring/PerformanceMonitor';
import { SecurityAuditor } from '../monitoring/SecurityAuditor';
import { PersonaCore } from '../persona/PersonaCore';
import { PersonaRules } from '../persona/PersonaRules';
import { ITRAEOptimizationIntegrator } from '../server/init/types';
import { SYSTEM_CONSTANTS } from '../shared/contracts';
import { EventBus } from '../shared/EventBus';
import type { TrajectoryData } from '../training/TrajectoryExporter';
import {
  ExportFormat,
  TrajectoryExporter,
} from '../training/TrajectoryExporter';
import { Logger } from '../utils/Logger';
import { MemoryLeakGuard } from '../utils/MemoryLeakGuard';
import {
  ConstitutionPromptBuilder,
  type PromptBuilderDependencies,
} from './ConstitutionPromptBuilder';
import { ConversationHistoryManager } from './ConversationHistoryManager';
import { MemoryAssistant } from './MemoryAssistant';
import {
  OptimizationDependencies,
  OptimizationScheduler,
} from './OptimizationScheduler';
import { ScenarioAwareScheduler } from './ScenarioAwareScheduler';
import { StreamResponseService } from './StreamResponseService';
import type { ToTOptions, ToTResult } from './TreeOfThought';
import { TreeOfThoughtEngine } from './TreeOfThought';

function adaptMemoryEngineForPromptBuilder(
  me: JiabaixingCore['memoryEngine']
): PromptBuilderDependencies['memoryEngine'] {
  return me as PromptBuilderDependencies['memoryEngine'];
}

/**
 * 记忆引擎接口（避免循环依赖）
 */
export interface IMemoryEngine {
  storeShortTermMemory?(
    content: string | Record<string, unknown> | unknown[],
    scene?: string,
    emotion?: string
  ): Promise<unknown>;
  storeLongTermMemory?(
    content: string | Record<string, unknown> | unknown[],
    scene?: string,
    emotion?: string
  ): Promise<unknown>;
  retrieveContext?(
    input: string,
    userId?: string
  ): Promise<{
    memories: Array<{ type: string; relevance: number; content: string }>;
    preferences: { codingStyle: string[]; namingRules: string[] };
  }>;
  storeFeedbackSignal(data: {
    traceId?: string;
    toolName?: string;
    feedbackType:
      | 'success'
      | 'failure'
      | 'timeout'
      | 'correction'
      | 'satisfaction';
    rating?: number;
    message?: string;
    userId?: string;
    timestamp?: number;
  }): Promise<void>;
  storeInstantMemory?(
    content: string | Record<string, unknown> | unknown[],
    scene?: string,
    emotion?: string
  ): Promise<unknown>;
  retrieveRelevant?(params: {
    query: string;
    limit?: number;
    includeBehaviorPatterns?: boolean;
  }): Promise<unknown[]>;
  getUserProfileSummary?(userId: string): Promise<{
    name?: string;
    preferredLanguage?: string;
    preferredFrameworks?: string[];
    recentTopics?: string[];
  }>;
  getUserProfile?(): unknown;
  detectBehaviorPatterns?(): unknown[];
  /** 标记用户活跃（用于记忆"做梦"机制判断空闲状态） */
  markUserActive?(): void;
}

/**
 * 处理用户输入的结果
 */
export interface ProcessInputResult {
  response: string;
  traceId: string;
  intent: string;
  quality?: number;
  loopRounds?: number;
  toolCallsCount?: number;
  details?: Record<string, unknown>;
}

export interface TrackedProcessResult {
  success: boolean;
  response?: string;
  intent?: string;
  error?: string;
  duration: number;
  traceId: string;
}

/**
 * JiabaixingCore 核心引擎
 *
 * V5.0 统一架构：
 * - 完全委托给 AgentHarness 处理
 * - 保留必要的集成组件（记忆、调度、进化）
 * - 移除旧的 FC 循环、DirectExecutor 等残留
 */

/** 上下文文件扫描列表（按优先级排序） */
const CONTEXT_FILE_LIST = [
  'JIABAIXING.md',
  'CONTEXT.md',
  '.jiabaixing/context.md',
  'CLAUDE.md',
] as const;

/** 上下文文件缓存有效期（5分钟） */
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

/** 已加载的上下文文件条目 */
interface ContextFileEntry {
  fileName: string;
  content: string;
  loadedAt: number;
}

export class JiabaixingCore {
  private initialized = false;
  private personaCore: PersonaCore;
  private personaGuard: PersonaRules;
  private llm: LLMProvider;
  private memoryEngine: IMemoryEngine | null = null;
  private performanceMonitor: PerformanceMonitor;
  private securityAuditor: SecurityAuditor;
  private traeOptimizationIntegrator: ITRAEOptimizationIntegrator | null = null;
  // 反馈收集器 — 闭合 Loop B（进化反馈经 Python 后端 python/agent/evolution 采集）
  public feedbackCollector: FeedbackCollector = new FeedbackCollector();
  private optimizationSchedulerManager!: OptimizationScheduler;
  private scenarioScheduler: ScenarioAwareScheduler | null = null;

  /** 进化编排器（AGENT_BACKEND=python 模式下为 null，进化由 Python agent.evolution 经 PythonAgentBridge 接管） */
  public orchestrator: EvolutionOrchestrator | null = null;

  // V5.0: 核心组件
  private harness: import('../harness/AgentHarness').AgentHarness | null = null;
  private constitutionPromptBuilder: ConstitutionPromptBuilder;
  private memoryAssistant!: MemoryAssistant;
  private conversationHistoryManager: ConversationHistoryManager;
  private streamResponseService: StreamResponseService;

  // RL 训练轨迹导出器
  private trajectoryExporter: TrajectoryExporter = new TrajectoryExporter();
  private trajectoryBuffer: TrajectoryData[] = [];
  private memoryLeakGuard: MemoryLeakGuard = MemoryLeakGuard.getInstance();

  // 项目上下文文件缓存
  private _contextFileCache: ContextFileEntry[] = [];
  private _contextCacheTimestamp: number = 0;

  constructor() {
    this.personaCore = new PersonaCore();
    this.personaGuard = new PersonaRules(this.personaCore);
    this.llm = new LLMProvider(process.env.LLM_MODEL || 'deepseek-v4-flash');
    this.performanceMonitor = PerformanceMonitor.getInstance();
    this.streamResponseService = new StreamResponseService();
    this.securityAuditor = new SecurityAuditor({
      logFilePath: path.join(
        process.cwd(),
        'data',
        'logs',
        'security-audit.log'
      ),
    });

    // 初始化宪法 prompt 构建器 (V1 evolution removed)
    this.constitutionPromptBuilder = new ConstitutionPromptBuilder({
      memoryEngine: adaptMemoryEngineForPromptBuilder(this.memoryEngine),
      evolutionEngine: undefined,
    });

    // 初始化进化编排器
    // P2-3 收口：python 模式不实例化 TS 进化编排器（避免 TS 独立运行 Agent 核心，§0.1）。
    this.orchestrator = getActivePythonBridge()
      ? null
      : EvolutionOrchestrator.getInstance();

    // 初始化对话历史管理器
    this.conversationHistoryManager = new ConversationHistoryManager();

    this.memoryLeakGuard.registerBuffer<TrajectoryData>(
      'trajectoryBuffer',
      this.trajectoryBuffer,
      { maxSize: 1000, warningThreshold: 0.8 }
    );
  }

  public getLLM(): LLMProvider {
    return this.llm;
  }

  public getPersonaCore(): PersonaCore {
    return this.personaCore;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      Logger.info('JiabaixingCore 已初始化，跳过', 'JiabaixingCore');
      return;
    }

    const isPythonBackend =
      (process.env.AGENT_BACKEND ?? 'python') === 'python' &&
      this.pythonBridgeResolver;

    if (isPythonBackend) {
      Logger.info(
        'JiabaixingCore 轻量初始化 (Python后端模式 — 跳过本地AI组件)',
        'JiabaixingCore'
      );
      this.initialized = true;
      return;
    }

    Logger.info('🧠 初始化 JiabaixingCore (V5.0 统一架构)', 'JiabaixingCore');

    Logger.info(
      '✅ 步骤5：SkillRegistry 核心技能由 AgentHarness 双写兼容注册',
      'JiabaixingCore'
    );

    // 模型初始化 + 健康检查
    try {
      await this.llm.initialize();
      const healthCheckResult = await this.llm.healthCheck();
      if (!healthCheckResult.available) {
        Logger.warn(
          `⚠️ LLM服务暂时不可用: ${healthCheckResult.message}，将以降级模式运行`,
          'JiabaixingCore'
        );
        this.llm.markLocalUnavailable(healthCheckResult.message);
      } else {
        Logger.info(
          `✅ 步骤6：LLM健康检查通过: ${healthCheckResult.message}`,
          'JiabaixingCore'
        );
        Logger.info(
          `   LLM模型: ${process.env.LLM_MODEL || 'deepseek-v4-flash'}`,
          'JiabaixingCore'
        );
      }
    } catch (llmError) {
      Logger.warn(
        `⚠️ LLM初始化失败: ${(llmError as Error).message}，将以降级模式运行`,
        'JiabaixingCore'
      );
      this.llm.markLocalUnavailable((llmError as Error).message);
    }

    // 异步加载对话历史
    await this.conversationHistoryManager.init();

    // 初始化优化调度器
    this.optimizationSchedulerManager = new OptimizationScheduler({
      memoryEngine: this
        .memoryEngine as OptimizationDependencies['memoryEngine'],
    });

    this.memoryAssistant = new MemoryAssistant({
      memoryEngine: this.memoryEngine,
    });

    if (process.env.ENABLE_AUTO_OPTIMIZE !== 'false') {
      await this.optimizationSchedulerManager.applyOptimizationsFromReport();
      this.optimizationSchedulerManager.startOptimizationScheduler();
      Logger.info(
        '🧬 步骤9：自动优化调度已启动（每24小时执行一次）',
        'JiabaixingCore'
      );
    } else {
      Logger.info(
        '⏸️ 步骤9：自动优化调度已禁用（ENABLE_AUTO_OPTIMIZE=false）',
        'JiabaixingCore'
      );
    }

    this.optimizationSchedulerManager.setupUserCorrectionHandler();
    this.optimizationSchedulerManager.watchAnalysisReport();

    this.performanceMonitor.startMonitoring();

    this.initialized = true;
    Logger.info('✅ JiabaixingCore 初始化完成 (V5.0)', 'JiabaixingCore');
  }

  /**
   * 注入记忆引擎
   */
  setMemoryEngine(memoryEngine: IMemoryEngine): void {
    this.memoryEngine = memoryEngine;
    this.constitutionPromptBuilder = new ConstitutionPromptBuilder({
      memoryEngine: adaptMemoryEngineForPromptBuilder(this.memoryEngine),
      evolutionEngine: undefined,
    });
  }

  /**
   * Python 后端桥接解析器（由 bootstrap.ts 注入，避免循环依赖）
   *
   * 当 AGENT_BACKEND=python 时，processInput 会优先通过此解析器
   * 获取 PythonAgentBridge 实例并转发请求，实现统一路由。
   */
  private pythonBridgeResolver: (() => PythonAgentBridge | null) | null = null;

  /**
   * 注入 Python 后端桥接解析器
   *
   * @param resolver - 返回 PythonAgentBridge 实例或 null 的回调函数
   *
   * Usage:
   *   core.setPythonBridgeResolver(() => pythonBridge);
   */
  setPythonBridgeResolver(resolver: () => PythonAgentBridge | null): void {
    this.pythonBridgeResolver = resolver;
    Logger.info(
      '🔌 Python 后端桥接解析器已注入，processInput 将统一路由到 Python 后端',
      'JiabaixingCore'
    );
  }

  getPythonBridgeResolver(): (() => PythonAgentBridge | null) | null {
    return this.pythonBridgeResolver;
  }

  /**
   * 获取宪法 Prompt 构建器
   */
  getConstitutionPromptBuilder(): ConstitutionPromptBuilder {
    return this.constitutionPromptBuilder;
  }

  /**
   * 获取对话历史管理器
   */
  getConversationHistoryManager(): ConversationHistoryManager {
    return this.conversationHistoryManager;
  }

  /**
   * 设置场景感知调度器
   */
  setScenarioScheduler(scheduler: ScenarioAwareScheduler): void {
    this.scenarioScheduler = scheduler;
  }

  /**
   * 获取场景感知调度器
   */
  getScenarioScheduler(): ScenarioAwareScheduler | null {
    return this.scenarioScheduler;
  }

  /**
   * 获取性能监控器
   */
  getPerformanceMonitor(): PerformanceMonitor {
    return this.performanceMonitor;
  }

  /**
   * 设置TRAE优化系统集成器
   */
  setTRAEOptimizationIntegrator(integrator: ITRAEOptimizationIntegrator): void {
    this.traeOptimizationIntegrator = integrator;
    Logger.info('✅ TRAE优化系统集成器已注入', 'JiabaixingCore');
  }

  /**
   * 获取TRAE优化系统集成器
   */
  getTRAEOptimizationIntegrator(): ITRAEOptimizationIntegrator | null {
    return this.traeOptimizationIntegrator;
  }

  /**
   * 注入 Agent Harness（V5.0 统一架构）
   */
  setHarness(harness: import('../harness/AgentHarness').AgentHarness): void {
    this.harness = harness;
    Logger.info('✅ Agent Harness 已注入 (V5.0)', 'JiabaixingCore');
  }

  /**
   * 获取 Agent Harness
   */
  getHarness(): import('../harness/AgentHarness').AgentHarness | null {
    return this.harness;
  }

  exportTrajectories(
    format: 'sharegpt' | 'jsonl' | 'openai_finetune' = 'sharegpt'
  ): string | unknown[] {
    const fmt =
      format === 'jsonl'
        ? ExportFormat.JSONL
        : format === 'openai_finetune'
          ? ExportFormat.OPENAI_FINETUNE
          : ExportFormat.SHAREGPT;
    return this.trajectoryExporter.export(this.trajectoryBuffer, fmt);
  }

  getTrajectoryStats(): {
    total: number;
    filtered: number;
    avgQuality: number;
    avgSteps: number;
  } {
    return this.trajectoryExporter.getStats(this.trajectoryBuffer);
  }

  /**
   * 获取记忆引擎实例
   */
  public getMemoryEngine(): IMemoryEngine | null {
    return this.memoryEngine;
  }

  /**
   * 获取记忆助手实例（供 FeedbackLoops 使用）
   */
  public getMemoryAssistant(): MemoryAssistant {
    return this.memoryAssistant;
  }

  /**
   * 加载项目上下文文件并注入到 ConstitutionPromptBuilder
   * 使用缓存机制，5分钟内不重复读磁盘
   */
  private async loadAndInjectProjectContext(): Promise<void> {
    try {
      const now = Date.now();
      const cacheExpired =
        now - this._contextCacheTimestamp >= CONTEXT_CACHE_TTL_MS;

      if (cacheExpired) {
        this._contextFileCache = await this.scanContextFiles();
        this._contextCacheTimestamp = now;
        Logger.info(
          `📄 项目上下文文件已加载: ${this._contextFileCache.length} 个`,
          'JiabaixingCore'
        );
      }

      const contextText = this._contextFileCache
        .map((entry) => `[${entry.fileName}]\n${entry.content}`)
        .join('\n\n');

      this.constitutionPromptBuilder.setProjectContext(contextText);
    } catch (error) {
      Logger.warn(
        `项目上下文文件加载失败: ${(error as Error).message}`,
        'JiabaixingCore'
      );
      // 加载失败不影响主流程
    }
  }

  /**
   * 扫描项目根目录下的上下文文件
   * @returns 成功读取的上下文文件条目列表
   */
  private async scanContextFiles(): Promise<ContextFileEntry[]> {
    const projectRoot = process.cwd();
    const entries: ContextFileEntry[] = [];

    for (const fileName of CONTEXT_FILE_LIST) {
      const filePath = path.join(projectRoot, fileName);
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8').trim();
          if (content.length > 0) {
            entries.push({
              fileName,
              content,
              loadedAt: Date.now(),
            });
            Logger.debug(
              `📄 加载上下文文件: ${fileName} (${content.length} 字符)`,
              'JiabaixingCore'
            );
          }
        }
      } catch (error) {
        Logger.debug(
          `跳过上下文文件 ${fileName}: ${(error as Error).message}`,
          'JiabaixingCore'
        );
      }
    }

    return entries;
  }

  /**
   * 手动刷新项目上下文文件缓存
   * @returns 刷新后加载的上下文文件数量
   */
  public async refreshProjectContext(): Promise<number> {
    this._contextCacheTimestamp = 0;
    await this.loadAndInjectProjectContext();
    return this._contextFileCache.length;
  }

  /**
   * 获取当前已加载的上下文文件列表
   * @returns 上下文文件条目的只读副本
   */
  public getLoadedContextFiles(): ReadonlyArray<ContextFileEntry> {
    return [...this._contextFileCache];
  }

  async getLLMHealth(): Promise<{ available: boolean; message: string }> {
    return this.llm.healthCheck();
  }

  /**
   * V5.0 统一 processInput
   *
   * 完全委托给 AgentHarness 处理，保留降级路径
   */
  async processInput(
    input: string,
    userId?: string,
    traceId?: string,
    images?: Array<{ url: string; mimeType?: string }>
  ): Promise<ProcessInputResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // ═══════════════════════════════════════════════════════════════
    // 统一 Python 后端路由
    // 当 AGENT_BACKEND=python 且 bridge 可用时，所有调用 core.processInput
    // 的入口（HTTP路由/WebSocket/CLI/调度器/集成管理器）一次性全部走 Python 后端
    // ═══════════════════════════════════════════════════════════════
    // V5.0 默认启用 Python 后端（真后端）：AGENT_BACKEND 未设置时按 python 处理；
    // 仅当显式设置 AGENT_BACKEND=local 时回退到 TS 本地（已废弃）。
    // pythonBridgeResolver 守卫确保：未桥接 / 测试场景下安全降级到 TS 本地。
    if (
      (process.env.AGENT_BACKEND ?? 'python') === 'python' &&
      this.pythonBridgeResolver
    ) {
      const bridge = this.pythonBridgeResolver();
      if (bridge) {
        const bridgeResult = await bridge.processInput(
          input,
          userId,
          traceId,
          images
        );
        return {
          response: bridgeResult.response,
          traceId: bridgeResult.traceId || traceId || Logger.generateTraceId(),
          intent: bridgeResult.intent || 'python_backend',
        };
      }
    }

    const finalTraceId = traceId || Logger.generateTraceId();
    Logger.setTraceId(finalTraceId);
    Logger.info(
      `🚀 开始处理用户输入: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`,
      'JiabaixingCore'
    );

    // 加载项目上下文文件并注入到 ConstitutionPromptBuilder
    await this.loadAndInjectProjectContext();

    // 立即发送处理开始的信号，让前端知道后端已开始处理
    void EventBus.emit('agent_execution_update', {
      traceId: finalTraceId,
      phase: 'processing_start',
      status: 'started',
      timestamp: new Date().toISOString(),
    });

    const startTime = Date.now();
    let requestSuccess = false;

    // 更新用户活跃状态
    if (this.scenarioScheduler) {
      this.scenarioScheduler.updateUserActivity();
    }

    // 标记记忆引擎用户活跃（用于"做梦"机制判断空闲状态）
    if (this.memoryEngine?.markUserActive) {
      this.memoryEngine.markUserActive();
    }

    this.securityAuditor.logAuditEntry({
      level: 'info',
      category: 'user_action',
      userId: userId || 'anonymous',
      action: 'process_input',
      details: { inputLength: input.length, traceId: finalTraceId },
      severity: 'low',
    });

    try {
      // ═══════════════════════════════════════════════════════════════
      // V5.0: Harness Agent Framework (统一架构)
      // ═══════════════════════════════════════════════════════════════
      if (this.harness && this.harness.getConfig().useHarnessLoop) {
        Logger.info('🏗️ V5.0 Harness 统一处理', 'JiabaixingCore');

        // 获取上一个助手消息，供 FeedbackLoops 进行纠正检测
        const previousResponse =
          this.conversationHistoryManager.getPreviousAssistantMessage?.() || '';

        const harnessResult = await this.harness.processInput({
          text: input,
          userId,
          traceId: finalTraceId,
          images, // Fix: pass images through to harness
          metadata: { previousResponse },
        });

        const safeResponse = harnessResult.response;
        const qualityScore = harnessResult.quality.overall;

        Logger.info(
          `🏗️ Harness 处理完成 (质量:${qualityScore.toFixed(2)}, 轮次:${harnessResult.metadata.loopRounds}, 工具:${harnessResult.trace.totalToolCalls})`,
          'JiabaixingCore'
        );
        requestSuccess = qualityScore >= 0.5;

        // 累积 RL 训练轨迹 (通过 MemoryLeakGuard 管理防止内存泄漏)
        const trajectoryEntry: TrajectoryData = {
          id: finalTraceId,
          steps: [
            { role: 'user', content: input },
            { role: 'assistant', content: safeResponse },
          ],
          quality: qualityScore,
          metadata: {
            loopRounds: harnessResult.metadata.loopRounds,
            toolCalls: harnessResult.trace.totalToolCalls,
            userId,
          },
        };
        this.trajectoryBuffer.push(trajectoryEntry);
        this.memoryLeakGuard.pushToBuffer('trajectoryBuffer', trajectoryEntry);
        if (this.trajectoryBuffer.length > 1000) {
          this.trajectoryBuffer.splice(0, this.trajectoryBuffer.length - 1000);
        }

        // 更新对话历史
        this.conversationHistoryManager.addUserMessage(input);
        this.conversationHistoryManager.addAssistantMessage(safeResponse);

        // 闭环逻辑已迁移到 FeedbackLoops，通过 AFTER_RESPONSE 钩子自动触发
        this.streamResponseService.stream(safeResponse, finalTraceId);

        Logger.info(
          `✅ 流式推送已启动: traceId=${finalTraceId}, 响应长度=${safeResponse.length}, 质量=${qualityScore.toFixed(2)}`,
          'JiabaixingCore'
        );
        Logger.debug(
          `📦 对话历史已更新，当前 ${this.conversationHistoryManager.getLength()} 条，将在 ${SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS}ms 内批量保存`,
          'JiabaixingCore'
        );

        return {
          response: safeResponse,
          traceId: finalTraceId,
          intent: 'harness_orchestrated',
          quality: harnessResult.quality.overall,
          loopRounds: harnessResult.metadata.loopRounds as number,
          toolCallsCount: harnessResult.trace.totalToolCalls,
        };
      }

      // ═══════════════════════════════════════════════════════════════
      // 降级：如果 Harness 不可用，尝试直接 LLM 调用
      // ═══════════════════════════════════════════════════════════════
      Logger.warn('⚠️ Harness 不可用，尝试直接LLM调用', 'JiabaixingCore');
      let fallbackResponse = '';
      try {
        const llm = this.getLLM();
        if (llm && llm.isServiceAvailable()) {
          fallbackResponse = await llm.chat(input);
          Logger.info('✅ 直接LLM调用成功', 'JiabaixingCore');
        }
      } catch (llmErr) {
        Logger.warn('⚠️ 直接LLM调用也失败，使用硬编码降级', 'JiabaixingCore');
      }
      if (!fallbackResponse.trim()) {
        fallbackResponse = '抱歉，当前系统配置不完整，请检查环境变量设置。';
      }

      this.conversationHistoryManager.addUserMessage(input);
      this.conversationHistoryManager.addAssistantMessage(fallbackResponse);

      this.streamResponseService.stream(fallbackResponse, finalTraceId);
      Logger.warn(
        `⚠️ 流式推送已启动(降级): traceId=${finalTraceId}`,
        'JiabaixingCore'
      );
      Logger.debug(
        `📦 对话历史已更新，当前 ${this.conversationHistoryManager.getLength()} 条，将在 ${SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS}ms 内批量保存`,
        'JiabaixingCore'
      );

      return {
        response: fallbackResponse,
        traceId: finalTraceId,
        intent: 'fallback_simple',
      };
    } catch (error) {
      Logger.error('❌ 处理用户输入失败', error as Error, 'JiabaixingCore');
      const fallbackResponse = '抱歉，处理过程中出现了问题，请稍后重试。';

      this.conversationHistoryManager.addUserMessage(input);
      this.conversationHistoryManager.addAssistantMessage(fallbackResponse);

      this.streamResponseService.stream(fallbackResponse, finalTraceId);
      Logger.error(
        `❌ 流式推送已启动(错误): traceId=${finalTraceId}, error=${(error as Error).message}`,
        error as Error,
        'JiabaixingCore'
      );
      Logger.debug(
        `📦 对话历史已更新，当前 ${this.conversationHistoryManager.getLength()} 条，将在 ${SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS}ms 内批量保存`,
        'JiabaixingCore'
      );

      return {
        response: fallbackResponse,
        traceId: finalTraceId,
        intent: 'error_fallback',
      };
    } finally {
      const duration = Date.now() - startTime;
      this.performanceMonitor.recordRequest(duration, requestSuccess);
      Logger.clearTraceId();
    }
  }

  async processInputWithTracking(
    input: string,
    userId?: string,
    traceId?: string
  ): Promise<TrackedProcessResult> {
    const finalTraceId = traceId || Logger.generateTraceId();
    const startTime = Date.now();

    EventBus.startTrace(finalTraceId, 'core_process_input', {
      input: input.substring(0, 50),
      userId,
    });

    void EventBus.emit('agent_execution_update', {
      traceId: finalTraceId,
      phase: 'processing_start',
      status: 'started',
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await this.processInput(input, userId, finalTraceId);

      EventBus.completeTrace(finalTraceId, true);

      return {
        success: true,
        response: result.response,
        intent: result.intent,
        duration: Date.now() - startTime,
        traceId: finalTraceId,
      };
    } catch (error) {
      EventBus.failTrace(finalTraceId, (error as Error).message);

      void EventBus.emit('agent_execution_update', {
        traceId: finalTraceId,
        phase: 'processing_error',
        status: 'failed',
        result: { error: (error as Error).message },
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        traceId: finalTraceId,
      };
    }
  }

  /**
   * 生成主动消息 — 使用 LLM 生成人格化的主动消息
   */
  public async generateProactiveMessage(context: {
    reason: string;
    context: string;
    scene: string;
    isEmotionBased: boolean;
  }): Promise<string> {
    // 主动消息原因 → 引导文案映射
    const reasonGuidance: Record<string, string> = {
      long_silence:
        '用户已经很久没有互动了，用温暖的方式打个招呼，不要有压力感',
      negative_emotion_trend: '用户之前的情绪不太好，用关心但不刻意的语气问候',
      morning_greeting: '早上好，用轻松的方式开启新的一天',
      evening_checkin: '晚上好，关心一下今天过得怎么样',
      late_night: '用户还在熬夜，用关心的语气提醒休息',
      scheduled: '有日程提醒需要告知用户',
      behavior_pattern: '根据用户的行为习惯，提供适时的建议',
      git_changes: '用户的代码仓库有变化，可以主动提供建议',
      idle_reminder: '用户似乎空闲了，可以提供一些有用的建议',
    };

    const guidance = reasonGuidance[context.reason] || '用自然的方式与用户互动';

    try {
      const systemPrompt = `${this.personaCore.buildPersonaSummary()}

你正在发起一次主动对话。规则：
- 不要说"我是AI"或"作为助手"
- 不要过度热情或刻意
- 保持自然、温暖、简洁
- 不超过50字
- 不要用"主人"称呼
- 不编造不存在的信息或事件
- ${guidance}`;

      const userPrompt = context.context
        ? `背景信息: ${context.context}\n场景: ${context.scene}`
        : `场景: ${context.scene}`;

      const response = await this.llm.chat(userPrompt, [], systemPrompt);
      return response || this.getFallbackProactiveMessage(context.reason);
    } catch {
      return this.getFallbackProactiveMessage(context.reason);
    }
  }

  /**
   * 主动消息降级方案
   */
  private getFallbackProactiveMessage(reason: string): string {
    const fallbacks: Record<string, string> = {
      long_silence: '在忙什么呢？需要帮忙的话随时说~',
      negative_emotion_trend: '今天还好吗？有什么我能帮上的？',
      morning_greeting: '早~ 新的一天开始了，有什么计划吗？',
      evening_checkin: '晚上好，今天辛苦了~',
      late_night: '这么晚了还在忙？注意休息哦',
      scheduled: '有个提醒想跟你说一下~',
      behavior_pattern: '想到一个可能对你有帮助的建议~',
      git_changes: '看到你的代码有更新，需要帮忙review吗？',
      idle_reminder: '闲着的话，要不要看看待办事项？',
    };
    return fallbacks[reason] || '在呢，需要什么帮忙吗？';
  }

  // ═══════════════════════════════════════════════════════════
  // P1 #8: Tree-of-Thought 推理框架
  // 多路径探索 + 评估 + 回溯，增强复杂推理能力
  // ═══════════════════════════════════════════════════════════

  public async treeOfThoughtReasoning(
    problem: string,
    options?: ToTOptions
  ): Promise<ToTResult> {
    const engine = new TreeOfThoughtEngine(this.llm);
    return engine.reason(problem, options);
  }
}

export { type ToTNode, type ToTOptions, type ToTResult } from './TreeOfThought';
