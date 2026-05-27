import { MemoryDepth, UserProfile } from './types';

export class ProfileTrendAnalyzer {
  private static _instance: ProfileTrendAnalyzer | null = null;
  private memoryDepths: Map<string, MemoryDepth> = new Map();
  private _trendTrackingEnabled = true;

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
}
