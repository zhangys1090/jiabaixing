/**
 * Harness Layer 5: Evaluation - 优化反馈闭环
 *
 * OptimizationFeedbackLoop 连接评估结果到进化引擎，形成完整的自优化闭环：
 *
 *   1. 运行评估管道 (EvaluationPipeline.run)
 *   2. 检查评分是否低于阈值 → 生成优化建议
 *   3. 通过 EvolutionOrchestrator 应用优化
 *   4. 返回评分和优化记录
 *
 * 闭环周期:
 *   evaluateAndOptimize()
 *   ├── EvaluationPipeline.run()         → 评估当前状态
 *   ├── checkThreshold()                 → 判断是否需要优化
 *   ├── generateOptimizationOps()        → 生成优化操作
 *   ├── applyOptimizations()             → 通过 EvolutionOrchestrator 应用
 *   └── recordOptimization()             → 记录优化历史
 *
 * Phase 11: 自评估与持续优化管道
 */

import {
  EvolutionOrchestrator,
  InteractionRecord,
} from '../../evolution/EvolutionOrchestrator';
import { Logger } from '../../utils/Logger';
import {
  EvaluationPipeline,
  EvaluationContext,
  PipelineResult,
} from './EvaluationPipeline';
import { QualityScore } from './QualityScorer';

/**
 * 优化反馈闭环结果
 */
export interface OptimizationFeedbackResult {
  /** 当前质量评分 */
  score: QualityScore;
  /** 优化操作列表 */
  optimizations: string[];
  /** 流水线评估结果 */
  pipelineResult: PipelineResult;
  /** 是否触发了优化 */
  optimizationTriggered: boolean;
  /** 优化周期ID（如果触发了优化） */
  optimizationCycleId?: string;
  /** 优化前后的验证快照ID */
  verificationSnapshotId?: string;
}

/**
 * 优化反馈闭环配置
 */
export interface OptimizationFeedbackConfig {
  /** 触发优化的评分阈值 (0-100)，低于此值触发优化 */
  threshold: number;
  /** 最大连续优化次数 */
  maxConsecutiveOptimizations: number;
  /** 两次优化之间的最小间隔 (ms) */
  cooldownMs: number;
  /** 是否强制优化（忽略冷却期） */
  forceOptimization: boolean;
}

/** 默认配置 */
const DEFAULT_CONFIG: OptimizationFeedbackConfig = {
  threshold: 60,
  maxConsecutiveOptimizations: 3,
  cooldownMs: 60 * 1000, // 1 分钟冷却
  forceOptimization: false,
};

/**
 * 优化反馈闭环
 */
export class OptimizationFeedbackLoop {
  private pipeline: EvaluationPipeline;
  private orchestrator: EvolutionOrchestrator;
  private config: OptimizationFeedbackConfig;

  /** 优化历史 */
  private optimizationHistory: Array<{
    timestamp: number;
    thresholdScore: number;
    actualScore: number;
    optimizations: string[];
    success: boolean;
  }> = [];

  /** 上次优化时间 */
  private lastOptimizationTime = 0;
  /** 连续优化计数 */
  private consecutiveOptimizationCount = 0;

  /**
   * @param pipeline     评估流水线实例
   * @param orchestrator 进化编排器实例（单例或传入）
   * @param config       可选配置
   */
  constructor(
    pipeline: EvaluationPipeline,
    orchestrator?: EvolutionOrchestrator,
    config?: Partial<OptimizationFeedbackConfig>
  ) {
    this.pipeline = pipeline;
    this.orchestrator = orchestrator || EvolutionOrchestrator.getInstance();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 更新配置
   */
  setConfig(config: Partial<OptimizationFeedbackConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): OptimizationFeedbackConfig {
    return { ...this.config };
  }

  /**
   * 获取优化历史
   */
  getOptimizationHistory(): Array<{
    timestamp: number;
    thresholdScore: number;
    actualScore: number;
    optimizations: string[];
    success: boolean;
  }> {
    return [...this.optimizationHistory];
  }

  /**
   * 核心方法：评估并优化
   *
   * 流程：
   * 1. 运行评估流水线
   * 2. 检查评分是否低于阈值
   * 3. 如果低于阈值，生成并应用优化
   * 4. 返回评分和优化记录
   *
   * @param context 评估上下文
   * @returns OptimizationFeedbackResult
   */
  async evaluateAndOptimize(
    context: EvaluationContext
  ): Promise<OptimizationFeedbackResult> {
    // 1. 运行评估流水线
    const pipelineResult = await this.pipeline.run(context);

    // 2. 提取质量评分
    const qualityScore =
      pipelineResult.qualityScore || this.buildFallbackScore(pipelineResult);
    const overallScore = qualityScore.overall;

    const result: OptimizationFeedbackResult = {
      score: qualityScore,
      optimizations: [],
      pipelineResult,
      optimizationTriggered: false,
    };

    // 3. 检查是否需要优化
    if (!this.shouldOptimize(overallScore)) {
      return result;
    }

    // 4. 生成优化操作
    const optimizations = this.generateOptimizations(
      qualityScore,
      pipelineResult
    );

    if (optimizations.length === 0) {
      // 无具体优化建议，但需要记录
      result.optimizations.push('评分低于阈值，但未生成具体优化操作');
      return result;
    }

    // 5. 应用优化
    const optimizationResult = await this.applyOptimizations(
      optimizations,
      pipelineResult
    );

    result.optimizations = optimizationResult.appliedOptimizations;
    result.optimizationTriggered = optimizationResult.triggered;
    result.optimizationCycleId = optimizationResult.cycleId;
    result.verificationSnapshotId = optimizationResult.verificationId;

    // 6. 记录优化历史
    this.optimizationHistory.push({
      timestamp: Date.now(),
      thresholdScore: this.config.threshold,
      actualScore: overallScore,
      optimizations: optimizationResult.appliedOptimizations,
      success: optimizationResult.triggered,
    });

    // 限制历史记录大小
    if (this.optimizationHistory.length > 100) {
      this.optimizationHistory = this.optimizationHistory.slice(-100);
    }

    // 7. 记录交互到进化编排器
    this.recordInteraction(context, overallScore);

    return result;
  }

  /**
   * 重置连续优化计数和冷却期
   */
  reset(): void {
    this.consecutiveOptimizationCount = 0;
    this.lastOptimizationTime = 0;
  }

  // ── 内部方法 ──

  /**
   * 判断是否应该触发优化
   */
  private shouldOptimize(score: number): boolean {
    // 分数高于阈值 → 不需要优化
    if (score >= this.config.threshold) {
      return false;
    }

    // 超过最大连续优化次数
    if (
      this.consecutiveOptimizationCount >=
      this.config.maxConsecutiveOptimizations
    ) {
      Logger.warn(
        `已达到最大连续优化次数 (${this.config.maxConsecutiveOptimizations})，跳过本次优化`,
        'OptimizationFeedbackLoop'
      );
      this.consecutiveOptimizationCount = 0; // 重置计数
      return false;
    }

    // 冷却期检查
    if (!this.config.forceOptimization) {
      const elapsed = Date.now() - this.lastOptimizationTime;
      if (elapsed < this.config.cooldownMs) {
        Logger.debug(
          `优化冷却期中 (${elapsed}ms < ${this.config.cooldownMs}ms)，跳过`,
          'OptimizationFeedbackLoop'
        );
        return false;
      }
    }

    return true;
  }

  /**
   * 基于评估结果生成优化操作列表
   */
  private generateOptimizations(
    qualityScore: QualityScore,
    pipelineResult: PipelineResult
  ): string[] {
    const optimizations: string[] = [];
    const dims = qualityScore.dimensions;

    // 1. 准确率优化
    if (dims.accuracy < 60) {
      optimizations.push(
        'ACCURACY: 提高工具调用准确性 — 检查工具参数定义，优化工具选择逻辑'
      );
    }

    // 2. 效率优化
    if (dims.efficiency < 60) {
      const meta = this.extractScorerMetadata(pipelineResult);
      if (meta && meta.totalToolCalls && meta.totalToolCalls > 10) {
        optimizations.push(
          'EFFICIENCY: 减少工具调用次数 — 考虑合并多个操作为一个批量操作'
        );
      }
      if (meta && (meta.retries ?? 0) > 2) {
        optimizations.push(
          'EFFICIENCY: 降低重试率 — 检查工具稳定性，添加前置条件验证'
        );
      }
      if (meta && meta.duration > 20000) {
        optimizations.push(
          'EFFICIENCY: 缩短执行耗时 — 简化执行路径，减少不必要的轮次'
        );
      }
    }

    // 3. 安全优化
    if (dims.safety < 60) {
      optimizations.push(
        'SAFETY: 加强安全审查 — 添加敏感信息过滤层，审计输出内容'
      );
    }

    // 4. 人设优化
    if (dims.persona < 60) {
      optimizations.push(
        'PERSONA: 调整人设一致性 — 更新系统提示词，强化御姐秘书风格约束'
      );
    }

    // 5. 稳定性优化
    if (dims.stability < 60) {
      optimizations.push(
        'STABILITY: 提升执行稳定性 — 添加错误恢复机制，增强容错处理'
      );
    }

    // 6. 从流水线结果中的建议提取
    for (const suggestion of pipelineResult.suggestions) {
      const normalized = `SUGGESTION: ${suggestion}`;
      if (!optimizations.includes(normalized)) {
        optimizations.push(normalized);
      }
    }

    // 7. 从独立评估结果提取
    if (pipelineResult.independentResult) {
      const ir = pipelineResult.independentResult;
      if (
        ir.safety.riskLevel === 'high' ||
        ir.safety.riskLevel === 'critical'
      ) {
        optimizations.push(
          'SAFETY_URGENT: 存在高风险安全问题，立即审查输出内容安全策略'
        );
      }
      if (ir.overall.suggestedAction === 'replan') {
        optimizations.push(
          'REPLAN: 评估建议重新规划，检查任务分解和目标清晰度'
        );
      }
    }

    return optimizations;
  }

  /**
   * 通过进化编排器应用优化
   */
  private async applyOptimizations(
    optimizations: string[],
    _pipelineResult: PipelineResult
  ): Promise<{
    triggered: boolean;
    appliedOptimizations: string[];
    cycleId?: string;
    verificationId?: string;
  }> {
    this.consecutiveOptimizationCount++;
    this.lastOptimizationTime = Date.now();

    const reason =
      optimizations.length > 0
        ? `自评估优化: ${optimizations.slice(0, 3).join('; ')}`
        : '自评估优化: 评分低于阈值';

    try {
      // 使用带验证的优化周期
      const result =
        await this.orchestrator.triggerOptimizationCycleWithVerification(
          reason,
          this.config.forceOptimization
        );

      if (result.cycle) {
        Logger.info(
          `🔄 优化反馈闭环触发: ${result.cycle.cycleId} | 优化: ${optimizations.length} 项`,
          'OptimizationFeedbackLoop'
        );

        // 记录交互到编排器
        this.orchestrator.recordInteraction({
          traceId: `opt_feedback_${Date.now()}`,
          input: reason,
          response: `自动优化: ${optimizations.join(', ')}`,
          success: true,
          qualityScore: 0, // 优化后的分数未知，留待下次评估
          executionDuration: 0,
          toolCalls: [],
        });

        return {
          triggered: true,
          appliedOptimizations: optimizations,
          cycleId: result.cycle.cycleId,
          verificationId: result.verificationId || undefined,
        };
      }

      return {
        triggered: false,
        appliedOptimizations: [],
      };
    } catch (error) {
      Logger.error(
        '优化应用失败',
        error instanceof Error ? error : new Error(String(error)),
        'OptimizationFeedbackLoop'
      );

      return {
        triggered: false,
        appliedOptimizations: optimizations, // 返回建议但标记为未触发
      };
    }
  }

  /**
   * 记录交互到进化编排器
   */
  private recordInteraction(
    context: EvaluationContext,
    overallScore: number
  ): void {
    const record: InteractionRecord = {
      traceId: `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      input: context.evalInput.userInput,
      response: context.evalInput.currentOutput || '',
      success: overallScore >= 50,
      qualityScore: overallScore / 100, // 归一化到 0-1
      executionDuration: context.scorerMetadata.duration,
      toolCalls: context.stepParams.map((p) => ({
        toolName: p.toolName,
        success: p.result.success,
        executionTime: 0,
      })),
      scene: 'self_evaluation',
    };

    try {
      this.orchestrator.recordInteraction(record);
    } catch {
      // 静默失败，不阻塞评估流程
    }
  }

  /**
   * 当 pipeline 未生成 QualityScore 时构建回退评分
   */
  private buildFallbackScore(pipelineResult: PipelineResult): QualityScore {
    return {
      overall: pipelineResult.overallScore,
      dimensions: {
        accuracy: pipelineResult.overallScore,
        efficiency: pipelineResult.overallScore,
        safety: pipelineResult.overallScore,
        persona: pipelineResult.overallScore,
        stability: pipelineResult.overallScore,
      },
      breakdown: '回退评分：基于流水线综合分（QualityScorer 未启用或无数据）',
      suggestions: pipelineResult.suggestions,
    };
  }

  /**
   * 从 PipelineResult 提取评分元数据
   */
  private extractScorerMetadata(pipelineResult: PipelineResult): {
    duration: number;
    totalToolCalls?: number;
    retries?: number;
  } | null {
    if (!pipelineResult) return null;

    return {
      duration: pipelineResult.duration,
      totalToolCalls: 0,
      retries: 0,
    };
  }
}

export default OptimizationFeedbackLoop;
