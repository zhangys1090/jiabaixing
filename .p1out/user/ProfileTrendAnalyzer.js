"use strict";
/**
 * 用户画像趋势分析 + 辩证式推理（整合版）
 *
 * 整合了原 ProfileTrendAnalyzer 和 DialecticalUserModeling：
 * - 趋势追踪：偏好、行为、情绪的历史变化
 * - 辩证推理：矛盾检测、信念更新、综合分析
 *
 * 消除了两个模块之间的功能重叠和重复数据处理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileTrendAnalyzer = void 0;
const Logger_1 = require("../utils/Logger");
class ProfileTrendAnalyzer {
    constructor() {
        this.memoryDepths = new Map();
        this.MAX_USERS = 5000;
        this._trendTrackingEnabled = true;
        this.contradictions = new Map();
        this.beliefStates = new Map();
        this.behaviorHistory = [];
        this.MAX_HISTORY = 1000;
    }
    static getInstance() {
        if (!ProfileTrendAnalyzer._instance) {
            ProfileTrendAnalyzer._instance = new ProfileTrendAnalyzer();
        }
        return ProfileTrendAnalyzer._instance;
    }
    get trendTrackingEnabled() {
        return this._trendTrackingEnabled;
    }
    getMemoryDepth(userId) {
        return this.memoryDepths.get(userId);
    }
    getOrCreateMemoryDepth(userId) {
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
            if (this.memoryDepths.size >= this.MAX_USERS) {
                const oldestKey = this.memoryDepths.keys().next().value;
                this.memoryDepths.delete(oldestKey);
                this.contradictions.delete(oldestKey);
                this.beliefStates.delete(oldestKey);
            }
            this.memoryDepths.set(userId, depth);
        }
        return depth;
    }
    // ==================== 趋势追踪 ====================
    recordPreferenceTrend(userId, profile) {
        if (!this._trendTrackingEnabled)
            return;
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
    recordBehaviorTrend(userId, profile) {
        if (!this._trendTrackingEnabled)
            return;
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
    recordEmotionalTrend(userId, profile) {
        if (!this._trendTrackingEnabled)
            return;
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
    getDominantEmotion(profile) {
        const emotions = profile.emotionalProfile.dominantEmotions;
        if (Object.keys(emotions).length === 0)
            return null;
        return Object.entries(emotions).sort((a, b) => b[1] - a[1])[0][0];
    }
    getPreferenceTrendAnalysis(userId) {
        const depth = this.memoryDepths.get(userId);
        if (!depth) {
            return { topicTrend: {}, activityTrend: {}, styleChanges: [] };
        }
        const topicTrend = {};
        const activityTrend = {};
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
        const styleChanges = depth.preferenceTrends.styleHistory.map(({ style }) => style);
        return { topicTrend, activityTrend, styleChanges };
    }
    getBehaviorTrendAnalysis(userId) {
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
        const timeSlotCounts = {};
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
    getEmotionalTrendAnalysis(userId) {
        const depth = this.memoryDepths.get(userId);
        if (!depth) {
            return { emotionTrend: {}, dominantEmotions: [], triggerFrequency: {} };
        }
        const emotionTrend = {};
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
    setTrendTrackingEnabled(enabled) {
        this._trendTrackingEnabled = enabled;
    }
    clearMemoryDepths() {
        this.memoryDepths.clear();
    }
    // ==================== 辩证式推理（整合自DialecticalUserModeling） ====================
    /**
     * 记录用户行为并检查矛盾（统一入口）
     */
    recordAndAnalyze(userId, behavior) {
        this.behaviorHistory.push(behavior);
        if (this.behaviorHistory.length > this.MAX_HISTORY) {
            this.behaviorHistory = this.behaviorHistory.slice(-this.MAX_HISTORY);
        }
        this.detectContradictions(userId, behavior);
        this.updateBeliefStates(userId, behavior);
    }
    detectContradictions(userId, newBehavior) {
        const recentBehaviors = this.getRecentBehaviors(userId, 50);
        const preferenceContradictions = this.checkPreferenceContradictions(newBehavior, recentBehaviors);
        const behaviorContradictions = this.checkBehaviorContradictions(newBehavior, recentBehaviors);
        [...preferenceContradictions, ...behaviorContradictions].forEach((contradiction) => {
            this.contradictions.set(contradiction.id, contradiction);
            Logger_1.Logger.warn(`检测到用户矛盾 (${contradiction.severity}): ${contradiction.description}`, 'ProfileTrendAnalyzer');
        });
    }
    checkPreferenceContradictions(newBehavior, history) {
        const contradictions = [];
        if (newBehavior.type !== 'preference')
            return contradictions;
        const similarPreferenceBehaviors = history.filter((b) => b.type === 'preference' && b.action === newBehavior.action);
        similarPreferenceBehaviors.forEach((oldBehavior) => {
            if (newBehavior.content !== oldBehavior.content) {
                contradictions.push({
                    id: `pref_${Date.now()}_${Math.random()}`,
                    type: 'preference',
                    severity: this.calculateContradictionSeverity(newBehavior, oldBehavior),
                    description: `偏好冲突: "${oldBehavior.content}" vs "${newBehavior.content}"`,
                    evidence: [oldBehavior, newBehavior],
                    timestamp: new Date(),
                });
            }
        });
        return contradictions;
    }
    checkBehaviorContradictions(newBehavior, history) {
        const contradictions = [];
        const recentActions = history.slice(-20);
        recentActions.forEach((oldBehavior) => {
            if (oldBehavior.action !== newBehavior.action)
                return;
            const timeDiff = Math.abs(newBehavior.timestamp.getTime() - oldBehavior.timestamp.getTime());
            if (timeDiff < 3600000)
                return;
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
    calculateContradictionSeverity(a, b) {
        const timeDiff = Math.abs(a.timestamp.getTime() - b.timestamp.getTime());
        const satisfactionA = a.metadata.satisfaction || 3;
        const satisfactionB = b.metadata.satisfaction || 3;
        const satDiff = Math.abs(satisfactionA - satisfactionB);
        if (timeDiff < 86400000 && satDiff > 2)
            return 'high';
        if (timeDiff < 604800000 && satDiff > 1)
            return 'medium';
        return 'low';
    }
    updateBeliefStates(userId, behavior) {
        const beliefs = this.extractBeliefs(behavior);
        const currentBeliefs = this.beliefStates.get(userId) || [];
        beliefs.forEach((beliefContent) => {
            const existingBelief = currentBeliefs.find((b) => b.content === beliefContent);
            if (existingBelief) {
                existingBelief.confidence = Math.min(1, existingBelief.confidence + 0.1);
                existingBelief.evidenceCount += 1;
                existingBelief.lastUpdated = new Date();
                existingBelief.supportingBehaviors.push(behavior.action);
            }
            else {
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
    extractBeliefs(behavior) {
        const beliefs = [];
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
    getRecentBehaviors(userId, count) {
        return this.behaviorHistory
            .filter((b) => b.userId === userId)
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            .slice(0, count);
    }
    getActiveContradictions(userId) {
        return Array.from(this.contradictions.values())
            .filter((c) => c.evidence.some((e) => e.userId === userId))
            .filter((c) => !c.resolution || c.resolution.status === 'pending');
    }
    resolveContradiction(contradictionId, explanation, resolvedBy) {
        const contradiction = this.contradictions.get(contradictionId);
        if (contradiction) {
            contradiction.resolution = {
                status: 'resolved',
                explanation,
                resolvedBy,
                resolvedAt: new Date(),
            };
            Logger_1.Logger.info(`矛盾已解决: ${contradiction.description}`, 'ProfileTrendAnalyzer');
        }
    }
    generateDialecticalAnalysis(userId) {
        const activeContradictions = this.getActiveContradictions(userId);
        const beliefs = this.beliefStates.get(userId) || [];
        const sortedBeliefs = beliefs
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 10);
        const synthesis = activeContradictions.length > 0
            ? `检测到 ${activeContradictions.length} 个潜在矛盾，正在进行辩证式综合。`
            : '用户画像一致性良好，未检测到显著矛盾。';
        return { activeContradictions, beliefEvolution: sortedBeliefs, synthesis };
    }
    getConfidenceScore(userId) {
        const activeContradictions = this.getActiveContradictions(userId);
        const beliefs = this.beliefStates.get(userId) || [];
        if (beliefs.length === 0)
            return 0.5;
        const avgConfidence = beliefs.reduce((sum, b) => sum + b.confidence, 0) / beliefs.length;
        const contradictionPenalty = activeContradictions.length * 0.05;
        return Math.max(0, Math.min(1, avgConfidence - contradictionPenalty));
    }
}
exports.ProfileTrendAnalyzer = ProfileTrendAnalyzer;
ProfileTrendAnalyzer._instance = null;
