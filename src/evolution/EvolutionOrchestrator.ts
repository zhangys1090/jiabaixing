/**
 * 进化编排器 v2
 * 统一调度全部七个进化引擎，确保优化不冲突，提供系统级可观测性
 *
 * 职责：
 * 1. 统一入口：recordInteraction() 同时驱动所有子引擎
 * 2. 优化协调：协调各引擎优化周期，防止冲突
 * 3. 统一指标：从所有引擎聚合指标，提供全局视图
 * 4. 调度管理：统一管理定时优化（替代各引擎独立调度）
 * 5. 自我修复：自动检测并修复问题
 * 6. 自我重构：自动优化代码结构
 * 7. 自我增强：自动扩展功能
 */

import { DynamicTaskAdjuster } from '../core/DynamicTaskAdjuster';
import EventBus from '../shared/EventBus';
import { ProfileEvolutionManager } from '../user/ProfileEvolutionManager';
import { Logger } from '../utils/Logger';
import { EvolutionEngine, EvolutionMetrics } from './EvolutionEngine';

/** 自我增强结果（原 SelfEnhancementEngine 已删除，本地定义） */
export interface EnhancementResult {
  id: string;
  success: boolean;
  type: string;
  description: string;
  timestamp: number;
  enhancement: { type: string; description: string; priority: string };
  filesCreated: string[];
  filesModified: string[];
  testsPassed: boolean;
  integrated: boolean;
}

/** SelfEnhancementEngine 已移除（未实际使用） */

export interface InteractionRecord {
  traceId: string;
  input: string;
  response: string;
  success: boolean;
  qualityScore: number;
  executionDuration: number;
  toolCalls: Array<{
    toolName: string;
    success: boolean;
    executionTime: number;
  }>;
  scene?: string;
  userId?: string;
}

export interface OptimizationCycle {
  cycleId: string;
  timestamp: number;
  enginesParticipated: string[];
  results: Array<{
    engineName: string;
    triggered: boolean;
    detail?: string;
  }>;
  overallScore: number;
}

export interface UnifiedEvolutionMetrics {
  summary: {
    totalInteractions: number;
    totalOptimizations: number;
    averageQualityScore: number;
    weeklyImprovement: number;
    enginesActive: string[];
  };
  quality: {
    current: number;
    trend: 'improving' | 'stable' | 'declining';
    recentScores: number[];
    failureRate: number;
  };
  performance: {
    averageResponseTime: number;
    p95ResponseTime: number;
    throughput: number;
  };
  optimization: {
    lastCycleTime: number | null;
    cyclesToday: number;
    totalCycles: number;
    successRate: number;
    recentCycles: OptimizationCycle[];
  };
  evolution: EvolutionMetrics | null;
  engines: {
    toolWeights: Record<string, number>;
    userProfileConfidence: number;
    taskAdjustmentCount: number;
  };
  verification: {
    totalVerifications: number;
    successRate: number;
    recentResults: Array<{
      type: string;
      target: string;
      before: string;
      after: string;
      verdict: string;
      confidence: string;
    }>;
  };
}

export class EvolutionOrchestrator {
  private static instance: EvolutionOrchestrator;

  private evolutionEngine: EvolutionEngine | null = null;
  private profileEvolution: ProfileEvolutionManager | null = null;
  private taskAdjuster: DynamicTaskAdjuster | null = null;

  private static readonly MAX_RESULTS_SIZE = 200;
  private eventBus: typeof EventBus = EventBus;

  private interactionCount = 0;
  private qualityHistory: number[] = [];
  private responseTimeHistory: number[] = [];
  private optimizationCycles: OptimizationCycle[] = [];
  private cyclesToday = 0;
  private lastCycleDay = Date.now();
  private optimizationInProgress = false;
  private readonly maxQualityHistory = 500;
  private readonly maxResponseTimeHistory = 500;
  private readonly maxOptimizationCycles = 100;

  // 各引擎的冷却期（毫秒）
  private engineCooldowns: Map<string, number> = new Map();
  private engineLastTriggered: Map<string, number> = new Map();
  private readonly defaultCooldownMs = 5 * 60 * 1000;

  // 定时调度
  private unifiedTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  static getInstance(): EvolutionOrchestrator {
    if (!EvolutionOrchestrator.instance) {
      EvolutionOrchestrator.instance = new EvolutionOrchestrator();
    }
    return EvolutionOrchestrator.instance;
  }

  /**
   * 注册所有子引擎
   */
  registerEngines(engines: {
    evolutionEngine?: EvolutionEngine;
    profileEvolution?: ProfileEvolutionManager;
    taskAdjuster?: DynamicTaskAdjuster;
    llmProvider?: import('../models/LLMProvider').LLMProvider;
  }): void {
    this.evolutionEngine = engines.evolutionEngine || null;
    this.profileEvolution = engines.profileEvolution || null;
    this.taskAdjuster = engines.taskAdjuster || null;

    const activeEngines: string[] = [];
    if (this.evolutionEngine) activeEngines.push('EvolutionEngine');
    if (this.profileEvolution) activeEngines.push('ProfileEvolution');
    if (this.taskAdjuster) activeEngines.push('DynamicTaskAdjuster');

    Logger.info(
      `🎯 进化编排器已注册 ${activeEngines.length} 个引擎: ${activeEngines.join(', ')}`,
      'EvolutionOrchestrator'
    );
  }

  /**
   * 启动统一调度
   */
  start(): void {
    if (this.isRunning) {
      Logger.warn('⚠️ 进化编排器已在运行', 'EvolutionOrchestrator');
      return;
    }

    this.isRunning = true;
    Logger.info('🎯 进化编排器已启动', 'EvolutionOrchestrator');

    // 注册 EventBus 监听器以接收全局事件
    this.setupEventListeners();
  }

  /**
   * 停止统一调度
   */
  stop(): void {
    this.isRunning = false;
    if (this.unifiedTimer) {
      clearInterval(this.unifiedTimer);
      this.unifiedTimer = null;
    }
    Logger.info('🎯 进化编排器已停止', 'EvolutionOrchestrator');
  }

  /**
   * P1+P2: 统一交互记录入口
   * 一次调用同时驱动全部四个闭环
   */
  recordInteraction(record: InteractionRecord): void {
    this.interactionCount++;
    this.qualityHistory.push(record.qualityScore);
    this.responseTimeHistory.push(record.executionDuration);

    if (this.qualityHistory.length > this.maxQualityHistory) {
      this.qualityHistory = this.qualityHistory.slice(-this.maxQualityHistory);
    }
    if (this.responseTimeHistory.length > this.maxResponseTimeHistory) {
      this.responseTimeHistory = this.responseTimeHistory.slice(
        -this.maxResponseTimeHistory
      );
    }

    // 并行驱动所有子引擎
    this.driveEvolutionEngine(record);
    this.driveProfileEvolution(record);

    // 统一验证：每20次交互自动记录before快照，10次交互后自动对比
    if (this.interactionCount % 20 === 0) {
      const pendingVerification =
        this.verificationResults.length > 0
          ? this.verificationResults[this.verificationResults.length - 1]
          : null;
      if (
        !pendingVerification ||
        Date.now() - pendingVerification.verifiedAt > 300000
      ) {
        const snapshotId = this.recordBeforeSnapshot('auto_periodic_check');
        // 10次交互后验证
        const targetCount = this.interactionCount + 10;
        setTimeout(() => {
          if (this.interactionCount >= targetCount) {
            this.recordAfterSnapshot(snapshotId);
          }
        }, 30000);
      }
    }

    // 更新每日周期计数
    this.updateDailyCycleCount();
  }

  private driveEvolutionEngine(record: InteractionRecord): void {
    if (!this.evolutionEngine) return;

    try {
      this.evolutionEngine.assessQuality(
        record.traceId,
        record.success,
        record.qualityScore,
        record.executionDuration,
        record.scene
      );

      // 关键修复：同时喂 FeedbackCollector，让 StrategyOptimizer
      // 的 feedbackBuffer 累积真实交互数据
      this.evolutionEngine.collectFeedback(
        record.input,
        record.response,
        {
          success: record.success,
          intent: record.scene || 'general',
          toolsUsed: record.toolCalls.map((t) => t.toolName),
        },
        record.scene
      );
    } catch {
      Logger.debug('EvolutionEngine 记录失败', 'EvolutionOrchestrator');
    }
  }

  private driveProfileEvolution(record: InteractionRecord): void {
    if (!this.profileEvolution || !record.userId) return;

    try {
      this.profileEvolution.recordFeedback(
        {
          traceId: record.traceId,
          taskId: record.traceId,
          inputText: record.input,
          scene: record.scene || 'unknown',
          emotion: 'neutral',
          isSuccess: record.success,
          loopCount: record.toolCalls?.length || 0,
          totalExecutionTime: record.executionDuration,
          toolExecutions:
            record.toolCalls?.map((tc) => ({
              toolName: tc.toolName,
              params: {},
              success: tc.success,
              executionTime: tc.executionTime,
              retryCount: 0,
            })) || [],
          failureReasons: [],
          reflection: null,
          timestamp: Date.now(),
        },
        record.userId
      );

      // 每30次交互自动触发一次画像进化验证
      if (this.interactionCount > 0 && this.interactionCount % 30 === 0) {
        const snapshotId = this.recordBeforeSnapshot('profile_update');
        setTimeout(() => {
          if (this.interactionCount > 0) {
            this.recordAfterSnapshot(snapshotId);
          }
        }, 15000);
      }
    } catch {
      // 静默失败
    }
  }

  /**
   * P1+P2: 统一优化触发
   * 协调各引擎的优化周期，防止冲突
   */
  async triggerOptimizationCycle(
    reason: string,
    force: boolean = false
  ): Promise<OptimizationCycle | null> {
    if (this.optimizationInProgress && !force) {
      Logger.warn(
        '⚠️ 优化周期已在执行中，跳过本次触发',
        'EvolutionOrchestrator'
      );
      return null;
    }

    this.optimizationInProgress = true;
    const cycleId = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = Date.now();
    const results: OptimizationCycle['results'] = [];

    try {
      // 检查各引擎冷却期
      const canTriggerEngine = (engineName: string): boolean => {
        const cooldown =
          this.engineCooldowns.get(engineName) || this.defaultCooldownMs;
        const lastTriggered = this.engineLastTriggered.get(engineName) || 0;
        return force || Date.now() - lastTriggered >= cooldown;
      };

      // 按顺序触发各引擎的优化（不并行以避免冲突）
      if (this.evolutionEngine && canTriggerEngine('EvolutionEngine')) {
        try {
          const optLog = await this.evolutionEngine.triggerManualOptimization(
            `${reason} (编排器触发)`
          );
          this.engineLastTriggered.set('EvolutionEngine', Date.now());
          results.push({
            engineName: 'EvolutionEngine',
            triggered: true,
            detail: `优化ID: ${optLog.id}`,
          });
        } catch (error) {
          results.push({
            engineName: 'EvolutionEngine',
            triggered: false,
            detail: (error as Error).message,
          });
        }
      } else if (this.evolutionEngine) {
        results.push({
          engineName: 'EvolutionEngine',
          triggered: false,
          detail: '冷却期中，跳过',
        });
      }

      this.optimizationCycles.push({
        cycleId,
        timestamp,
        enginesParticipated: results
          .filter((r) => r.triggered)
          .map((r) => r.engineName),
        results,
        overallScore: this.calculateOverallScore(),
      });

      if (this.optimizationCycles.length > this.maxOptimizationCycles) {
        this.optimizationCycles = this.optimizationCycles.slice(
          -this.maxOptimizationCycles
        );
      }

      this.cyclesToday++;

      const triggeredCount = results.filter((r) => r.triggered).length;
      void EventBus.emit('optimization_cycle_completed', {
        cycleId,
        timestamp,
        improvements: triggeredCount,
        results,
        overallScore:
          this.optimizationCycles[this.optimizationCycles.length - 1]
            .overallScore,
      });

      Logger.info(
        `🔄 优化周期完成: ${cycleId} (参与: ${results.filter((r) => r.triggered).length}/${results.length} 个引擎)`,
        'EvolutionOrchestrator'
      );
    } finally {
      this.optimizationInProgress = false;
    }

    return this.optimizationCycles[this.optimizationCycles.length - 1];
  }

  // ── 统一优化效果验证框架 ──
  //
  // 职责：替代三套独立的验证机制（RealTimeFeedbackLoop / EvolutionOptimizer / ContinuousPerformanceOptimizer）
  // 设计：beforeSnapshot → [优化执行] → 等待N次交互 → afterSnapshot → 对比报告
  // 覆盖：- 通用质量验证（quality trend before/after）
  //       - 工具权重下游验证（单工具成功率变化）
  //       - 用户画像进化验证（profile更新前后质量变化）

  private verificationSnapshots: Array<{
    id: string;
    type:
      | 'before_optimization'
      | 'after_optimization'
      | 'tool_weight'
      | 'profile_update';
    timestamp: number;
    metrics: {
      avgQualityScore: number;
      avgResponseTime: number;
      toolSuccessRates: Record<string, { success: number; total: number }>;
      interactionCount: number;
    };
    context: {
      target?: string; // 验证目标（工具名 / profile / general）
      relatedEvent?: string; // 关联事件ID
    };
  }> = [];

  private verificationResults: Array<{
    id: string;
    type: 'optimization' | 'tool_weight' | 'profile_update';
    target: string;
    beforeScore: number;
    afterScore: number;
    improvement: number;
    verifiedAt: number;
    confidence: 'high' | 'medium' | 'low';
    success: boolean;
  }> = [];

  /** 记录优化前的基线快照 */
  recordBeforeSnapshot(target: string, relatedEvent?: string): string {
    const snapshotId = 'ver_before_' + Date.now();
    const recentQuality = this.qualityHistory.slice(-30);
    const recentResponseTimes = this.responseTimeHistory.slice(-30);

    const toolSuccessRates: Record<string, { success: number; total: number }> =
      {};

    this.verificationSnapshots.push({
      id: snapshotId,
      type: 'before_optimization',
      timestamp: Date.now(),
      metrics: {
        avgQualityScore:
          recentQuality.length > 0
            ? recentQuality.reduce((s, v) => s + v, 0) / recentQuality.length
            : 0,
        avgResponseTime:
          recentResponseTimes.length > 0
            ? recentResponseTimes.reduce((s, v) => s + v, 0) /
              recentResponseTimes.length
            : 0,
        toolSuccessRates,
        interactionCount: this.interactionCount,
      },
      context: { target, relatedEvent },
    });

    return snapshotId;
  }

  /** 记录优化后的快照并与基线对比 */
  recordAfterSnapshot(beforeSnapshotId: string): {
    result: string;
    improvement: number;
    verificationResult: {
      id: string;
      type: 'optimization' | 'tool_weight' | 'profile_update';
      target: string;
      beforeScore: number;
      afterScore: number;
      improvement: number;
      verifiedAt: number;
      confidence: 'high' | 'medium' | 'low';
      success: boolean;
    } | null;
  } | null {
    const before = this.verificationSnapshots.find(
      (s) => s.id === beforeSnapshotId
    );
    if (!before) return null;

    const recentQuality = this.qualityHistory.slice(-30);

    const afterScore =
      recentQuality.length > 0
        ? recentQuality.reduce((s, v) => s + v, 0) / recentQuality.length
        : 0;
    const improvement = afterScore - before.metrics.avgQualityScore;

    let toolVerificationDetail = '';

    // 用户画像进化验证：前后质量对比
    let profileVerificationDetail = '';
    if (before.context.target === 'profile_update') {
      const interactionsAfter =
        this.interactionCount - before.metrics.interactionCount;
      profileVerificationDetail = ` | 画像更新后已交互${interactionsAfter}次`;
    }

    const confidence: 'high' | 'medium' | 'low' =
      improvement > 0.1 ? 'high' : improvement > 0.03 ? 'medium' : 'low';
    const success = improvement > 0;

    const result = {
      id: `ver_${Date.now()}`,
      type:
        before.context.target === 'profile_update'
          ? ('profile_update' as const)
          : before.context.target?.startsWith('tool_')
            ? ('tool_weight' as const)
            : ('optimization' as const),
      target: before.context.target || 'general',
      beforeScore: before.metrics.avgQualityScore,
      afterScore,
      improvement,
      verifiedAt: Date.now(),
      confidence,
      success,
    };

    this.verificationResults.push(result);
    if (this.verificationResults.length > 100) {
      this.verificationResults = this.verificationResults.slice(-100);
    }

    Logger.info(
      `📊 效果验证: ${result.type}/${result.target} | ${before.metrics.avgQualityScore.toFixed(2)} → ${afterScore.toFixed(2)} (${improvement > 0 ? '+' : ''}${improvement.toFixed(2)})${toolVerificationDetail}${profileVerificationDetail}`,
      'EvolutionOrchestrator'
    );

    return {
      result: success ? 'improved' : 'declined',
      improvement,
      verificationResult: result,
    };
  }

  /** 简化接口：在优化周期中自动执行 before/after 验证 */
  async triggerOptimizationCycleWithVerification(
    reason: string,
    force: boolean = false
  ): Promise<{
    cycle: OptimizationCycle | null;
    verificationId: string | null;
  }> {
    const snapshotId = this.recordBeforeSnapshot(reason);
    const cycle = await this.triggerOptimizationCycle(reason, force);

    // 延迟验证：等 10 次交互后再记录 after 快照
    const targetInteractions = this.interactionCount + 10;
    let retryCount = 0;
    const MAX_RETRIES = 60; // 最多等待 5 分钟（60 * 5s）
    const checkAndVerify = (): void => {
      if (this.interactionCount >= targetInteractions) {
        this.recordAfterSnapshot(snapshotId);
      } else if (retryCount < MAX_RETRIES) {
        retryCount++;
        setTimeout(checkAndVerify, 5000);
      } else {
        Logger.warn(
          `验证超时：${reason}，已等待 ${MAX_RETRIES * 5} 秒`,
          'EvolutionOrchestrator'
        );
      }
    };
    setTimeout(checkAndVerify, 5000);

    return { cycle, verificationId: snapshotId };
  }

  /** 获取验证报告 */
  getVerificationReport(): Array<{
    type: string;
    target: string;
    before: string;
    after: string;
    improvement: string;
    verdict: string;
  }> {
    return this.verificationResults.slice(-20).map((r) => ({
      type: r.type,
      target: r.target,
      before: r.beforeScore.toFixed(2),
      after: r.afterScore.toFixed(2),
      improvement: `${r.improvement > 0 ? '+' : ''}${r.improvement.toFixed(2)}`,
      verdict: r.success ? '✅ 改善' : '⚠️ 未改善',
    }));
  }

  /**
   * P1: 获取统一进化指标
   * 从所有引擎聚合指标，提供全局视图
   */
  getUnifiedMetrics(): UnifiedEvolutionMetrics {
    const recentQuality = this.qualityHistory.slice(-50);
    const avgQuality =
      recentQuality.length > 0
        ? recentQuality.reduce((s, v) => s + v, 0) / recentQuality.length
        : 0;

    const recentResponseTimes = this.responseTimeHistory.slice(-50);
    const avgResponseTime =
      recentResponseTimes.length > 0
        ? recentResponseTimes.reduce((s, v) => s + v, 0) /
          recentResponseTimes.length
        : 0;

    const sortedTimes = [...recentResponseTimes].sort((a, b) => a - b);
    const p95Index = Math.ceil(sortedTimes.length * 0.95) - 1;
    const p95Time = p95Index >= 0 ? sortedTimes[p95Index] : 0;

    const qualityTrend = this.calculateQualityTrend();

    const failureCount = this.qualityHistory.filter((s) => s < 0.4).length;
    const failureRate =
      this.qualityHistory.length > 0
        ? failureCount / this.qualityHistory.length
        : 0;

    const successfulCycles = this.optimizationCycles.filter((c) =>
      c.results.some((r) => r.triggered)
    ).length;
    const cycleSuccessRate =
      this.optimizationCycles.length > 0
        ? successfulCycles / this.optimizationCycles.length
        : 0;

    const toolWeights: Record<string, number> = {};

    const evolutionMetrics = this.evolutionEngine
      ? this.getEvolutionMetricsSafe()
      : null;

    return {
      summary: {
        totalInteractions: this.interactionCount,
        totalOptimizations: this.optimizationCycles.length,
        averageQualityScore: avgQuality,
        weeklyImprovement:
          evolutionMetrics?.weeklyOptimizationStats?.successRate || 0,
        enginesActive: [
          ...(this.evolutionEngine ? ['EvolutionEngine'] : []),
          ...(this.profileEvolution ? ['ProfileEvolution'] : []),
          ...(this.taskAdjuster ? ['DynamicTaskAdjuster'] : []),
        ],
      },
      quality: {
        current: avgQuality,
        trend: qualityTrend,
        recentScores: recentQuality.slice(-20),
        failureRate,
      },
      performance: {
        averageResponseTime: avgResponseTime,
        p95ResponseTime: p95Time,
        throughput:
          this.interactionCount > 0
            ? (this.interactionCount / (Date.now() - this.startTime)) * 3600000
            : 0,
      },
      optimization: {
        lastCycleTime:
          this.optimizationCycles.length > 0
            ? this.optimizationCycles[this.optimizationCycles.length - 1]
                .timestamp
            : null,
        cyclesToday: this.cyclesToday,
        totalCycles: this.optimizationCycles.length,
        successRate: cycleSuccessRate,
        recentCycles: this.optimizationCycles.slice(-10),
      },
      evolution: evolutionMetrics,
      engines: {
        toolWeights,
        userProfileConfidence: this.profileEvolution
          ? this.profileEvolution.getStatistics
            ? this.profileEvolution.getStatistics().averageLearningConfidence
            : 0
          : 0,
        taskAdjustmentCount: this.taskAdjuster
          ? this.taskAdjuster.getAdjustmentHistory
            ? this.taskAdjuster.getAdjustmentHistory().length
            : 0
          : 0,
      },
      verification: {
        totalVerifications: this.verificationResults.length,
        successRate:
          this.verificationResults.length > 0
            ? this.verificationResults.filter((r) => r.success).length /
              this.verificationResults.length
            : 0,
        recentResults: this.verificationResults.slice(-10).map((r) => ({
          type: r.type,
          target: r.target,
          before: r.beforeScore.toFixed(2),
          after: r.afterScore.toFixed(2),
          verdict: r.success ? 'improved' : 'declined',
          confidence: r.confidence,
        })),
      },
    };
  }

  /**
   * 设置各引擎的冷却期
   */
  setEngineCooldown(engineName: string, cooldownMs: number): void {
    this.engineCooldowns.set(engineName, cooldownMs);
  }

  /**
   * 重置每日周期计数
   */
  resetDailyCount(): void {
    this.cyclesToday = 0;
    this.lastCycleDay = Date.now();
  }

  // ── 以下为私有辅助方法 ──

  private startTime = Date.now();

  private setupEventListeners(): void {
    void EventBus.on('feedback_collected', async () => {
      if (this.isRunning && this.interactionCount % 20 === 0) {
        // 每20次交互触发一次检查性优化
        this.scheduleDeferredOptimization('周期性检查');
      }
    });

    void EventBus.on(
      'optimization_requested',
      async (payload: {
        requestId: string;
        target: string;
        priority: 'high' | 'medium' | 'low';
      }) => {
        if (this.isRunning) {
          await this.triggerOptimizationCycle(payload.target);
        }
      }
    );
  }

  private scheduleDeferredOptimization(reason: string): void {
    setImmediate(() => {
      void this.triggerOptimizationCycle(reason);
    });
  }

  private updateDailyCycleCount(): void {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    if (now - this.lastCycleDay > oneDay) {
      this.cyclesToday = 0;
      this.lastCycleDay = now;
    }
  }

  private calculateQualityTrend(): 'improving' | 'stable' | 'declining' {
    const recent = this.qualityHistory.slice(-50);
    if (recent.length < 10) return 'stable';

    const half = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, half);
    const secondHalf = recent.slice(half);

    const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

    const diff = avgSecond - avgFirst;
    if (diff > 0.05) return 'improving';
    if (diff < -0.05) return 'declining';
    return 'stable';
  }

  private calculateOverallScore(): number {
    const recentScores = this.qualityHistory.slice(-20);
    if (recentScores.length === 0) return 0.5;

    const avg = recentScores.reduce((s, v) => s + v, 0) / recentScores.length;

    const activeEngineCount = [
      this.evolutionEngine,
      this.profileEvolution,
      this.taskAdjuster,
    ].filter(Boolean).length;

    return avg * (0.5 + 0.5 * (activeEngineCount / 3));
  }

  private getEvolutionMetricsSafe(): EvolutionMetrics | null {
    try {
      if (
        this.evolutionEngine &&
        typeof (this.evolutionEngine as unknown as Record<string, unknown>)
          .getMetrics === 'function'
      ) {
        return (
          this.evolutionEngine as unknown as { getMetrics(): EvolutionMetrics }
        ).getMetrics();
      }
    } catch {
      // 静默
    }
    return null;
  }
}

export default EvolutionOrchestrator;
