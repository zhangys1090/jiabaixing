/**
 * 统一进化引擎接口
 *
 * 【架构定位】
 * 所有进化引擎（V1、V2、未来的V3等）都应实现此接口
 * 便于统一调度、监控和管理
 *
 * 设计原则：
 * - 统一的方法签名
 * - 统一的类型定义
 * - 统一的生命周期管理
 * - 向后兼容，不破坏现有实现
 *
 * 实施阶段：
 * - 第一阶段（当前）：接口定义 + 适配器模式
 * - 第二阶段：各引擎逐步适配
 * - 第三阶段：统一调度器使用统一接口
 */

/**
 * 进化引擎类型
 */
export type EvolutionEngineType =
  | 'feedback_learning'
  | 'code_evolution'
  | 'hybrid';

/**
 * 进化输入
 */
export interface EvolutionInput {
  /** 输入类型 */
  type: 'feedback' | 'trigger' | 'scheduled';
  /** 描述 */
  description: string;
  /** 上下文数据 */
  context?: Record<string, unknown>;
  /** 优先级 */
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * 进化结果
 */
export interface EvolutionResult {
  /** 进化ID */
  id: string;
  /** 是否成功 */
  success: boolean;
  /** 进化类型 */
  type: string;
  /** 描述 */
  description: string;
  /** 耗时（ms） */
  duration: number;
  /** 影响评估 */
  impact?: {
    /** 质量变化 */
    qualityDelta?: number;
    /** 性能变化 */
    performanceDelta?: number;
    /** 风险等级 */
    riskLevel?: 'low' | 'medium' | 'high';
  };
  /** 错误信息 */
  error?: string;
}

/**
 * 评估上下文
 */
export interface EvaluationContext {
  /** 评估类型 */
  type: 'quality' | 'performance' | 'risk';
  /** 评估目标 */
  target?: string;
  /** 基线数据 */
  baseline?: Record<string, unknown>;
}

/**
 * 评估结果
 */
export interface EvaluationResult {
  /** 评分 */
  score: number;
  /** 详细数据 */
  details: Record<string, unknown>;
  /** 建议 */
  recommendations?: string[];
}

/**
 * 回滚结果
 */
export interface RollbackResult {
  /** 是否成功 */
  success: boolean;
  /** 进化ID */
  evolutionId: string;
  /** 耗时（ms） */
  duration: number;
  /** 错误信息 */
  error?: string;
}

/**
 * 进化引擎配置
 */
export interface EvolutionEngineConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 学习率 */
  learningRate?: number;
  /** 风险阈值 */
  riskThreshold?: 'low' | 'medium' | 'high';
  /** 资源限制 */
  resourceLimits?: {
    /** 最大耗时（ms） */
    maxDuration?: number;
    /** 最大内存（MB） */
    maxMemory?: number;
  };
}

/**
 * 进化历史条目
 */
export interface EvolutionHistoryEntry {
  /** ID */
  id: string;
  /** 类型 */
  type: string;
  /** 时间戳 */
  timestamp: number;
  /** 是否成功 */
  success: boolean;
  /** 耗时（ms） */
  duration: number;
  /** 描述 */
  description: string;
}

/**
 * 统一进化指标
 *
 * 涵盖反馈学习（V1）和代码进化（V2）的所有指标
 */
export interface UnifiedEvolutionMetrics {
  /** 概览指标 */
  overview: {
    /** 总学习周期数 */
    totalLearningCycles: number;
    /** 总体成功率 */
    overallSuccessRate: number;
    /** 总耗时（ms） */
    totalDuration: number;
    /** 平均质量评分 */
    averageQualityScore: number;
  };

  /** 反馈学习指标（V1） */
  feedbackLearning?: {
    /** 总反馈数 */
    totalFeedback: number;
    /** 总优化数 */
    totalOptimizations: number;
    /** 成功优化数 */
    successfulOptimizations: number;
    /** 失败优化数 */
    failedOptimizations: number;
    /** 周成功率 */
    weeklySuccessRate: number;
    /** 工具权重调整次数 */
    toolWeightAdjustments: number;
    /** Prompt 示例生成数 */
    promptExamplesGenerated: number;
  };

  /** 代码进化指标（V2） */
  codeEvolution?: {
    /** 总进化数 */
    totalEvolutions: number;
    /** 成功率 */
    successRate: number;
    /** 平均耗时（ms） */
    averageDuration: number;
    /** 回滚率 */
    rollbackRate: number;
    /** 质量提升 */
    qualityImprovement: number;
    /** 按类型统计 */
    byType?: Record<
      string,
      {
        count: number;
        successRate: number;
        averageDuration: number;
      }
    >;
  };

  /** 策略学习指标 */
  strategyLearning?: {
    /** 总策略数 */
    totalStrategies: number;
    /** 活跃策略数 */
    activeStrategies: number;
    /** 平均策略成功率 */
    averageStrategySuccessRate: number;
    /** 策略趋势 */
    strategyTrends?: Array<{
      strategyType: string;
      direction: 'improving' | 'declining' | 'stable';
      successRate: number;
    }>;
  };

  /** 性能指标 */
  performance?: {
    /** 平均学习时间（ms） */
    averageLearningTime: number;
    /** 平均进化时间（ms） */
    averageEvolutionTime: number;
    /** 资源使用 */
    resourceUsage?: {
      cpuAverage: number;
      memoryAverage: number;
    };
  };

  /** 风险指标 */
  risk?: {
    /** 回滚次数 */
    rollbackCount: number;
    /** 回滚率 */
    rollbackRate: number;
    /** 高风险进化数 */
    highRiskEvolutions: number;
    /** 事故数 */
    incidentCount: number;
  };
}

/**
 * 统一进化引擎接口
 *
 * 所有进化引擎都应实现此接口
 * 便于统一调度、监控和管理
 */
export interface IEvolutionEngine {
  // ========== 基本信息 ==========

  /** 引擎名称 */
  readonly name: string;

  /** 引擎版本 */
  readonly version: string;

  /** 引擎描述 */
  readonly description: string;

  /** 引擎类型 */
  readonly type: EvolutionEngineType;

  // ========== 核心方法 ==========

  /**
   * 学习/进化
   * @param input 学习输入
   * @returns 学习结果
   */
  learn(input: EvolutionInput): Promise<EvolutionResult>;

  /**
   * 评估效果
   * @param context 评估上下文
   * @returns 评估结果
   */
  evaluate(context: EvaluationContext): Promise<EvaluationResult>;

  /**
   * 获取指标
   * @returns 进化指标
   */
  getMetrics(): Promise<UnifiedEvolutionMetrics>;

  /**
   * 回滚
   * @param evolutionId 要回滚的进化ID
   * @returns 回滚结果
   */
  rollback(evolutionId: string): Promise<RollbackResult>;

  // ========== 生命周期方法 ==========

  /**
   * 初始化引擎
   */
  initialize(config: EvolutionEngineConfig): Promise<void>;

  /**
   * 启动引擎
   */
  start(): Promise<void>;

  /**
   * 停止引擎
   */
  stop(): Promise<void>;

  /**
   * 销毁引擎
   */
  destroy(): Promise<void>;

  // ========== 查询方法 ==========

  /**
   * 获取进化历史
   * @param limit 数量限制
   * @param offset 偏移量
   */
  getHistory(limit?: number, offset?: number): Promise<EvolutionHistoryEntry[]>;

  /**
   * 检查是否支持某个功能
   * @param feature 功能名称
   */
  supports(feature: string): boolean;
}
