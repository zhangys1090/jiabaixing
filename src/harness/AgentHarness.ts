/**
 * Harness Agent Framework - Agent Harness 入口
 *
 * 六层架构组装点，协调 Loop/Tools/Context/Persistence/Verification/Constraints
 *
 * 双后端架构说明：
 * - 当 AGENT_BACKEND=python（默认）时，请求通过 PythonAgentBridge 转发到 Python 后端
 *   此文件中的 LoopController、MemoryEngine 等组件不会被使用
 * - 当 AGENT_BACKEND=local 时，使用 TypeScript 本地实现（已废弃，仅用于回退）
 *
 * 废弃组件说明：
 * - LoopController: 已迁移到 Python agent/loop/controller.py
 * - MemoryEngine: 已迁移到 Python agent/memory/
 * 预计 V6.0 移除 TypeScript 端的废弃组件
 */

import path from 'path';
import { CronJobScheduler } from '../cron/CronJobScheduler';
import { skillUsageTracker } from '../evolution/SkillUsageTracker';
import { StrategyAdjuster } from '../evolution/StrategyAdjuster';
import { ACPActivityTracker } from '../ide/ACPActivityTracker';
import { SessionStore } from '../persistence/SessionStore';
import { EventBus } from '../shared/EventBus';
import { I18nManager } from '../shared/I18nManager';
import { MessageProcessor } from '../shared/MessageProcessor';

import { SkillRegistry } from '../skills/SkillRegistry';
import { Logger } from '../utils/Logger';
import { ConstraintsService } from './constraints/ConstraintsService';
import { ContextManager } from './context/ContextManager';
import { ContextWindowManager } from './context/ContextWindowManager';
import { type HarnessDeps } from './deps';
import { IndependentEvaluationService } from './evaluation/IndependentEvaluationService';
import { LspClientManager } from './lsp/LspClientManager';
import { LspCompletionProvider } from './lsp/LspCompletionProvider';
import { LspDiagnosticsProvider } from './lsp/LspDiagnosticsProvider';
import { AgentRegistry } from './orchestration/AgentRegistry';
import { OrchestratorAgent } from './orchestration/OrchestratorAgent';
import { PersistenceService } from './persistence/PersistenceService';
import { TrajectoryDatabase } from './persistence/TrajectoryDatabase';

import { SandboxExecutor } from './sandbox/SandboxExecutor';
import {
  registerHarnessTools,
  syncToLegacySkillRegistry,
  type HarnessToolDeps,
} from './tools/registerHarnessTools';
import { PermissionGuard } from './tools/registry/PermissionGuard';
import { SchemaValidator } from './tools/registry/SchemaValidator';
import { ToolRegistry } from './tools/registry/ToolRegistry';
import { getToolsetRegistry, registerBuiltinToolsets } from './tools/toolsets';
import type { HarnessConfig } from './types';
import {
  AgentResult,
  HookContext,
  LifecycleEvent,
  LoopState,
  UserInput,
} from './types';
import { VerificationService } from './verification/VerificationService';

export { validateHarnessDeps, type HarnessDeps } from './deps';

/** 从环境变量读取配置 */
function getEnvConfig(): Partial<HarnessConfig> {
  const envConfig: Partial<HarnessConfig> = {};

  if (process.env.HARNESS_LOOP !== undefined) {
    envConfig.useHarnessLoop = process.env.HARNESS_LOOP === 'true';
  }
  if (process.env.HARNESS_TOOLS !== undefined) {
    envConfig.useHarnessTools = process.env.HARNESS_TOOLS === 'true';
  }
  if (process.env.HARNESS_CONTEXT !== undefined) {
    envConfig.useHarnessContext = process.env.HARNESS_CONTEXT === 'true';
  }
  if (process.env.HARNESS_VERIFICATION !== undefined) {
    envConfig.useHarnessVerification =
      process.env.HARNESS_VERIFICATION === 'true';
  }
  if (process.env.HARNESS_CONSTRAINTS !== undefined) {
    envConfig.useHarnessConstraints =
      process.env.HARNESS_CONSTRAINTS === 'true';
  }
  if (process.env.HARNESS_PERSISTENCE !== undefined) {
    envConfig.useHarnessPersistence =
      process.env.HARNESS_PERSISTENCE === 'true';
  }
  if (process.env.HARNESS_TRAJECTORY !== undefined) {
    envConfig.useTrajectoryPersistence =
      process.env.HARNESS_TRAJECTORY === 'true';
  }
  if (process.env.HARNESS_EVALUATOR !== undefined) {
    envConfig.useIndependentEvaluator =
      process.env.HARNESS_EVALUATOR === 'true';
  }

  return envConfig;
}

/** 默认配置 - TS本地Agent Loop已恢复，useHarnessLoop 默认 true */
const DEFAULT_CONFIG: HarnessConfig = {
  useHarnessLoop: true,
  useHarnessTools: true,
  useHarnessContext: true,
  useHarnessVerification: true,
  useHarnessConstraints: true,
  useHarnessPersistence: true,
  useTrajectoryPersistence: true,
  useIndependentEvaluator: true,
};

export class AgentHarness {
  private config: HarnessConfig;
  private deps: HarnessDeps | null = null;
  private initialized = false;

  // 六层组件
  private toolRegistry: ToolRegistry | null = null;
  private schemaValidator: SchemaValidator | null = null;
  private permissionGuard: PermissionGuard | null = null;
  private contextManager: ContextManager | null = null;
  // P0-4: 上下文窗口管理器 — 循环内动态 token 预算管理
  private contextWindowManager: ContextWindowManager =
    new ContextWindowManager();
  private verificationService: VerificationService | null = null;
  private constraintsService: ConstraintsService | null = null;
  private persistenceService: PersistenceService | null = null;
  private trajectoryDatabase: TrajectoryDatabase | null = null;
  private eventStore: EventStore | null = null;
  private eventStoreBridge: EventStoreBridge | null = null;
  // 独立评估服务（P0 核心功能）
  private independentEvaluationService: IndependentEvaluationService | null =
    null;
  // 沙箱执行器（安全隔离）
  private sandboxExecutor: SandboxExecutor | null = null;
  // 多Agent编排组件
  private agentRegistry: AgentRegistry | null = null;
  private orchestratorAgent: OrchestratorAgent | null = null;
  // P5: 策略自适应调整器 — 驱动学习闭环
  private strategyAdjuster: StrategyAdjuster = new StrategyAdjuster();
  // Phase 2: LSP 客户端管理器 — 语言服务器协议集成
  private lspClientManager: LspClientManager | null = null;
  private lspDiagnosticsProvider: LspDiagnosticsProvider | null = null;
  private lspCompletionProvider: LspCompletionProvider | null = null;
  // Phase 3: 会话存储 + Cron调度器 + Skill注册中心
  private sessionStore: SessionStore | null = null;
  private cronScheduler: CronJobScheduler | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private acpTracker: ACPActivityTracker | null = null;
  private messageProcessor: MessageProcessor | null = null;
  private i18nManager: I18nManager | null = null;

  constructor(config?: Partial<HarnessConfig>) {
    const envConfig = getEnvConfig();
    this.config = { ...DEFAULT_CONFIG, ...envConfig, ...config };
  }

  /**
   * 注入依赖 — 校验必需依赖，缺失时快速失败
   */
  setDeps(deps: HarnessDeps): void {
    const validation = validateHarnessDeps(deps);
    if (!validation.valid) {
      Logger.warn(
        `⚠️ HarnessDeps 缺少必需依赖: ${validation.missing.join(', ')}，部分功能不可用`,
        'AgentHarness'
      );
    }
    this.deps = deps;
  }

  /**
   * 初始化 Harness 各层
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Python 后端模式下，仅初始化路由层必需的最小组件集
    if ((process.env.AGENT_BACKEND ?? 'python') === 'python') {
      Logger.info(
        '🏗️ Agent Harness 轻量初始化 (Python后端模式)',
        'AgentHarness'
      );
      try {
        const result = registerHarnessTools(
          this.deps?.toolDeps ?? ({} as HarnessToolDeps)
        );
        this.toolRegistry = result.toolRegistry;
        this.permissionGuard = result.permissionGuard;
        // P0-1/P0-2: 同步 SchemaValidator + PermissionGuard 到 ToolRegistry 内部
        this.toolRegistry.setSchemaValidator(result.schemaValidator);
        this.toolRegistry.setPermissionGuard(result.permissionGuard);
        // P1-2：将真实工具注册表注入统一动作调度器（tool 通道可用）
        try {
          const { configureActionDispatcher } = await import('./action');
          configureActionDispatcher({ toolRegistry: this.toolRegistry });
        } catch (ae) {
          Logger.warn(
            `  ⚠️ 动作调度器装配失败: ${(ae as Error).message}`,
            'AgentHarness'
          );
        }
        Logger.info(
          `  🔧 工具层(路由用): ${result.registeredCount} 个工具`,
          'AgentHarness'
        );
      } catch (err) {
        Logger.warn(
          `  ⚠️ 工具层轻量初始化失败: ${(err as Error).message}`,
          'AgentHarness'
        );
      }
      this.initialized = true;
      Logger.info('✅ Agent Harness 轻量初始化完成', 'AgentHarness');
      return;
    }

    Logger.info('🏗️ Agent Harness 初始化中...', 'AgentHarness');

    if (!this.deps) {
      Logger.warn('⚠️ 未注入依赖，部分功能不可用', 'AgentHarness');
    }

    // Phase 1: 工具层初始化
    try {
      if (this.config.useHarnessTools) {
        const result = registerHarnessTools(
          this.deps?.toolDeps ?? ({} as HarnessToolDeps)
        );
        this.toolRegistry = result.toolRegistry;
        this.schemaValidator = result.schemaValidator;
        this.permissionGuard = result.permissionGuard;

        // P1-2：将真实工具注册表注入统一动作调度器（tool 通道可用）
        try {
          const { configureActionDispatcher } = await import('./action');
          configureActionDispatcher({ toolRegistry: this.toolRegistry });
        } catch (ae) {
          Logger.warn(
            `  ⚠️ 动作调度器装配失败: ${(ae as Error).message}`,
            'AgentHarness'
          );
        }
        // P0-1/P0-2: 同步 SchemaValidator + PermissionGuard 到 ToolRegistry 内部
        this.toolRegistry.setSchemaValidator(result.schemaValidator);
        this.toolRegistry.setPermissionGuard(result.permissionGuard);

        if (this.deps?.skillRegistry) {
          syncToLegacySkillRegistry(
            this.toolRegistry,
            this.deps.skillRegistry as never
          );
          Logger.info(
            '  🔄 双写兼容: 已同步到旧版 SkillRegistry',
            'AgentHarness'
          );
        }

        Logger.info(
          `  🔧 工具层: 启用 (${result.registeredCount} 个工具)`,
          'AgentHarness'
        );

        // P0-3: 注册内置工具集（按 Agent 角色预组装工具包）
        registerBuiltinToolsets();
        const toolsetIds = getToolsetRegistry().list();
        Logger.info(
          `  📦 工具集层: 启用 (${toolsetIds.length} 个工具集: ${toolsetIds.join(', ')})`,
          'AgentHarness'
        );
      }
    } catch (err) {
      Logger.error(
        `  ❌ 工具层初始化失败: ${(err as Error).message}`,
        err as Error,
        'AgentHarness'
      );
      throw err;
    }

    // Phase 2: 约束层初始化
    try {
      if (this.config.useHarnessConstraints) {
        this.constraintsService = new ConstraintsService({
          permissionGuard: this.permissionGuard || new PermissionGuard(),
        });
        Logger.info('  🛡️ 约束层: 启用', 'AgentHarness');
      }
    } catch (err) {
      Logger.error(
        `  ❌ 约束层初始化失败: ${(err as Error).message}`,
        err as Error,
        'AgentHarness'
      );
      throw err;
    }

    // Phase 2.5: 沙箱执行器初始化
    try {
      this.sandboxExecutor = new SandboxExecutor({
        securityLevel: 'high',
        timeoutMs: 30000,
      });
      Logger.info('  🔒 沙箱执行器: 启用 (安全级别: high)', 'AgentHarness');
    } catch (err) {
      Logger.error(
        `  ❌ 沙箱执行器初始化失败: ${(err as Error).message}`,
        err as Error,
        'AgentHarness'
      );
      throw err;
    }

    // Phase 2.6: 多Agent编排初始化
    if (this.deps?.orchestratorAgent) {
      this.orchestratorAgent = this.deps.orchestratorAgent;
      Logger.info(
        '  🤖 多Agent编排: 使用外部提供的 OrchestratorAgent',
        'AgentHarness'
      );
    } else if (this.deps) {
      this.agentRegistry = new AgentRegistry();
      // 注册默认Agent
      this.agentRegistry.register({
        id: 'default-agent',
        name: '默认执行Agent',
        capabilities: [
          {
            name: '通用任务执行',
            description: '处理各类通用任务',
            tools: ['*'],
          },
        ],
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });

      // 创建OrchestratorAgent
      this.orchestratorAgent = new OrchestratorAgent({
        registry: this.agentRegistry,
        llm: {
          decomposeGoal: async (goal: string, context?: string) => {
            try {
              const prompt = `请将以下目标分解为可执行的步骤，每个步骤应该是一个独立的任务。请返回JSON格式，格式为 {"tasks": [{"id": "步骤id", "goal": "步骤描述", "dependencies": ["依赖的步骤id"], "priority": 5}]}\n\n目标: ${goal}\n${context ? `上下文: ${context}` : ''}`;
              const response = await this.deps!.llm.chat(prompt);
              const jsonMatch = response.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return parsed.tasks || [];
              }
            } catch {
              Logger.warn('LLM目标分解失败，使用默认分解', 'AgentHarness');
            }
            return [
              {
                id: 'step-1',
                goal,
                context,
                dependencies: [],
                priority: 5,
                status: 'pending' as const,
              },
            ];
          },
        },
        config: {
          enableMultiAgent: true,
          complexityThreshold: 'complex',
          maxSubAgents: 3,
        },
      });
      Logger.info('  🤖 多Agent编排: 启用 (内部初始化)', 'AgentHarness');
    }

    // Phase 3: 验证层初始化
    if (this.config.useHarnessVerification) {
      this.verificationService = new VerificationService(
        this.deps ? { llm: this.deps.llm } : {}
      );
      Logger.info('  ✅ 验证层: 启用', 'AgentHarness');
    }

    // Phase 4: 持久化层初始化
    if (this.config.useHarnessPersistence) {
      this.persistenceService = new PersistenceService(
        this.deps?.persistenceDeps || {}
      );
      await this.persistenceService.initialize();
      Logger.info('  💾 持久化层: 启用', 'AgentHarness');
    }

    // Phase 4.2: 独立评估服务初始化（P0 核心功能）
    if (this.config.useIndependentEvaluator && this.deps) {
      this.independentEvaluationService = new IndependentEvaluationService({
        llm: this.deps.llm,
        enableLLMEvaluation: true,
      });
      Logger.info('  📋 独立评估服务: 启用', 'AgentHarness');
    }

    // Phase 4.5: 轨迹持久化初始化
    if (this.config.useTrajectoryPersistence) {
      const dbPath = path.resolve(
        process.cwd(),
        'data',
        'trajectory',
        'trajectory.db'
      );
      this.trajectoryDatabase = new TrajectoryDatabase(dbPath);

      // P3: 注入语义嵌入函数 — 使 TrajectoryDatabase 支持语义相似度检索
      try {
        const { SemanticSimilarityEngine } =
          await import('../memory/SemanticSimilarityEngine');
        const semanticEngine = new SemanticSimilarityEngine();
        await semanticEngine.initialize();
        this.trajectoryDatabase.setEmbedFunction((text: string) => {
          const vector = semanticEngine.generateVectorSync(text);
          return vector;
        });
        Logger.info('  📐 语义嵌入: 已注入 TrajectoryDatabase', 'AgentHarness');
      } catch (semErr) {
        Logger.warn(
          `  ⚠️ 语义嵌入注入失败，回退到关键词检索: ${(semErr as Error).message}`,
          'AgentHarness'
        );
      }

      Logger.info('  📊 轨迹持久化: 启用', 'AgentHarness');
    }

    // Phase 1 (Event Sourcing): EventStore + EventStoreBridge 初始化
    try {
      this.eventStore = new EventStore();
      this.eventStore.initialize();

      if (this.deps?.eventBus) {
        const sessionId = `session_${Date.now()}`;
        this.eventStoreBridge = new EventStoreBridge(
          this.deps.eventBus,
          this.eventStore,
          { sessionId }
        );
        this.eventStoreBridge.start();
        Logger.info(
          `  📦 事件溯源: 启用 (EventStore + Bridge, sessionId=${sessionId})`,
          'AgentHarness'
        );
      } else {
        Logger.info(
          '  📦 事件溯源: EventStore 启用（无 EventBus，Bridge 未启动）',
          'AgentHarness'
        );
      }
    } catch (err) {
      Logger.warn(
        `  ⚠️ 事件溯源初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.eventStore = null;
      this.eventStoreBridge = null;
    }

    // Phase 5: 上下文层初始化
    if (this.config.useHarnessContext && this.deps) {
      this.contextManager = new ContextManager({
        constitutionalBuilder: this.deps.constitutionalBuilder,
        memoryInjector: this.deps.memoryInjector,
        dynamicContext: this.deps.dynamicContext,
        historyProvider: this.deps.historyProvider,
        personaCore: this.deps.personaCore,
        environmentSensor: this.deps.environmentSensor,
        evolutionExamples: this.deps.evolutionExamples,
        referenceResolver: this.deps.contextReferenceResolver || undefined,
      });
      Logger.info('  📋 上下文层: 启用', 'AgentHarness');
      if (this.deps.personaCore) {
        Logger.info(
          '  🎭 进化闭环: PersonaCore 语气注入已连通',
          'AgentHarness'
        );
      }
    }

    // Phase 6: 循环层已迁移到 Python 后端（agent/loop/controller.py）
    // TS 本地循环层（LoopController/Executor/Planner/Evaluator/ReflectionEngine）已删除
    // 当 AGENT_BACKEND=python（默认）时由 PythonAgentBridge 处理
    Logger.info(
      '  🔄 循环层: 由 Python 后端处理（AGENT_BACKEND=python）',
      'AgentHarness'
    );

    // P3: 订阅 learning_signal 事件，转发到 StrategyAdjuster
    if (this.deps?.eventBus) {
      this.deps.eventBus.on('learning_signal', (payload: unknown) => {
        try {
          const signal =
            payload as import('../evolution/LearningSignalCollector').LearningSignal;
          this.strategyAdjuster.recordSignal({
            signalType: signal.signalType,
            toolName: signal.toolName,
            error: signal.error,
            quality: signal.quality,
            duration: signal.duration,
            timestamp: signal.timestamp,
          });
        } catch {
          // 学习信号处理失败不影响主流程
        }
      });
      Logger.info('  📡 学习信号订阅: 已注册', 'AgentHarness');
    }

    // Phase 6.5: 注册敏感信息存储拦截钩子（由独立方法管理，不嵌入初始化流程）
    await this.registerSensitiveDataHooks();

    // Phase 6.6: LSP 集成层初始化
    try {
      this.lspClientManager = LspClientManager.getInstance();
      this.lspDiagnosticsProvider = new LspDiagnosticsProvider(
        this.lspClientManager
      );
      this.lspCompletionProvider = new LspCompletionProvider(
        this.lspClientManager
      );

      if (this.deps?.workspaceRootUri) {
        this.lspClientManager.configureWorkspace({
          rootUri: this.deps.workspaceRootUri,
          folders: [{ uri: this.deps.workspaceRootUri }],
        });
      }

      Logger.info(
        '  🌐 LSP 集成层: 启用（按需连接语言服务器）',
        'AgentHarness'
      );
    } catch (err) {
      Logger.warn(
        `  ⚠️ LSP 集成层初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.lspClientManager = null;
      this.lspDiagnosticsProvider = null;
      this.lspCompletionProvider = null;
    }

    // Phase 3: 会话存储 + Cron调度器 + Skill注册中心
    try {
      this.sessionStore = new SessionStore();
      Logger.info(
        `  🗄️ 会话存储: 已就绪 (${this.sessionStore.getStats().sessions} 个会话)`,
        'AgentHarness'
      );
    } catch (err) {
      Logger.warn(
        `  ⚠️ 会话存储初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.sessionStore = null;
    }

    try {
      this.cronScheduler = CronJobScheduler.getInstance();
      this.cronScheduler.start();
      Logger.info(
        `  ⏰ Cron调度器: 已启动 (${this.cronScheduler.getJobs().length} 个任务)`,
        'AgentHarness'
      );
    } catch (err) {
      Logger.warn(
        `  ⚠️ Cron调度器初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.cronScheduler = null;
    }

    try {
      this.skillRegistry = SkillRegistry.getInstance();
      Logger.info(
        `  🔧 Skill注册中心: 已就绪 (${this.skillRegistry.getSkillCount()} 个技能)`,
        'AgentHarness'
      );
    } catch (err) {
      Logger.warn(
        `  ⚠️ Skill注册中心初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.skillRegistry = null;
    }

    // Phase 4: ACP 活动追踪器 + 消息处理层 + i18n
    try {
      this.acpTracker = ACPActivityTracker.getInstance();
      Logger.info(`  📡 ACP活动追踪器: 已就绪`, 'AgentHarness');
    } catch (err) {
      Logger.warn(
        `  ⚠️ ACP活动追踪器初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.acpTracker = null;
    }

    try {
      this.messageProcessor = MessageProcessor.getInstance();
      Logger.info(`  📨 消息处理层: 已就绪`, 'AgentHarness');
    } catch (err) {
      Logger.warn(
        `  ⚠️ 消息处理层初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.messageProcessor = null;
    }

    try {
      this.i18nManager = I18nManager.getInstance();
      Logger.info(
        `  🌐 i18n管理器: 已就绪 (${this.i18nManager.getLocale()}, ${this.i18nManager.getStats().totalKeys} 条消息)`,
        'AgentHarness'
      );
    } catch (err) {
      Logger.warn(
        `  ⚠️ i18n管理器初始化失败（非阻塞）: ${(err as Error).message}`,
        'AgentHarness'
      );
      this.i18nManager = null;
    }

    // Phase 7: 注册进化反馈钩子（闭环）
    if (this.constraintsService && this.deps?.evolutionEngine) {
      this.constraintsService.registerHook(
        LifecycleEvent.AFTER_RESPONSE,
        async (hookCtx: HookContext) => {
          const evo = this.deps!.evolutionEngine!;
          const input = String(hookCtx.metadata.input || '');
          const response = String(hookCtx.metadata.response || '');
          const quality = hookCtx.metadata.quality as
            | { overall: number }
            | undefined;
          const traceId = String(hookCtx.metadata.traceId || '');
          const toolsUsedRaw = hookCtx.metadata.toolsUsed;
          const toolsUsed = Array.isArray(toolsUsedRaw)
            ? (toolsUsedRaw as string[])
            : [];

          try {
            await evo.collectFeedback(input, response, {
              success: true,
              toolsUsed,
            });

            if (quality) {
              await evo.assessQuality(traceId, true, quality.overall, 0);
            }

            // 高质量任务 → 自动生成 SKILL.md
            if (quality && quality.overall >= 0.7) {
              const metadata = hookCtx.metadata;
              await evo.generateSkill({
                input,
                response,
                toolsUsed,
                totalDuration: (typeof metadata.duration === 'number'
                  ? metadata.duration
                  : 0) as number,
                qualityScore: quality.overall,
                traceId,
              });
            }
          } catch (evoErr) {
            Logger.warn(
              `进化反馈记录失败（已忽略，不影响主响应）: ${
                (evoErr as Error)?.message ?? String(evoErr)
              }`,
              'AgentHarness'
            );
          }

          // 跟踪本次使用的工具中是否有已注册的 skill
          for (const toolName of toolsUsed) {
            skillUsageTracker.trackUse(toolName);
          }

          if (this.persistenceService) {
            this.persistenceService.recordEvolutionMetric({
              metricType: 'feedback',
              value: quality?.overall ?? 0.7,
              timestamp: Date.now(),
              metadata: {
                traceId,
                inputLength: input.length,
                responseLength: response.length,
              },
            });
          }

          return { proceed: true };
        }
      );
      Logger.info('  🧬 进化闭环: 启用', 'AgentHarness');
    }

    // Phase 7.5: 注册调度任务完成事件监听（反馈闭环）
    if (this.deps?.evolutionEngine) {
      EventBus.on('scheduled_task_completed', (payload: unknown) => {
        const data = payload as {
          taskId: string;
          taskName: string;
          success: boolean;
          executionTime: number;
          timestamp: string;
          error?: string;
        };
        Logger.info(
          `📊 调度任务完成事件: ${data.taskName} (${data.success ? '成功' : '失败'})`,
          'AgentHarness'
        );

        // 调用 EvolutionEngine 收集反馈
        this.deps!.evolutionEngine!.collectFeedback(
          `调度任务: ${data.taskName}`,
          data.success
            ? '任务执行成功'
            : `任务执行失败: ${data.error || '未知错误'}`,
          {
            success: data.success,
            intent: data.taskId,
            error: data.error,
          },
          'scheduler'
        );
      });
      Logger.info('  📊 调度任务反馈监听: 启用', 'AgentHarness');
    }

    // Phase 7.6: 注册文件变更事件监听（记录文件变更历史）
    EventBus.on('file_changed', (payload: unknown) => {
      const data = payload as {
        filePath: string;
        changeType: 'created' | 'modified' | 'deleted' | 'renamed';
        timestamp: string;
        matchedRules: Array<{ id: string; name: string; action: string }>;
      };
      Logger.debug(
        `📁 文件变更: ${path.basename(data.filePath)} (${data.changeType})`,
        'AgentHarness'
      );

      // 记录文件变更到持久化服务
      if (this.persistenceService) {
        this.persistenceService.recordEvolutionMetric({
          metricType: 'file_change',
          value: 1,
          timestamp: Date.now(),
          metadata: {
            filePath: data.filePath,
            changeType: data.changeType,
            timestamp: data.timestamp,
            matchedRulesCount: data.matchedRules.length,
          },
        });
      }
    });
    Logger.info('  📁 文件变更监听: 启用', 'AgentHarness');

    // Phase 7.8: 注册 FeedbackLoops 闭环钩子
    if (this.deps?.feedbackCollector && this.constraintsService) {
      try {
        const { FeedbackLoops } = await import('./loops/FeedbackLoops');
        const feedbackLoops = new FeedbackLoops({
          feedbackCollector: this.deps.feedbackCollector,
          evolutionEngine: this.deps.evolutionEngine,
          memoryAssistant: this.deps.memoryAssistant,
        });
        this.constraintsService.registerHook(
          LifecycleEvent.AFTER_RESPONSE,
          feedbackLoops.createAFTER_RESPONSEHook()
        );
        Logger.info('  🔄 FeedbackLoops 闭环钩子: 已注册', 'AgentHarness');
      } catch (fbErr) {
        Logger.warn(
          `  ⚠️ FeedbackLoops 加载失败: ${(fbErr as Error).message}`,
          'AgentHarness'
        );
      }
    }

    this.initialized = true;
    Logger.info('✅ Agent Harness 初始化完成', 'AgentHarness');
  }

  /**
   * 处理用户输入（TS 入口壳，非 Agent 核心）。
   *
   * Agent 核心（ReAct / Loop / 工具调用 / 记忆）已在 Python 端实现（agent/loop、agent/core）。
   * 本方法优先经 PythonAgentBridge 路由到 Python 后端（AGENTS.md §0.1）；
   * 仅当桥接不可用时退化为单次 LLM 直答（TS 本地不再实现 ReAct 循环）。
   */
  async processInput(input: UserInput): Promise<AgentResult> {
    const llm = this.deps?.llm;
    if (!llm) {
      return {
        response: '系统尚未就绪，请稍后重试。',
        quality: {
          overall: 0,
          accuracy: 0,
          usefulness: 0,
          friendliness: 0,
          efficiency: 0,
          details: 'LLM不可用',
        },
        trace: {
          traceId: input.traceId || `harness_${Date.now()}`,
          state: LoopState.FAILED,
          stateTransitions: [],
          trajectory: [],
          totalDuration: 0,
          totalToolCalls: 0,
          budgetState: {
            roundsUsed: 0,
            softRoundLimit: 5,
            hardRoundLimit: 5,
            tokensUsed: 0,
            tokenWarningLimit: 0,
            tokenHardLimit: 0,
            startTime: Date.now(),
            maxDurationMs: 60000,
            toolCallsUsed: 0,
            maxToolCalls: 20,
          },
        },
        metadata: { loopRounds: 0 },
      };
    }

    try {
      const { getPythonBridge } = await import('../server/bootstrap');
      const bridge = getPythonBridge();
      if (bridge) {
        const result = await bridge.processInput(
          input.text,
          input.userId || 'default',
          input.traceId
        );
        const qualityScore = result.qualityScore ?? 0.8;
        const totalToolCalls = result.toolCallsMade ?? 0;
        const roundsUsed = result.roundsUsed ?? 1;
        const totalDuration = result.duration ?? 0;
        return {
          response: result.response || '',
          quality: {
            overall: qualityScore,
            accuracy: qualityScore,
            usefulness: Math.min(qualityScore + 0.05, 1),
            friendliness: Math.min(qualityScore + 0.1, 1),
            efficiency: totalToolCalls > 0 ? Math.max(qualityScore - 0.05, 0) : qualityScore,
            details: `Python backend response (tools=${totalToolCalls}, rounds=${roundsUsed}, duration=${totalDuration}ms)`,
          },
          trace: {
            traceId: result.traceId || input.traceId || `harness_${Date.now()}`,
            state: LoopState.COMPLETED,
            stateTransitions: [{
              state: LoopState.COMPLETED,
              timestamp: Date.now(),
              duration: totalDuration,
              result: result.finishReason || 'stop',
            }],
            trajectory: totalToolCalls > 0 ? [{
              type: 'tool_call',
              timestamp: Date.now() - totalDuration,
              duration: totalDuration,
              toolName: 'python_backend_loop',
              metadata: {
                toolCallsMade: totalToolCalls,
                roundsUsed,
                finishReason: result.finishReason,
              },
            }] : [],
            totalDuration,
            totalToolCalls,
            budgetState: {
              roundsUsed,
              softRoundLimit: 5,
              hardRoundLimit: 5,
              tokensUsed: 0,
              tokenWarningLimit: 0,
              tokenHardLimit: 0,
              startTime: Date.now() - totalDuration,
              maxDurationMs: 60000,
              toolCallsUsed: totalToolCalls,
              maxToolCalls: 20,
            },
          },
          metadata: { loopRounds: roundsUsed, backend: 'python', finishReason: result.finishReason },
        };
      }
    } catch (bridgeErr) {
      Logger.warn(
        `Python bridge unavailable, falling back to local LLM: ${(bridgeErr as Error).message}`,
        'AgentHarness'
      );
    }

    // TS 本地回退：Python 桥接不可用时，直接用 LLM 生成回复
    if (this.deps?.llm) {
      try {
        const llmResponse = await this.deps.llm.chat(
          input.text,
          '你是一个智能助手，请直接回答问题。'
        );
        const responseText =
          typeof llmResponse === 'string' ? llmResponse : String(llmResponse);
        return {
          response: responseText,
          quality: {
            overall: 0.7,
            accuracy: 0.7,
            usefulness: 0.7,
            friendliness: 0.7,
            efficiency: 0.7,
            details: 'TS local fallback',
          },
          trace: {
            traceId: input.traceId || `harness_${Date.now()}`,
            state: LoopState.COMPLETED,
            stateTransitions: [],
            trajectory: [],
            totalDuration: 0,
            totalToolCalls: 0,
            budgetState: {
              roundsUsed: 1,
              softRoundLimit: 5,
              hardRoundLimit: 5,
              tokensUsed: 0,
              tokenWarningLimit: 0,
              tokenHardLimit: 0,
              startTime: Date.now(),
              maxDurationMs: 60000,
              toolCallsUsed: 0,
              maxToolCalls: 20,
            },
          },
          metadata: { loopRounds: 1, backend: 'ts_local' },
        };
      } catch (llmErr) {
        Logger.warn(
          `Local LLM also failed: ${(llmErr as Error).message}`,
          'AgentHarness'
        );
      }
    }

    return {
      response: 'Agent 后端不可用，请检查 Python 服务状态。',
      quality: {
        overall: 0,
        accuracy: 0,
        usefulness: 0,
        friendliness: 0,
        efficiency: 0,
        details: 'Backend unavailable',
      },
      trace: {
        traceId: input.traceId || `harness_${Date.now()}`,
        state: LoopState.FAILED,
        stateTransitions: [],
        trajectory: [],
        totalDuration: 0,
        totalToolCalls: 0,
        budgetState: {
          roundsUsed: 0,
          softRoundLimit: 5,
          hardRoundLimit: 5,
          tokensUsed: 0,
          tokenWarningLimit: 0,
          tokenHardLimit: 0,
          startTime: Date.now(),
          maxDurationMs: 60000,
          toolCallsUsed: 0,
          maxToolCalls: 20,
        },
      },
      metadata: { loopRounds: 0, backend: 'unavailable' },
    };
  }

  /**
   * 执行生命周期钩子
   */
  private async executeHook(
    event: LifecycleEvent,
    extra: Record<string, unknown>
  ): Promise<void> {
    if (!this.constraintsService) return;

    try {
      const hookContext: HookContext = {
        event,
        metadata: extra,
      };

      const result = await this.constraintsService.executeHooks(
        event,
        hookContext
      );

      if (!result.proceed) {
        Logger.info(
          `🛑 钩子拦截: ${event} - ${result.reason || '未提供原因'}`,
          'AgentHarness'
        );
      }
    } catch (err) {
      Logger.warn(
        `⚠️ 生命周期钩子执行失败: ${event} - ${(err as Error).message}`,

        'AgentHarness'
      );
    }
  }

  /**
   * 获取工具注册表
   */
  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  /**
   * 获取 Schema 验证器
   */
  getSchemaValidator(): SchemaValidator | null {
    return this.schemaValidator;
  }

  /**
   * 获取权限守卫
   */
  getPermissionGuard(): PermissionGuard | null {
    return this.permissionGuard;
  }

  /**
   * 获取上下文管理器
   */
  getContextManager(): ContextManager | null {
    return this.contextManager;
  }

  /**
   * 获取验证服务
   */
  getVerificationService(): VerificationService | null {
    return this.verificationService;
  }

  /**
   * 获取约束服务
   */
  getConstraintsService(): ConstraintsService | null {
    return this.constraintsService;
  }

  /**
   * 获取持久化服务
   */
  getPersistenceService(): PersistenceService | null {
    return this.persistenceService;
  }

  /**
   * 获取轨迹数据库
   */
  getTrajectoryDatabase(): TrajectoryDatabase | null {
    return this.trajectoryDatabase;
  }

  getEventStore(): EventStore | null {
    return this.eventStore;
  }

  getEventStoreBridge(): EventStoreBridge | null {
    return this.eventStoreBridge;
  }

  /**
   * 注入 TrajectoryFlywheel（已迁移到 Python 后端，此方法为空操作）
   */
  injectTrajectoryFlywheel(_flywheel: {
    analyze(
      executionId?: string
    ): import('./persistence/TrajectoryFlywheel').TrajectoryAnalysis;
  }): void {
    Logger.info(
      '🔄 TrajectoryFlywheel 注入已跳过（循环层已迁移到 Python）',
      'AgentHarness'
    );
  }

  /**
   * 获取独立评估服务（P0 核心功能）
   */
  getIndependentEvaluationService(): IndependentEvaluationService | null {
    return this.independentEvaluationService;
  }

  /**
   * 获取沙箱执行器
   */
  getSandboxExecutor(): SandboxExecutor | null {
    return this.sandboxExecutor;
  }

  /**
   * 获取 LSP 客户端管理器
   */
  getLspClientManager(): LspClientManager | null {
    return this.lspClientManager;
  }

  /**
   * 获取 LSP 诊断提供器
   */
  getLspDiagnosticsProvider(): LspDiagnosticsProvider | null {
    return this.lspDiagnosticsProvider;
  }

  /**
   * 获取 LSP 补全提供器
   */
  getLspCompletionProvider(): LspCompletionProvider | null {
    return this.lspCompletionProvider;
  }

  /**
   * 获取会话存储
   */
  getSessionStore(): SessionStore | null {
    return this.sessionStore;
  }

  /**
   * 获取 Cron 调度器
   */
  getCronScheduler(): CronJobScheduler | null {
    return this.cronScheduler;
  }

  /**
   * 获取 Skill 注册中心
   */
  getSkillRegistry(): SkillRegistry | null {
    return this.skillRegistry;
  }

  getACPTracker(): ACPActivityTracker | null {
    return this.acpTracker;
  }

  getMessageProcessor(): MessageProcessor | null {
    return this.messageProcessor;
  }

  getI18nManager(): I18nManager | null {
    return this.i18nManager;
  }

  /**
   * 获取 Harness 配置
   */
  getConfig(): Readonly<HarnessConfig> {
    return this.config;
  }

  /**
   * 中止当前执行循环（已迁移到 Python 后端，此方法为空操作）
   */
  abortCurrentLoop(): void {
    Logger.info(
      '🛑 AgentHarness: 中止信号已跳过（循环层已迁移到 Python）',
      'AgentHarness'
    );
  }

  /**
   * 更新配置（运行时热更新）
   */
  updateConfig(partial: Partial<HarnessConfig>): void {
    this.config = { ...this.config, ...partial };
    Logger.info(`Harness 配置更新: ${JSON.stringify(partial)}`, 'AgentHarness');
  }

  /**
   * 关闭 Harness
   */
  async shutdown(): Promise<void> {
    Logger.info('🏗️ Agent Harness 关闭', 'AgentHarness');
    this.initialized = false;

    // Fix: close resources to prevent leaks
    if (this.trajectoryDatabase) {
      try {
        this.trajectoryDatabase.close();
      } catch {
        /* best-effort */
      }
      this.trajectoryDatabase = null;
    }
    if (this.persistenceService) {
      try {
        void (
          this.persistenceService as unknown as {
            shutdown?: () => Promise<void>;
          }
        ).shutdown?.();
      } catch {
        /* best-effort */
      }
      this.persistenceService = null;
    }
    if (this.sandboxExecutor) {
      this.sandboxExecutor = null;
    }
    // Phase 2: 关闭 LSP 连接
    if (this.lspClientManager) {
      try {
        await this.lspClientManager.disconnectAll();
      } catch {
        /* best-effort */
      }
      this.lspClientManager = null;
      this.lspDiagnosticsProvider = null;
      this.lspCompletionProvider = null;
    }
    // Phase 3: 关闭会话存储 + Cron调度器
    if (this.sessionStore) {
      try {
        this.sessionStore.close();
      } catch {
        /* best-effort */
      }
      this.sessionStore = null;
    }
    if (this.cronScheduler) {
      try {
        this.cronScheduler.stop();
      } catch {
        /* best-effort */
      }
      this.cronScheduler = null;
    }
    this.skillRegistry = null;
    if (this.acpTracker) {
      try {
        ACPActivityTracker.resetInstance();
      } catch {
        /* best-effort */
      }
      this.acpTracker = null;
    }
    if (this.messageProcessor) {
      try {
        MessageProcessor.resetInstance();
      } catch {
        /* best-effort */
      }
      this.messageProcessor = null;
    }
    this.i18nManager = null;
  }

  /**
   * 注册敏感数据存储拦截钩子
   * 独立方法避免业务逻辑嵌入约束层初始化流程
   */
  private async registerSensitiveDataHooks(): Promise<void> {
    if (!this.constraintsService) return;
    this.constraintsService.registerHook(
      LifecycleEvent.BEFORE_TOOL_CALL,
      async (hookCtx: HookContext) => {
        const toolName = hookCtx.toolName || '';
        if (toolName === 'memory_store' || toolName === 'note_take') {
          const result = this.constraintsService!.enforceBehaviorConstraint(
            'no-sensitive-storage',
            { toolName, params: hookCtx.params }
          );
          if (!result.compliant) {
            return {
              proceed: false,
              replacementResult: {
                success: false,
                output: `🛡️ 安全拦截: ${result.violation}`,
                duration: 0,
                validated: false,
              },
              reason: result.violation,
            };
          }
        }
        return { proceed: true };
      }
    );
    Logger.info('  🛡️ 敏感数据钩子: 已注册 (约束层外)', 'AgentHarness');
  }
}
