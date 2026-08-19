/**
 * QualityAnnotator — 质量标注 + 过滤
 *
 * Phase 3: 自动为轨迹数据打质量标签
 * - 多维度质量评估（任务完成度、工具效率、错误率、连贯性、有用性）
 * - 自动标注（基于规则 + 启发式）
 * - 质量过滤（按阈值筛选高质量/低质量数据）
 * - 多样性采样（避免重复模式）
 */

import type { EventStoreEvent } from '../persistence/EventStore';

export interface QualityLabels {
  taskCompletion: number;
  toolEfficiency: number;
  errorRate: number;
  coherence: number;
  usefulness: number;
}

export interface QualityAnnotation {
  dimension: keyof QualityLabels;
  score: number;
  reason: string;
  autoLabeled: boolean;
}

export interface AnnotatedTrajectory {
  events: EventStoreEvent[];
  quality: number;
  labels: QualityLabels;
  annotations: QualityAnnotation[];
}

export interface QualityFilterConfig {
  minTaskCompletion: number;
  maxErrorRate: number;
  minCoherence: number;
  minUsefulness: number;
  minOverallQuality: number;
  maxOverallQuality: number;
}

export interface DiversitySampleConfig {
  maxSimilarSequences: number;
  similarityThreshold: number;
  strategy: 'random' | 'quality_weighted' | 'diversity_maximizing';
}

const DEFAULT_FILTER: QualityFilterConfig = {
  minTaskCompletion: 0.3,
  maxErrorRate: 0.5,
  minCoherence: 0.3,
  minUsefulness: 0.3,
  minOverallQuality: 0.4,
  maxOverallQuality: 1.0,
};

export class QualityAnnotator {
  private filterConfig: QualityFilterConfig;
  private seenSequences: Map<string, number> = new Map();

  constructor(filterConfig: Partial<QualityFilterConfig> = {}) {
    this.filterConfig = { ...DEFAULT_FILTER, ...filterConfig };
  }

  annotate(events: EventStoreEvent[]): AnnotatedTrajectory {
    const labels = this.computeLabels(events);
    const annotations = this.generateAnnotations(events, labels);
    const quality = this.computeOverallQuality(labels);

    return {
      events,
      quality,
      labels,
      annotations,
    };
  }

  filter(trajectories: AnnotatedTrajectory[]): AnnotatedTrajectory[] {
    return trajectories.filter((t) => this.passesFilter(t));
  }

  diversitySample(
    trajectories: AnnotatedTrajectory[],
    config: Partial<DiversitySampleConfig> = {}
  ): AnnotatedTrajectory[] {
    const maxSimilar = config.maxSimilarSequences ?? 3;
    const threshold = config.similarityThreshold ?? 0.8;
    const strategy = config.strategy ?? 'quality_weighted';

    const sequenceGroups: Map<string, AnnotatedTrajectory[]> = new Map();

    for (const trajectory of trajectories) {
      const signature = this.computeSequenceSignature(trajectory);
      let matched = false;

      for (const [existingSig, group] of sequenceGroups) {
        if (this.sequenceSimilarity(signature, existingSig) >= threshold) {
          group.push(trajectory);
          matched = true;
          break;
        }
      }

      if (!matched) {
        sequenceGroups.set(signature, [trajectory]);
      }
    }

    const result: AnnotatedTrajectory[] = [];

    for (const [, group] of sequenceGroups) {
      const sampled = this.sampleFromGroup(group, Math.min(maxSimilar, group.length), strategy);
      result.push(...sampled);
    }

    return result;
  }

  batchAnnotate(eventsBySession: Map<string, EventStoreEvent[]>): Map<string, AnnotatedTrajectory> {
    const result = new Map<string, AnnotatedTrajectory>();

    for (const [sessionId, events] of eventsBySession) {
      result.set(sessionId, this.annotate(events));
    }

    return result;
  }

  getQualityDistribution(trajectories: AnnotatedTrajectory[]): {
    histogram: Record<string, number>;
    percentiles: { p25: number; p50: number; p75: number; p90: number };
    mean: number;
    stdDev: number;
  } {
    const qualities = trajectories.map((t) => t.quality).sort((a, b) => a - b);
    const n = qualities.length;

    if (n === 0) {
      return {
        histogram: {},
        percentiles: { p25: 0, p50: 0, p75: 0, p90: 0 },
        mean: 0,
        stdDev: 0,
      };
    }

    const mean = qualities.reduce((s, q) => s + q, 0) / n;
    const variance = qualities.reduce((s, q) => s + (q - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    const histogram: Record<string, number> = {};
    for (const q of qualities) {
      const bucket = q >= 0.8 ? '0.8-1.0' : q >= 0.6 ? '0.6-0.8' : q >= 0.4 ? '0.4-0.6' : q >= 0.2 ? '0.2-0.4' : '0.0-0.2';
      histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    }

    const percentile = (p: number) => {
      const idx = Math.floor((p / 100) * (n - 1));
      return qualities[Math.min(idx, n - 1)];
    };

    return {
      histogram,
      percentiles: { p25: percentile(25), p50: percentile(50), p75: percentile(75), p90: percentile(90) },
      mean,
      stdDev,
    };
  }

  private computeLabels(events: EventStoreEvent[]): QualityLabels {
    const userEvents = events.filter((e) => e.eventType === 'user_input');
    const toolCallEvents = events.filter((e) => e.eventType === 'tool_call');
    const toolResultEvents = events.filter((e) => e.eventType === 'tool_result');
    const errorEvents = events.filter((e) => e.eventType === 'error_occurred');
    const thinkingEvents = events.filter((e) => e.eventType === 'agent_thinking');

    const successTools = toolResultEvents.filter((e) => Boolean(e.payload.success));
    const taskCompletion = userEvents.length > 0
      ? Math.min(1, (toolResultEvents.length + thinkingEvents.length) / userEvents.length)
      : 0.5;

    const toolEfficiency = toolResultEvents.length > 0
      ? successTools.length / toolResultEvents.length
      : toolCallEvents.length === 0 ? 0.8 : 0.3;

    const errorRate = events.length > 0
      ? errorEvents.length / events.length
      : 0;

    const coherence = this.computeCoherence(events);

    const usefulness = this.computeUsefulness(events, taskCompletion, toolEfficiency);

    return {
      taskCompletion: Math.min(1, Math.max(0, taskCompletion)),
      toolEfficiency: Math.min(1, Math.max(0, toolEfficiency)),
      errorRate: Math.min(1, Math.max(0, errorRate)),
      coherence: Math.min(1, Math.max(0, coherence)),
      usefulness: Math.min(1, Math.max(0, usefulness)),
    };
  }

  private computeCoherence(events: EventStoreEvent[]): number {
    if (events.length <= 1) return 0.5;

    let consecutivePairs = 0;
    let coherentPairs = 0;

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];

      consecutivePairs++;

      if (this.isCoherentPair(prev, curr)) {
        coherentPairs++;
      }
    }

    return consecutivePairs > 0 ? coherentPairs / consecutivePairs : 0.5;
  }

  private isCoherentPair(prev: EventStoreEvent, curr: EventStoreEvent): boolean {
    const validTransitions: Record<string, string[]> = {
      'user_input': ['agent_thinking', 'tool_call', 'tool_result'],
      'agent_thinking': ['tool_call', 'tool_result', 'agent_thinking'],
      'tool_call': ['tool_result', 'error_occurred'],
      'tool_result': ['agent_thinking', 'tool_call', 'user_input'],
      'error_occurred': ['agent_thinking', 'tool_call'],
    };

    const allowed = validTransitions[prev.eventType];
    return allowed ? allowed.includes(curr.eventType) : true;
  }

  private computeUsefulness(events: EventStoreEvent[], taskCompletion: number, toolEfficiency: number): number {
    const hasFinalAnswer = events.some((e) =>
      e.eventType === 'agent_thinking' &&
      typeof e.payload.content === 'string' &&
      e.payload.content.length > 50
    );

    const hasSuccessfulToolUse = events.some((e) =>
      e.eventType === 'tool_result' && Boolean(e.payload.success)
    );

    let usefulness = 0;

    if (hasFinalAnswer) usefulness += 0.3;
    if (hasSuccessfulToolUse) usefulness += 0.2;
    usefulness += taskCompletion * 0.3;
    usefulness += toolEfficiency * 0.2;

    return Math.min(1, usefulness);
  }

  private generateAnnotations(events: EventStoreEvent[], labels: QualityLabels): QualityAnnotation[] {
    const annotations: QualityAnnotation[] = [];

    for (const [dimension, score] of Object.entries(labels)) {
      const reason = this.explainScore(dimension as keyof QualityLabels, score, events);
      annotations.push({
        dimension: dimension as keyof QualityLabels,
        score,
        reason,
        autoLabeled: true,
      });
    }

    return annotations;
  }

  private explainScore(dimension: keyof QualityLabels, score: number, events: EventStoreEvent[]): string {
    const explanations: Record<keyof QualityLabels, (s: number) => string> = {
      taskCompletion: (s) =>
        s >= 0.8 ? '任务完成度高，有充分的响应和工具调用' :
        s >= 0.5 ? '任务部分完成，可能缺少最终回答' :
        '任务完成度低，缺少有效响应',
      toolEfficiency: (s) =>
        s >= 0.8 ? '工具调用效率高，大部分调用成功' :
        s >= 0.5 ? '工具调用效率中等，部分调用失败' :
        '工具调用效率低，大量失败调用',
      errorRate: (s) =>
        s <= 0.05 ? '几乎无错误' :
        s <= 0.2 ? '少量错误，可接受' :
        '错误率较高，影响质量',
      coherence: (s) =>
        s >= 0.8 ? '事件流连贯，逻辑清晰' :
        s >= 0.5 ? '事件流基本连贯，偶有跳跃' :
        '事件流不连贯，逻辑混乱',
      usefulness: (s) =>
        s >= 0.8 ? '输出有用，包含最终答案和有效工具使用' :
        s >= 0.5 ? '输出部分有用' :
        '输出缺乏有用信息',
    };

    return explanations[dimension](score);
  }

  private computeOverallQuality(labels: QualityLabels): number {
    const weights: Record<keyof QualityLabels, number> = {
      taskCompletion: 0.3,
      toolEfficiency: 0.2,
      errorRate: -0.2,
      coherence: 0.15,
      usefulness: 0.25,
    };

    let quality = 0;
    for (const [dim, weight] of Object.entries(weights)) {
      quality += labels[dim as keyof QualityLabels] * weight;
    }

    return Math.min(1, Math.max(0, quality + 0.2));
  }

  private passesFilter(trajectory: AnnotatedTrajectory): boolean {
    const { labels, quality } = trajectory;

    if (labels.taskCompletion < this.filterConfig.minTaskCompletion) return false;
    if (labels.errorRate > this.filterConfig.maxErrorRate) return false;
    if (labels.coherence < this.filterConfig.minCoherence) return false;
    if (labels.usefulness < this.filterConfig.minUsefulness) return false;
    if (quality < this.filterConfig.minOverallQuality) return false;
    if (quality > this.filterConfig.maxOverallQuality) return false;

    return true;
  }

  private computeSequenceSignature(trajectory: AnnotatedTrajectory): string {
    const toolSequence = trajectory.events
      .filter((e) => e.eventType === 'tool_call')
      .map((e) => String(e.payload.toolName ?? 'unknown'))
      .join('→');

    const eventTypes = trajectory.events.map((e) => e.eventType).join('→');

    return `${eventTypes}|${toolSequence}`;
  }

  private sequenceSimilarity(sigA: string, sigB: string): number {
    const partsA = sigA.split('|');
    const partsB = sigB.split('|');

    const toolsA = partsA[1]?.split('→') ?? [];
    const toolsB = partsB[1]?.split('→') ?? [];

    if (toolsA.length === 0 && toolsB.length === 0) return 1.0;
    if (toolsA.length === 0 || toolsB.length === 0) return 0.0;

    const setA = new Set(toolsA);
    const setB = new Set(toolsB);
    const intersection = new Set([...setA].filter((x) => setB.has(x)));

    return intersection.size / Math.max(setA.size, setB.size);
  }

  private sampleFromGroup(
    group: AnnotatedTrajectory[],
    count: number,
    strategy: DiversitySampleConfig['strategy']
  ): AnnotatedTrajectory[] {
    if (group.length <= count) return group;

    switch (strategy) {
      case 'random':
        return this.shuffleArray(group).slice(0, count);

      case 'quality_weighted':
        return [...group]
          .sort((a, b) => b.quality - a.quality)
          .slice(0, count);

      case 'diversity_maximizing': {
        const selected: AnnotatedTrajectory[] = [group[0]];
        const remaining = group.slice(1);

        while (selected.length < count && remaining.length > 0) {
          let maxDist = -1;
          let maxIdx = 0;

          for (let i = 0; i < remaining.length; i++) {
            const minDist = Math.min(
              ...selected.map((s) =>
                Math.abs(s.quality - remaining[i].quality)
              )
            );
            if (minDist > maxDist) {
              maxDist = minDist;
              maxIdx = i;
            }
          }

          selected.push(remaining[maxIdx]);
          remaining.splice(maxIdx, 1);
        }

        return selected;
      }

      default:
        return group.slice(0, count);
    }
  }

  private shuffleArray<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
