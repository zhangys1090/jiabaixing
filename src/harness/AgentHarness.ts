/**
 * Harness Agent Framework - Agent Harness 入口
 *
 * 六层架构组装点，协调 Loop/Tools/Context/Persistence/Verification/Constraints
 */

import { Logger } from '../utils/Logger';
import path from 'path';
import { LoopController } from './loop/LoopController';
import { Planner } from './loop/Planner';
import { Executor } from './loop/Executor';
import { Evaluator } from './loop/Evaluator';
import { Reporter } from './loop/Reporter';
import { IndependentEvaluationService } from './evaluation/IndependentEvaluationService';
import { ToolRegistry } from './tools/registry/ToolRegistry';
import { SchemaValidator } from './tools/registry/SchemaValidator';
import { PermissionGuard } from './tools/registry/PermissionGuard';
import { ContextManager } from './context/ContextManager';
import { VerificationService } from './verification/VerificationService';
import { ConstraintsService } from './constraints/ConstraintsService';
import { PersistenceService } from './persistence/PersistenceService';
import { TrajectoryDatabase } from './persistence/TrajectoryDatabase';
import { SandboxExecutor } from './sandbox/SandboxExecutor';
import {
  registerHarnessTools,
  syncToLegacySkillRegistry,
  type HarnessToolDeps,
} from './tools/registerHarnessTools';
import {
  UserInput,
  AgentResult,
  ChatMessage,
  LifecycleEvent,
  HookContext,
  LoopState,
} from './types';
import type { HarnessConfig } from './types';
import { type HarnessDeps } from './deps';
import { EventBus } from '../shared/EventBus';

export { type HarnessDeps } from './deps';

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

/** 默认配置 - 全开 */
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
  private loopController: LoopController | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private schemaValidator: SchemaValidator | null = null;
  private permissionGuard: PermissionGuard | null = null;
  private contextManager: ContextManager | null = null;
  private verificationService: VerificationService | null = null;
  private constraintsService: ConstraintsService | null = null;
  private persistenceService: PersistenceService | null = null;
  private trajectoryDatabase: TrajectoryDatabase | null = null;
  // 独立评估服务（P0 核心功能）
  private independentEvaluationService: IndependentEvaluationService | null =
    null;
  // 沙箱执行器（安全隔离）
  private sandboxExecutor: SandboxExecutor | null = null;

  constructor(config?: Partial<HarnessConfig>) {
    const envConfig = getEnvConfig();
    this.config = { ...DEFAULT_CONFIG, ...envConfig, ...config };
  }

  /**
   * 注入依赖
   */
  setDeps(deps: HarnessDeps): void {
    this.deps = deps;
  }

  /**
   * 初始化 Harness 各层
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    Logger.info('🏗️ Agent Harness 初始化中...', 'AgentHarness');

    if (!this.deps) {
      Logger.warn('⚠️ 未注入依赖，部分功能不可用', 'AgentHarness');
    }

    // Phase 1: 工具层初始化
    if (this.config.useHarnessTools) {
      const result = registerHarnessTools(
        this.deps?.toolDeps ?? ({} as HarnessToolDeps)
      );
      this.toolRegistry = result.toolRegistry;
      this.schemaValidator = result.schemaValidator;
      this.permissionGuard = result.permissionGuard;

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
    }

    // Phase 2: 约束层初始化
    if (this.config.useHarnessConstraints) {
      this.constraintsService = new ConstraintsService({
        permissionGuard: this.permissionGuard || new PermissionGuard(),
      });
      Logger.info('  🛡️ 约束层: 启用', 'AgentHarness');
    }

    // Phase 2.5: 沙箱执行器初始化
    this.sandboxExecutor = new SandboxExecutor({
      securityLevel: 'high',
      timeoutMs: 30000,
    });
    Logger.info('  🔒 沙箱执行器: 启用 (安全级别: high)', 'AgentHarness');

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
      Logger.info('  📊 轨迹持久化: 启用', 'AgentHarness');
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
      });
      Logger.info('  📋 上下文层: 启用', 'AgentHarness');
      if (this.deps.personaCore) {
        Logger.info(
          '  🎭 进化闭环: PersonaCore 语气注入已连通',
          'AgentHarness'
        );
      }
    }

    // Phase 6: 循环层初始化 (依赖前面所有层)
    if (this.config.useHarnessLoop && this.deps) {
      const planner = new Planner({
        llm: this.deps.llm,
        evolutionExamples: this.deps.evolutionExamples,
      });
      const executor = new Executor({
        llm: this.deps.llm,
        toolRegistry: this.toolRegistry || new ToolRegistry(),
        schemaValidator: this.schemaValidator || new SchemaValidator(),
        permissionGuard: this.permissionGuard || new PermissionGuard(),
        verificationService: this.verificationService || undefined,
        constraintsService: this.constraintsService || undefined,
        trajectoryDatabase: this.trajectoryDatabase || undefined,
        // 非侵入式 hooks 适配器 —— 桥接约束/验证/轨迹到 Executor
        hooks: {
          beforeToolCall: async (toolName, params, ctx) => {
            // 0. 沙箱权限检查
            if (this.sandboxExecutor) {
              const sandboxCheck = this.sandboxExecutor.checkToolPermission(
                toolName,
                params
              );
              if (!sandboxCheck.allowed) {
                return {
                  proceed: false,
                  reason: sandboxCheck.reason,
                  replacementResult: {
                    success: false,
                    output: `🛡️ 沙箱拦截: ${sandboxCheck.reason}`,
                    error: sandboxCheck.reason,
                    duration: 0,
                    validated: false,
                  },
                };
              }
            }

            // 1. 执行生命周期钩子（约束层）
            if (this.constraintsService) {
              const hookResult = await this.constraintsService.executeHooks(
                LifecycleEvent.BEFORE_TOOL_CALL,
                {
                  event: LifecycleEvent.BEFORE_TOOL_CALL,
                  toolName,
                  params,
                  loopState:
                    LifecycleEvent.BEFORE_TOOL_CALL as unknown as LoopState,
                  metadata: { traceId: ctx.traceId, loopCount: ctx.loopCount },
                }
              );
              if (!hookResult.proceed) {
                return {
                  proceed: false,
                  reason: hookResult.reason,
                  replacementResult: hookResult.replacementResult,
                };
              }
              if (hookResult.modifiedParams) {
                return {
                  proceed: true,
                  modifiedParams: hookResult.modifiedParams,
                };
              }
            }
            // 2. Schema 验证（工具层）
            const registeredTool = this.toolRegistry?.get(toolName);
            if (registeredTool && this.schemaValidator) {
              const validation = this.schemaValidator.validate(
                params,
                registeredTool.definition.parameters,
                registeredTool.definition.requiredParams
              );
              if (!validation.valid && validation.sanitizedParams) {
                return {
                  proceed: true,
                  modifiedParams: validation.sanitizedParams,
                };
              }
            }
            return { proceed: true };
          },
          afterToolCall: async (toolName, result) => {
            // 安全检查（验证层）
            let safeOutput =
              typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output);
            if (this.verificationService) {
              const safetyCheck =
                this.verificationService.checkOutputSafety(safeOutput);
              if (safetyCheck.sanitizedOutput) {
                safeOutput = safetyCheck.sanitizedOutput;
              }
            }
            return { ...result, output: safeOutput, validated: true };
          },
          onToolError: async (toolName, error, ctx) => {
            Logger.warn(`🛑 工具错误: ${toolName} - ${error}`, 'AgentHarness');
            if (this.constraintsService) {
              await this.constraintsService.executeHooks(
                LifecycleEvent.ON_ERROR,
                {
                  event: LifecycleEvent.ON_ERROR,
                  toolName,
                  metadata: { traceId: ctx.traceId, error },
                }
              );
            }
          },
          recordTrajectory: (step) => {
            if (this.trajectoryDatabase) {
              try {
                const toolResult = step.toolResult;
                if (toolResult && step.metadata) {
                  const meta = step.metadata as Record<string, unknown>;
                  this.trajectoryDatabase.recordToolInvocation({
                    execution_id: String(meta.execution_id || ''),
                    step_index: 0,
                    tool_name: step.toolName || '',
                    args_json: '{}',
                    result_success: toolResult.success ? 1 : 0,
                    duration: step.duration || 0,
                    created_at: Date.now(),
                  });
                }
              } catch (err) {
                Logger.warn(
                  `⚠️ 轨迹记录失败: ${(err as Error).message}`,
                  'AgentHarness'
                );
              }
            }
          },
        },
      });
      // H1 fix: rule-based evaluation by default, LLM eval only for ambiguous cases
      const evaluator = new Evaluator({
        llm: this.deps.llm,
        enableLLMEvaluation: false,
      });
      const reporter = new Reporter();

      this.loopController = new LoopController({
        planner,
        executor,
        evaluator,
        reporter,
        constraintsService: this.constraintsService || undefined,
        verificationService: this.verificationService || undefined,
        persistenceService: this.persistenceService || undefined,
        trajectoryDatabase: this.trajectoryDatabase || undefined,
      });
      Logger.info('  🔄 循环层: 启用', 'AgentHarness');
    }

    // Phase 6.5: 注册敏感信息存储拦截钩子（由独立方法管理，不嵌入初始化流程）
    await this.registerSensitiveDataHooks();

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
          const toolsUsed = hookCtx.metadata.toolsUsed as string[] | undefined;

          evo.collectFeedback(input, response, {
            success: true,
            toolsUsed: toolsUsed || [],
          });

          if (quality) {
            evo.assessQuality(traceId, true, quality.overall, 0);
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

    this.initialized = true;
    Logger.info('✅ Agent Harness 初始化完成', 'AgentHarness');
  }

  /**
   * 处理用户输入
   */
  async processInput(input: UserInput): Promise<AgentResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // 使用 Harness 循环层
    if (this.config.useHarnessLoop && this.loopController && this.deps) {
      // 发送 Harness 开始处理的信号
      void EventBus.emit('agent_execution_update', {
        traceId: input.traceId ?? '',
        phase: 'harness_start',
        status: 'started',
        timestamp: new Date().toISOString(),
      });

      // Step 1: 触发 BEFORE_LOOP 钩子
      await this.executeHook(LifecycleEvent.BEFORE_LOOP, {
        input: input.text,
        userId: input.userId,
        traceId: input.traceId,
      });

      // 构建上下文
      let messages: ChatMessage[];
      if (this.config.useHarnessContext && this.contextManager) {
        // 发送构建上下文的信号
        void EventBus.emit('agent_execution_update', {
          traceId: input.traceId ?? '',
          phase: 'building_context',
          status: 'in_progress',
          timestamp: new Date().toISOString(),
        });
        messages = await this.contextManager.buildContext(input);
      } else {
        // 降级：简单上下文
        messages = [
          { role: 'system', content: '你是一个智能助手。' },
          { role: 'user', content: input.text },
        ];
      }

      const result = await this.loopController.run(input, messages);

      // F0-05: 对话结果回写记忆，确保跨会话持久化
      if (this.deps.memoryStore && result.response) {
        try {
          await this.deps.memoryStore.storeConversation(
            input.text,
            result.response,
            {
              userId: input.userId,
              traceId: result.trace.traceId,
              quality: result.quality.overall,
              toolCalls: result.metadata.toolCalls,
              duration: result.metadata.duration,
            }
          );
          Logger.debug('💾 对话结果已回写记忆', 'AgentHarness');
        } catch (err) {
          Logger.warn(
            `⚠️ 记忆回写失败: ${(err as Error).message}`,
            'AgentHarness'
          );
        }
      }

      // Step 2: 触发 AFTER_RESPONSE 钩子
      await this.executeHook(LifecycleEvent.AFTER_RESPONSE, {
        input: input.text,
        response: result.response,
        quality: result.quality,
        traceId: result.trace.traceId,
        toolsUsed: result.metadata.toolCalls,
        metadata: result.metadata,
      });

      return result;
    }

    // 未启用 Harness 循环层
    throw new Error(
      'AgentHarness 循环层未启用。请设置 useHarnessLoop=true 并注入依赖。'
    );
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
   * 获取 Harness 配置
   */
  getConfig(): Readonly<HarnessConfig> {
    return this.config;
  }

  /**
   * 中止当前执行循环
   */
  abortCurrentLoop(): void {
    if (this.loopController) {
      (this.loopController as unknown as { abort(): void }).abort();
      Logger.info('🛑 AgentHarness: 已发送中止信号', 'AgentHarness');
    }
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
    this.loopController = null;
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
