/**
 * 用户画像趋势分析 + 辩证式推理（整合版）
 *
 * 整合了原 ProfileTrendAnalyzer 和 DialecticalUserModeling：
 * - 趋势追踪：偏好、行为、情绪的历史变化
 * - 辩证推理：矛盾检测、信念更新、综合分析
 *
 * 消除了两个模块之间的功能重叠和重复数据处理
 */

import { Logger } from '../utils/Logger';
import { MemoryDepth, UserBehavior, UserProfile } from './types';

export interface Contradiction {
  id: string;
  type: 'preference' | 'behavior' | 'emotional' | 'value';
  severity: 'low' | 'medium' | 'high';
  description: string;
  evidence: UserBehavior[];
  timestamp: Date;
  resolution?: {
    status: 'pending' | 'resolved' | 'archived';
    explanation?: string;
    resolvedBy?: 'user_input' | 'pattern_analysis' | 'context_change';
    resolvedAt?: Date;
  };
}

export interface BeliefState {
  beliefId: string;
  content: string;
  confidence: number;
  evidenceCount: number;
  lastUpdated: Date;
  supportingBehaviors: string[];
}

export class ProfileTrendAnalyzer {
  private static _instance: ProfileTrendAnalyzer | null = null;
  private memoryDepths: Map<string, MemoryDepth> = new Map();
  private _trendTrackingEnabled = true;

  private contradictions: Map<string, Contradiction> = new Map();
  private beliefStates: Map<string, BeliefState[]> = new Map();
  private behaviorHistory: UserBehavior[] = [];
  private readonly MAX_HISTORY = 1000;

  private constructor() {}

  static getInstance(): ProfileTrendAnalyzer {
    if (!ProfileTrendAnalyzer._instance) {
      ProfileTrendAnalyzer._instance = new ProfileTrendAnalyzer();
    }
    return ProfileTrendAnalyzer._instance;
  }

  get trendTrackingEnabled(): boolean {
    return this._trendTrackingEnabled;
  }

  getMemoryDepth(userId: string): MemoryDepth | undefined {
    return this.memoryDepths.get(userId);
  }

  private getOrCreateMemoryDepth(userId: string): MemoryDepth {
    let depth = this.memoryDepths.get(userId);
    if (!depth) {
      depth = {
        userId,
        preferenceTrends: {
          topicHistory: [],
          activityHistory: [],
          styleHistory: [],
        },
        behaviorTrends: {
          frequencyTrend: [],
          durationTrend: [],
          timeSlotTrend: [],
        },
        emotionalTrends: {
          emotionHistory: [],
          triggerFrequency: {},
          dominantEmotionChanges: [],
        },
        metadata: {
          lastUpdated: new Date(),
          trackingStartDate: new Date(),
          dataPointsCount: 0,
        },
      };
      this.memoryDepths.set(userId, depth);
    }
    return depth;
  }

  // ==================== 趋势追踪 ====================

  recordPreferenceTrend(userId: string, profile: UserProfile): void {
    if (!this._trendTrackingEnabled) return;

    const depth = this.getOrCreateMemoryDepth(userId);
    const now = new Date();

    depth.preferenceTrends.topicHistory.push({
      timestamp: now,
      topics: { ...profile.preferences.topics },
    });

    depth.preferenceTrends.activityHistory.push({
      timestamp: now,
      activities: { ...profile.preferences.activities },
    });

    depth.preferenceTrends.styleHistory.push({
      timestamp: now,
      style: profile.preferences.communicationStyle,
    });

    depth.metadata.lastUpdated = now;
    depth.metadata.dataPointsCount++;

    this.memoryDepths.set(userId, depth);
  }

  recordBehaviorTrend(userId: string, profile: UserProfile): void {
    if (!this._trendTrackingEnabled) return;

    const depth = this.getOrCreateMemoryDepth(userId);
    const now = new Date();

    depth.behaviorTrends.frequencyTrend.push({
      timestamp: now,
      frequency: profile.behaviorPatterns.interactionFrequency,
    });

    depth.behaviorTrends.durationTrend.push({
      timestamp: now,
      duration: profile.behaviorPatterns.averageSessionDuration,
    });

    depth.behaviorTrends.timeSlotTrend.push({
      timestamp: now,
      slots: [...profile.behaviorPatterns.preferredTimeSlots],
    });

    depth.metadata.lastUpdated = now;
    depth.metadata.dataPointsCount++;

    this.memoryDepths.set(userId, depth);
  }

  recordEmotionalTrend(userId: string, profile: UserProfile): void {
    if (!this._trendTrackingEnabled) return;

    const depth = this.getOrCreateMemoryDepth(userId);
    const now = new Date();

    depth.emotionalTrends.emotionHistory.push({
      timestamp: now,
      emotions: { ...profile.emotionalProfile.dominantEmotions },
    });

    const dominantEmotion = this.getDominantEmotion(profile);
    if (dominantEmotion) {
      depth.emotionalTrends.dominantEmotionChanges.push({
        timestamp: now,
        dominantEmotion,
      });
    }

    depth.metadata.lastUpdated = now;
    depth.metadata.dataPointsCount++;

    this.memoryDepths.set(userId, depth);
  }

  private getDominantEmotion(profile: UserProfile): string | null {
    const emotions = profile.emotionalProfile.dominantEmotions;
    if (Object.keys(emotions).length === 0) return null;

    return Object.entries(emotions).sort((a, b) => b[1] - a[1])[0][0];
  }

  getPreferenceTrendAnalysis(userId: string): {
    topicTrend: { [key: string]: number };
    activityTrend: { [key: string]: number };
    styleChanges: string[];
  } {
    const depth = this.memoryDepths.get(userId);
    if (!depth) {
      return { topicTrend: {}, activityTrend: {}, styleChanges: [] };
    }

    const topicTrend: { [key: string]: number } = {};
    const activityTrend: { [key: string]: number } = {};

    const recentTopics = depth.preferenceTrends.topicHistory.slice(-10);
    recentTopics.forEach(({ topics }) => {
      Object.entries(topics).forEach(([topic, score]) => {
        topicTrend[topic] = (topicTrend[topic] || 0) + score;
      });
    });

    const recentActivities = depth.preferenceTrends.activityHistory.slice(-10);
    recentActivities.forEach(({ activities }) => {
      Object.entries(activities).forEach(([activity, score]) => {
        activityTrend[activity] = (activityTrend[activity] || 0) + score;
      });
    });

    const styleChanges = depth.preferenceTrends.styleHistory.map(
      ({ style }) => style
    );

    return { topicTrend, activityTrend, styleChanges };
  }

  getBehaviorTrendAnalysis(userId: string): {
    frequencyTrend: number[];
    durationTrend: number[];
    commonTimeSlots: string[];
  } {
    const depth = this.memoryDepths.get(userId);
    if (!depth) {
      return { frequencyTrend: [], durationTrend: [], commonTimeSlots: [] };
    }

    const frequencyTrend = depth.behaviorTrends.frequencyTrend
      .slice(-10)
      .map(({ frequency }) => frequency);

    const durationTrend = depth.behaviorTrends.durationTrend
      .slice(-10)
      .map(({ duration }) => duration);

    const timeSlotCounts: { [key: string]: number } = {};
    depth.behaviorTrends.timeSlotTrend.forEach(({ slots }) => {
      slots.forEach((slot) => {
        timeSlotCounts[slot] = (timeSlotCounts[slot] || 0) + 1;
      });
    });

    const commonTimeSlots = Object.entries(timeSlotCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([slot]) => slot);

    return { frequencyTrend, durationTrend, commonTimeSlots };
  }

  getEmotionalTrendAnalysis(userId: string): {
    emotionTrend: { [key: string]: number };
    dominantEmotions: string[];
    triggerFrequency: { [key: string]: number };
  } {
    const depth = this.memoryDepths.get(userId);
    if (!depth) {
      return { emotionTrend: {}, dominantEmotions: [], triggerFrequency: {} };
    }

    const emotionTrend: { [key: string]: number } = {};
    const recentEmotions = depth.emotionalTrends.emotionHistory.slice(-10);
    recentEmotions.forEach(({ emotions }) => {
      Object.entries(emotions).forEach(([emotion, score]) => {
        emotionTrend[emotion] = (emotionTrend[emotion] || 0) + score;
      });
    });

    const dominantEmotions = depth.emotionalTrends.dominantEmotionChanges
      .slice(-10)
      .map(({ dominantEmotion }) => dominantEmotion);

    return {
      emotionTrend,
      dominantEmotions,
      triggerFrequency: { ...depth.emotionalTrends.triggerFrequency },
    };
  }

  setTrendTrackingEnabled(enabled: boolean): void {
    this._trendTrackingEnabled = enabled;
  }

  clearMemoryDepths(): void {
    this.memoryDepths.clear();
  }

  // ==================== 辩证式推理（整合自DialecticalUserModeling） ====================

  /**
   * 记录用户行为并检查矛盾（统一入口）
   */
  recordAndAnalyze(userId: string, behavior: UserBehavior): void {
    this.behaviorHistory.push(behavior);
    if (this.behaviorHistory.length > this.MAX_HISTORY) {
      this.behaviorHistory = this.behaviorHistory.slice(-this.MAX_HISTORY);
    }

    this.detectContradictions(userId, behavior);
    this.updateBeliefStates(userId, behavior);
  }

  private detectContradictions(
    userId: string,
    newBehavior: UserBehavior
  ): void {
    const recentBehaviors = this.getRecentBehaviors(userId, 50);

    const preferenceContradictions = this.checkPreferenceContradictions(
      newBehavior,
      recentBehaviors
    );
    const behaviorContradictions = this.checkBehaviorContradictions(
      newBehavior,
      recentBehaviors
    );

    [...preferenceContradictions, ...behaviorContradictions].forEach(
      (contradiction) => {
        this.contradictions.set(contradiction.id, contradiction);
        Logger.warn(
          `检测到用户矛盾 (${contradiction.severity}): ${contradiction.description}`,
          'ProfileTrendAnalyzer'
        );
      }
    );
  }

  private checkPreferenceContradictions(
    newBehavior: UserBehavior,
    history: UserBehavior[]
  ): Contradiction[] {
    const contradictions: Contradiction[] = [];
    if (newBehavior.type !== 'preference') return contradictions;

    const similarPreferenceBehaviors = history.filter(
      (b) => b.type === 'preference' && b.action === newBehavior.action
    );

    similarPreferenceBehaviors.forEach((oldBehavior) => {
      if (newBehavior.content !== oldBehavior.content) {
        contradictions.push({
          id: `pref_${Date.now()}_${Math.random()}`,
          type: 'preference',
          severity: this.calculateContradictionSeverity(
            newBehavior,
            oldBehavior
          ),
          description: `偏好冲突: "${oldBehavior.content}" vs "${newBehavior.content}"`,
          evidence: [oldBehavior, newBehavior],
          timestamp: new Date(),
        });
      }
    });

    return contradictions;
  }

  private checkBehaviorContradictions(
    newBehavior: UserBehavior,
    history: UserBehavior[]
  ): Contradiction[] {
    const contradictions: Contradiction[] = [];
    const recentActions = history.slice(-20);

    recentActions.forEach((oldBehavior) => {
      if (oldBehavior.action !== newBehavior.action) return;
      const timeDiff = Math.abs(
        newBehavior.timestamp.getTime() - oldBehavior.timestamp.getTime()
      );
      if (timeDiff < 3600000) return;

      const satisfactionA = newBehavior.metadata.satisfaction || 3;
      const satisfactionB = oldBehavior.metadata.satisfaction || 3;
      if (Math.abs(satisfactionA - satisfactionB) > 2) {
        contradictions.push({
          id: `behav_${Date.now()}_${Math.random()}`,
          type: 'behavior',
          severity: 'medium',
          description: `行为模式冲突: "${oldBehavior.action}" vs "${newBehavior.action}"`,
          evidence: [oldBehavior, newBehavior],
          timestamp: new Date(),
        });
      }
    });

    return contradictions;
  }

  private calculateContradictionSeverity(
    a: UserBehavior,
    b: UserBehavior
  ): 'low' | 'medium' | 'high' {
    const timeDiff = Math.abs(a.timestamp.getTime() - b.timestamp.getTime());
    const satisfactionA = a.metadata.satisfaction || 3;
    const satisfactionB = b.metadata.satisfaction || 3;
    const satDiff = Math.abs(satisfactionA - satisfactionB);

    if (timeDiff < 86400000 && satDiff > 2) return 'high';
    if (timeDiff < 604800000 && satDiff > 1) return 'medium';
    return 'low';
  }

  private updateBeliefStates(userId: string, behavior: UserBehavior): void {
    const beliefs = this.extractBeliefs(behavior);
    const currentBeliefs = this.beliefStates.get(userId) || [];

    beliefs.forEach((beliefContent) => {
      const existingBelief = currentBeliefs.find(
        (b) => b.content === beliefContent
      );
      if (existingBelief) {
        existingBelief.confidence = Math.min(
          1,
          existingBelief.confidence + 0.1
        );
        existingBelief.evidenceCount += 1;
        existingBelief.lastUpdated = new Date();
        existingBelief.supportingBehaviors.push(behavior.action);
      } else {
        currentBeliefs.push({
          beliefId: `belief_${Date.now()}_${Math.random()}`,
          content: beliefContent,
          confidence: 0.5,
          evidenceCount: 1,
          lastUpdated: new Date(),
          supportingBehaviors: [behavior.action],
        });
      }
    });

    this.beliefStates.set(userId, currentBeliefs);
  }

  private extractBeliefs(behavior: UserBehavior): string[] {
    const beliefs: string[] = [];
    if (behavior.type === 'preference') {
      beliefs.push(`prefers_${behavior.action}`);
    }
    if (behavior.metadata.satisfaction !== undefined) {
      if (behavior.metadata.satisfaction > 3)
        beliefs.push(`liked_${behavior.action}`);
      else if (behavior.metadata.satisfaction < 3)
        beliefs.push(`disliked_${behavior.action}`);
    }
    return beliefs;
  }

  private getRecentBehaviors(userId: string, count: number): UserBehavior[] {
    return this.behaviorHistory
      .filter((b) => b.userId === userId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, count);
  }

  getActiveContradictions(userId: string): Contradiction[] {
    return Array.from(this.contradictions.values())
      .filter((c) => c.evidence.some((e) => e.userId === userId))
      .filter((c) => !c.resolution || c.resolution.status === 'pending');
  }

  resolveContradiction(
    contradictionId: string,
    explanation: string,
    resolvedBy: 'user_input' | 'pattern_analysis' | 'context_change'
  ): void {
    const contradiction = this.contradictions.get(contradictionId);
    if (contradiction) {
      contradiction.resolution = {
        status: 'resolved',
        explanation,
        resolvedBy,
        resolvedAt: new Date(),
      };
      Logger.info(
        `矛盾已解决: ${contradiction.description}`,
        'ProfileTrendAnalyzer'
      );
    }
  }

  generateDialecticalAnalysis(userId: string): {
    activeContradictions: Contradiction[];
    beliefEvolution: BeliefState[];
    synthesis: string;
  } {
    const activeContradictions = this.getActiveContradictions(userId);
    const beliefs = this.beliefStates.get(userId) || [];
    const sortedBeliefs = beliefs
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);

    const synthesis =
      activeContradictions.length > 0
        ? `检测到 ${activeContradictions.length} 个潜在矛盾，正在进行辩证式综合。`
        : '用户画像一致性良好，未检测到显著矛盾。';

    return { activeContradictions, beliefEvolution: sortedBeliefs, synthesis };
  }

  getConfidenceScore(userId: string): number {
    const activeContradictions = this.getActiveContradictions(userId);
    const beliefs = this.beliefStates.get(userId) || [];

    if (beliefs.length === 0) return 0.5;

    const avgConfidence =
      beliefs.reduce((sum, b) => sum + b.confidence, 0) / beliefs.length;
    const contradictionPenalty = activeContradictions.length * 0.05;

    return Math.max(0, Math.min(1, avgConfidence - contradictionPenalty));
  }
}
