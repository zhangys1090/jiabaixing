import { Logger } from '../../utils/Logger';
import { EvolutionPlanner } from './EvolutionPlanner';
import { EvolutionRollback } from './EvolutionRollback';
import { SelfModificationEngine } from './SelfModificationEngine';
import {
  EvolutionCause,
  EvolutionHistory,
  EvolutionMetrics,
  EvolutionPlan,
  EvolutionResult,
  EvolutionType,
  ResourcePreloadHint,
  StrategyRecommendation,
  StrategyRecord,
  StrategyTrend,
} from './types';

interface LLMClient {
  chat(systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * EvolutionEngineV2 - 进化引擎 V2（自我进化层）
 *
 * 【架构定位】
 * 双层进化体系中的 V2 - 自我进化层（重量、深度、高风险）
 *
 * 与 V1 的关系：
 * - V1 = 反馈学习层：从交互中优化参数和 Prompt，不修改代码
 * - V2（本文件）= 自我进化层：真正的代码级自我修改，有完整的规划→执行→回滚机制
 * - 两者配合形成"快速迭代 + 深度进化"的双层进化体系
 *
 * 【核心职责】
 * - 进化规划：根据问题原因生成详细的进化计划
 * - 自我修改：直接修改代码文件（通过 SelfModificationEngine）
 * - 回滚机制：进化失败时自动回滚（通过 EvolutionRollback）
 * - 多类型进化支持：
 *   - CODE_FIX - 代码修复
 *   - CODE_OPTIMIZATION - 代码优化
 *   - PROMPT_IMPROVEMENT - Prompt 改进
 *   - TOOL_ENHANCEMENT - 工具增强
 *   - ARCHITECTURE_CHANGE - 架构变更
 * - 风险评估：对进化操作进行风险等级评估
 * - 策略学习：记录策略效果，调整策略权重
 *
 * 【特点】
 * - 重量：涉及代码修改，执行时间长
 * - 深度：可以进行架构级别的改进
 * - 高风险：直接修改代码，可能引入新问题
 * - 有防护：完整的规划→验证→执行→回滚流程
 *
 * 【使用场景】
 * - 代码修复与优化
 * - Prompt 深度改进
 * - 工具功能增强
 * - 架构级变更
 * - 低频、大幅度的优化
 *
 * 【核心组件】
 * - EvolutionPlanner：进化规划器
 * - SelfModificationEngine：自我修改引擎
 * - EvolutionRollback：进化回滚机制
 */
export class EvolutionEngineV2 {
  private rollback: EvolutionRollback;
  private modifier: SelfModificationEngine;
  private planner: EvolutionPlanner;
  private history: EvolutionHistory[] = [];
  private isRunning: boolean = false;
  /** 策略记录历史 */
  private strategyRecords: StrategyRecord[] = [];
  /** 策略权重 — key 为策略类型 */
  private strategyWeights: Map<string, number> = new Map();
  /** 能力记录 — key 为领域 */
  private capabilityOutcomes: Map<
    string,
    { successes: number; failures: number; lastSeen: number }
  > = new Map();

  constructor(
    llmClient: LLMClient,
    checkpointDir: string = './.evolution-checkpoints'
  ) {
    this.rollback = new EvolutionRollback(checkpointDir);
    this.modifier = new SelfModificationEngine();
    this.planner = new EvolutionPlanner(llmClient);

    Logger.info('🧬 EvolutionEngineV2 initialized', 'EvolutionEngineV2');
  }

  /**
   * 主入口：触发进化
   */
  async triggerEvolution(
    cause: EvolutionCause
  ): Promise<EvolutionResult | null> {
    if (this.isRunning) {
      Logger.warn(
        'Evolution already in progress, skipping',
        'EvolutionEngineV2'
      );
      return null;
    }

    this.isRunning = true;

    try {
      Logger.info(
        `🚀 Evolution started: ${cause.type} - ${cause.description}`,
        'EvolutionEngineV2'
      );

      const plan = await this.planner.generateEvolutionPlan(cause);
      return await this.executePlan(plan);
    } catch (error) {
      Logger.error('Evolution failed', error as Error, 'EvolutionEngineV2');
      return null;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 执行进化计划（完整流程）
   */
  private async executePlan(plan: EvolutionPlan): Promise<EvolutionResult> {
    Logger.info(
      `📋 Plan: ${plan.title} (${plan.actions.length} actions, risk: ${plan.estimatedRisk})`,
      'EvolutionEngineV2'
    );

    let result: EvolutionResult;

    // 即使是空计划也要记录历史
    const emptyPlan = plan.actions.length === 0;
    if (emptyPlan) {
      Logger.info(
        'No actions in plan, skipping execution',
        'EvolutionEngineV2'
      );
      result = {
        planId: plan.id,
        success: true,
        executedActions: 0,
        duration: 0,
      };
    } else {
      // Step 1: 创建回滚检查点
      const checkpoint = this.rollback.createCheckpoint(plan.id, plan.actions);

      try {
        // Step 2: 执行修改
        result = await this.modifier.executePlan(plan, checkpoint.id);

        // Step 3: 验证效果
        if (result.success) {
          Logger.info('🔍 Validating evolution...', 'EvolutionEngineV2');
          const validationResult = await this.validateEvolution(plan);
          result.validationResult = validationResult;

          if (!validationResult.passed) {
            Logger.warn(
              'Validation failed, initiating rollback',
              'EvolutionEngineV2'
            );
            result.rollbackNeeded = true;
          }
        }
      } catch (error) {
        result = {
          planId: plan.id,
          success: false,
          executedActions: 0,
          error: (error as Error).message,
          duration: 0,
        };
        result.rollbackNeeded = true;
      }

      // Step 4: 回滚（如果需要）
      if (result.rollbackNeeded) {
        const rollbackResult = await this.rollback.rollback(checkpoint.id);
        result.rollbackResult = rollbackResult;

        if (rollbackResult.success) {
          Logger.info(
            '⏪ Evolution rolled back successfully',
            'EvolutionEngineV2'
          );
        } else {
          Logger.error(
            '❌ Rollback failed!',
            new Error(rollbackResult.error),
            'EvolutionEngineV2'
          );
        }
      }
    }

    // Step 5: 记录历史（包括空计划）
    this.history.push({
      planId: plan.id,
      type: plan.type,
      title: plan.title,
      success: result.success && !result.rollbackNeeded,
      cause: plan.cause,
      result,
      timestamp: Date.now(),
    });

    return result;
  }

  /**
   * 验证进化效果 — 真正跑 tsc 编译检查
   * HIGH 风险计划额外跑 jest 测试
   */
  private async validateEvolution(
    plan: EvolutionPlan
  ): Promise<{ passed: boolean; details: string }> {
    const { execSync } = await import('child_process');
    const failures: string[] = [];

    // Step 1: TypeScript 编译检查（必须通过）
    try {
      execSync('npx tsc --noEmit --project tsconfig.fast.json', {
        cwd: process.cwd(),
        timeout: 60000,
        stdio: 'pipe',
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() || '';
      failures.push(`TypeScript 编译失败: ${stderr.slice(0, 300)}`);
    }

    // Step 2: HIGH 风险计划额外跑测试
    if (plan.estimatedRisk === 'HIGH') {
      try {
        execSync('npx jest --forceExit --no-coverage --passWithNoTests', {
          cwd: process.cwd(),
          timeout: 120000,
          stdio: 'pipe',
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() || '';
        failures.push(`测试失败: ${stderr.slice(0, 300)}`);
      }
    }

    if (failures.length > 0) {
      return { passed: false, details: failures.join('; ') };
    }
    return {
      passed: true,
      details: `验证通过 (tsc${plan.estimatedRisk === 'HIGH' ? ' + jest' : ''})`,
    };
  }

  /**
   * 获取进化历史
   */
  getHistory(limit: number = 100): EvolutionHistory[] {
    return this.history.slice(-limit);
  }

  /**
   * 获取进化指标
   *
   * [OVERLAP] 此功能与 V1 中的 EvolutionMetrics 高度重叠
   * - V1：EvolutionMetrics 接口，包含反馈数、优化数、成功率等
   * - V2（本方法）：EvolutionMetrics 接口（同名但定义不同），包含进化数、成功率、平均耗时、回滚率等
   * - 未来合并方向：统一指标格式，设计包含 V1+V2 所有指标的统一接口
   */
  getMetrics(): EvolutionMetrics {
    const total = this.history.length;
    const successful = this.history.filter((h) => h.success).length;
    const rolledBack = this.history.filter(
      (h) => h.result.rollbackResult?.success
    ).length;
    const averageDuration =
      total > 0
        ? this.history.reduce((sum, h) => sum + h.result.duration, 0) / total
        : 0;

    const byType: Partial<Record<EvolutionType, number>> = {};
    for (const h of this.history) {
      byType[h.type] = (byType[h.type] || 0) + 1;
    }

    return {
      totalEvolutions: total,
      successRate: total > 0 ? successful / total : 0,
      averageDuration,
      evolutionsByType: byType,
      rollbackRate: total > 0 ? rolledBack / total : 0,
      qualityImprovement: 0, // TODO: 实际质量改善计算
    };
  }

  /**
   * 手动触发回滚
   */
  async rollbackToCheckpoint(
    checkpointId: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.rollback.rollback(checkpointId);
  }

  /**
   * 按进化计划 ID 回滚到最近的检查点
   */
  async rollbackByPlanId(
    planId: string
  ): Promise<{ success: boolean; error?: string }> {
    const checkpointIds = this.rollback.getCheckpointIdsByPlanId(planId);
    if (checkpointIds.length === 0) {
      return { success: false, error: `未找到计划 ${planId} 的检查点` };
    }
    return this.rollback.rollback(checkpointIds[0]);
  }

  /**
   * 记录策略结果 — 更新策略权重
   *
   * [OVERLAP] 此功能与 V1 中的 StrategyOptimizer 高度重叠
   * - V1：StrategyOptimizer 类，负责策略优化，生成优化日志
   * - V2（本方法）：strategyRecords 和 strategyWeights 属性，负责策略记录和权重调整
   * - 未来合并方向：统一策略学习框架，提取共享的策略管理模块
   */
  recordStrategyOutcome(record: StrategyRecord): void {
    this.strategyRecords.push(record);

    // 保留最近 100 条记录
    if (this.strategyRecords.length > 100) {
      this.strategyRecords.shift();
    }

    // 更新权重：成功提升，失败降低
    const currentWeight = this.strategyWeights.get(record.strategyType) ?? 0.5;
    const delta = record.outcome === 'success' ? 0.1 : -0.15;
    const newWeight = Math.max(0, Math.min(1, currentWeight + delta));
    this.strategyWeights.set(record.strategyType, newWeight);
  }

  /**
   * 预测最优策略 — 基于历史权重和上下文
   */
  predictOptimalStrategy(_context: string): StrategyRecommendation | null {
    if (this.strategyRecords.length === 0) {
      return null;
    }

    // 找出权重最高的策略
    let topStrategy = '';
    let topWeight = 0;
    for (const [strategyType, weight] of this.strategyWeights) {
      if (weight > topWeight) {
        topWeight = weight;
        topStrategy = strategyType;
      }
    }

    if (!topStrategy) {
      return null;
    }

    // 计算置信度 — 基于权重和样本数
    const sampleCount = this.strategyRecords.filter(
      (r) => r.strategyType === topStrategy
    ).length;
    const confidence = Math.min(0.95, topWeight * (1 - 1 / (sampleCount + 1)));

    return {
      recommendedType: topStrategy,
      confidence,
      reasoning: `基于 ${sampleCount} 次历史记录，权重 ${topWeight.toFixed(2)}`,
    };
  }

  /**
   * 获取策略趋势 — 分析策略的成功率变化
   */
  getStrategyTrends(): StrategyTrend[] {
    const trends: StrategyTrend[] = [];
    const strategyTypes = new Set(
      this.strategyRecords.map((r) => r.strategyType)
    );

    for (const strategyType of strategyTypes) {
      const records = this.strategyRecords
        .filter((r) => r.strategyType === strategyType)
        .sort((a, b) => a.appliedAt - b.appliedAt);

      if (records.length === 0) continue;

      const successCount = records.filter(
        (r) => r.outcome === 'success'
      ).length;
      const successRate = successCount / records.length;

      // 判断趋势：比较前半段和后半段的成功率
      let direction: 'improving' | 'declining' | 'stable' = 'stable';
      if (records.length >= 4) {
        const midpoint = Math.floor(records.length / 2);
        const firstHalf = records.slice(0, midpoint);
        const secondHalf = records.slice(midpoint);
        const firstRate =
          firstHalf.filter((r) => r.outcome === 'success').length /
          firstHalf.length;
        const secondRate =
          secondHalf.filter((r) => r.outcome === 'success').length /
          secondHalf.length;

        if (secondRate - firstRate > 0.2) {
          direction = 'improving';
        } else if (firstRate - secondRate > 0.2) {
          direction = 'declining';
        }
      }

      trends.push({
        strategyType,
        direction,
        dataPoints: records.length,
        successRate,
      });
    }

    return trends;
  }

  /**
   * 获取资源预加载提示 — 基于策略历史预测可能需要的资源
   */
  getResourcePreloadHints(): ResourcePreloadHint[] {
    if (this.strategyRecords.length < 3) {
      return [];
    }

    // 统计策略类型频率
    const strategyFrequency = new Map<string, number>();
    for (const record of this.strategyRecords) {
      strategyFrequency.set(
        record.strategyType,
        (strategyFrequency.get(record.strategyType) || 0) + 1
      );
    }

    const total = this.strategyRecords.length;
    const hints: ResourcePreloadHint[] = [];

    for (const [strategyType, count] of strategyFrequency) {
      const probability = count / total;
      if (probability > 0.1) {
        hints.push({
          resourceType: strategyType,
          probability,
          preloadAction: `preload_${strategyType.toLowerCase()}_resources`,
        });
      }
    }

    return hints.sort((a, b) => b.probability - a.probability);
  }

  /**
   * 记录能力结果 — 跟踪各领域的成功/失败
   */
  recordCapabilityOutcome(domain: string, success: boolean): void {
    let record = this.capabilityOutcomes.get(domain);
    if (!record) {
      record = { successes: 0, failures: 0, lastSeen: Date.now() };
      this.capabilityOutcomes.set(domain, record);
    }

    if (success) {
      record.successes++;
    } else {
      record.failures++;
    }
    record.lastSeen = Date.now();
  }

  /**
   * 评估能力 — 判断是否能处理指定领域的任务
   */
  assessCapability(
    domain: string,
    _task: string
  ): {
    canHandle: boolean;
    confidenceLevel: number;
    suggestedAlternative: string | null;
    reasoning: string;
  } {
    const record = this.capabilityOutcomes.get(domain);

    if (!record || (record.successes === 0 && record.failures === 0)) {
      return {
        canHandle: true,
        confidenceLevel: 0.5,
        suggestedAlternative: null,
        reasoning: '无历史记录，默认中等置信度',
      };
    }

    const total = record.successes + record.failures;
    const successRate = record.successes / total;
    const confidenceLevel = Math.max(0, Math.min(1, successRate));

    // 失败率过高则建议替代方案
    if (successRate < 0.3 && total >= 3) {
      return {
        canHandle: false,
        confidenceLevel,
        suggestedAlternative: '建议委派给更擅长此领域的 agent 或使用辅助工具',
        reasoning: `成功率仅 ${(successRate * 100).toFixed(0)}%（${total} 次记录）`,
      };
    }

    return {
      canHandle: true,
      confidenceLevel,
      suggestedAlternative: null,
      reasoning: `成功率 ${(successRate * 100).toFixed(0)}%（${total} 次记录）`,
    };
  }

  /**
   * 获取能力报告 — 汇总所有领域的能力边界
   */
  getCapabilityReport(): {
    totalDomains: number;
    boundaries: Array<{
      domain: string;
      successRate: number;
      totalAttempts: number;
      confidenceLevel: number;
    }>;
    weakAreas: string[];
    averageConfidence: number;
  } {
    const boundaries: Array<{
      domain: string;
      successRate: number;
      totalAttempts: number;
      confidenceLevel: number;
    }> = [];

    const weakAreas: string[] = [];
    let totalConfidence = 0;

    for (const [domain, record] of this.capabilityOutcomes) {
      const total = record.successes + record.failures;
      const successRate = total > 0 ? record.successes / total : 0;
      const confidenceLevel = Math.max(0, Math.min(1, successRate));

      boundaries.push({
        domain,
        successRate,
        totalAttempts: total,
        confidenceLevel,
      });

      totalConfidence += confidenceLevel;

      // 成功率低于 50% 且有足够样本则标记为弱区
      if (successRate < 0.5 && total >= 2) {
        weakAreas.push(domain);
      }
    }

    return {
      totalDomains: this.capabilityOutcomes.size,
      boundaries,
      weakAreas,
      averageConfidence:
        boundaries.length > 0 ? totalConfidence / boundaries.length : 0,
    };
  }
}

export default EvolutionEngineV2;
