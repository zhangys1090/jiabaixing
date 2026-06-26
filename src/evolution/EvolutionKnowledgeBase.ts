/**
 * 进化知识库 (P3-2)
 *
 * 累积进化经验，形成可复用的进化策略库。
 * 区别于浅层行为学习：结构化存储"触发器→动作→结果"三元组，
 * 支持语义检索与可复用模式提取。
 *
 * 核心能力：
 * 1. recordEvolutionOutcome — 结构化存储进化经验
 * 2. findRelevantEvolutionExperience — 按语义相似度检索历史经验
 * 3. extractReusablePatterns — 从历史经验提取可复用的成功模式
 * 4. save/load — 持久化到 TrajectoryDatabase
 */

import { Logger } from '../utils/Logger';

/** 进化触发器 — 什么触发了进化 */
export interface EvolutionTrigger {
  type:
    | 'low_quality'
    | 'timeout'
    | 'high_cost'
    | 'llm_upgrade'
    | 'failure_pattern'
    | 'test';
  context: string;
  metrics: Record<string, number>;
}

/** 进化动作 — 做了什么改进 */
export interface EvolutionAction {
  type:
    | 'prompt_adjustment'
    | 'config_change'
    | 'tool_swap'
    | 'strategy_shift'
    | 'timeout_adjustment'
    | 'test';
  description: string;
  target: string;
}

/** 进化结果 — 效果如何 */
export interface EvolutionOutcome {
  success: boolean;
  qualityImprovement: number;
  sideEffects: string[];
}

/** 完整的进化经验记录 */
export interface EvolutionExperience {
  id: string;
  trigger: EvolutionTrigger;
  action: EvolutionAction;
  outcome: EvolutionOutcome;
  llmProvider: string;
  timestamp: number;
}

/** 可复用的进化模式 — 从多次经验中提炼 */
export interface ReusablePattern {
  triggerType: string;
  actionType: string;
  description: string;
  occurrenceCount: number;
  averageGain: number;
  successRate: number;
  recommendedFor: string[];
}

/** 持久化接口（与 TrajectoryDatabase 兼容） */
export interface PersistenceLike {
  saveEnvironmentState(state: Record<string, unknown>): void;
  loadEnvironmentState(): Record<string, unknown> | null;
}

/** 进化知识库配置 */
export interface KnowledgeBaseConfig {
  /** 最大存储数量，默认 1000 */
  maxExperiences?: number;
  /** 持久化实例 */
  persistence?: PersistenceLike;
}

/** 持久化存储的 key */
const STORAGE_KEY = 'evolutionKnowledgeBase';

/**
 * 进化知识库
 *
 * 设计原则：
 * - 不重复造轮子：复用 TrajectoryDatabase 的环境状态持久化机制
 * - 立即集成：通过 EvolutionOrchestrator 集成到主流程
 * - 向后兼容：持久化可选，无持久化时仅内存
 */
export class EvolutionKnowledgeBase {
  private experiences: EvolutionExperience[] = [];
  private readonly maxExperiences: number;
  private persistence: PersistenceLike | null;
  private idCounter = 0;

  constructor(config: KnowledgeBaseConfig = {}) {
    this.maxExperiences = config.maxExperiences ?? 1000;
    this.persistence = config.persistence ?? null;
  }

  /**
   * 设置持久化实例
   */
  setPersistence(persistence: PersistenceLike): void {
    this.persistence = persistence;
    this.load();
  }

  /**
   * 结构化存储进化经验
   *
   * @param record - 进化经验记录（不含 id 和 timestamp）
   * @returns 生成的经验 ID
   */
  recordEvolutionOutcome(record: {
    trigger: EvolutionTrigger;
    action: EvolutionAction;
    outcome: EvolutionOutcome;
    llmProvider: string;
  }): string {
    const experience: EvolutionExperience = {
      id: `exp_${Date.now()}_${++this.idCounter}`,
      trigger: record.trigger,
      action: record.action,
      outcome: record.outcome,
      llmProvider: record.llmProvider,
      timestamp: Date.now(),
    };

    this.experiences.push(experience);

    // 限制最大数量，保留最新的
    if (this.experiences.length > this.maxExperiences) {
      this.experiences = this.experiences.slice(-this.maxExperiences);
    }

    Logger.info(
      `📚 P3-2 记录进化经验: trigger=${record.trigger.type} | action=${record.action.type} | gain=${record.outcome.qualityImprovement.toFixed(2)}`,
      'EvolutionKnowledgeBase'
    );

    return experience.id;
  }

  /**
   * 获取所有进化经验
   */
  getAllExperiences(): EvolutionExperience[] {
    return [...this.experiences];
  }

  /**
   * 按语义相似度检索历史进化经验
   *
   * 基于关键词重叠度进行简单匹配（避免引入额外依赖）。
   *
   * @param situation - 当前场景描述
   * @param maxResults - 最大返回数量，默认 5
   * @returns 按相关性排序的进化经验
   */
  findRelevantEvolutionExperience(
    situation: { description: string; type: string },
    maxResults: number = 5
  ): EvolutionExperience[] {
    if (this.experiences.length === 0) return [];

    const currentKeywords = this.extractKeywords(
      `${situation.description} ${situation.type}`
    );
    if (currentKeywords.length === 0) {
      return this.experiences.slice(-maxResults);
    }

    return this.experiences
      .map((exp) => {
        const expKeywords = this.extractKeywords(
          `${exp.trigger.context} ${exp.trigger.type} ${exp.action.description}`
        );
        const overlap = expKeywords.filter((k) =>
          currentKeywords.includes(k)
        ).length;
        // 优先选择成功的经验
        const successBonus = exp.outcome.success ? 1 : 0;
        return { exp, score: overlap + successBonus };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.exp);
  }

  /**
   * 从历史经验提取可复用的成功模式
   *
   * 聚合相同 (triggerType, actionType) 的成功经验，
   * 计算平均收益和成功率。
   *
   * @returns 可复用的进化模式列表
   */
  extractReusablePatterns(): ReusablePattern[] {
    const patternMap = new Map<string, EvolutionExperience[]>();

    for (const exp of this.experiences) {
      if (!exp.outcome.success) continue;
      const key = `${exp.trigger.type}|${exp.action.type}`;
      const list = patternMap.get(key) || [];
      list.push(exp);
      patternMap.set(key, list);
    }

    const patterns: ReusablePattern[] = [];
    for (const [key, exps] of patternMap) {
      // 至少出现2次才认为是稳定模式
      if (exps.length < 2) continue;

      const [triggerType, actionType] = key.split('|');
      const avgGain =
        exps.reduce((sum, e) => sum + e.outcome.qualityImprovement, 0) /
        exps.length;
      const successRate =
        this.experiences.filter(
          (e) => e.trigger.type === triggerType && e.action.type === actionType
        ).length > 0
          ? exps.length /
            this.experiences.filter(
              (e) =>
                e.trigger.type === triggerType && e.action.type === actionType
            ).length
          : 1;

      patterns.push({
        triggerType,
        actionType,
        description: exps[0].action.description,
        occurrenceCount: exps.length,
        averageGain: avgGain,
        successRate,
        recommendedFor: [...new Set(exps.map((e) => e.action.target))],
      });
    }

    return patterns.sort((a, b) => b.averageGain - a.averageGain);
  }

  /**
   * 保存到持久化存储
   */
  save(): void {
    if (!this.persistence) return;
    try {
      this.persistence.saveEnvironmentState({
        [STORAGE_KEY]: {
          experiences: this.experiences,
          idCounter: this.idCounter,
        },
      });
    } catch (err) {
      Logger.error(
        '进化知识库保存失败',
        err as Error,
        'EvolutionKnowledgeBase'
      );
    }
  }

  /**
   * 从持久化存储加载
   */
  load(): void {
    if (!this.persistence) return;
    try {
      const state = this.persistence.loadEnvironmentState();
      if (!state) return;
      const data = state[STORAGE_KEY] as
        | { experiences: EvolutionExperience[]; idCounter: number }
        | undefined;
      if (data?.experiences && Array.isArray(data.experiences)) {
        this.experiences = data.experiences.slice(-this.maxExperiences);
        this.idCounter = data.idCounter ?? 0;
        Logger.info(
          `📚 P3-2 加载 ${this.experiences.length} 条历史进化经验`,
          'EvolutionKnowledgeBase'
        );
      }
    } catch (err) {
      Logger.error(
        '进化知识库加载失败',
        err as Error,
        'EvolutionKnowledgeBase'
      );
    }
  }

  /**
   * 提取关键词（简单分词）
   */
  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s,，。.;；:：!！?？()（）"'`]+/)
      .filter((w) => w.length > 1)
      .slice(0, 30);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalExperiences: number;
    successCount: number;
    averageGain: number;
    topPatterns: ReusablePattern[];
  } {
    const successCount = this.experiences.filter(
      (e) => e.outcome.success
    ).length;
    const averageGain =
      this.experiences.length > 0
        ? this.experiences.reduce(
            (sum, e) => sum + e.outcome.qualityImprovement,
            0
          ) / this.experiences.length
        : 0;
    return {
      totalExperiences: this.experiences.length,
      successCount,
      averageGain,
      topPatterns: this.extractReusablePatterns().slice(0, 5),
    };
  }
}
