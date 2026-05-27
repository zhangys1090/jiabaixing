/**
 * 反馈采集器
 * 在 processInput 末尾非阻塞采集执行结果、主人纠错、满意度推断
 * 写入记忆的 feedback 存储区
 */

import { ToolExecutionResult } from '../interfaces';
import { PreferenceManager } from '../memory/PreferenceManager';
import { Logger } from '../utils/Logger';

/** 反馈记录 */
export interface FeedbackRecord {
  traceId: string;
  input: string;
  response: string;
  executionSuccess: boolean;
  userCorrection: string | null;
  inferredSatisfaction: number;
  timestamp: number;
  scene?: string;
}

/**
 * 反馈采集器
 */
export class FeedbackCollector {
  private feedbackStore: FeedbackRecord[] = [];
  private readonly maxStoreSize = 500;
  private readonly correctionPatterns = [
    {
      pattern: /不是[，,、\s].*意思|不对|错了|不应该|不要/,
      label: 'negative_feedback',
    },
    { pattern: /应该|要用|请用|改成|改为/, label: 'correction' },
    { pattern: /谢谢|不错|好[的嘛]|可以|没问题/, label: 'positive_feedback' },
    { pattern: /太[冷硬生]/, label: 'tone_complaint' },
    { pattern: /听不懂|没理解|不明白/, label: 'misunderstanding' },
  ];

  /**
   * 非阻塞采集反馈
   */
  collect(
    input: string,
    response: string,
    executionResult: ToolExecutionResult,
    scene?: string
  ): void {
    setImmediate(() => {
      try {
        const feedback = this.buildFeedback(
          input,
          response,
          executionResult,
          scene
        );
        this.storeFeedback(feedback);

        if (feedback.userCorrection) {
          const prefManager = PreferenceManager.getInstance();
          const entry = prefManager.applyCorrection(feedback.userCorrection);
          if (entry) {
            Logger.info(
              `⚡ 纠错已转化为偏好: ${entry.key}=${entry.value}`,
              'FeedbackCollector'
            );
          }
        }
      } catch (error) {
        Logger.error('❌ 反馈采集失败', error as Error, 'FeedbackCollector');
      }
    });
  }

  /**
   * 采集纠错反馈
   */
  collectCorrection(skillName: string, category: string, value: string): void {
    const record: FeedbackRecord = {
      traceId: `correction_${Date.now()}`,
      input: '',
      response: '',
      executionSuccess: true,
      userCorrection: `${category}:${value}`,
      inferredSatisfaction: 0.5,
      timestamp: Date.now(),
      scene: skillName,
    };
    this.storeFeedback(record);

    const prefManager = PreferenceManager.getInstance();
    const entry = prefManager.applyCorrection(`${category}:${value}`);
    if (entry) {
      Logger.info(
        `⚡ 主动纠错已转化为偏好: ${entry.key}=${entry.value}`,
        'FeedbackCollector'
      );
    }
  }

  /**
   * 获取所有反馈记录
   */
  getFeedbackRecords(limit?: number): FeedbackRecord[] {
    const records = [...this.feedbackStore].sort(
      (a, b) => b.timestamp - a.timestamp
    );
    return limit ? records.slice(0, limit) : records;
  }

  /**
   * 获取最近 N 条反馈
   */
  getRecent(limit: number = 50): FeedbackRecord[] {
    return this.getFeedbackRecords(limit);
  }

  /**
   * 获取纠错类反馈
   */
  getCorrections(): FeedbackRecord[] {
    return this.feedbackStore.filter((f) => f.userCorrection !== null);
  }

  /**
   * 获取满意度低于阈值的反馈
   */
  getLowSatisfaction(threshold: number = 0.3): FeedbackRecord[] {
    return this.feedbackStore.filter((f) => f.inferredSatisfaction < threshold);
  }

  /**
   * 清除旧反馈（保留最近的 N 条）
   */
  prune(maxCount: number = 300): void {
    if (this.feedbackStore.length > maxCount) {
      this.feedbackStore = this.feedbackStore
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, maxCount);
    }
  }

  /**
   * 反馈总数
   */
  get count(): number {
    return this.feedbackStore.length;
  }

  // ── 内部方法 ──

  private buildFeedback(
    input: string,
    response: string,
    executionResult: ToolExecutionResult,
    scene?: string
  ): FeedbackRecord {
    return {
      traceId: `feedback_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      input,
      response,
      executionSuccess: executionResult.success,
      userCorrection: this.detectCorrection(input),
      inferredSatisfaction: this.inferSatisfaction(
        input,
        response,
        executionResult
      ),
      timestamp: Date.now(),
      scene,
    };
  }

  private detectCorrection(input: string): string | null {
    const lowerInput = input.toLowerCase();

    for (const cp of this.correctionPatterns) {
      if (cp.pattern.test(lowerInput)) {
        if (cp.label === 'correction') {
          const actionMatch = input.match(/(用|改成|改为|使用)\s+([\w-]+)/);
          if (actionMatch) {
            return `${cp.label}:${actionMatch[2]}`;
          }
        }
        return cp.label;
      }
    }

    return null;
  }

  private inferSatisfaction(
    input: string,
    response: string,
    executionResult: ToolExecutionResult
  ): number {
    let score = 0.7;

    if (executionResult.success === false) {
      score -= 0.3;
    }

    const lowerInput = input.toLowerCase();
    if (/谢谢|不错|好[的嘛]|完美|很棒/.test(lowerInput)) {
      score += 0.2;
    }
    if (/不对|错了|不应该|不是这样/.test(lowerInput)) {
      score -= 0.2;
    }

    if (response.length > 200) {
      score -= 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  private storeFeedback(record: FeedbackRecord): void {
    this.feedbackStore.push(record);

    if (this.feedbackStore.length > this.maxStoreSize) {
      this.prune();
    }

    Logger.debug(
      `📊 反馈已采集: 满意度=${record.inferredSatisfaction.toFixed(2)} 纠错=${record.userCorrection || '无'}`,
      'FeedbackCollector'
    );
  }
}
