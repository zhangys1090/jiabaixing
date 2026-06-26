/**
 * V2 进化引擎适配器
 *
 * 【架构定位】
 * 将 V2 代码进化引擎适配到统一的 IEvolutionEngine 接口
 *
 * 设计原则：
 * - 不修改原有 V2 实现
 * - 使用适配器模式（Wrapper）包装
 * - 逐步完善，先实现核心方法
 * - 保持向后兼容
 */

import { Logger } from '../utils/Logger';
import { EvolutionEngineV2 } from './v2/EvolutionEngineV2';
import type { EvolutionCause, EvolutionHistory } from './v2/types';
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

export class EvolutionEngineV2Adapter implements IEvolutionEngine {
  readonly name = 'EvolutionEngine V2';
  readonly version = '2.0.0';
  readonly description = '自我进化层 - 重量、深度、高风险的代码级自我进化引擎';
  readonly type: EvolutionEngineType = 'code_evolution';

  private engine: EvolutionEngineV2;
  private initialized = false;
  private running = false;

  constructor(engine: EvolutionEngineV2) {
    this.engine = engine;

    Logger.info('🚀 [V2Adapter] V2 进化引擎适配器已创建', 'EvolutionAdapter');
  }

  // ========== 核心方法 ==========

  /**
   * 学习/进化
   *
   * V2 实现：触发代码级自我进化
   */
  async learn(input: EvolutionInput): Promise<EvolutionResult> {
    const startTime = Date.now();

    try {
      // V2 的学习方式：触发进化
      if (input.type === 'trigger' && input.context) {
        const ctx = input.context as Record<string, unknown>;

        // 构造 EvolutionCause
        const cause = {
          type:
            (ctx.causeType as EvolutionCause['type']) ||
            'PROACTIVE_IMPROVEMENT',
          description: input.description || '主动优化',
          context: (ctx.failureContext as EvolutionCause['context']) || {},
          timestamp: Date.now(),
        };

        // 调用 V2 的进化触发方法
        const result = await this.engine.triggerEvolution(cause);

        if (!result) {
          return {
            id: `v2-${Date.now()}`,
            success: false,
            type: 'code_evolution',
            description: input.description || 'V2 代码进化（引擎正忙）',
            duration: Date.now() - startTime,
            error: '进化引擎正在运行中，请稍后再试',
          };
        }

        // 从 V2 引擎的全局指标中获取质量改善数据
        const v2Metrics = this.engine.getMetrics();

        return {
          id: result.planId || `v2-${Date.now()}`,
          success: result.success,
          type: 'code_evolution',
          description: input.description || 'V2 代码进化',
          duration: Date.now() - startTime,
          impact: {
            qualityDelta: v2Metrics.qualityImprovement,
            riskLevel: 'medium',
          },
          error: result.error,
        };
      }

      // 默认：记录但不实际执行
      return {
        id: `v2-${Date.now()}`,
        success: true,
        type: 'code_evolution',
        description: input.description || 'V2 代码进化（未触发）',
        duration: Date.now() - startTime,
        impact: {
          riskLevel: 'low',
        },
      };
    } catch (error) {
      return {
        id: `v2-${Date.now()}`,
        success: false,
        type: 'code_evolution',
        description: input.description || 'V2 代码进化',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 评估效果
   */
  async evaluate(_context: EvaluationContext): Promise<EvaluationResult> {
    // V2 的评估：获取当前进化成功率
    const metrics = this.engine.getMetrics();

    return {
      score: metrics.successRate,
      details: {
        totalEvolutions: metrics.totalEvolutions,
        successRate: metrics.successRate,
        averageDuration: metrics.averageDuration,
        rollbackRate: metrics.rollbackRate,
      },
      recommendations: [
        '关注高风险进化，确保有充分的测试和回滚机制',
        '优先修复成功率低的进化类型',
      ],
    };
  }

  /**
   * 获取指标
   */
  async getMetrics(): Promise<UnifiedEvolutionMetrics> {
    const v2Metrics = this.engine.getMetrics();

    // 获取所有历史记录用于统计
    const history = this.engine.getHistory(1000);

    // 转换按类型统计（从历史记录中计算每类型的成功率）
    const byType: Record<
      string,
      {
        count: number;
        successRate: number;
        averageDuration: number;
      }
    > = {};

    if (v2Metrics.evolutionsByType) {
      // 从历史记录中计算每类型的详细统计
      const typeStats = new Map<
        string,
        { total: number; success: number; totalDuration: number }
      >();

      for (const h of history) {
        const type = h.type || 'unknown';
        const stats = typeStats.get(type) || {
          total: 0,
          success: 0,
          totalDuration: 0,
        };
        stats.total++;
        if (h.success) stats.success++;
        stats.totalDuration += h.result?.duration || 0;
        typeStats.set(type, stats);
      }

      for (const [type, count] of Object.entries(v2Metrics.evolutionsByType)) {
        const stats = typeStats.get(type);
        byType[type] = {
          count: count || 0,
          successRate:
            stats && stats.total > 0 ? stats.success / stats.total : 0,
          averageDuration:
            stats && stats.total > 0
              ? stats.totalDuration / stats.total
              : v2Metrics.averageDuration,
        };
      }
    }

    return {
      overview: {
        totalLearningCycles: v2Metrics.totalEvolutions,
        overallSuccessRate: v2Metrics.successRate,
        totalDuration: v2Metrics.totalEvolutions * v2Metrics.averageDuration,
        averageQualityScore: v2Metrics.qualityImprovement,
      },
      codeEvolution: {
        totalEvolutions: v2Metrics.totalEvolutions,
        successRate: v2Metrics.successRate,
        averageDuration: v2Metrics.averageDuration,
        rollbackRate: v2Metrics.rollbackRate,
        qualityImprovement: v2Metrics.qualityImprovement,
        byType,
      },
      risk: {
        rollbackCount: Math.round(
          v2Metrics.rollbackRate * v2Metrics.totalEvolutions
        ),
        rollbackRate: v2Metrics.rollbackRate,
        highRiskEvolutions: history.filter(
          (h) => h.cause?.type === 'FAILURE' || h.cause?.type === 'BUG_REPORT'
        ).length,
        incidentCount: history.filter((h) => !h.success).length,
      },
    };
  }

  /**
   * 回滚
   *
   * V2 支持回滚
   */
  async rollback(evolutionId: string): Promise<RollbackResult> {
    const startTime = Date.now();

    try {
      const result = await this.engine.rollbackByPlanId(evolutionId);

      return {
        success: result.success,
        evolutionId,
        duration: Date.now() - startTime,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        evolutionId,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ========== 生命周期方法 ==========

  async initialize(_config: EvolutionEngineConfig): Promise<void> {
    this.initialized = true;
    Logger.info('[V2Adapter] V2 进化引擎已初始化', 'EvolutionAdapter');
  }

  async start(): Promise<void> {
    this.running = true;
    // V2 没有单独的 start 方法，在需要时触发
    Logger.info('[V2Adapter] V2 进化引擎已启动', 'EvolutionAdapter');
  }

  async stop(): Promise<void> {
    this.running = false;
    Logger.info('[V2Adapter] V2 进化引擎已停止', 'EvolutionAdapter');
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.initialized = false;
    Logger.info('[V2Adapter] V2 进化引擎已销毁', 'EvolutionAdapter');
  }

  // ========== 查询方法 ==========

  async getHistory(
    limit?: number,
    _offset?: number
  ): Promise<EvolutionHistoryEntry[]> {
    // V2 维护进化历史（getHistory 只接受可选的 limit 参数）
    const history: EvolutionHistory[] = this.engine.getHistory(limit ?? 100);

    return history.map((h) => ({
      id: h.planId || '',
      type: h.type || 'code_evolution',
      timestamp: h.timestamp || 0,
      success: h.success,
      duration: h.result?.duration || 0,
      description: h.title || '',
    }));
  }

  supports(feature: string): boolean {
    const supportedFeatures = [
      'code_evolution',
      'self_modification',
      'evolution_planning',
      'rollback',
      'risk_assessment',
      'strategy_learning',
    ];

    return supportedFeatures.includes(feature);
  }

  /**
   * 获取原始引擎实例（用于向后兼容）
   */
  getOriginalEngine(): EvolutionEngineV2 {
    return this.engine;
  }
}
