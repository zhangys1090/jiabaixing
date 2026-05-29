import path from 'path';
import { EvolutionOrchestrator } from '../evolution/EvolutionOrchestrator';
import { LLMProvider } from '../models/LLMProvider';
import { PerformanceMonitor } from '../monitoring/PerformanceMonitor';
import { SecurityAuditor } from '../monitoring/SecurityAuditor';
import { PersonaCore } from '../persona/PersonaCore';
import { PersonaRules } from '../persona/PersonaRules';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { SYSTEM_CONSTANTS } from '../shared/contracts';
import {
  IEvolutionEngine,
  ITRAEOptimizationIntegrator,
} from '../server/init/types';
import {
  ConstitutionPromptBuilder,
  type PromptBuilderDependencies,
} from './ConstitutionPromptBuilder';
import {
  ConversationEntry,
  ConversationHistoryManager,
} from './ConversationHistoryManager';
import { MemoryAssistant } from './MemoryAssistant';
import {
  OptimizationDependencies,
  OptimizationScheduler,
} from './OptimizationScheduler';
import { ScenarioAwareScheduler } from './ScenarioAwareScheduler';

/**
 * 记忆引擎接口（避免循环依赖）
 */
export interface IMemoryEngine {
  storeShortTermMemory?(
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
}

/**
 * 处理用户输入的结果
 */
export interface ProcessInputResult {
  response: string;
  traceId: string;
  intent: string;
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
export class JiabaixingCore {
  private initialized = false;
  private personaCore: PersonaCore;
  private personaGuard: PersonaRules;
  private llm: LLMProvider;
  private memoryEngine: IMemoryEngine | null = null;
  private performanceMonitor: PerformanceMonitor;
  private securityAuditor: SecurityAuditor;
  private evolutionEngine: IEvolutionEngine | null = null;
  private traeOptimizationIntegrator: ITRAEOptimizationIntegrator | null = null;
  private optimizationSchedulerManager!: OptimizationScheduler;
  private scenarioScheduler: ScenarioAwareScheduler | null = null;

  public orchestrator: EvolutionOrchestrator;

  // V5.0: 核心组件
  private harness: import('../harness/AgentHarness').AgentHarness | null = null;
  private constitutionPromptBuilder: ConstitutionPromptBuilder;
  private memoryAssistant!: MemoryAssistant;
  private conversationHistoryManager: ConversationHistoryManager;

  constructor() {
    this.personaCore = new PersonaCore();
    this.personaGuard = new PersonaRules(this.personaCore);
    this.llm = new LLMProvider(process.env.LLM_MODEL || 'deepseek-chat');
    this.performanceMonitor = PerformanceMonitor.getInstance();
    this.securityAuditor = new SecurityAuditor({
      logFilePath: path.join(
        process.cwd(),
        'data',
        'logs',
        'security-audit.log'
      ),
    });

    // 初始化宪法 prompt 构建器
    this.constitutionPromptBuilder = new ConstitutionPromptBuilder({
      memoryEngine: this
        .memoryEngine as unknown as PromptBuilderDependencies['memoryEngine'],
      evolutionEngine: this.evolutionEngine,
    });

    // 初始化进化编排器
    this.orchestrator = EvolutionOrchestrator.getInstance();

    // 初始化对话历史管理器
    this.conversationHistoryManager = new ConversationHistoryManager();
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
          `   LLM模型: ${process.env.LLM_MODEL || 'deepseek-chat'}`,
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
      memoryEngine: this
        .memoryEngine as unknown as PromptBuilderDependencies['memoryEngine'],
      evolutionEngine: this.evolutionEngine,
    });
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
   * 获取进化引擎
   */
  getEvolutionEngineInternal(): IEvolutionEngine | null {
    return this.evolutionEngine;
  }

  /**
   * 设置进化引擎
   */
  setEvolutionEngine(engine: IEvolutionEngine): void {
    this.evolutionEngine = engine;
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

  /**
   * 获取记忆引擎实例
   */
  public getMemoryEngine(): IMemoryEngine | null {
    return this.memoryEngine;
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
    traceId?: string
  ): Promise<ProcessInputResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const finalTraceId = traceId || Logger.generateTraceId();
    Logger.setTraceId(finalTraceId);
    Logger.info(
      `🚀 开始处理用户输入: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`,
      'JiabaixingCore'
    );

    // 立即发送处理开始的信号，让前端知道后端已开始处理
    void EventBus.emit('agent_execution_update', {
      traceId: finalTraceId,
      phase: 'processing_start',
      status: 'started',
      timestamp: new Date().toISOString(),
    });

    const startTime = Date.now();

    // 更新用户活跃状态
    if (this.scenarioScheduler) {
      this.scenarioScheduler.updateUserActivity();
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

        const harnessResult = await this.harness.processInput({
          text: input,
          userId,
          traceId: finalTraceId,
        });

        const safeResponse = harnessResult.response;
        const qualityScore = harnessResult.quality.overall;

        Logger.info(
          `🏗️ Harness 处理完成 (质量:${qualityScore.toFixed(2)}, 轮次:${harnessResult.metadata.loopRounds}, 工具:${harnessResult.trace.totalToolCalls})`,
          'JiabaixingCore'
        );

        // 更新对话历史
        this.conversationHistoryManager.addUserMessage(input);
        this.conversationHistoryManager.addAssistantMessage(safeResponse);

        // 自动知识提取
        setImmediate(() => {
          this.memoryAssistant
            .autoExtractKnowledge(input, safeResponse, userId)
            .catch(() => {});
        });

        // 进化记录
        setImmediate(() => {
          try {
            const orchestrator = EvolutionOrchestrator.getInstance();
            // 从轨迹中提取工具调用详情
            const toolCalls = (harnessResult.trace.trajectory || [])
              .filter((s: { type: string }) => s.type === 'tool_call')
              .map((s: { toolName?: string; duration?: number }) => ({
                toolName: s.toolName || 'unknown',
                success: true,
                executionTime: s.duration || 0,
              }));
            orchestrator.recordInteraction({
              traceId: finalTraceId,
              input,
              response: safeResponse,
              success: qualityScore >= 0.5,
              qualityScore,
              executionDuration: harnessResult.trace.totalDuration,
              toolCalls,
              scene: 'general',
              userId: userId || 'default',
            });
          } catch (error) {
            Logger.debug(
              `进化编排器记录失败（非关键）: ${(error as Error).message}`,
              'JiabaixingCore'
            );
          }
        });

        void EventBus.emit('response_ready', {
          response: safeResponse,
          traceId: finalTraceId,
          success: true,
        });
        Logger.info(
          `✅ response_ready已发射: traceId=${finalTraceId}, 响应长度=${safeResponse.length}, 质量=${qualityScore.toFixed(2)}`,
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
        };
      }

      // ═══════════════════════════════════════════════════════════════
      // 降级：如果 Harness 不可用
      // ═══════════════════════════════════════════════════════════════
      Logger.warn('⚠️ Harness 不可用，使用简单回复', 'JiabaixingCore');
      const fallbackResponse = `抱歉，当前系统配置不完整，请检查环境变量设置。`;

      this.conversationHistoryManager.addUserMessage(input);
      this.conversationHistoryManager.addAssistantMessage(fallbackResponse);

      void EventBus.emit('response_ready', {
        response: fallbackResponse,
        traceId: finalTraceId,
        success: false,
      });
      Logger.warn(
        `⚠️ response_ready已发射(降级): traceId=${finalTraceId}`,
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
      const fallbackResponse = `抱歉，处理过程中出现了问题：${(error as Error).message}`;

      this.conversationHistoryManager.addUserMessage(input);
      this.conversationHistoryManager.addAssistantMessage(fallbackResponse);

      void EventBus.emit('response_ready', {
        response: fallbackResponse,
        traceId: finalTraceId,
        success: false,
      });
      Logger.error(
        `❌ response_ready已发射(错误): traceId=${finalTraceId}, error=${(error as Error).message}`,
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
      // C1 fix: report actual success instead of always true
      const success = this.harness ? true : false;
      this.performanceMonitor.recordRequest(duration, success);
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

  // 兼容层：保留原有属性，委托给 ConversationHistoryManager
  private get recentConversationHistory(): Array<{
    role: string;
    content: string;
    timestamp: Date;
  }> {
    return this.conversationHistoryManager.getAll();
  }

  private set recentConversationHistory(
    value: Array<{ role: string; content: string; timestamp: Date }>
  ) {
    this.conversationHistoryManager.setHistory(value as ConversationEntry[]);
  }

  private readonly MAX_CONVERSATION_HISTORY = 20;

  /**
   * 生成主动消息（已简化，不再依赖 ProactiveMessageGenerator）
   */
  public async generateProactiveMessage(context: {
    reason: string;
    context: string;
    scene: string;
    isEmotionBased: boolean;
  }): Promise<string> {
    return `提醒：${context.reason}`;
  }

  public getLastToolResults(): Array<{
    toolCall: {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    };
    validated: { valid: boolean; sanitizedOutput: string; warning?: string };
    duration: number;
  }> {
    return [];
  }
}
