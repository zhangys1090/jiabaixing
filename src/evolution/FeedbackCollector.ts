/**
 * FeedbackCollector — 从用户交互中收集反馈信号
 *
 * 闭合 Loop B: 用户纠正 → 反馈信号 → EvolutionEngine 学习
 *
 * 反馈来源:
 * 1. 用户明确纠正（"不对，应该是..."）
 * 2. 用户重复提问（表示上次回答不满意）
 * 3. 工具调用失败
 * 4. 低质量评分
 */

import { Logger } from '../utils/Logger';

export interface FeedbackRecord {
  [key: string]: unknown;
  id: string;
  type: 'correction' | 'retry' | 'tool_failure' | 'low_quality' | 'explicit';
  input: string;
  response: string;
  correction?: string;
  timestamp: number;
  scene?: string;
  userId?: string;
  qualityScore?: number;
  toolName?: string;
  errorMessage?: string;
}

interface FeedbackCollectorDeps {
  onFeedback?: (record: FeedbackRecord) => void;
}

/** 用户纠正模式 — 匹配"不对/错了/应该是/不要这样"等表达 */
const CORRECTION_PATTERNS = [
  /不对[，,！!。.]/,
  /错了[，,！!。.]/,
  /应该是/,
  /不要这样/,
  /我不是这个意思/,
  /重新/,
  /再试/,
  /换一[个种]/,
  /不对不对/,
  /你理解错了/,
  /我说的是/,
  /actually/i,
  /no[，,]\s*you/,
  /that's wrong/i,
  /I meant/i,
  /I didn't mean/i,
];

/** 重复提问模式 — 短时间内相似输入 */
const RETRY_WINDOW_MS = 60_000; // 1分钟内

export class FeedbackCollector {
  private recentInputs: Array<{
    input: string;
    timestamp: number;
    userId?: string;
  }> = [];
  private deps: FeedbackCollectorDeps;
  private feedbackHistory: FeedbackRecord[] = [];
  private readonly MAX_HISTORY = 200;

  constructor(deps: FeedbackCollectorDeps = {}) {
    this.deps = deps;
  }

  /**
   * 分析用户输入，检测是否为纠正反馈
   */
  analyzeUserInput(
    currentInput: string,
    previousResponse: string,
    userId?: string,
    scene?: string
  ): FeedbackRecord | null {
    const now = Date.now();

    // 检测明确纠正
    const isCorrection = CORRECTION_PATTERNS.some((p) => p.test(currentInput));
    if (isCorrection && previousResponse) {
      const record: FeedbackRecord = {
        id: `fb_${now}_${Math.random().toString(36).substring(2, 8)}`,
        type: 'correction',
        input: currentInput.substring(0, 500),
        response: previousResponse.substring(0, 500),
        timestamp: now,
        scene,
        userId,
      };
      this.recordFeedback(record);
      return record;
    }

    // 检测重复提问
    const recentForUser = this.recentInputs.filter(
      (r) => r.userId === userId && now - r.timestamp < RETRY_WINDOW_MS
    );
    const isRetry = recentForUser.some(
      (r) => this.calculateSimilarity(r.input, currentInput) > 0.7
    );
    if (isRetry) {
      const record: FeedbackRecord = {
        id: `fb_${now}_${Math.random().toString(36).substring(2, 8)}`,
        type: 'retry',
        input: currentInput.substring(0, 500),
        response: previousResponse.substring(0, 500),
        timestamp: now,
        scene,
        userId,
      };
      this.recordFeedback(record);
      return record;
    }

    // 记录输入历史
    this.recentInputs.push({ input: currentInput, timestamp: now, userId });
    if (this.recentInputs.length > 50) {
      this.recentInputs = this.recentInputs.slice(-50);
    }

    return null;
  }

  /**
   * 记录工具调用失败反馈
   */
  recordToolFailure(
    toolName: string,
    errorMessage: string,
    input: string,
    userId?: string
  ): void {
    const record: FeedbackRecord = {
      id: `fb_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'tool_failure',
      input: input.substring(0, 500),
      response: '',
      timestamp: Date.now(),
      userId,
      toolName,
      errorMessage: errorMessage.substring(0, 200),
    };
    this.recordFeedback(record);
  }

  /**
   * 记录低质量反馈
   */
  recordLowQuality(
    input: string,
    response: string,
    qualityScore: number,
    userId?: string,
    scene?: string
  ): void {
    const record: FeedbackRecord = {
      id: `fb_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'low_quality',
      input: input.substring(0, 500),
      response: response.substring(0, 500),
      qualityScore,
      timestamp: Date.now(),
      scene,
      userId,
    };
    this.recordFeedback(record);
  }

  /**
   * 记录明确反馈（用户主动评分等）
   */
  recordExplicitFeedback(
    input: string,
    response: string,
    correction: string,
    userId?: string
  ): void {
    const record: FeedbackRecord = {
      id: `fb_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'explicit',
      input: input.substring(0, 500),
      response: response.substring(0, 500),
      correction: correction.substring(0, 500),
      timestamp: Date.now(),
      userId,
    };
    this.recordFeedback(record);
  }

  /**
   * 获取反馈历史
   */
  getFeedbackHistory(): FeedbackRecord[] {
    return [...this.feedbackHistory];
  }

  /**
   * 获取最近 N 条反馈
   */
  getRecentFeedback(count: number = 10): FeedbackRecord[] {
    return this.feedbackHistory.slice(-count);
  }

  /**
   * 按类型统计反馈
   */
  getFeedbackStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const record of this.feedbackHistory) {
      stats[record.type] = (stats[record.type] || 0) + 1;
    }
    return stats;
  }

  // ---- 内部方法 ----

  private recordFeedback(record: FeedbackRecord): void {
    this.feedbackHistory.push(record);
    if (this.feedbackHistory.length > this.MAX_HISTORY) {
      this.feedbackHistory = this.feedbackHistory.slice(-this.MAX_HISTORY);
    }

    Logger.info(
      `📝 反馈收集: type=${record.type} input="${record.input.substring(0, 30)}..."`,
      'FeedbackCollector'
    );

    // 通知外部消费者
    if (this.deps.onFeedback) {
      try {
        this.deps.onFeedback(record);
      } catch (err) {
        Logger.warn(
          `反馈通知失败: ${(err as Error).message}`,
          'FeedbackCollector'
        );
      }
    }
  }

  private calculateSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(/\s+/));
    const setB = new Set(b.split(/\s+/));
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /** 情绪模式记录 */
  private emotionPatterns: Map<
    string,
    { emotionType: string; frequency: number; lastSeen: number }
  > = new Map();

  /**
   * 检测情绪转变 — 分析用户输入中的情绪变化
   */
  detectEmotionShift(
    currentInput: string,
    _previousResponse: string
  ): {
    emotionType: 'positive' | 'negative' | 'neutral';
    intensity: number;
    triggerPhrase: string;
    suggestedResponseAdjustment: string;
  } | null {
    // 消极情绪关键词
    const negativePatterns: Array<{ regex: RegExp; phrase: string }> = [
      {
        regex: /烦死|讨厌|糟糕|失败|错误|问题|不行|不能|不可以/i,
        phrase: '消极情绪',
      },
      { regex: /生气|愤怒|气死|可恶|该死|混蛋/i, phrase: '愤怒' },
      { regex: /累|疲惫|困|睡|休息|不想|放弃/i, phrase: '疲惫' },
    ];

    // 积极情绪关键词
    const positivePatterns: Array<{ regex: RegExp; phrase: string }> = [
      { regex: /太好了|好棒|完美|成功|搞定|解决|可以|行/i, phrase: '积极情绪' },
      { regex: /开心|高兴|快乐|棒|赞|好/i, phrase: '开心' },
      { regex: /谢谢|感谢|多谢|辛苦/i, phrase: '感谢' },
    ];

    // 检测消极情绪
    for (const pattern of negativePatterns) {
      if (pattern.regex.test(currentInput)) {
        const intensity = Math.min(10, currentInput.length / 5);
        this.recordEmotionPattern('negative');
        return {
          emotionType: 'negative',
          intensity,
          triggerPhrase: pattern.phrase,
          suggestedResponseAdjustment:
            '建议采用更谨慎、安抚性的回复风格，先确认问题再提供解决方案',
        };
      }
    }

    // 检测积极情绪
    for (const pattern of positivePatterns) {
      if (pattern.regex.test(currentInput)) {
        const intensity = Math.min(10, currentInput.length / 5);
        this.recordEmotionPattern('positive');
        return {
          emotionType: 'positive',
          intensity,
          triggerPhrase: pattern.phrase,
          suggestedResponseAdjustment: '建议保持当前风格，可适当简化回复',
        };
      }
    }

    return null;
  }

  /**
   * 记录情绪模式
   */
  private recordEmotionPattern(emotionType: string): void {
    const existing = this.emotionPatterns.get(emotionType);
    if (existing) {
      existing.frequency++;
      existing.lastSeen = Date.now();
    } else {
      this.emotionPatterns.set(emotionType, {
        emotionType,
        frequency: 1,
        lastSeen: Date.now(),
      });
    }
  }

  /**
   * 获取学习到的情绪模式
   */
  getEmotionPatterns(): Array<{
    emotionType: string;
    frequency: number;
    lastSeen: number;
  }> {
    return Array.from(this.emotionPatterns.values()).sort(
      (a, b) => b.frequency - a.frequency
    );
  }
}
