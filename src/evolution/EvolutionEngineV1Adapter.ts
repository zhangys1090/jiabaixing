/**
 * V1 进化引擎适配器
 *
 * 【架构定位】
 * 将 V1 反馈学习引擎适配到统一的 IEvolutionEngine 接口
 *
 * 设计原则：
 * - 不修改原有 V1 实现
 * - 使用适配器模式（Wrapper）包装
 * - 逐步完善，先实现核心方法
 * - 保持向后兼容
 *
 * @deprecated V1 已标记 deprecated，最终将被 V2 替代
 * 迁移状态：V5.0 引入适配器，V6.0 移除 V1
 */

import { Logger } from '../utils/Logger';
import { EvolutionEngine } from './EvolutionEngine';
import type {
  IEvolutionEngine,
  EvolutionEngineType,
  EvolutionInput,
  EvolutionResult,
  EvaluationContext,
  EvaluationResult,
  RollbackResult,
  EvolutionEngineConfig,
  EvolutionHistoryEntry,
  UnifiedEvolutionMetrics,
} from './IEvolutionEngine';

export class EvolutionEngineV1Adapter implements IEvolutionEngine {
  readonly name = 'EvolutionEngine V1';
  readonly version = '1.0.0';
  readonly description = '反馈学习层 - 轻量、快速、低风险的参数优化引擎';
  readonly type: EvolutionEngineType = 'feedback_learning';

  private engine: EvolutionEngine;
  private initialized = false;
  private running = false;

  constructor(engine: EvolutionEngine) {
    this.engine = engine;

    Logger.info('🎯 [V1Adapter] V1 进化引擎适配器已创建', 'EvolutionAdapter');
  }

  // ========== 核心方法 ==========

  /**
   * 学习/进化
   *
   * V1 实现：收集反馈，进行参数优化
   */
  async learn(input: EvolutionInput): Promise<EvolutionResult> {
    const startTime = Date.now();

    try {
      // V1 的学习方式：收集反馈
      if (input.type === 'feedback' && input.context) {
        const {
          input: userInput,
          response,
          success,
          toolsUsed,
        } = input.context as Record<string, unknown>;

        this.engine.collectFeedback(
          String(userInput || ''),
          String(response || ''),
          {
            success: Boolean(success),
            toolsUsed: Array.isArray(toolsUsed) ? (toolsUsed as string[]) : [],
          }
        );
      }

      return {
        id: `v1-${Date.now()}`,
        success: true,
        type: 'feedback_learning',
        description: input.description || 'V1 反馈学习',
        duration: Date.now() - startTime,
        impact: {
          riskLevel: 'low',
        },
      };
    } catch (error) {
      return {
        id: `v1-${Date.now()}`,
        success: false,
        type: 'feedback_learning',
        description: input.description || 'V1 反馈学习',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 评估效果
   */
  async evaluate(_context: EvaluationContext): Promise<EvaluationResult> {
    // V1 的评估：获取当前质量评分
    const metrics = this.engine.getMetrics();

    return {
      score: metrics.weeklyOptimizationStats?.successRate || 0.5,
      details: {
        totalFeedback: metrics.totalFeedback,
        totalOptimizations: metrics.totalOptimizations,
        successRate:
          metrics.totalOptimizations > 0
            ? metrics.successfulOptimizations / metrics.totalOptimizations
            : 0,
      },
      recommendations: [
        '增加反馈数据量可以提高学习效果',
        '关注低质量交互，从中提取改进点',
      ],
    };
  }

  /**
   * 获取指标
   */
  async getMetrics(): Promise<UnifiedEvolutionMetrics> {
    const v1Metrics = this.engine.getMetrics();

    return {
      overview: {
        totalLearningCycles: v1Metrics.totalFeedback,
        overallSuccessRate:
          v1Metrics.totalOptimizations > 0
            ? v1Metrics.successfulOptimizations / v1Metrics.totalOptimizations
            : 0,
        totalDuration: 0, // V1 不统计总耗时
        averageQualityScore: 0, // V1 不直接提供质量评分
      },
      feedbackLearning: {
        totalFeedback: v1Metrics.totalFeedback,
        totalOptimizations: v1Metrics.totalOptimizations,
        successfulOptimizations: v1Metrics.successfulOptimizations,
        failedOptimizations: v1Metrics.failedOptimizations,
        weeklySuccessRate: v1Metrics.weeklyOptimizationStats?.successRate || 0,
        toolWeightAdjustments: Object.keys(this.engine.getToolWeights()).length,
        promptExamplesGenerated: this.engine
          .getStrategyOptimizer()
          .getPromptExamples().length,
      },
      risk: {
        rollbackCount: 0,
        rollbackRate: 0,
        highRiskEvolutions: 0,
        incidentCount: 0,
      },
    };
  }

  /**
   * 回滚
   *
   * V1 不支持回滚（因为只修改参数，不修改代码）
   */
  async rollback(_evolutionId: string): Promise<RollbackResult> {
    Logger.warn(
      '[V1Adapter] V1 引擎不支持回滚（仅修改参数，不修改代码）',
      'EvolutionAdapter'
    );

    return {
      success: false,
      evolutionId: _evolutionId,
      duration: 0,
      error: 'V1 引擎不支持回滚',
    };
  }

  // ========== 生命周期方法 ==========

  async initialize(_config: EvolutionEngineConfig): Promise<void> {
    this.initialized = true;
    Logger.info('[V1Adapter] V1 进化引擎已初始化', 'EvolutionAdapter');
  }

  async start(): Promise<void> {
    this.running = true;
    this.engine.start();
    Logger.info('[V1Adapter] V1 进化引擎已启动', 'EvolutionAdapter');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.engine.stop();
    Logger.info('[V1Adapter] V1 进化引擎已停止', 'EvolutionAdapter');
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.initialized = false;
    Logger.info('[V1Adapter] V1 进化引擎已销毁', 'EvolutionAdapter');
  }

  // ========== 查询方法 ==========

  async getHistory(
    _limit?: number,
    _offset?: number
  ): Promise<EvolutionHistoryEntry[]> {
    // V1 不维护详细的进化历史
    return [];
  }

  supports(feature: string): boolean {
    const supportedFeatures = [
      'feedback_learning',
      'strategy_optimization',
      'prompt_examples',
      'tool_weight_adjustment',
    ];

    return supportedFeatures.includes(feature);
  }

  /**
   * 获取原始引擎实例（用于向后兼容）
   */
  getOriginalEngine(): EvolutionEngine {
    return this.engine;
  }
}
