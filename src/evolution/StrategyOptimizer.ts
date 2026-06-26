/**
 * 策略优化器
 *
 * 收集反馈数据，分析成功率，生成优化日志（语气调整、技能权重调整、提示词样例）
 */

import { Logger } from '../utils/Logger';

export interface ToneAdjustment {
  targetScene: string;
  temperatureDelta: number;
  formalityDelta: number;
  verbosityDelta: number;
  emojiFrequencyDelta?: number;
  proactiveDelta?: number;
}

export interface SkillWeightAdjustment {
  skillName: string;
  weightDelta: number;
  reason: string;
}

export interface PromptExample {
  trigger: string;
  correction: string;
  example: string;
  frequency: number;
}

export interface OptimizationLog {
  id: string;
  timestamp: Date;
  reason: string;
  toneAdjustments: ToneAdjustment[];
  skillAdjustments: SkillWeightAdjustment[];
  promptExamples: PromptExample[];
  success: boolean;
  description: string;
}

export interface FeedbackData {
  input: string;
  response: string;
  success: boolean;
  qualityScore: number;
  toolsUsed: string[];
  scene?: string;
}

export interface OptimizationStats {
  totalOptimizations: number;
  promptExampleCount: number;
  recentSuccessRate: number;
}

const MIN_FEEDBACK_SAMPLES = 5;

const DEFAULT_SKILL_WEIGHTS: Record<string, number> = {
  file_search: 1.0,
  shell_exec: 0.8,
  code_analyze: 1.0,
  memory_recall: 1.0,
};

const SCENE_TONE_ADJUSTMENTS: Record<string, ToneAdjustment> = {
  coding: {
    targetScene: 'coding',
    temperatureDelta: -0.1,
    formalityDelta: 0,
    verbosityDelta: -0.1,
  },
  daily: {
    targetScene: 'daily',
    temperatureDelta: 0.1,
    formalityDelta: -0.1,
    verbosityDelta: 0.1,
  },
  research: {
    targetScene: 'research',
    temperatureDelta: -0.2,
    formalityDelta: 0.2,
    verbosityDelta: 0.1,
  },
};

export class StrategyOptimizer {
  private feedbackHistory: FeedbackData[] = [];
  private optimizationLogs: OptimizationLog[] = [];
  private skillWeights: Record<string, number> = { ...DEFAULT_SKILL_WEIGHTS };
  private promptExamples: PromptExample[] = [];
  private totalOptimizations = 0;

  /**
   * 收集反馈数据
   */
  collectFeedback(feedback: FeedbackData): void {
    this.feedbackHistory.push(feedback);
    if (this.feedbackHistory.length > 100) {
      this.feedbackHistory.shift();
    }
  }

  /**
   * 执行优化分析
   * @returns 优化日志，样本不足时返回 null
   */
  optimize(): OptimizationLog | null {
    if (this.feedbackHistory.length < MIN_FEEDBACK_SAMPLES) {
      return null;
    }

    const recent = this.feedbackHistory.slice(-20);
    const successCount = recent.filter((f) => f.success).length;
    const successRate = successCount / recent.length;

    // 分析技能使用情况
    const skillStats: Record<string, { success: number; total: number }> = {};
    for (const f of recent) {
      for (const tool of f.toolsUsed) {
        if (!skillStats[tool]) skillStats[tool] = { success: 0, total: 0 };
        skillStats[tool].total++;
        if (f.success) skillStats[tool].success++;
      }
    }

    // 生成技能权重调整
    const skillAdjustments: SkillWeightAdjustment[] = [];
    for (const [skill, stats] of Object.entries(skillStats)) {
      const rate = stats.success / stats.total;
      if (rate >= 0.8) {
        const delta = 0.1;
        this.skillWeights[skill] = (this.skillWeights[skill] ?? 1.0) + delta;
        skillAdjustments.push({
          skillName: skill,
          weightDelta: delta,
          reason: `成功率高 (${(rate * 100).toFixed(0)}%)`,
        });
      } else if (rate < 0.5) {
        const delta = -0.1;
        this.skillWeights[skill] = Math.max(
          0.1,
          (this.skillWeights[skill] ?? 1.0) + delta
        );
        skillAdjustments.push({
          skillName: skill,
          weightDelta: delta,
          reason: `成功率低 (${(rate * 100).toFixed(0)}%)`,
        });
      }
    }

    // 生成语气调整
    const sceneStats: Record<string, { success: number; total: number }> = {};
    for (const f of recent) {
      const scene = f.scene ?? 'default';
      if (!sceneStats[scene]) sceneStats[scene] = { success: 0, total: 0 };
      sceneStats[scene].total++;
      if (f.success) sceneStats[scene].success++;
    }

    const toneAdjustments: ToneAdjustment[] = [];
    for (const scene of Object.keys(sceneStats)) {
      const preset = SCENE_TONE_ADJUSTMENTS[scene];
      if (preset) {
        toneAdjustments.push(preset);
      }
    }

    // 生成提示词样例（失败→成功的纠错对）
    this.extractPromptExamples();

    const log: OptimizationLog = {
      id: `opt_${Date.now().toString(36)}`,
      timestamp: new Date(),
      reason: `基于 ${recent.length} 条反馈分析，成功率 ${(successRate * 100).toFixed(0)}%`,
      toneAdjustments,
      skillAdjustments,
      promptExamples: this.promptExamples.filter((p) => p.frequency >= 1),
      success: successRate >= 0.5,
      description: `优化 #${this.totalOptimizations + 1}: 成功率 ${(successRate * 100).toFixed(0)}%，调整 ${skillAdjustments.length} 个技能权重`,
    };

    this.optimizationLogs.push(log);
    this.totalOptimizations++;
    Logger.info(
      `📊 策略优化完成: ${log.id} (成功率: ${(successRate * 100).toFixed(0)}%)`,
      'StrategyOptimizer'
    );
    return log;
  }

  /**
   * 从反馈历史中提取提示词样例
   */
  private extractPromptExamples(): void {
    const failures = this.feedbackHistory.filter((f) => !f.success);
    const successes = this.feedbackHistory.filter((f) => f.success);

    for (const fail of failures) {
      const similar = successes.find(
        (s) =>
          s.input.includes(fail.input.slice(0, 5)) ||
          fail.input.includes(s.input.slice(0, 5))
      );
      if (similar) {
        const trigger = fail.input;
        const existing = this.promptExamples.find((p) => p.trigger === trigger);
        if (existing) {
          existing.frequency++;
        } else {
          this.promptExamples.push({
            trigger,
            correction: `改用 ${similar.toolsUsed.join(', ')} 代替 ${fail.toolsUsed.join(', ')}`,
            example: similar.response,
            frequency: 1,
          });
        }
      }
    }
  }

  /**
   * 获取技能权重
   */
  getSkillWeights(): Record<string, number> {
    return { ...this.skillWeights };
  }

  /**
   * 获取场景语气调整
   */
  getToneAdjustment(scene: string): ToneAdjustment | undefined {
    return SCENE_TONE_ADJUSTMENTS[scene];
  }

  /**
   * 获取提示词样例（仅返回 frequency >= 2 的）
   */
  getPromptExamples(): PromptExample[] {
    return this.promptExamples.filter((p) => p.frequency >= 2);
  }

  /**
   * 获取优化统计信息
   */
  getOptimizationStats(): OptimizationStats {
    const recent = this.feedbackHistory.slice(-20);
    const successCount = recent.filter((f) => f.success).length;
    const recentSuccessRate =
      recent.length > 0 ? successCount / recent.length : 0;

    return {
      totalOptimizations: this.totalOptimizations,
      promptExampleCount: this.getPromptExamples().length,
      recentSuccessRate,
    };
  }

  /**
   * 获取优化日志列表
   */
  getOptimizationLogs(): OptimizationLog[] {
    return [...this.optimizationLogs];
  }
}
