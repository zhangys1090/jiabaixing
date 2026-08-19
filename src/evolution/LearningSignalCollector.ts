/**
 * P5: 学习信号收集器 — 实时收集工具执行和任务完成的学习信号
 *
 * Hermes级别：每次执行都产生学习信号，而非仅依赖 user_correction 事件
 * P1增强：多维反馈（用户满意度、执行效率、质量评分）
 */
import { Logger } from '../utils/Logger';

/**
 * 多维反馈维度 — 覆盖用户满意度、执行效率、质量评分
 */
export interface FeedbackDimensions {
  /** 用户满意度 0-1（显式评分或隐式推断） */
  satisfaction?: number;
  /** 执行效率 0-1（基于耗时与基线对比） */
  efficiency?: number;
  /** 输出质量 0-1（基于评估器评分） */
  quality?: number;
  /** 用户参与度 0-1（追问、复制、修改等行为推断） */
  engagement?: number;
  /** 任务复杂度 0-1（工具调用次数、推理轮数推断） */
  complexity?: number;
}

export interface LearningSignal {
  signalType: 'positive' | 'negative' | 'task_success' | 'task_failure';
  toolName?: string;
  error?: string;
  quality?: number;
  duration?: number;
  userInput?: string;
  toolCount?: number;
  timestamp: number;
  /** P1增强：多维反馈维度 */
  dimensions?: FeedbackDimensions;
}

/** 原始学习信号输入类型 */
export type RawLearningSignal = {
  type: 'tool_success' | 'tool_failure' | 'task_complete' | 'task_failure';
  toolName?: string;
  error?: string;
  quality?: number;
  duration?: number;
  userInput?: string;
  toolCount?: number;
  /** P1增强：多维反馈 */
  dimensions?: FeedbackDimensions;
};

/** EventBus 最小契约 */
export interface LearningEventBus {
  emit(event: string, payload: unknown): void;
}

/**
 * 收集学习信号并通过 EventBus 广播
 *
 * @param eventBus - 事件总线，用于广播 learning_signal 事件
 * @param rawSignal - 原始学习信号
 */
export function collectLearningSignal(
  eventBus: LearningEventBus,
  rawSignal: RawLearningSignal
): void {
  let signalType: LearningSignal['signalType'];

  switch (rawSignal.type) {
    case 'tool_success':
      signalType = 'positive';
      break;
    case 'tool_failure':
      signalType = 'negative';
      break;
    case 'task_complete':
      signalType = 'task_success';
      break;
    case 'task_failure':
      signalType = 'task_failure';
      break;
  }

  const signal: LearningSignal = {
    signalType,
    toolName: rawSignal.toolName,
    error: rawSignal.error,
    quality: rawSignal.quality,
    duration: rawSignal.duration,
    userInput: rawSignal.userInput,
    toolCount: rawSignal.toolCount,
    timestamp: Date.now(),
    dimensions: rawSignal.dimensions,
  };

  eventBus.emit('learning_signal', signal);
  Logger.debug(
    `📡 学习信号已收集: ${signalType} ${rawSignal.toolName || ''}`,
    'LearningSignalCollector'
  );
}

/**
 * 多维反馈聚合器 — 汇总多维反馈信号，生成综合学习指标
 */
export class MultiDimensionalFeedbackAggregator {
  private feedbackBuffer: Array<{
    dimensions: FeedbackDimensions;
    signalType: LearningSignal['signalType'];
    timestamp: number;
  }> = [];
  private readonly maxBufferSize = 1000;

  /**
   * 记录一条多维反馈
   */
  record(signal: LearningSignal): void {
    if (!signal.dimensions) return;

    this.feedbackBuffer.push({
      dimensions: signal.dimensions,
      signalType: signal.signalType,
      timestamp: signal.timestamp,
    });

    if (this.feedbackBuffer.length > this.maxBufferSize) {
      this.feedbackBuffer.shift();
    }
  }

  /**
   * 获取聚合指标
   */
  getAggregatedMetrics(): {
    sampleSize: number;
    avgSatisfaction: number;
    avgEfficiency: number;
    avgQuality: number;
    avgEngagement: number;
    avgComplexity: number;
    compositeScore: number;
    trend: 'improving' | 'stable' | 'declining';
  } {
    const buffer = this.feedbackBuffer;
    if (buffer.length === 0) {
      return {
        sampleSize: 0,
        avgSatisfaction: 0,
        avgEfficiency: 0,
        avgQuality: 0,
        avgEngagement: 0,
        avgComplexity: 0,
        compositeScore: 0,
        trend: 'stable',
      };
    }

    const avg = (field: keyof FeedbackDimensions): number => {
      const values = buffer
        .map((b) => b.dimensions[field])
        .filter((v): v is number => v !== undefined);
      return values.length > 0
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
    };

    const avgSatisfaction = avg('satisfaction');
    const avgEfficiency = avg('efficiency');
    const avgQuality = avg('quality');
    const avgEngagement = avg('engagement');
    const avgComplexity = avg('complexity');

    const compositeScore =
      avgSatisfaction * 0.3 +
      avgEfficiency * 0.2 +
      avgQuality * 0.3 +
      avgEngagement * 0.2;

    const trend = this.calculateTrend();

    return {
      sampleSize: buffer.length,
      avgSatisfaction,
      avgEfficiency,
      avgQuality,
      avgEngagement,
      avgComplexity,
      compositeScore,
      trend,
    };
  }

  /**
   * 计算趋势方向
   */
  private calculateTrend(): 'improving' | 'stable' | 'declining' {
    const buffer = this.feedbackBuffer;
    if (buffer.length < 10) return 'stable';

    const half = Math.floor(buffer.length / 2);
    const firstHalf = buffer.slice(0, half);
    const secondHalf = buffer.slice(half);

    const avgComposite = (items: typeof buffer): number => {
      const scores = items.map((i) => {
        const d = i.dimensions;
        return (
          (d.satisfaction ?? 0) * 0.3 +
          (d.efficiency ?? 0) * 0.2 +
          (d.quality ?? 0) * 0.3 +
          (d.engagement ?? 0) * 0.2
        );
      });
      return scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;
    };

    const firstScore = avgComposite(firstHalf);
    const secondScore = avgComposite(secondHalf);
    const delta = secondScore - firstScore;

    if (delta > 0.05) return 'improving';
    if (delta < -0.05) return 'declining';
    return 'stable';
  }

  /**
   * 清空缓冲区
   */
  reset(): void {
    this.feedbackBuffer = [];
  }
}

/**
 * 从执行结果推断多维反馈维度
 */
export function inferFeedbackDimensions(input: {
  duration?: number;
  baselineDuration?: number;
  toolCount?: number;
  success: boolean;
  userActions?: Array<'copy' | 'modify' | 'retry' | 'follow_up' | 'accept'>;
  qualityScore?: number;
}): FeedbackDimensions {
  const efficiency =
    input.duration && input.baselineDuration
      ? Math.min(1, input.baselineDuration / Math.max(1, input.duration))
      : undefined;

  const engagement = input.userActions
    ? (() => {
        let score = 0.5;
        for (const action of input.userActions) {
          if (action === 'copy') score += 0.15;
          if (action === 'accept') score += 0.2;
          if (action === 'modify') score -= 0.1;
          if (action === 'retry') score -= 0.2;
          if (action === 'follow_up') score += 0.05;
        }
        return Math.max(0, Math.min(1, score));
      })()
    : undefined;

  const complexity = input.toolCount
    ? Math.min(1, input.toolCount / 10)
    : undefined;

  const satisfaction = input.userActions
    ? (() => {
        const hasPositive =
          input.userActions.includes('accept') ||
          input.userActions.includes('copy');
        const hasNegative =
          input.userActions.includes('retry') ||
          input.userActions.includes('modify');
        if (hasPositive && !hasNegative) return 0.8 + Math.random() * 0.2;
        if (hasNegative && !hasPositive) return 0.1 + Math.random() * 0.3;
        return 0.5;
      })()
    : undefined;

  return {
    satisfaction,
    efficiency,
    quality: input.qualityScore,
    engagement,
    complexity,
  };
}
