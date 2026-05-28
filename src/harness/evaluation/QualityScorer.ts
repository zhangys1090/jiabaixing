/**
 * Harness Layer 5: Evaluation - 五维质量评分器
 *
 * QualityScorer 对 Agent 的完整执行过程进行多维度质量评估：
 * - accuracy:   准确率 — 工具调用是否正确、结果是否符合预期
 * - efficiency: 效率   — 执行耗时、重试次数、资源消耗
 * - safety:     安全   — 敏感信息泄露、权限违规、风险内容
 * - persona:    人设一致性 — 输出是否符合御姐秘书人设风格
 * - stability:  稳定性 — 执行过程是否平稳、错误率
 *
 * 输入: StepEvaluationResult[] + 执行元数据
 * 输出: 各维度 0-100 分 + 综合评分 + 评分说明 + 改进建议
 *
 * Phase 11: 自评估与持续优化管道
 */

import { StepEvaluationResult } from './StepEvaluator';

/**
 * 五维质量评分
 */
export interface QualityDimensions {
  accuracy: number;
  efficiency: number;
  safety: number;
  persona: number;
  stability: number;
}

/**
 * 质量评分结果
 */
export interface QualityScore {
  /** 综合评分 (0-100) */
  overall: number;
  /** 各维度评分 (0-100) */
  dimensions: QualityDimensions;
  /** 评分说明文本 */
  breakdown: string;
  /** 改进建议列表 */
  suggestions: string[];
}

/**
 * 评分元数据
 */
export interface ScorerMetadata {
  /** 总执行耗时 (ms) */
  duration: number;
  /** 重试次数 */
  retries: number;
  /** 错误次数 */
  errors: number;
  /** 对话上下文摘要 */
  context: string;
  /** 总工具调用次数 */
  totalToolCalls?: number;
  /** 成功工具调用次数 */
  successfulToolCalls?: number;
  /** 执行轮次 */
  loopRounds?: number;
  /** 输出文本长度 */
  outputLength?: number;
}

/**
 * 各维度权重配置
 */
export interface WeightConfig {
  accuracy: number;
  efficiency: number;
  safety: number;
  persona: number;
  stability: number;
}

/** 默认权重 — 安全最高，人设与人设一致性次之 */
const DEFAULT_WEIGHTS: WeightConfig = {
  accuracy: 0.25,
  efficiency: 0.15,
  safety: 0.3,
  persona: 0.15,
  stability: 0.15,
};

/** 人设一致性关键词（御姐秘书风格） */
const PERSONA_POSITIVE_KEYWORDS = [
  '您',
  '请',
  '建议',
  '提醒',
  '汇报',
  '记录',
  '整理',
  '安排',
  '查看',
  '确认',
  '好的',
  '明白',
  '收到',
  '已',
  '温馨',
  '贴心',
  '周到',
];

const PERSONA_NEGATIVE_PATTERNS = [
  /^(哈哈|hhh|笑死)/i,
  /^兄弟们?/i,
  /^老铁/i,
  /^卧槽/i,
  /草$/i,
  /^[Tt]bh/i,
  /^lol/i,
  /^yyds/i,
  /^绝了/i,
];

export class QualityScorer {
  private weights: WeightConfig;

  constructor(weights?: Partial<WeightConfig>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * 主入口：对执行结果进行五维评分
   *
   * @param stepResults  每一步的评估结果
   * @param metadata     执行元数据（耗时、重试、错误数等）
   * @returns QualityScore 包含综合分、各维度分、说明和建议
   */
  score(
    stepResults: StepEvaluationResult[],
    metadata: ScorerMetadata
  ): QualityScore {
    const dimensions = this.computeDimensions(stepResults, metadata);
    const overall = this.weightedAverage(dimensions);
    const breakdown = this.generateBreakdown(dimensions, metadata);
    const suggestions = this.generateSuggestions(
      dimensions,
      stepResults,
      metadata
    );

    return {
      overall: Math.round(overall * 10) / 10,
      dimensions,
      breakdown,
      suggestions,
    };
  }

  /**
   * 更新权重配置
   */
  setWeights(weights: Partial<WeightConfig>): void {
    this.weights = { ...this.weights, ...weights };
  }

  /**
   * 获取当前权重配置
   */
  getWeights(): WeightConfig {
    return { ...this.weights };
  }

  // ── 维度评分方法 ──

  private computeDimensions(
    stepResults: StepEvaluationResult[],
    metadata: ScorerMetadata
  ): QualityDimensions {
    return {
      accuracy: this.scoreAccuracy(stepResults, metadata),
      efficiency: this.scoreEfficiency(metadata),
      safety: this.scoreSafety(stepResults, metadata),
      persona: this.scorePersona(metadata),
      stability: this.scoreStability(stepResults, metadata),
    };
  }

  /**
   * 准确率评分 (0-100)
   * - 步骤通过率
   * - 工具调用成功率
   * - 输出是否为空或错误
   */
  private scoreAccuracy(
    stepResults: StepEvaluationResult[],
    metadata: ScorerMetadata
  ): number {
    if (stepResults.length === 0) {
      // 无步骤记录，基于已有元数据估算
      const successRate = metadata.totalToolCalls
        ? (metadata.successfulToolCalls ?? 0) / metadata.totalToolCalls
        : 0.5;
      return Math.round(successRate * 70);
    }

    const passedSteps = stepResults.filter((s) => s.passed).length;
    const passRate = passedSteps / stepResults.length;

    const avgStepScore =
      stepResults.reduce((sum, s) => sum + s.score, 0) / stepResults.length;

    // 综合通过率和步骤分数，满分100
    const raw = passRate * 0.6 * 100 + avgStepScore * 0.4 * 100;

    return this.clampScore(raw);
  }

  /**
   * 效率评分 (0-100)
   * - 执行耗时: 越短越高
   * - 重试次数: 越少越高
   * - 工具调用密度: 适中为好
   */
  private scoreEfficiency(metadata: ScorerMetadata): number {
    let score = 100;

    // 耗时惩罚 (基准 5s，每多 5s 减 5 分)
    if (metadata.duration > 5000) {
      const penalty = Math.min(
        40,
        Math.floor((metadata.duration - 5000) / 5000) * 5
      );
      score -= penalty;
    }

    // 重试惩罚 (每次重试减 10 分)
    score -= Math.min(40, metadata.retries * 10);

    // 错误惩罚 (每次错误减 15 分)
    score -= Math.min(50, metadata.errors * 15);

    // 工具调用密度合理性
    const totalCalls = metadata.totalToolCalls ?? 0;
    if (totalCalls > 15) {
      score -= Math.min(20, (totalCalls - 15) * 2);
    }

    return this.clampScore(score);
  }

  /**
   * 安全评分 (0-100)
   * - 检查敏感信息泄露
   * - 检查错误/异常栈泄露
   * - 基于 StepEvaluationResult 中 issues 的类型
   */
  private scoreSafety(
    stepResults: StepEvaluationResult[],
    _metadata: ScorerMetadata
  ): number {
    if (stepResults.length === 0) {
      return 100; // 无步骤时假设安全
    }

    let hasSensitiveLeak = false;
    let hasErrorSeverity = false;
    let hasErrorOutput = false;
    let hasExecutionFailure = false;
    let totalIssues = 0;

    for (const step of stepResults) {
      for (const issue of step.issues) {
        totalIssues++;
        if (
          issue.type === 'SENSITIVE_INFO_LEAK' ||
          issue.type === 'SENSITIVE_DATA'
        ) {
          hasSensitiveLeak = true;
        }
        if (issue.severity === 'error') {
          hasErrorSeverity = true;
        }
        if (issue.type === 'ERROR_IN_OUTPUT') {
          hasErrorOutput = true;
        }
        if (issue.type === 'EXECUTION_FAILED') {
          hasExecutionFailure = true;
        }
      }
    }

    // 严重安全违规：敏感信息泄露 = 直接 0 分
    if (hasSensitiveLeak) {
      return 0;
    }

    let score = 100;

    // 存在 error 级别问题，安全分上限降至 20
    if (hasErrorSeverity) {
      score = 20;
    }

    // 输出含异常信息
    if (hasErrorOutput) {
      score -= 40;
    }

    // 执行失败
    if (hasExecutionFailure) {
      score -= 30;
    }

    // 每个 issue 减分
    score -= Math.min(30, totalIssues * 5);

    return this.clampScore(score);
  }

  /**
   * 人设一致性评分 (0-100)
   * - 使用正向关键词匹配评估风格符合度
   * - 检测负面模式
   * - 输出长度合理性
   */
  private scorePersona(metadata: ScorerMetadata): number {
    const context = metadata.context || '';
    if (!context) {
      return 70; // 无文本时给中等分
    }

    let score = 60; // 基础分

    // 正向关键词加分
    const positiveHits = PERSONA_POSITIVE_KEYWORDS.filter((kw) =>
      context.includes(kw)
    ).length;
    score += Math.min(30, positiveHits * 5);

    // 负面模式扣分
    for (const pattern of PERSONA_NEGATIVE_PATTERNS) {
      if (pattern.test(context)) {
        score -= 20;
      }
    }

    // 输出长度合理性
    const outputLen = metadata.outputLength ?? context.length;
    if (outputLen < 10) {
      score -= 15; // 输出太短
    } else if (outputLen > 2000) {
      score -= 10; // 输出过长可能有冗余
    }

    return this.clampScore(score);
  }

  /**
   * 稳定性评分 (0-100)
   * - 步间评分方差
   * - 失败步骤占比
   * - 工具调用成功率
   */
  private scoreStability(
    stepResults: StepEvaluationResult[],
    metadata: ScorerMetadata
  ): number {
    if (stepResults.length === 0) {
      // 无步骤记录，用元数据估算
      if (metadata.errors > 0) {
        return this.clampScore(100 - metadata.errors * 20);
      }
      return 85;
    }

    // 失败步骤占比
    const failedSteps = stepResults.filter((s) => !s.passed).length;
    const failRatio = failedSteps / stepResults.length;
    let score = 100 - failRatio * 60;

    // 分数方差 — 方差越大越不稳定
    const scores = stepResults.map((s) => s.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance =
      scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;

    // 方差惩罚: 方差 > 0.1 时扣分
    if (variance > 0.1) {
      const vPenalty = Math.min(20, Math.floor(variance * 50));
      score -= vPenalty;
    }

    // 错误次数惩罚
    score -= Math.min(30, metadata.errors * 10);

    return this.clampScore(score);
  }

  // ── 辅助方法 ──

  /**
   * 加权平均计算综合评分
   */
  private weightedAverage(dimensions: QualityDimensions): number {
    return (
      dimensions.accuracy * this.weights.accuracy +
      dimensions.efficiency * this.weights.efficiency +
      dimensions.safety * this.weights.safety +
      dimensions.persona * this.weights.persona +
      dimensions.stability * this.weights.stability
    );
  }

  /**
   * 生成评分说明
   */
  private generateBreakdown(
    dimensions: QualityDimensions,
    metadata: ScorerMetadata
  ): string {
    const lines: string[] = [
      `五维质量评分报告`,
      `═══════════════════`,
      `准确率(accuracy):   ${dimensions.accuracy.toFixed(1)}/100 (权重 ${(this.weights.accuracy * 100).toFixed(0)}%)`,
      `效率(efficiency):   ${dimensions.efficiency.toFixed(1)}/100 (权重 ${(this.weights.efficiency * 100).toFixed(0)}%)`,
      `安全(safety):       ${dimensions.safety.toFixed(1)}/100 (权重 ${(this.weights.safety * 100).toFixed(0)}%)`,
      `人设(persona):      ${dimensions.persona.toFixed(1)}/100 (权重 ${(this.weights.persona * 100).toFixed(0)}%)`,
      `稳定性(stability):  ${dimensions.stability.toFixed(1)}/100 (权重 ${(this.weights.stability * 100).toFixed(0)}%)`,
      `───────────────────────────────`,
      `综合评分: ${this.weightedAverage(dimensions).toFixed(1)}/100`,
      `───────────────────────────────`,
    ];

    // 执行信息
    lines.push(`执行信息:`);
    lines.push(`  耗时: ${metadata.duration}ms`);
    lines.push(`  重试: ${metadata.retries} 次`);
    lines.push(`  错误: ${metadata.errors} 次`);
    if (metadata.totalToolCalls !== undefined) {
      lines.push(`  工具调用: ${metadata.totalToolCalls} 次`);
    }
    if (metadata.loopRounds !== undefined) {
      lines.push(`  执行轮次: ${metadata.loopRounds} 轮`);
    }

    return lines.join('\n');
  }

  /**
   * 生成改进建议
   */
  private generateSuggestions(
    dimensions: QualityDimensions,
    stepResults: StepEvaluationResult[],
    metadata: ScorerMetadata
  ): string[] {
    const suggestions: string[] = [];

    // 从步骤评估结果中聚合建议
    for (const step of stepResults) {
      for (const suggestion of step.suggestions) {
        if (!suggestions.includes(suggestion)) {
          suggestions.push(suggestion);
        }
      }
    }

    // 维度级别建议
    if (dimensions.accuracy < 60) {
      suggestions.push('提高工具调用准确性，检查参数和返回结果');
    }
    if (dimensions.efficiency < 60) {
      suggestions.push('优化执行效率：减少重试次数，缩短工具调用耗时');
      if (metadata.totalToolCalls && metadata.totalToolCalls > 10) {
        suggestions.push('减少不必要的工具调用，考虑批量操作');
      }
    }
    if (dimensions.safety < 60) {
      suggestions.push('加强安全审查：检查敏感信息泄露和异常输出');
    }
    if (dimensions.persona < 60) {
      suggestions.push('保持御姐秘书人设：使用尊称和正式用语，避免网络用语');
    }
    if (dimensions.stability < 60) {
      suggestions.push('提升执行稳定性：减少错误和异常步骤');
    }

    // 去重并限制数量
    return [...new Set(suggestions)].slice(0, 10);
  }

  /**
   * 将分数限制在 0-100 之间
   */
  private clampScore(score: number): number {
    return Math.round(Math.max(0, Math.min(100, score)));
  }
}

export default QualityScorer;
