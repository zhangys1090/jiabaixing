/**
 * 进化引擎主控 v3 - P1 增强版
 * 1. 定时每日凌晨 3 点自动运行分析
 * 2. 用户触发词检测
 * 3. 实时反馈闭环（新增）
 * 4. 自适应阈值调整（新增）
 * 5. 进化指标 API（新增）
 * 6. P1: 失败案例自动收集与分析模块
 * 7. P1: 优化方案的自动生成与验证流程
 * 8. P1: 任务执行效果评估指标体系
 */

import { MemoryEngine } from '../memory/MemoryEngine';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { FeedbackCollector } from './FeedbackCollector';
import { OptimizationLog, StrategyOptimizer } from './StrategyOptimizer';

/** 质量评估结果（原 RealTimeFeedbackLoop 已删除，本地定义） */
export interface QualityAssessment {
  score: number;
  scene: string;
  timestamp: number;
  needsOptimization: boolean;
  factors: string[];
}

/** RealTimeFeedbackLoop - 真实实现 */
class RealTimeFeedbackLoop {
  private assessments: QualityAssessment[] = [];
  private readonly maxAssessments = 500;
  private consecutiveLowCount = 0;
  private totalOptimizations = 0;
  private optimizationVerifications: Array<{
    optimizationId: string;
    beforeScore: number;
    afterScore: number;
    improvement: number;
    improvementPercentage: number;
    verifiedAt: number;
  }> = [];
  private pendingVerifications: Map<
    string,
    { beforeScore: number; timestamp: number }
  > = new Map();
  private strategyOptimizer: StrategyOptimizer | null;

  constructor(strategyOptimizer?: StrategyOptimizer) {
    this.strategyOptimizer = strategyOptimizer || null;
  }

  assessAndReact(
    traceId: string,
    success: boolean,
    satisfaction: number,
    duration: number,
    scene?: string
  ): QualityAssessment {
    const factors: string[] = [];
    let score = satisfaction;

    if (!success) {
      score = Math.min(score, 0.3);
      factors.push('execution_failed');
    }

    if (duration > 10000) {
      score *= 0.9;
      factors.push('slow_response');
    } else if (duration > 30000) {
      score *= 0.7;
      factors.push('very_slow_response');
    }

    if (satisfaction < 0.4) {
      factors.push('low_satisfaction');
    }

    score = Math.max(0, Math.min(1, score));

    const needsOptimization =
      !success || score < 0.4 || this.consecutiveLowCount >= 3;

    if (score < 0.4) {
      this.consecutiveLowCount++;
    } else {
      this.consecutiveLowCount = 0;
    }

    const assessment: QualityAssessment = {
      score,
      scene: scene || 'unknown',
      timestamp: Date.now(),
      needsOptimization,
      factors,
    };

    this.assessments.push(assessment);
    if (this.assessments.length > this.maxAssessments) {
      this.assessments = this.assessments.slice(-this.maxAssessments);
    }

    if (
      needsOptimization &&
      this.consecutiveLowCount >= 3 &&
      this.strategyOptimizer
    ) {
      Logger.info(
        `🔄 连续 ${this.consecutiveLowCount} 次低质量，触发自动优化`,
        'RealTimeFeedbackLoop'
      );
      this.strategyOptimizer
        .triggerManualOptimization(
          `连续${this.consecutiveLowCount}次低质量评估 [场景:${scene || 'unknown'}]`
        )
        .catch(() => {});
      this.totalOptimizations++;
    }

    return assessment;
  }

  getStats(): {
    totalOptimizations: number;
    averageScore: number;
    consecutiveLowCount: number;
  } {
    const recent = this.assessments.slice(-50);
    const averageScore =
      recent.length > 0
        ? recent.reduce((s, a) => s + a.score, 0) / recent.length
        : 0.5;

    return {
      totalOptimizations: this.totalOptimizations,
      averageScore,
      consecutiveLowCount: this.consecutiveLowCount,
    };
  }

  getRecentAssessments(limit: number): QualityAssessment[] {
    return this.assessments.slice(-limit);
  }

  getFailureAnalysis(): Array<{
    scene: string;
    failureCount: number;
    topFactors: string[];
    averageScore: number;
    trend: 'improving' | 'stable' | 'worsening';
  }> {
    const sceneStats = new Map<
      string,
      {
        failures: number;
        totalScore: number;
        count: number;
        factorCounts: Map<string, number>;
        recentScores: number[];
      }
    >();

    for (const a of this.assessments) {
      if (!sceneStats.has(a.scene)) {
        sceneStats.set(a.scene, {
          failures: 0,
          totalScore: 0,
          count: 0,
          factorCounts: new Map(),
          recentScores: [],
        });
      }
      const stats = sceneStats.get(a.scene)!;
      stats.count++;
      stats.totalScore += a.score;
      stats.recentScores.push(a.score);
      if (stats.recentScores.length > 20) {
        stats.recentScores = stats.recentScores.slice(-20);
      }

      if (!a.score || a.score < 0.4 || a.factors.includes('execution_failed')) {
        stats.failures++;
      }

      for (const factor of a.factors) {
        stats.factorCounts.set(
          factor,
          (stats.factorCounts.get(factor) || 0) + 1
        );
      }
    }

    const results: Array<{
      scene: string;
      failureCount: number;
      topFactors: string[];
      averageScore: number;
      trend: 'improving' | 'stable' | 'worsening';
    }> = [];

    for (const [scene, stats] of sceneStats) {
      if (stats.failures === 0) continue;

      const sortedFactors = Array.from(stats.factorCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([f]) => f);

      const scores = stats.recentScores;
      let trend: 'improving' | 'stable' | 'worsening' = 'stable';
      if (scores.length >= 6) {
        const half = Math.floor(scores.length / 2);
        const firstHalf = scores.slice(0, half);
        const secondHalf = scores.slice(half);
        const avgFirst =
          firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
        const avgSecond =
          secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
        const diff = avgSecond - avgFirst;
        if (diff > 0.05) trend = 'improving';
        else if (diff < -0.05) trend = 'worsening';
      }

      results.push({
        scene,
        failureCount: stats.failures,
        topFactors: sortedFactors,
        averageScore: stats.count > 0 ? stats.totalScore / stats.count : 0,
        trend,
      });
    }

    return results.sort((a, b) => b.failureCount - a.failureCount);
  }

  getOptimizationVerificationReport(): Array<{
    optimizationId: string;
    beforeScore: number;
    afterScore: number;
    improvement: number;
    improvementPercentage: number;
    verifiedAt: number;
  }> {
    return [...this.optimizationVerifications];
  }

  verifyOptimizationEffect(optimizationId: string): void {
    const recent = this.assessments.slice(-20);
    const beforeScore =
      recent.length > 0
        ? recent
            .slice(0, Math.floor(recent.length / 2))
            .reduce((s, a) => s + a.score, 0) /
          Math.max(1, Math.floor(recent.length / 2))
        : 0.5;
    const afterScore =
      recent.length > 0
        ? recent
            .slice(Math.floor(recent.length / 2))
            .reduce((s, a) => s + a.score, 0) /
          Math.max(1, recent.length - Math.floor(recent.length / 2))
        : 0.5;

    const improvement = afterScore - beforeScore;
    const improvementPercentage =
      beforeScore > 0 ? (improvement / beforeScore) * 100 : 0;

    this.optimizationVerifications.push({
      optimizationId,
      beforeScore,
      afterScore,
      improvement,
      improvementPercentage,
      verifiedAt: Date.now(),
    });

    if (this.optimizationVerifications.length > 50) {
      this.optimizationVerifications =
        this.optimizationVerifications.slice(-50);
    }

    Logger.info(
      `📊 优化效果验证: ${optimizationId} | ${beforeScore.toFixed(2)} → ${afterScore.toFixed(2)} (${improvement > 0 ? '+' : ''}${improvement.toFixed(2)})`,
      'RealTimeFeedbackLoop'
    );
  }
}

export interface EvolutionMetrics {
  totalFeedback: number;
  totalOptimizations: number;
  averageQualityScore: number;
  consecutiveLowCount: number;
  adaptiveThreshold: number;
  optimizationHistory: Array<{
    id: string;
    timestamp: number;
    triggeredBy: string;
    reason: string;
  }>;
  recentAssessments: QualityAssessment[];
  /** P1: 失败案例分析 */
  failureAnalysis: Array<{
    scene: string;
    failureCount: number;
    topFactors: string[];
    averageScore: number;
    trend: 'improving' | 'stable' | 'worsening';
  }>;
  /** P1: 优化效果验证 */
  optimizationVerification: Array<{
    optimizationId: string;
    beforeScore: number;
    afterScore: number;
    improvement: number;
    improvementPercentage: number;
    verifiedAt: number;
  }>;
  /** P1: 周优化统计 */
  weeklyOptimizationStats: {
    weekStart: number;
    optimizationCount: number;
    averageImprovement: number;
    successRate: number;
  };
}

/** P1: 任务执行效果评估指标 */
export interface TaskExecutionMetrics {
  totalTasks: number;
  successRate: number;
  averageDuration: number;
  averageQualityScore: number;
  weeklyImprovement: number;
  failureRateByScene: Array<{
    scene: string;
    failureRate: number;
    count: number;
  }>;
}

export class EvolutionEngine {
  private feedbackCollector: FeedbackCollector;
  private strategyOptimizer: StrategyOptimizer;
  private realTimeFeedbackLoop: RealTimeFeedbackLoop;
  private memoryEngine: MemoryEngine | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private eventUnsubscribers: Array<() => void> = [];
  private interactionTimestamps: number[] = [];
  private adaptiveThreshold = 50;
  /** P1: 每周优化计数 */
  private weeklyOptimizationCount = 0;
  private weekStartTime = Date.now();
  /** P1: 任务成功率记录 */
  private taskResults: Array<{
    success: boolean;
    scene?: string;
    duration: number;
    score: number;
    timestamp: number;
  }> = [];

  constructor(memoryEngine?: MemoryEngine) {
    this.feedbackCollector = new FeedbackCollector();
    this.strategyOptimizer = new StrategyOptimizer();
    this.realTimeFeedbackLoop = new RealTimeFeedbackLoop(
      this.strategyOptimizer
    );
    this.memoryEngine = memoryEngine || null;
  }

  setMemoryEngine(memoryEngine: MemoryEngine): void {
    this.memoryEngine = memoryEngine;
  }

  getFeedbackCollector(): FeedbackCollector {
    return this.feedbackCollector;
  }

  getStrategyOptimizer(): StrategyOptimizer {
    return this.strategyOptimizer;
  }

  getRealTimeFeedbackLoop(): RealTimeFeedbackLoop {
    return this.realTimeFeedbackLoop;
  }

  start(): void {
    if (this.isRunning) {
      Logger.warn('⚠️ 进化引擎已在运行', 'EvolutionEngine');
      return;
    }

    this.isRunning = true;
    Logger.info(
      '🧬 进化引擎已启动（v3 含实时反馈闭环 + P1 增强）',
      'EvolutionEngine'
    );

    this.scheduleDailyOptimization();
    this.setupEventListeners();
    this.startAdaptiveThresholdLoop();
    this.startWeeklyStatsResetLoop();

    setImmediate(() => {
      void this.runQuickCheck();
    });
  }

  stop(): void {
    this.isRunning = false;

    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }

    for (const unsubscribe of this.eventUnsubscribers) {
      unsubscribe();
    }
    this.eventUnsubscribers = [];

    Logger.info('🧬 进化引擎已停止', 'EvolutionEngine');
  }

  async triggerManualOptimization(reason: string): Promise<OptimizationLog> {
    Logger.info(`🔧 手动触发优化: ${reason}`, 'EvolutionEngine');
    return this.strategyOptimizer.triggerManualOptimization(reason);
  }

  collectFeedback(
    input: string,
    response: string,
    executionResult: {
      success: boolean;
      intent?: string;
      toolsUsed?: string[];
      error?: string;
    },
    scene?: string
  ): void {
    this.feedbackCollector.collect(input, response, executionResult, scene);

    // 关键桥接：将 FeedbackCollector 的数据同步到 StrategyOptimizer
    // 让 learnTonePreference / learnSkillPreference 有真实数据可用
    const recentFeedback = this.feedbackCollector.getRecent(1);
    if (recentFeedback.length > 0) {
      this.strategyOptimizer.addFeedback(recentFeedback[0]);
    }

    this.interactionTimestamps.push(Date.now());
    if (this.interactionTimestamps.length > 100) {
      this.interactionTimestamps = this.interactionTimestamps.slice(-100);
    }

    this.realTimeFeedbackLoop.assessAndReact(
      executionResult.intent || 'unknown',
      executionResult.success,
      executionResult.success ? 0.7 : 0.3,
      0,
      scene
    );

    // P1: 记录任务执行结果
    this.recordTaskResult(
      executionResult.success,
      scene,
      0,
      executionResult.success ? 0.7 : 0.3
    );

    this.updateAdaptiveThreshold();
  }

  assessQuality(
    traceId: string,
    success: boolean,
    satisfaction: number,
    duration: number,
    scene?: string
  ): QualityAssessment {
    const assessment = this.realTimeFeedbackLoop.assessAndReact(
      traceId,
      success,
      satisfaction,
      duration,
      scene
    );

    // P1: 记录任务执行结果
    this.recordTaskResult(success, scene, duration, assessment.score);

    return assessment;
  }

  /** P1: 记录任务执行结果 */
  private recordTaskResult(
    success: boolean,
    scene: string | undefined,
    duration: number,
    score: number
  ): void {
    this.taskResults.push({
      success,
      scene,
      duration,
      score,
      timestamp: Date.now(),
    });

    // 限制记录数量
    if (this.taskResults.length > 1000) {
      this.taskResults = this.taskResults.slice(-500);
    }
  }

  /** P1: 获取任务执行效果评估指标 */
  getTaskExecutionMetrics(): TaskExecutionMetrics {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

    const recentResults = this.taskResults.filter(
      (r) => r.timestamp > oneWeekAgo
    );
    const previousResults = this.taskResults.filter(
      (r) => r.timestamp > twoWeeksAgo && r.timestamp <= oneWeekAgo
    );

    const totalTasks = recentResults.length;
    const successCount = recentResults.filter((r) => r.success).length;
    const successRate = totalTasks > 0 ? successCount / totalTasks : 0;

    const averageDuration =
      totalTasks > 0
        ? recentResults.reduce((s, r) => s + r.duration, 0) / totalTasks
        : 0;

    const averageQualityScore =
      totalTasks > 0
        ? recentResults.reduce((s, r) => s + r.score, 0) / totalTasks
        : 0;

    // 计算周环比提升
    const previousSuccessRate =
      previousResults.length > 0
        ? previousResults.filter((r) => r.success).length /
          previousResults.length
        : 0;
    const weeklyImprovement = successRate - previousSuccessRate;

    // 按场景统计失败率
    const sceneStats = new Map<string, { total: number; failures: number }>();
    for (const result of recentResults) {
      const scene = result.scene || 'unknown';
      if (!sceneStats.has(scene)) {
        sceneStats.set(scene, { total: 0, failures: 0 });
      }
      const stats = sceneStats.get(scene)!;
      stats.total++;
      if (!result.success) {
        stats.failures++;
      }
    }

    const failureRateByScene = Array.from(sceneStats.entries()).map(
      ([scene, stats]) => ({
        scene,
        failureRate: stats.total > 0 ? stats.failures / stats.total : 0,
        count: stats.total,
      })
    );

    return {
      totalTasks,
      successRate,
      averageDuration,
      averageQualityScore,
      weeklyImprovement,
      failureRateByScene,
    };
  }

  getMetrics(): EvolutionMetrics {
    const feedbackStats = this.realTimeFeedbackLoop.getStats();
    const optimizationHistory = this.strategyOptimizer
      .getOptimizationHistory()
      .map((log) => ({
        id: log.id,
        timestamp: log.timestamp.getTime(),
        triggeredBy: log.triggeredBy,
        reason: log.reason,
      }));

    // P1: 获取失败案例分析
    const failureAnalysis = this.realTimeFeedbackLoop.getFailureAnalysis();

    // P1: 获取优化效果验证报告
    const optimizationVerification =
      this.realTimeFeedbackLoop.getOptimizationVerificationReport();

    // P1: 计算周优化统计
    const weekStart = this.weekStartTime;
    const weekOptimizations = optimizationHistory.filter(
      (log) => log.timestamp >= weekStart
    );
    const averageImprovement =
      optimizationVerification.length > 0
        ? optimizationVerification.reduce((s, v) => s + v.improvement, 0) /
          optimizationVerification.length
        : 0;
    const successRate =
      optimizationVerification.length > 0
        ? optimizationVerification.filter((v) => v.improvement > 0).length /
          optimizationVerification.length
        : 0;

    return {
      totalFeedback: this.feedbackCollector.count,
      totalOptimizations: feedbackStats.totalOptimizations,
      averageQualityScore: feedbackStats.averageScore,
      consecutiveLowCount: feedbackStats.consecutiveLowCount,
      adaptiveThreshold: this.adaptiveThreshold,
      optimizationHistory,
      recentAssessments: this.realTimeFeedbackLoop.getRecentAssessments(10),
      failureAnalysis,
      optimizationVerification,
      weeklyOptimizationStats: {
        weekStart,
        optimizationCount: weekOptimizations.length,
        averageImprovement,
        successRate,
      },
    };
  }

  getInsights(): Array<{
    category: string;
    content: string;
    confidence: number;
  }> {
    const lowSatisfaction = this.feedbackCollector.getLowSatisfaction(0.4);
    const corrections = this.feedbackCollector.getCorrections();

    const insights: Array<{
      category: string;
      content: string;
      confidence: number;
    }> = [];

    if (lowSatisfaction.length > 0) {
      const avgSatisfaction =
        lowSatisfaction.reduce((s, f) => s + f.inferredSatisfaction, 0) /
        lowSatisfaction.length;
      insights.push({
        category: 'satisfaction',
        content: `${lowSatisfaction.length} 条低满意度反馈，平均满意度 ${avgSatisfaction.toFixed(2)}`,
        confidence: 0.8,
      });
    }

    if (corrections.length > 0) {
      insights.push({
        category: 'correction',
        content: `${corrections.length} 条用户纠正，需要关注语气和准确性`,
        confidence: 0.9,
      });
    }

    const recentAssessments =
      this.realTimeFeedbackLoop.getRecentAssessments(20);
    const lowQualityCount = recentAssessments.filter(
      (a) => a.score < 0.6
    ).length;
    if (lowQualityCount > recentAssessments.length * 0.3) {
      insights.push({
        category: 'quality',
        content: `近期 ${lowQualityCount}/${recentAssessments.length} 次交互质量偏低`,
        confidence: 0.7,
      });
    }

    // P1: 添加失败案例洞察
    const failureAnalysis = this.realTimeFeedbackLoop.getFailureAnalysis();
    if (failureAnalysis.length > 0) {
      const topFailure = failureAnalysis[0];
      insights.push({
        category: 'failure_analysis',
        content: `场景 "${topFailure.scene}" 失败率最高 (${topFailure.failureCount} 次)，主要因素: ${topFailure.topFactors.join(', ')}`,
        confidence: 0.85,
      });
    }

    // P1: 添加任务执行效果洞察
    const taskMetrics = this.getTaskExecutionMetrics();
    if (taskMetrics.weeklyImprovement > 0) {
      insights.push({
        category: 'improvement',
        content: `任务成功率周环比提升 ${(taskMetrics.weeklyImprovement * 100).toFixed(1)}%`,
        confidence: 0.75,
      });
    } else if (taskMetrics.weeklyImprovement < 0) {
      insights.push({
        category: 'degradation',
        content: `任务成功率周环比下降 ${(Math.abs(taskMetrics.weeklyImprovement) * 100).toFixed(1)}%，需要关注`,
        confidence: 0.8,
      });
    }

    return insights;
  }

  getAdaptiveThreshold(): number {
    return this.adaptiveThreshold;
  }

  private updateAdaptiveThreshold(): void {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const recentInteractions = this.interactionTimestamps.filter(
      (t) => t > oneHourAgo
    ).length;

    if (recentInteractions > 20) {
      this.adaptiveThreshold = Math.max(10, this.adaptiveThreshold - 5);
    } else if (recentInteractions < 5) {
      this.adaptiveThreshold = Math.min(100, this.adaptiveThreshold + 5);
    }

    Logger.debug(
      `自适应阈值: ${this.adaptiveThreshold} (近1小时交互: ${recentInteractions})`,
      'EvolutionEngine'
    );
  }

  private startAdaptiveThresholdLoop(): void {
    const interval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(interval);
        return;
      }
      this.updateAdaptiveThreshold();
    }, 3600000);
  }

  /** P1: 每周重置统计 */
  private startWeeklyStatsResetLoop(): void {
    const interval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(interval);
        return;
      }

      const now = Date.now();
      const oneWeek = 7 * 24 * 60 * 60 * 1000;

      if (now - this.weekStartTime >= oneWeek) {
        Logger.info(
          `📊 周统计重置: 上周优化 ${this.weeklyOptimizationCount} 次`,
          'EvolutionEngine'
        );
        this.weeklyOptimizationCount = 0;
        this.weekStartTime = now;
      }
    }, 3600000); // 每小时检查一次
  }

  private scheduleDailyOptimization(): void {
    const now = new Date();
    const target = new Date(now);
    target.setHours(3, 0, 0, 0);

    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    const delay = target.getTime() - now.getTime();
    Logger.info(
      `⏰ 下次每日优化: ${target.toLocaleString()} (${Math.round(delay / 3600000)} 小时后)`,
      'EvolutionEngine'
    );

    this.dailyTimer = setTimeout(async () => {
      try {
        const log =
          await this.strategyOptimizer.triggerManualOptimization(
            '每日定时优化'
          );
        Logger.info(`✅ 每日优化完成: ${log.id}`, 'EvolutionEngine');

        // P1: 验证优化效果
        this.realTimeFeedbackLoop.verifyOptimizationEffect(log.id);
        this.weeklyOptimizationCount++;
      } catch (error) {
        Logger.error('❌ 每日优化失败', error as Error, 'EvolutionEngine');
      }

      this.scheduleDailyOptimization();
    }, delay);
  }

  private setupEventListeners(): void {
    const onActiveInteraction = (data: { input?: string }): void => {
      if (!data.input) return;

      const triggerPatterns = [
        /你最近[有是]点[冷硬机械]/,
        /你(的回复|的回答)(太[冷硬机械]|可以更好)/,
        /语气[冷硬不自然]/,
        /感觉你不[太好了]/,
        /能(不能|否)(调整|改变)语气/,
      ];

      for (const pattern of triggerPatterns) {
        if (pattern.test(data.input)) {
          Logger.info('🔧 检测到优化触发词，执行手动优化', 'EvolutionEngine');
          void this.triggerManualOptimization('用户反馈语气问题');
          break;
        }
      }
    };

    EventBus.on('active_interaction', onActiveInteraction);
    this.eventUnsubscribers.push(() =>
      EventBus.off('active_interaction', onActiveInteraction)
    );
  }

  private async runQuickCheck(): Promise<void> {
    try {
      const log = await this.strategyOptimizer.optimizeIfNeeded();
      if (log) {
        Logger.info(`✅ 首次快速优化完成: ${log.id}`, 'EvolutionEngine');
        this.weeklyOptimizationCount++;
      } else {
        Logger.info('ℹ️ 反馈不足，跳过首次优化', 'EvolutionEngine');
      }
    } catch (error) {
      Logger.error('❌ 首次快速优化失败', error as Error, 'EvolutionEngine');
    }
  }
}

export default EvolutionEngine;
