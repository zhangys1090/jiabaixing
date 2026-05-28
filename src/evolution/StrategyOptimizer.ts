/**
 * 策略优化器
 * 支持三种策略调整：
 * ① 语气偏好学习 — 主人对某种语气回应积极时提升该语气概率
 * ② 技能选择偏好 — 主人更爱用 search 而非 file，则提高 search 推荐权重
 * ③ 拆解策略微调 — 将纠错模式转为 prompt 中的示例
 */

import { Logger } from '../utils/Logger';
import { FeedbackRecord } from './FeedbackCollector';
import { OptimizationResultDispatcher } from './OptimizationResultDispatcher';

/** 语气调整 */
export interface ToneAdjustment {
  targetScene: string;
  temperatureDelta: number;
  formalityDelta: number;
  verbosityDelta: number;
  emojiFrequencyDelta: number;
  proactiveDelta: number;
  confidence: number;
}

/** 技能权重调整 */
export interface SkillWeightAdjustment {
  skillName: string;
  weightDelta: number;
  reason: string;
}

/** Prompt 示例 */
export interface PromptExample {
  trigger: string;
  correction: string;
  example: string;
  frequency: number;
}

/** 优化日志 */
export interface OptimizationLog {
  id: string;
  timestamp: Date;
  triggeredBy: 'auto' | 'manual';
  reason: string;
  toneAdjustments: ToneAdjustment[];
  skillAdjustments: SkillWeightAdjustment[];
  promptExamples: PromptExample[];
  feedbackCount: number;
}

/**
 * 策略优化器
 */
export class StrategyOptimizer {
  private toneAdjustments: Map<string, ToneAdjustment> = new Map();
  private skillWeights: Map<string, number> = new Map();
  private promptExamples: PromptExample[] = [];
  private optimizationHistory: OptimizationLog[] = [];
  private feedbackBuffer: FeedbackRecord[] = [];
  private readonly autoTriggerThreshold = 8; // 积累8条反馈即触发优化（原50）

  constructor() {
    // 默认技能权重
    this.skillWeights.set('file', 1.0);
    this.skillWeights.set('search', 1.0);
    this.skillWeights.set('schedule', 1.0);
    this.skillWeights.set('command', 1.0);
    this.skillWeights.set('code_analysis', 1.0);
    this.skillWeights.set('code_generator', 1.0);
    this.skillWeights.set('project_analyzer', 1.0);
  }

  /**
   * 添加反馈到缓冲区
   */
  addFeedback(record: FeedbackRecord): void {
    this.feedbackBuffer.push(record);
    Logger.debug(
      `📥 反馈加入缓冲区: ${this.feedbackBuffer.length}/${this.autoTriggerThreshold}`,
      'StrategyOptimizer'
    );
    // 达到阈值自动触发优化
    if (this.feedbackBuffer.length >= this.autoTriggerThreshold) {
      setImmediate(() => {
        this.runOptimization('auto', `积累 ${this.feedbackBuffer.length} 条反馈`).catch(() => {});
      });
    }
  }

  /**
   * 检查是否需要自动触发优化
   */
  async optimizeIfNeeded(): Promise<OptimizationLog | null> {
    if (this.feedbackBuffer.length >= this.autoTriggerThreshold) {
      return this.runOptimization(
        'auto',
        `积累 ${this.feedbackBuffer.length} 条反馈`
      );
    }
    return null;
  }

  /**
   * 手动触发优化
   */
  async triggerManualOptimization(reason: string): Promise<OptimizationLog> {
    return this.runOptimization('manual', reason);
  }

  /**
   * 获取优化历史
   */
  getOptimizationHistory(): OptimizationLog[] {
    return [...this.optimizationHistory];
  }

  /**
   * 获取所有 Prompt 示例
   */
  getPromptExamples(): PromptExample[] {
    return [...this.promptExamples];
  }

  /**
   * 获取技能权重
   */
  getSkillWeights(): Map<string, number> {
    return new Map(this.skillWeights);
  }

  // ════════════════════════════════════════════════════════════
  // 内部优化逻辑
  // ════════════════════════════════════════════════════════════

  private async runOptimization(
    triggeredBy: 'auto' | 'manual',
    reason: string
  ): Promise<OptimizationLog> {
    Logger.info(
      `🧬 开始策略优化: ${triggeredBy} - ${reason} (缓冲区=${this.feedbackBuffer.length}条)`,
      'StrategyOptimizer'
    );

    const toneAdjustments = this.learnTonePreference();
    const skillAdjustments = this.learnSkillPreference();
    const promptExamples = this.learnDecompositionStrategy();

    Logger.info(
      `📊 优化产出: 语气=${toneAdjustments.length} 技能=${skillAdjustments.length} 示例=${promptExamples.length} (基于${this.feedbackBuffer.length}条反馈)`,
      'StrategyOptimizer'
    );

    // 调试：输出反馈的满意度分布
    if (toneAdjustments.length === 0 && this.feedbackBuffer.length > 0) {
      const scenes = new Map<string, { pos: number; neg: number; total: number }>();
      for (const r of this.feedbackBuffer) {
        const s = r.scene || 'daily';
        if (!scenes.has(s)) scenes.set(s, { pos: 0, neg: 0, total: 0 });
        const d = scenes.get(s)!;
        d.total++;
        if (r.inferredSatisfaction > 0.6) d.pos++;
        if (r.inferredSatisfaction < 0.4) d.neg++;
      }
      Logger.info(`📋 反馈分布: ${JSON.stringify([...scenes.entries()].map(([k,v]) => `${k}:${v.total}条(pos=${v.pos}/neg=${v.neg})`))}`, 'StrategyOptimizer');
    }

    const log: OptimizationLog = {
      id: `opt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      timestamp: new Date(),
      triggeredBy,
      reason,
      toneAdjustments,
      skillAdjustments,
      promptExamples,
      feedbackCount: this.feedbackBuffer.length,
    };

    this.optimizationHistory.push(log);

    // ── 关键修复：分发优化结果到所有消费者，完成进化闭环 ──
    const dispatcher = OptimizationResultDispatcher.getInstance();
    dispatcher.dispatch(log).catch((err: Error) => {
      Logger.error('❌ 优化结果分发失败', err, 'StrategyOptimizer');
    });

    // 清空缓冲区
    this.feedbackBuffer = [];

    Logger.info(
      `✅ 优化完成: 语气调整=${toneAdjustments.length}, 技能调整=${skillAdjustments.length}, Prompt示例=${promptExamples.length}`,
      'StrategyOptimizer'
    );

    return log;
  }

  /**
   * ① 语气偏好学习
   */
  private learnTonePreference(): ToneAdjustment[] {
    const adjustments: ToneAdjustment[] = [];
    const sceneFeedback = new Map<
      string,
      { positive: number; negative: number; total: number }
    >();

    for (const record of this.feedbackBuffer) {
      const scene = record.scene || 'daily';
      if (!sceneFeedback.has(scene)) {
        sceneFeedback.set(scene, { positive: 0, negative: 0, total: 0 });
      }
      const sf = sceneFeedback.get(scene)!;
      sf.total++;
      if (record.inferredSatisfaction > 0.6) sf.positive++;
      if (record.inferredSatisfaction < 0.4) sf.negative++;
    }

    for (const [scene, stats] of sceneFeedback) {
      if (stats.total < 3) continue;

      const positiveRatio = stats.positive / stats.total;
      const negativeRatio = stats.negative / stats.total;
      const confidence = Math.min(1, stats.total / 20);

      if (positiveRatio > 0.7) {
        adjustments.push({
          targetScene: scene,
          temperatureDelta: 0.05,
          formalityDelta: -0.03,
          verbosityDelta: 0.02,
          emojiFrequencyDelta: 0.01,
          proactiveDelta: 0.02,
          confidence,
        });
      } else if (negativeRatio > 0.5) {
        adjustments.push({
          targetScene: scene,
          temperatureDelta: -0.05,
          formalityDelta: 0.03,
          verbosityDelta: -0.02,
          emojiFrequencyDelta: -0.01,
          proactiveDelta: -0.02,
          confidence,
        });
      }
    }

    // 应用调整
    for (const adj of adjustments) {
      const existing = this.toneAdjustments.get(adj.targetScene);
      if (existing) {
        existing.temperatureDelta += adj.temperatureDelta;
        existing.formalityDelta += adj.formalityDelta;
        existing.verbosityDelta += adj.verbosityDelta;
        existing.confidence = Math.max(existing.confidence, adj.confidence);
      } else {
        this.toneAdjustments.set(adj.targetScene, { ...adj });
      }
    }

    return adjustments;
  }

  /**
   * ② 技能选择偏好
   */
  private learnSkillPreference(): SkillWeightAdjustment[] {
    const adjustments: SkillWeightAdjustment[] = [];
    const skillUsage = new Map<
      string,
      { success: number; fail: number; corrections: number }
    >();

    for (const record of this.feedbackBuffer) {
      if (!record.userCorrection) continue;

      for (const [skill] of this.skillWeights) {
        if (record.userCorrection.includes(skill)) {
          if (!skillUsage.has(skill)) {
            skillUsage.set(skill, { success: 0, fail: 0, corrections: 0 });
          }
          const su = skillUsage.get(skill)!;
          su.corrections++;
          su.fail++;
        }
      }
    }

    for (const [skill, usage] of skillUsage) {
      const failRate =
        usage.corrections / Math.max(1, this.feedbackBuffer.length);
      const delta = -failRate * 0.2;

      if (Math.abs(delta) > 0.05) {
        const currentWeight = this.skillWeights.get(skill) || 1.0;
        const newWeight = Math.max(0.5, Math.min(2.0, currentWeight + delta));
        this.skillWeights.set(skill, newWeight);

        adjustments.push({
          skillName: skill,
          weightDelta: delta,
          reason: `纠错率 ${(failRate * 100).toFixed(1)}%`,
        });
      }
    }

    return adjustments;
  }

  /**
   * ③ 拆解策略微调 — 将纠错模式转为 prompt 中的示例
   */
  private learnDecompositionStrategy(): PromptExample[] {
    const correctionPatterns = new Map<
      string,
      { count: number; examples: string[] }
    >();

    for (const record of this.feedbackBuffer) {
      if (!record.userCorrection) continue;

      const key = record.userCorrection;
      if (!correctionPatterns.has(key)) {
        correctionPatterns.set(key, { count: 0, examples: [] });
      }
      const cp = correctionPatterns.get(key)!;
      cp.count++;
      if (cp.examples.length < 3) {
        cp.examples.push(`用户输入: ${record.input.substring(0, 50)}`);
      }
    }

    const newExamples: PromptExample[] = [];

    for (const [key, info] of correctionPatterns) {
      if (info.count < 3) continue;

      const example: PromptExample = {
        trigger: key,
        correction: key,
        example: info.examples.join('\n'),
        frequency: info.count,
      };

      newExamples.push(example);
      this.promptExamples.push(example);
    }

    return newExamples;
  }
}
