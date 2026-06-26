/**
 * 策略适配器
 *
 * 职责：根据 LLM 能力探测结果，动态调整 Agent 的策略配置
 * 设计：
 *  - 接收 LLMCapabilities，输出策略配置建议
 *  - 调整范围：Prompt策略、规划深度、工具使用、反思深度
 *  - 通过回调机制将配置应用到各模块
 *  - 持久化策略配置，重启后可恢复
 *
 * 集成点：EvolutionOrchestrator.triggerCapabilityDrivenEvolution()
 */

import { Logger } from '../utils/Logger';
import { LLMCapabilities } from './LLMCapabilityDetector';

/** 策略配置 — 由 StrategyAdapter 输出，各模块消费 */
export interface StrategyConfig {
  /** Prompt 策略 */
  prompt: {
    /** 推理自由度：high=给LLM更多自由度，structured=结构化引导 */
    reasoningFreedom: 'high' | 'medium' | 'structured';
    /** 输出严格度：strict=要求严格JSON格式，flexible=允许自然语言 */
    outputStrictness: 'strict' | 'moderate' | 'flexible';
    /** 上下文注入深度：deep=注入更多上下文，shallow=精简上下文 */
    contextInjectionDepth: 'deep' | 'moderate' | 'shallow';
    /** 工具链复杂度：complex=允许多步工具链，simple=单工具调用 */
    toolChainComplexity: 'complex' | 'moderate' | 'simple';
    /** 是否启用 CoT 推理过程 */
    enableCoT: boolean;
  };

  /** 规划策略 */
  planning: {
    /** 是否启用 Tree of Thoughts 多路径规划 */
    enableToT: boolean;
    /** 是否启用因果建模 */
    enableCausalModeling: boolean;
    /** 最大规划深度（步骤数） */
    maxPlanDepth: number;
    /** 是否启用动态重规划 */
    enableDynamicReplanning: boolean;
    /** 是否启用并行规划 */
    enableParallelPlanning: boolean;
  };

  /** 工具使用策略 */
  toolUse: {
    /** 是否允许工具链组合 */
    enableToolChaining: boolean;
    /** 最大连续工具调用数 */
    maxConsecutiveToolCalls: number;
    /** 是否启用工具预测 */
    enableToolPrediction: boolean;
    /** 工具失败后最大重试次数 */
    maxRetriesPerTool: number;
  };

  /** 反思策略 */
  reflection: {
    /** 反思深度：deep=任务级反思，shallow=工具级反思 */
    depth: 'deep' | 'shallow';
    /** 是否启用跨轮次反思 */
    enableCrossTurnReflection: boolean;
    /** 是否将反思结果注入规划 */
    injectReflectionToPlanning: boolean;
    /** 最大反思轮次 */
    maxReflectionRounds: number;
  };

  /** 执行策略 */
  execution: {
    /** 是否启用执行中调控 */
    enableAdaptiveControl: boolean;
    /** 风险评估阈值（0-1，超过则先评估再执行） */
    riskAssessmentThreshold: number;
    /** 是否启用并行执行 */
    enableParallelExecution: boolean;
    /** 执行质量阈值（低于则触发重规划） */
    qualityThreshold: number;
  };

  /** 配置版本和时间戳 */
  version: string;
  appliedAt: number;
  /** 关联的 LLM 能力评分 */
  llmOverallScore: number;
}

/** 策略应用回调 */
export interface StrategyApplicationCallbacks {
  onPromptConfigUpdate?(config: StrategyConfig['prompt']): void;
  onPlanningConfigUpdate?(config: StrategyConfig['planning']): void;
  onToolUseConfigUpdate?(config: StrategyConfig['toolUse']): void;
  onReflectionConfigUpdate?(config: StrategyConfig['reflection']): void;
  onExecutionConfigUpdate?(config: StrategyConfig['execution']): void;
}

/** 持久化接口 */
interface StrategyPersistenceInterface {
  saveEnvironmentState(state: Record<string, unknown>): void;
  loadEnvironmentState(): Record<string, unknown> | null;
}

/**
 * 策略适配器 — 根据 LLM 能力动态调整 Agent 策略
 */
export class StrategyAdapter {
  private static readonly STORAGE_KEY = 'strategy_config';
  private static readonly VERSION = '1.0.0';

  private currentConfig: StrategyConfig | null = null;
  private callbacks: StrategyApplicationCallbacks = {};
  private persistence: StrategyPersistenceInterface | null = null;

  /**
   * 设置应用回调
   */
  setCallbacks(callbacks: StrategyApplicationCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 设置持久化服务
   */
  setPersistence(persistence: StrategyPersistenceInterface): void {
    this.persistence = persistence;
    this.loadSavedConfig();
    Logger.info('🔧 策略适配器已连接持久化', 'StrategyAdapter');
  }

  /**
   * 根据 LLM 能力适配策略
   */
  async adaptStrategies(
    capabilities: LLMCapabilities
  ): Promise<StrategyConfig> {
    Logger.info(
      `🔧 开始适配策略 (LLM评分: ${capabilities.overallScore.toFixed(1)}/10)`,
      'StrategyAdapter'
    );

    const config = this.buildStrategyConfig(capabilities);

    // 应用配置
    await this.applyConfig(config);

    // 持久化
    this.currentConfig = config;
    this.persistConfig();

    Logger.info(
      `🔧 策略适配完成: Prompt(${config.prompt.reasoningFreedom}) | 规划深度(${config.planning.maxPlanDepth}) | 工具链(${config.prompt.toolChainComplexity}) | 反思(${config.reflection.depth})`,
      'StrategyAdapter'
    );

    return config;
  }

  /**
   * 获取当前策略配置
   */
  getCurrentConfig(): StrategyConfig | null {
    return this.currentConfig;
  }

  /**
   * 获取默认策略配置（无 LLM 能力数据时使用）
   */
  getDefaultConfig(): StrategyConfig {
    return this.buildDefaultConfig();
  }

  // ── 私有方法 ──

  /**
   * 构建策略配置
   */
  private buildStrategyConfig(caps: LLMCapabilities): StrategyConfig {
    return {
      prompt: this.buildPromptStrategy(caps),
      planning: this.buildPlanningStrategy(caps),
      toolUse: this.buildToolUseStrategy(caps),
      reflection: this.buildReflectionStrategy(caps),
      execution: this.buildExecutionStrategy(caps),
      version: StrategyAdapter.VERSION,
      appliedAt: Date.now(),
      llmOverallScore: caps.overallScore,
    };
  }

  /**
   * 构建 Prompt 策略
   */
  private buildPromptStrategy(caps: LLMCapabilities): StrategyConfig['prompt'] {
    const reasoningFreedom: StrategyConfig['prompt']['reasoningFreedom'] =
      caps.reasoningDepth > 7
        ? 'high'
        : caps.reasoningDepth > 4
          ? 'medium'
          : 'structured';

    const outputStrictness: StrategyConfig['prompt']['outputStrictness'] =
      caps.structuredOutput > 0.9
        ? 'strict'
        : caps.structuredOutput > 0.6
          ? 'moderate'
          : 'flexible';

    const contextInjectionDepth: StrategyConfig['prompt']['contextInjectionDepth'] =
      caps.contextWindow > 100000
        ? 'deep'
        : caps.contextWindow > 30000
          ? 'moderate'
          : 'shallow';

    const toolChainComplexity: StrategyConfig['prompt']['toolChainComplexity'] =
      caps.toolCallingAccuracy > 0.95
        ? 'complex'
        : caps.toolCallingAccuracy > 0.7
          ? 'moderate'
          : 'simple';

    return {
      reasoningFreedom,
      outputStrictness,
      contextInjectionDepth,
      toolChainComplexity,
      enableCoT: caps.reasoningDepth > 5,
    };
  }

  /**
   * 构建规划策略
   */
  private buildPlanningStrategy(
    caps: LLMCapabilities
  ): StrategyConfig['planning'] {
    return {
      enableToT: caps.reasoningDepth > 6,
      enableCausalModeling: caps.reasoningDepth > 8,
      maxPlanDepth:
        caps.reasoningDepth > 7 ? 5 : caps.reasoningDepth > 4 ? 4 : 3,
      enableDynamicReplanning: caps.reasoningDepth > 6,
      enableParallelPlanning: caps.reasoningDepth > 8,
    };
  }

  /**
   * 构建工具使用策略
   */
  private buildToolUseStrategy(
    caps: LLMCapabilities
  ): StrategyConfig['toolUse'] {
    return {
      enableToolChaining: caps.toolCallingAccuracy > 0.8,
      maxConsecutiveToolCalls: caps.toolCallingAccuracy > 0.9 ? 10 : 5,
      enableToolPrediction: caps.overallScore > 6,
      maxRetriesPerTool: caps.toolCallingAccuracy > 0.9 ? 1 : 2,
    };
  }

  /**
   * 构建反思策略
   */
  private buildReflectionStrategy(
    caps: LLMCapabilities
  ): StrategyConfig['reflection'] {
    return {
      depth: caps.reasoningDepth > 6 ? 'deep' : 'shallow',
      enableCrossTurnReflection: caps.reasoningDepth > 7,
      injectReflectionToPlanning: caps.reasoningDepth > 5,
      maxReflectionRounds: caps.reasoningDepth > 7 ? 3 : 1,
    };
  }

  /**
   * 构建执行策略
   */
  private buildExecutionStrategy(
    caps: LLMCapabilities
  ): StrategyConfig['execution'] {
    return {
      enableAdaptiveControl: caps.reasoningDepth > 5,
      riskAssessmentThreshold: caps.overallScore > 7 ? 0.8 : 0.6,
      enableParallelExecution: caps.reasoningDepth > 7,
      qualityThreshold: caps.overallScore > 7 ? 0.6 : 0.4,
    };
  }

  /**
   * 构建默认配置（保守策略）
   */
  private buildDefaultConfig(): StrategyConfig {
    return {
      prompt: {
        reasoningFreedom: 'structured',
        outputStrictness: 'moderate',
        contextInjectionDepth: 'moderate',
        toolChainComplexity: 'simple',
        enableCoT: false,
      },
      planning: {
        enableToT: false,
        enableCausalModeling: false,
        maxPlanDepth: 3,
        enableDynamicReplanning: false,
        enableParallelPlanning: false,
      },
      toolUse: {
        enableToolChaining: false,
        maxConsecutiveToolCalls: 5,
        enableToolPrediction: false,
        maxRetriesPerTool: 2,
      },
      reflection: {
        depth: 'shallow',
        enableCrossTurnReflection: false,
        injectReflectionToPlanning: false,
        maxReflectionRounds: 1,
      },
      execution: {
        enableAdaptiveControl: false,
        riskAssessmentThreshold: 0.6,
        enableParallelExecution: false,
        qualityThreshold: 0.4,
      },
      version: StrategyAdapter.VERSION,
      appliedAt: Date.now(),
      llmOverallScore: 0,
    };
  }

  /**
   * 应用配置到各模块
   */
  private async applyConfig(config: StrategyConfig): Promise<void> {
    try {
      this.callbacks.onPromptConfigUpdate?.(config.prompt);
      this.callbacks.onPlanningConfigUpdate?.(config.planning);
      this.callbacks.onToolUseConfigUpdate?.(config.toolUse);
      this.callbacks.onReflectionConfigUpdate?.(config.reflection);
      this.callbacks.onExecutionConfigUpdate?.(config.execution);
    } catch (error) {
      Logger.error('应用策略配置失败', error as Error, 'StrategyAdapter');
    }
  }

  // ── 持久化 ──

  /**
   * 持久化策略配置
   */
  private persistConfig(): void {
    if (!this.persistence || !this.currentConfig) return;

    try {
      this.persistence.saveEnvironmentState({
        [StrategyAdapter.STORAGE_KEY]: this.currentConfig,
      });
    } catch (error) {
      Logger.error('持久化策略配置失败', error as Error, 'StrategyAdapter');
    }
  }

  /**
   * 加载已保存的策略配置
   */
  private loadSavedConfig(): void {
    if (!this.persistence) return;

    try {
      const saved = this.persistence.loadEnvironmentState();
      if (!saved) return;

      const stored = saved[StrategyAdapter.STORAGE_KEY] as
        | StrategyConfig
        | undefined;
      if (!stored) return;

      this.currentConfig = stored;
      Logger.info(
        `🔧 已加载策略配置 (版本: ${stored.version}, LLM评分: ${stored.llmOverallScore})`,
        'StrategyAdapter'
      );
    } catch (error) {
      Logger.error('加载策略配置失败', error as Error, 'StrategyAdapter');
    }
  }
}

export default StrategyAdapter;
