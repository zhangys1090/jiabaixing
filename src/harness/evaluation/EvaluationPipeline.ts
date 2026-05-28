/**
 * Harness Layer 5: Evaluation - 评估流水线
 *
 * EvaluationPipeline 按阶段串联所有评估器，形成可配置的评估流水线：
 *   阶段1: 单步骤评估 (StepEvaluator)         — 检查工具调用的正确性、安全性
 *   阶段2: 独立综合评估 (IndependentEvaluationService) — 任务完成度、数据Groundedness、安全
 *   阶段3: 五维质量评分 (QualityScorer)       — 准确率、效率、安全、人设、稳定性
 *
 * 每个阶段可独立启用/禁用，并配置权重
 * 最终输出 PipelineResult 包含各阶段详细结果和综合报告
 *
 * Phase 11: 自评估与持续优化管道
 */

import {
  StepEvaluator,
  StepEvaluationParams,
  StepEvaluationResult,
} from './StepEvaluator';
import {
  IndependentEvaluationService,
  EvaluationInput,
  IndependentEvaluationResult,
} from './IndependentEvaluationService';
import { QualityScorer, QualityScore, ScorerMetadata } from './QualityScorer';

/**
 * 评估上下文
 */
export interface EvaluationContext {
  /** 步骤评估参数列表 */
  stepParams: StepEvaluationParams[];
  /** 独立评估输入 */
  evalInput: EvaluationInput;
  /** 评分元数据 */
  scorerMetadata: ScorerMetadata;
}

/**
 * 流水线阶段配置
 */
export interface PipelineStageConfig {
  name: string;
  enabled: boolean;
  weight: number;
}

/**
 * 流水线配置
 */
export interface PipelineConfig {
  stages: PipelineStageConfig[];
}

/** 默认流水线配置 */
const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  stages: [
    { name: 'step_evaluation', enabled: true, weight: 0.2 },
    { name: 'independent_evaluation', enabled: true, weight: 0.35 },
    { name: 'quality_scoring', enabled: true, weight: 0.45 },
  ],
};

/**
 * 流水线阶段结果
 */
export interface StageResult {
  stageName: string;
  weight: number;
  passed: boolean;
  score: number;
  details: string;
  data?: unknown;
}

/**
 * 流水线结果
 */
export interface PipelineResult {
  /** 是否通过全部阶段 */
  passed: boolean;
  /** 综合分数 (0-100) */
  overallScore: number;
  /** 各阶段结果 */
  stages: StageResult[];
  /** 所有收集的建议 */
  suggestions: string[];
  /** 执行时间戳 */
  timestamp: number;
  /** 总耗时 (ms) */
  duration: number;
  /** 质量评分（如果 quality_scoring 阶段启用） */
  qualityScore?: QualityScore;
  /** 独立评估结果（如果 independent_evaluation 阶段启用） */
  independentResult?: IndependentEvaluationResult;
  /** 步骤评估结果列表 */
  stepResults?: StepEvaluationResult[];
}

/**
 * 评估流水线
 */
export class EvaluationPipeline {
  private stages: Array<{
    name: string;
    enabled: boolean;
    weight: number;
    evaluator?: StepEvaluator | IndependentEvaluationService | QualityScorer;
  }>;

  constructor(config?: Partial<PipelineConfig>) {
    const merged = this.mergeConfig(config);
    this.stages = merged.stages.map((s) => ({
      name: s.name,
      enabled: s.enabled,
      weight: s.weight,
      evaluator: undefined,
    }));
  }

  /**
   * 添加评估阶段
   *
   * @param name      阶段名称
   * @param evaluator 评估器实例
   * @param weight    权重 (0-1)
   */
  addStage(
    name: string,
    evaluator: StepEvaluator | IndependentEvaluationService | QualityScorer,
    weight: number
  ): void {
    // 检查是否已存在同名阶段，存在则更新
    const existing = this.stages.find((s) => s.name === name);
    if (existing) {
      existing.evaluator = evaluator;
      existing.weight = weight;
      existing.enabled = true;
    } else {
      this.stages.push({
        name,
        enabled: true,
        weight,
        evaluator,
      });
    }
  }

  /**
   * 启用/禁用某个阶段
   */
  setStageEnabled(name: string, enabled: boolean): void {
    const stage = this.stages.find((s) => s.name === name);
    if (stage) {
      stage.enabled = enabled;
    }
  }

  /**
   * 运行评估流水线
   *
   * @param context 评估上下文
   * @returns PipelineResult
   */
  async run(context: EvaluationContext): Promise<PipelineResult> {
    const startTime = Date.now();
    const stageResults: StageResult[] = [];
    const allSuggestions: string[] = [];

    let stepResults: StepEvaluationResult[] | undefined;
    let independentResult: IndependentEvaluationResult | undefined;
    let qualityScore: QualityScore | undefined;

    for (const stage of this.stages) {
      if (!stage.enabled) {
        stageResults.push({
          stageName: stage.name,
          weight: stage.weight,
          passed: true,
          score: 0,
          details: '阶段已禁用',
        });
        continue;
      }

      try {
        const result = await this.runStage(stage, context, stepResults);
        stageResults.push(result);

        if (result.data) {
          if (stage.name === 'step_evaluation') {
            stepResults = result.data as StepEvaluationResult[];
            allSuggestions.push(...stepResults.flatMap((sr) => sr.suggestions));
          } else if (stage.name === 'independent_evaluation') {
            independentResult = result.data as IndependentEvaluationResult;
            allSuggestions.push(
              ...(independentResult.overall.summary
                ? [independentResult.overall.summary]
                : [])
            );
          } else if (stage.name === 'quality_scoring') {
            qualityScore = result.data as QualityScore;
            allSuggestions.push(...qualityScore.suggestions);
          }
        }
      } catch (error) {
        stageResults.push({
          stageName: stage.name,
          weight: stage.weight,
          passed: false,
          score: 0,
          details: `阶段执行异常: ${(error as Error).message}`,
        });
      }
    }

    const duration = Date.now() - startTime;

    // 计算综合分数（加权平均）
    const totalWeight = stageResults
      .filter((sr) => sr.passed)
      .reduce((sum, sr) => sum + sr.weight, 0);

    const weightedScore =
      totalWeight > 0
        ? stageResults
            .filter((sr) => sr.passed)
            .reduce((sum, sr) => sum + sr.score * sr.weight, 0) / totalWeight
        : 0;

    // 去重建议
    const uniqueSuggestions = [...new Set(allSuggestions)];

    return {
      passed: weightedScore >= 50,
      overallScore: Math.round(weightedScore * 10) / 10,
      stages: stageResults,
      suggestions: uniqueSuggestions.slice(0, 20),
      timestamp: Date.now(),
      duration,
      qualityScore,
      independentResult,
      stepResults,
    };
  }

  /**
   * 生成人类可读的流水线报告
   */
  getReport(pipelineResult: PipelineResult): string {
    const lines: string[] = [];
    lines.push('╔══════════════════════════════════════════╗');
    lines.push('║        评估流水线报告                      ║');
    lines.push('╚══════════════════════════════════════════╝');
    lines.push('');
    lines.push(`综合评分: ${pipelineResult.overallScore}/100`);
    lines.push(`判定结果: ${pipelineResult.passed ? '✅ 通过' : '❌ 未通过'}`);
    lines.push(`耗时: ${pipelineResult.duration}ms`);
    lines.push(`时间戳: ${new Date(pipelineResult.timestamp).toISOString()}`);
    lines.push('');

    lines.push('── 各阶段结果 ──');
    for (const stage of pipelineResult.stages) {
      const icon = stage.passed ? '✅' : '❌';
      lines.push(
        `  ${icon} [${stage.stageName}] (权重 ${(stage.weight * 100).toFixed(0)}%)`
      );
      lines.push(`     得分: ${stage.score.toFixed(1)}/100`);
      lines.push(`     说明: ${stage.details}`);
    }

    // 如果有 QualityScore，显示详细五维评分
    if (pipelineResult.qualityScore) {
      lines.push('');
      lines.push('── 五维质量评分 ──');
      const qs = pipelineResult.qualityScore;
      lines.push(`  综合: ${qs.overall}/100`);
      lines.push(`  准确率: ${qs.dimensions.accuracy}/100`);
      lines.push(`  效率:   ${qs.dimensions.efficiency}/100`);
      lines.push(`  安全:   ${qs.dimensions.safety}/100`);
      lines.push(`  人设:   ${qs.dimensions.persona}/100`);
      lines.push(`  稳定性: ${qs.dimensions.stability}/100`);
      lines.push('');
      lines.push(`  详细说明:`);
      lines.push(`    ${qs.breakdown.replace(/\n/g, '\n    ')}`);
    }

    // 如果有 IndependentEvaluationResult
    if (pipelineResult.independentResult) {
      lines.push('');
      lines.push('── 独立评估摘要 ──');
      const ir = pipelineResult.independentResult;
      lines.push(
        `  任务完成: ${ir.taskCompletion.completed ? '✅' : '❌'} (置信度: ${(ir.taskCompletion.confidence * 100).toFixed(0)}%)`
      );
      lines.push(`  安全风险: ${ir.safety.riskLevel}`);
      lines.push(`  建议动作: ${ir.overall.suggestedAction}`);
    }

    // 改进建议
    if (pipelineResult.suggestions.length > 0) {
      lines.push('');
      lines.push('── 改进建议 ──');
      for (let i = 0; i < pipelineResult.suggestions.length; i++) {
        lines.push(`  ${i + 1}. ${pipelineResult.suggestions[i]}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 执行单个阶段
   */
  private async runStage(
    stage: {
      name: string;
      enabled: boolean;
      weight: number;
      evaluator?: StepEvaluator | IndependentEvaluationService | QualityScorer;
    },
    context: EvaluationContext,
    previousStepResults?: StepEvaluationResult[]
  ): Promise<StageResult> {
    const { name, weight } = stage;

    switch (name) {
      case 'step_evaluation': {
        const evaluator = stage.evaluator as StepEvaluator | undefined;
        const results = context.stepParams.map((params) => {
          if (evaluator) {
            return evaluator.evaluateStep(params);
          }
          // 默认 StepEvaluator
          return new StepEvaluator().evaluateStep(params);
        });

        const avgScore =
          results.length > 0
            ? results.reduce((sum, r) => sum + r.score, 0) / results.length
            : 0;

        const passedCount = results.filter((r) => r.passed).length;
        const passRate = results.length > 0 ? passedCount / results.length : 0;

        return {
          stageName: name,
          weight,
          passed: passRate >= 0.5,
          score: passRate * 60 + avgScore * 40,
          details: `共 ${results.length} 步, 通过 ${passedCount}/${results.length}, 平均分 ${(avgScore * 100).toFixed(1)}`,
          data: results,
        };
      }

      case 'independent_evaluation': {
        const service = stage.evaluator as
          | IndependentEvaluationService
          | undefined;
        const evaluator = service || new IndependentEvaluationService();

        const result = await evaluator.evaluate(context.evalInput);

        const score =
          result.quality.overall * 60 +
          result.taskCompletion.confidence * 20 +
          (result.safety.safe ? 20 : 0);

        return {
          stageName: name,
          weight,
          passed: score >= 50 && result.safety.riskLevel !== 'critical',
          score,
          details: `完成=${result.taskCompletion.completed}, 安全=${result.safety.riskLevel}, 质量=${(result.quality.overall * 100).toFixed(0)}`,
          data: result,
        };
      }

      case 'quality_scoring': {
        const scorer = stage.evaluator as QualityScorer | undefined;
        const scorerInstance = scorer || new QualityScorer();

        const stepResults =
          previousStepResults ||
          context.stepParams.map((p) => new StepEvaluator().evaluateStep(p));

        const qualityResult = scorerInstance.score(
          stepResults,
          context.scorerMetadata
        );

        return {
          stageName: name,
          weight,
          passed: qualityResult.overall >= 50,
          score: qualityResult.overall,
          details: `综合=${qualityResult.overall}, 准确=${qualityResult.dimensions.accuracy}, 效率=${qualityResult.dimensions.efficiency}, 安全=${qualityResult.dimensions.safety}, 人设=${qualityResult.dimensions.persona}, 稳定=${qualityResult.dimensions.stability}`,
          data: qualityResult,
        };
      }

      default:
        // 自定义阶段
        if (stage.evaluator) {
          const evaluator = stage.evaluator;
          if (evaluator instanceof QualityScorer) {
            const stepResults =
              previousStepResults ||
              context.stepParams.map((p) =>
                new StepEvaluator().evaluateStep(p)
              );
            const qr = evaluator.score(stepResults, context.scorerMetadata);
            return {
              stageName: name,
              weight,
              passed: qr.overall >= 50,
              score: qr.overall,
              details: `自定义QualityScorer阶段: ${qr.overall}/100`,
              data: qr,
            };
          }
          if (evaluator instanceof IndependentEvaluationService) {
            const result = await evaluator.evaluate(context.evalInput);
            const score = result.quality.overall * 100;
            return {
              stageName: name,
              weight,
              passed: score >= 50,
              score,
              details: `自定义IndependentEvaluation阶段: ${score.toFixed(1)}/100`,
              data: result,
            };
          }
        }
        return {
          stageName: name,
          weight,
          passed: false,
          score: 0,
          details: `未知阶段类型: ${name}`,
        };
    }
  }

  /**
   * 合并用户配置与默认配置
   */
  private mergeConfig(config?: Partial<PipelineConfig>): PipelineConfig {
    if (!config || !config.stages || config.stages.length === 0) {
      return DEFAULT_PIPELINE_CONFIG;
    }

    // 合并：用用户提供的阶段覆盖默认同名阶段
    const defaultStages = [...DEFAULT_PIPELINE_CONFIG.stages];
    for (const userStage of config.stages) {
      const idx = defaultStages.findIndex((s) => s.name === userStage.name);
      if (idx >= 0) {
        defaultStages[idx] = { ...defaultStages[idx], ...userStage };
      } else {
        defaultStages.push(userStage);
      }
    }

    return { stages: defaultStages };
  }
}

export default EvaluationPipeline;
