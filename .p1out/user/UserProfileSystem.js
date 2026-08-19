"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserProfileSystem = void 0;
const Logger_1 = require("../utils/Logger");
const ProfileTrendAnalyzer_1 = require("./ProfileTrendAnalyzer");
class UserProfileSystem {
    constructor() {
        this.profiles = new Map();
        this.MAX_PROFILES = 10000;
        this.behaviorHistory = [];
        this.maxBehaviorHistory = 10000;
        this.profileUpdateInterval = 5 * 60 * 1000;
        this.updateTimer = null;
        this.trendAnalyzer = ProfileTrendAnalyzer_1.ProfileTrendAnalyzer.getInstance();
    }
    initialize() {
        Logger_1.Logger.info('👤 用户画像系统：初始化完成', 'UserProfileSystem');
        this.startProfileUpdates();
    }
    createProfile(userId) {
        const defaultProfile = {
            userId,
            basicInfo: {},
            preferences: {
                topics: {},
                activities: {},
                communicationStyle: 'friendly',
                responseLength: 'medium',
                preferredChannels: ['text'],
            },
            behaviorPatterns: {
                dailyRoutine: {},
                interactionFrequency: 0,
                averageSessionDuration: 0,
                preferredTimeSlots: [],
            },
            emotionalProfile: {
                dominantEmotions: {},
                emotionalTriggers: [],
                emotionalResponses: {},
            },
            cognitiveProfile: {
                learningStyle: 'visual',
                problemSolvingApproach: 'analytical',
                informationProcessingSpeed: 'medium',
            },
            contextAwareness: {
                commonScenes: {},
                devicePreferences: {},
                environmentalFactors: {},
            },
            interactionHistory: {
                totalInteractions: 0,
                successfulTasks: 0,
                failedTasks: 0,
                averageSatisfaction: 3,
            },
            metadata: {
                lastUpdated: new Date(),
                profileVersion: 1,
                dataSources: [],
                confidenceScore: 0.5,
            },
        };
        if (this.profiles.size >= this.MAX_PROFILES && !this.profiles.has(userId)) {
            const oldestKey = this.profiles.keys().next().value;
            this.profiles.delete(oldestKey);
        }
        this.profiles.set(userId, defaultProfile);
        return defaultProfile;
    }
    recordBehavior(behavior) {
        this.behaviorHistory.push(behavior);
        if (this.behaviorHistory.length > this.maxBehaviorHistory) {
            this.behaviorHistory = this.behaviorHistory.slice(-this.maxBehaviorHistory);
        }
        this.trendAnalyzer.recordAndAnalyze(behavior.userId, behavior);
        this.updateProfile(behavior.userId);
    }
    /**
     * P1增强：获取辩证式用户分析
     */
    getDialecticalAnalysis(userId) {
        return this.trendAnalyzer.generateDialecticalAnalysis(userId);
    }
    /**
     * P1增强：获取用户画像置信度（结合辩证式分析）
     */
    getEnhancedConfidenceScore(userId) {
        const profile = this.profiles.get(userId);
        const dialecticalConfidence = this.trendAnalyzer.getConfidenceScore(userId);
        if (!profile)
            return 0.5;
        return (profile.metadata.confidenceScore + dialecticalConfidence) / 2;
    }
    recordBehaviors(behaviors) {
        for (const behavior of behaviors) {
            this.recordBehavior(behavior);
        }
    }
    updateProfile(userId, options = {}) {
        let profile = this.profiles.get(userId);
        if (!profile) {
            profile = this.createProfile(userId);
        }
        const userBehaviors = this.behaviorHistory.filter((b) => b.userId === userId);
        if (options.updatePreferences !== false) {
            this.updatePreferences(profile, userBehaviors);
        }
        if (options.updateBehaviorPatterns !== false) {
            this.updateBehaviorPatterns(profile, userBehaviors);
        }
        if (options.updateEmotionalProfile !== false) {
            this.updateEmotionalProfile(profile, userBehaviors);
        }
        if (options.updateCognitiveProfile !== false) {
            this.updateCognitiveProfile(profile, userBehaviors);
        }
        if (options.updateContextAwareness !== false) {
            this.updateContextAwareness(profile, userBehaviors);
        }
        this.updateInteractionHistory(profile, userBehaviors);
        profile.metadata.lastUpdated = new Date();
        profile.metadata.profileVersion += 1;
        profile.metadata.confidenceScore = this.calculateProfileConfidence(profile, userBehaviors);
        this.profiles.set(userId, profile);
        if (this.trendAnalyzer.trendTrackingEnabled) {
            this.trendAnalyzer.recordPreferenceTrend(userId, profile);
            this.trendAnalyzer.recordBehaviorTrend(userId, profile);
            this.trendAnalyzer.recordEmotionalTrend(userId, profile);
        }
        return profile;
    }
    updatePreferences(profile, behaviors) {
        const recentBehaviors = behaviors.slice(-100);
        const topicScores = {};
        recentBehaviors.forEach((behavior) => {
            if (behavior.type === 'interaction' || behavior.type === 'task') {
                const topics = this.extractTopics(behavior.content);
                topics.forEach((topic) => {
                    topicScores[topic] = (topicScores[topic] || 0) + 1;
                });
            }
        });
        const maxScore = Math.max(...Object.values(topicScores), 1);
        for (const [topic, score] of Object.entries(topicScores)) {
            profile.preferences.topics[topic] = score / maxScore;
        }
        const activityScores = {};
        recentBehaviors.forEach((behavior) => {
            if (behavior.type === 'task') {
                activityScores[behavior.action] =
                    (activityScores[behavior.action] || 0) + 1;
            }
        });
        const maxActivityScore = Math.max(...Object.values(activityScores), 1);
        for (const [activity, score] of Object.entries(activityScores)) {
            profile.preferences.activities[activity] = score / maxActivityScore;
        }
        this.analyzeCommunicationStyle(profile, recentBehaviors);
    }
    updateBehaviorPatterns(profile, behaviors) {
        const dailyRoutine = {};
        behaviors.forEach((behavior) => {
            const hour = behavior.timestamp.getHours();
            const timeSlot = `${hour}:00-${hour + 1}:00`;
            if (!dailyRoutine[timeSlot]) {
                dailyRoutine[timeSlot] = [];
            }
            dailyRoutine[timeSlot].push(behavior.action);
        });
        profile.behaviorPatterns.dailyRoutine = dailyRoutine;
        const now = new Date();
        const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const recentInteractions = behaviors.filter((b) => b.timestamp >= last7Days);
        profile.behaviorPatterns.interactionFrequency =
            recentInteractions.length / 7;
        const sessionDurations = behaviors
            .filter((b) => b.metadata.duration)
            .map((b) => b.metadata.duration);
        if (sessionDurations.length > 0) {
            const totalDuration = sessionDurations.reduce((sum, duration) => sum + duration, 0);
            profile.behaviorPatterns.averageSessionDuration =
                totalDuration / sessionDurations.length / 60;
        }
        const timeSlotFrequency = {};
        behaviors.forEach((behavior) => {
            const hour = behavior.timestamp.getHours();
            const timeSlot = `${hour}:00-${hour + 1}:00`;
            timeSlotFrequency[timeSlot] = (timeSlotFrequency[timeSlot] || 0) + 1;
        });
        const preferredTimeSlots = Object.entries(timeSlotFrequency)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([slot]) => slot);
        profile.behaviorPatterns.preferredTimeSlots = preferredTimeSlots;
    }
    updateEmotionalProfile(profile, behaviors) {
        const emotionScores = {};
        behaviors.forEach((behavior) => {
            if (behavior.context.emotion) {
                emotionScores[behavior.context.emotion] =
                    (emotionScores[behavior.context.emotion] || 0) + 1;
            }
        });
        profile.emotionalProfile.dominantEmotions = emotionScores;
        const emotionalTriggers = [];
        behaviors.forEach((behavior) => {
            if (behavior.context.emotion && behavior.content) {
                const triggers = this.extractEmotionalTriggers(behavior.content);
                emotionalTriggers.push(...triggers);
            }
        });
        profile.emotionalProfile.emotionalTriggers = [
            ...new Set(emotionalTriggers),
        ];
        const emotionalResponses = {};
        behaviors.forEach((behavior) => {
            if (behavior.context.emotion && behavior.action) {
                if (!emotionalResponses[behavior.context.emotion]) {
                    emotionalResponses[behavior.context.emotion] = [];
                }
                emotionalResponses[behavior.context.emotion].push(behavior.action);
            }
        });
        profile.emotionalProfile.emotionalResponses = emotionalResponses;
    }
    updateCognitiveProfile(profile, behaviors) {
        const taskBehaviors = behaviors.filter((b) => b.type === 'task');
        if (taskBehaviors.length > 0) {
            const visualCues = taskBehaviors.filter((b) => b.content.includes('看') ||
                b.content.includes('图片') ||
                b.content.includes('视频')).length;
            const auditoryCues = taskBehaviors.filter((b) => b.content.includes('听') ||
                b.content.includes('声音') ||
                b.content.includes('语音')).length;
            const kinestheticCues = taskBehaviors.filter((b) => b.content.includes('做') ||
                b.content.includes('操作') ||
                b.content.includes('实践')).length;
            const readingCues = taskBehaviors.filter((b) => b.content.includes('读') ||
                b.content.includes('文字') ||
                b.content.includes('文档')).length;
            const maxCue = Math.max(visualCues, auditoryCues, kinestheticCues, readingCues);
            if (maxCue === visualCues)
                profile.cognitiveProfile.learningStyle = 'visual';
            else if (maxCue === auditoryCues)
                profile.cognitiveProfile.learningStyle = 'auditory';
            else if (maxCue === kinestheticCues)
                profile.cognitiveProfile.learningStyle = 'kinesthetic';
            else
                profile.cognitiveProfile.learningStyle = 'reading';
            const analyticalCues = taskBehaviors.filter((b) => b.content.includes('分析') ||
                b.content.includes('逻辑') ||
                b.content.includes('推理')).length;
            const creativeCues = taskBehaviors.filter((b) => b.content.includes('创意') ||
                b.content.includes('想象') ||
                b.content.includes('创新')).length;
            const practicalCues = taskBehaviors.filter((b) => b.content.includes('实用') ||
                b.content.includes('实际') ||
                b.content.includes('现实')).length;
            const collaborativeCues = taskBehaviors.filter((b) => b.content.includes('合作') ||
                b.content.includes('团队') ||
                b.content.includes('一起')).length;
            const maxApproach = Math.max(analyticalCues, creativeCues, practicalCues, collaborativeCues);
            if (maxApproach === analyticalCues)
                profile.cognitiveProfile.problemSolvingApproach = 'analytical';
            else if (maxApproach === creativeCues)
                profile.cognitiveProfile.problemSolvingApproach = 'creative';
            else if (maxApproach === practicalCues)
                profile.cognitiveProfile.problemSolvingApproach = 'practical';
            else
                profile.cognitiveProfile.problemSolvingApproach = 'collaborative';
        }
    }
    updateContextAwareness(profile, behaviors) {
        const sceneFrequency = {};
        behaviors.forEach((behavior) => {
            if (behavior.context.scene) {
                sceneFrequency[behavior.context.scene] =
                    (sceneFrequency[behavior.context.scene] || 0) + 1;
            }
        });
        profile.contextAwareness.commonScenes = sceneFrequency;
        const deviceFrequency = {};
        behaviors.forEach((behavior) => {
            if (behavior.context.device) {
                deviceFrequency[behavior.context.device] =
                    (deviceFrequency[behavior.context.device] || 0) + 1;
            }
        });
        profile.contextAwareness.devicePreferences = deviceFrequency;
    }
    updateInteractionHistory(profile, behaviors) {
        profile.interactionHistory.totalInteractions = behaviors.length;
        const taskBehaviors = behaviors.filter((b) => b.type === 'task');
        profile.interactionHistory.successfulTasks = taskBehaviors.filter((b) => b.metadata.success === true).length;
        profile.interactionHistory.failedTasks = taskBehaviors.filter((b) => b.metadata.success === false).length;
        const satisfactionScores = behaviors
            .filter((b) => b.metadata.satisfaction)
            .map((b) => b.metadata.satisfaction);
        if (satisfactionScores.length > 0) {
            const totalSatisfaction = satisfactionScores.reduce((sum, score) => sum + score, 0);
            profile.interactionHistory.averageSatisfaction =
                totalSatisfaction / satisfactionScores.length;
        }
    }
    analyzeCommunicationStyle(profile, behaviors) {
        const interactionBehaviors = behaviors.filter((b) => b.type === 'interaction');
        if (interactionBehaviors.length === 0)
            return;
        let formalCount = 0;
        let casualCount = 0;
        let friendlyCount = 0;
        let professionalCount = 0;
        interactionBehaviors.forEach((behavior) => {
            const content = behavior.content.toLowerCase();
            if (content.includes('请') ||
                content.includes('您') ||
                content.includes('您好')) {
                formalCount++;
            }
            if (content.includes('嗨') ||
                content.includes('嘿') ||
                content.includes('哈')) {
                casualCount++;
            }
            if (content.includes('谢谢') ||
                content.includes('感谢') ||
                content.includes('好的')) {
                friendlyCount++;
            }
            if (content.includes('任务') ||
                content.includes('工作') ||
                content.includes('项目')) {
                professionalCount++;
            }
        });
        const maxStyle = Math.max(formalCount, casualCount, friendlyCount, professionalCount);
        if (maxStyle === formalCount)
            profile.preferences.communicationStyle = 'formal';
        else if (maxStyle === casualCount)
            profile.preferences.communicationStyle = 'casual';
        else if (maxStyle === friendlyCount)
            profile.preferences.communicationStyle = 'friendly';
        else
            profile.preferences.communicationStyle = 'professional';
        const contentLengths = interactionBehaviors.map((b) => b.content.length);
        const averageLength = contentLengths.reduce((sum, length) => sum + length, 0) /
            contentLengths.length;
        if (averageLength < 20)
            profile.preferences.responseLength = 'short';
        else if (averageLength < 100)
            profile.preferences.responseLength = 'medium';
        else
            profile.preferences.responseLength = 'long';
    }
    extractTopics(content) {
        const commonTopics = [
            '工作',
            '学习',
            '娱乐',
            '运动',
            '健康',
            '科技',
            '购物',
            '旅行',
            '美食',
            '社交',
            '家庭',
            '朋友',
            '音乐',
            '电影',
            '游戏',
            '阅读',
            '宠物',
            '汽车',
            '房子',
        ];
        const topics = [];
        const lowerContent = content.toLowerCase();
        commonTopics.forEach((topic) => {
            if (lowerContent.includes(topic.toLowerCase())) {
                topics.push(topic);
            }
        });
        return topics;
    }
    extractEmotionalTriggers(content) {
        const triggers = [
            '工作',
            '压力',
            '考试',
            '会议',
            ' deadline',
            '家人',
            '朋友',
            '健康',
            '金钱',
            '关系',
        ];
        const extractedTriggers = [];
        const lowerContent = content.toLowerCase();
        triggers.forEach((trigger) => {
            if (lowerContent.includes(trigger.toLowerCase())) {
                extractedTriggers.push(trigger);
            }
        });
        return extractedTriggers;
    }
    calculateProfileConfidence(profile, behaviors) {
        let confidence = 0.5;
        if (behaviors.length > 100)
            confidence += 0.2;
        else if (behaviors.length > 50)
            confidence += 0.1;
        const behaviorTypes = new Set(behaviors.map((b) => b.type));
        if (behaviorTypes.size >= 4)
            confidence += 0.1;
        else if (behaviorTypes.size >= 3)
            confidence += 0.05;
        const now = new Date();
        const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const recentBehaviors = behaviors.filter((b) => b.timestamp >= last30Days);
        if (recentBehaviors.length > 50)
            confidence += 0.1;
        return Math.min(1.0, confidence);
    }
    getProfile(userId) {
        return this.profiles.get(userId);
    }
    getAllProfiles() {
        return Array.from(this.profiles.values());
    }
    predictUserBehavior(userId, context) {
        const profile = this.profiles.get(userId);
        if (!profile)
            return [];
        const predictions = [];
        if (context.scene && profile.contextAwareness.commonScenes[context.scene]) {
            const sceneBehaviors = this.behaviorHistory.filter((b) => b.userId === userId && b.context.scene === context.scene);
            const activityFrequency = {};
            sceneBehaviors.forEach((b) => {
                activityFrequency[b.action] = (activityFrequency[b.action] || 0) + 1;
            });
            const topActivities = Object.entries(activityFrequency)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([action]) => action);
            predictions.push(...topActivities);
        }
        if (context.time) {
            const hour = context.time.getHours();
            const timeSlot = `${hour}:00-${hour + 1}:00`;
            const routineActivities = profile.behaviorPatterns.dailyRoutine[timeSlot];
            if (routineActivities) {
                predictions.push(...routineActivities.slice(0, 2));
            }
        }
        return [...new Set(predictions)];
    }
    getPersonalizedRecommendations(userId, context) {
        const profile = this.profiles.get(userId);
        if (!profile)
            return [];
        const recommendations = [];
        const topTopics = Object.entries(profile.preferences.topics)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([topic]) => topic);
        recommendations.push(...topTopics);
        const topActivities = Object.entries(profile.preferences.activities)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([activity]) => activity);
        recommendations.push(...topActivities);
        if (context.scene) {
            recommendations.push(`场景: ${context.scene}`);
        }
        return [...new Set(recommendations)];
    }
    startProfileUpdates() {
        this.updateTimer = setInterval(() => {
            for (const userId of this.profiles.keys()) {
                this.updateProfile(userId);
            }
        }, this.profileUpdateInterval);
        if (this.updateTimer.unref)
            this.updateTimer.unref();
        Logger_1.Logger.info('⏰ 启动用户画像定时更新', 'UserProfileSystem');
    }
    stopProfileUpdates() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }
        Logger_1.Logger.info('⏹️  停止用户画像定时更新', 'UserProfileSystem');
    }
    getStatistics() {
        const now = new Date();
        const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const activeUserIds = new Set(this.behaviorHistory
            .filter((b) => b.timestamp >= last7Days)
            .map((b) => b.userId));
        const totalConfidence = Array.from(this.profiles.values()).reduce((sum, profile) => sum + profile.metadata.confidenceScore, 0);
        const averageConfidence = this.profiles.size > 0 ? totalConfidence / this.profiles.size : 0;
        return {
            totalUsers: this.profiles.size,
            totalBehaviors: this.behaviorHistory.length,
            averageProfileConfidence: averageConfidence,
            activeUsers: activeUserIds.size,
        };
    }
    cleanupUser(userId) {
        this.profiles.delete(userId);
        this.behaviorHistory = this.behaviorHistory.filter((b) => b.userId !== userId);
        Logger_1.Logger.info(`🧹 清理用户 ${userId} 的数据`, 'UserProfileSystem');
    }
    cleanup() {
        this.profiles.clear();
        this.behaviorHistory = [];
        this.trendAnalyzer.clearMemoryDepths();
        this.stopProfileUpdates();
        Logger_1.Logger.info('🧹 清理用户画像系统数据', 'UserProfileSystem');
    }
    getMemoryDepth(userId) {
        return this.trendAnalyzer.getMemoryDepth(userId);
    }
    getPreferenceTrendAnalysis(userId) {
        return this.trendAnalyzer.getPreferenceTrendAnalysis(userId);
    }
    getBehaviorTrendAnalysis(userId) {
        return this.trendAnalyzer.getBehaviorTrendAnalysis(userId);
    }
    getEmotionalTrendAnalysis(userId) {
        return this.trendAnalyzer.getEmotionalTrendAnalysis(userId);
    }
    setTrendTrackingEnabled(enabled) {
        this.trendAnalyzer.setTrendTrackingEnabled(enabled);
    }
}
exports.UserProfileSystem = UserProfileSystem;
exports.default = UserProfileSystem;
