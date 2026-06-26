/**
 * 用户画像进化系统
 * 基于反馈记录和交互历史自动更新用户偏好，实现"越用越懂你"的核心能力
 *
 * 核心能力：
 * 1. 从工具使用模式学习用户偏好
 * 2. 从失败记录中识别用户期望
 * 3. 从成功模式中提取用户风格
 * 4. 跨会话持久化画像数据
 */

import * as fs from 'fs';
import * as path from 'path';
import { FeedbackRecord } from '../interfaces';
import { UserProfile, UserProfileSystem } from '../user/UserProfileSystem';
import { Logger } from '../utils/Logger';

/**
 * 带用户ID的反馈记录
 */
export interface UserFeedbackRecord extends FeedbackRecord {
  userId: string;
}

/**
 * 会话数据 — 用于学习用户使用模式
 */
export interface SessionData {
  userId: string;
  duration: number;
  tasksPerformed: string[];
  toolsUsed: string[];
  activityTimestamps: number[];
  resourcesAccessed: string[];
  sessionStart: number;
  sessionEnd: number;
}

/**
 * 预测结果
 */
export interface ActionPrediction {
  predictedAction: string;
  confidence: number;
  reasoning: string;
}

/**
 * 个性化推荐
 */
export interface PersonalizedRecommendation {
  type: string;
  description: string;
  confidence: number;
  action: string;
}

/**
 * 偏好进化数据
 */
export interface PreferenceEvolutionData {
  /** 用户ID */
  userId: string;
  /** 学习到的工具偏好 */
  toolPreferences: {
    toolName: string;
    usageCount: number;
    successRate: number;
    averageExecutionTime: number;
    lastUsed: number;
  }[];
  /** 学习到的场景偏好 */
  scenePreferences: {
    scene: string;
    frequency: number;
    successRate: number;
  }[];
  /** 学习到的沟通风格 */
  communicationStyle: {
    style: 'direct' | 'detailed' | 'casual' | 'formal';
    confidence: number;
    evidence: string[];
  };
  /** 学习到的响应长度偏好 */
  responseLengthPreference: {
    preferred: 'short' | 'medium' | 'long';
    confidence: number;
  };
  /** 学习到的交互时间模式 */
  interactionTimePatterns: {
    hourOfDay: number;
    frequency: number;
  }[];
  /** 上次更新时间 */
  lastUpdated: number;
  /** 学习置信度 (0-1) */
  learningConfidence: number;
}

/**
 * 用户画像进化系统
 */
export class ProfileEvolutionManager {
  private evolutionDataDir: string;
  private evolutionData: Map<string, PreferenceEvolutionData> = new Map();
  private feedbackRecords: UserFeedbackRecord[] = [];
  private userProfileSystem: UserProfileSystem;
  private updateInterval: number; // 毫秒
  private updateTimer: NodeJS.Timeout | null = null;
  private currentUserId: string;
  /** 会话模式历史 — key 为 userId */
  private sessionPatterns: Map<
    string,
    {
      sessions: SessionData[];
      taskFrequency: Map<string, number>;
      toolFrequency: Map<string, number>;
      hourFrequency: Map<number, number>;
    }
  > = new Map();

  constructor(
    userProfileSystem: UserProfileSystem,
    options: {
      dataDir?: string;
      updateInterval?: number; // 默认30分钟
      currentUserId?: string;
    } = {}
  ) {
    this.userProfileSystem = userProfileSystem;
    this.evolutionDataDir = options.dataDir || './data/profiles';
    this.updateInterval = options.updateInterval || 30 * 60 * 1000;
    this.currentUserId = options.currentUserId || 'default';
  }

  /**
   * 初始化进化系统
   */
  public async initialize(): Promise<void> {
    Logger.info('🧬 用户画像进化系统：初始化开始', 'ProfileEvolutionManager');

    // 确保数据目录存在
    if (!fs.existsSync(this.evolutionDataDir)) {
      fs.mkdirSync(this.evolutionDataDir, { recursive: true });
    }

    // 加载持久化的进化数据
    this.loadEvolutionData();

    // 启动定时更新
    this.startPeriodicUpdates();

    Logger.info('✅ 用户画像进化系统：初始化完成', 'ProfileEvolutionManager');
  }

  /**
   * 设置当前用户ID
   */
  public setCurrentUserId(userId: string): void {
    this.currentUserId = userId;
  }

  /**
   * 记录反馈数据用于学习
   */
  public recordFeedback(feedback: FeedbackRecord, userId?: string): void {
    const userFeedback: UserFeedbackRecord = {
      ...feedback,
      userId: userId || this.currentUserId,
    };

    this.feedbackRecords.push(userFeedback);

    // 限制记录数量
    if (this.feedbackRecords.length > 10000) {
      this.feedbackRecords = this.feedbackRecords.slice(-10000);
    }

    // 异步处理学习
    this.processLearning(userFeedback.userId);
  }

  /**
   * 批量记录反馈数据
   */
  public recordFeedbackBatch(
    feedbacks: FeedbackRecord[],
    userId?: string
  ): void {
    for (const feedback of feedbacks) {
      this.recordFeedback(feedback, userId);
    }
  }

  /**
   * 获取用户的进化数据
   */
  public getEvolutionData(userId: string): PreferenceEvolutionData | undefined {
    return this.evolutionData.get(userId);
  }

  /**
   * 更新用户画像基于学习到的偏好
   */
  public async updateUserProfile(
    userId: string
  ): Promise<UserProfile | undefined> {
    const evolutionData = this.evolutionData.get(userId);
    if (!evolutionData) {
      Logger.warn(
        `⚠️ 用户 ${userId} 无进化数据，无法更新画像`,
        'ProfileEvolutionManager'
      );
      return undefined;
    }

    // 获取当前用户画像
    let profile = this.userProfileSystem.getProfile(userId);
    if (!profile) {
      profile = this.userProfileSystem.createProfile(userId);
    }

    // 基于工具使用偏好更新活动偏好
    this.updateActivityPreferences(profile, evolutionData);

    // 基于场景使用更新场景感知
    this.updateContextAwareness(profile, evolutionData);

    // 更新沟通风格
    this.updateCommunicationStyle(profile, evolutionData);

    // 更新响应长度偏好
    this.updateResponseLengthPreference(profile, evolutionData);

    // 更新交互频率
    this.updateInteractionFrequency(profile, evolutionData);

    // 保存更新后的画像
    this.userProfileSystem.updateProfile(userId);

    Logger.info(
      `📊 用户画像已更新: ${userId} (置信度: ${evolutionData.learningConfidence.toFixed(2)})`,
      'ProfileEvolutionManager'
    );

    return profile;
  }

  /**
   * 处理学习逻辑
   */
  private processLearning(userId: string): void {
    const userFeedbacks = this.feedbackRecords.filter(
      (f) => f.userId === userId
    );
    if (userFeedbacks.length < 5) {
      // 数据量不足，暂不学习
      return;
    }

    // 获取或创建进化数据
    let evolutionData = this.evolutionData.get(userId);
    if (!evolutionData) {
      evolutionData = this.createDefaultEvolutionData(userId);
    }

    // 学习工具偏好
    this.learnToolPreferences(evolutionData, userFeedbacks);

    // 学习场景偏好
    this.learnScenePreferences(evolutionData, userFeedbacks);

    // 学习沟通风格
    this.learnCommunicationStyle(evolutionData, userFeedbacks);

    // 学习交互时间模式
    this.learnInteractionTimePatterns(evolutionData, userFeedbacks);

    // 更新学习置信度
    evolutionData.learningConfidence =
      this.calculateLearningConfidence(userFeedbacks);
    evolutionData.lastUpdated = Date.now();

    // 保存进化数据
    this.evolutionData.set(userId, evolutionData);
    this.saveEvolutionData(userId);
  }

  /**
   * 创建默认进化数据
   */
  private createDefaultEvolutionData(userId: string): PreferenceEvolutionData {
    return {
      userId,
      toolPreferences: [],
      scenePreferences: [],
      communicationStyle: {
        style: 'direct',
        confidence: 0.3,
        evidence: ['默认值'],
      },
      responseLengthPreference: {
        preferred: 'medium',
        confidence: 0.3,
      },
      interactionTimePatterns: [],
      lastUpdated: Date.now(),
      learningConfidence: 0.3,
    };
  }

  /**
   * 学习工具偏好
   */
  private learnToolPreferences(
    evolutionData: PreferenceEvolutionData,
    feedbacks: FeedbackRecord[]
  ): void {
    const toolStats: Record<
      string,
      { count: number; success: number; totalTime: number }
    > = {};

    for (const feedback of feedbacks) {
      for (const toolExec of feedback.toolExecutions) {
        if (!toolStats[toolExec.toolName]) {
          toolStats[toolExec.toolName] = { count: 0, success: 0, totalTime: 0 };
        }
        toolStats[toolExec.toolName].count++;
        if (toolExec.success) {
          toolStats[toolExec.toolName].success++;
        }
        toolStats[toolExec.toolName].totalTime += toolExec.executionTime;
      }
    }

    // 更新进化数据
    evolutionData.toolPreferences = Object.entries(toolStats).map(
      ([toolName, stats]) => ({
        toolName,
        usageCount: stats.count,
        successRate: stats.count > 0 ? stats.success / stats.count : 0,
        averageExecutionTime:
          stats.count > 0 ? stats.totalTime / stats.count : 0,
        lastUsed: Date.now(),
      })
    );

    // 按使用频率排序
    evolutionData.toolPreferences.sort((a, b) => b.usageCount - a.usageCount);
  }

  /**
   * 学习场景偏好
   */
  private learnScenePreferences(
    evolutionData: PreferenceEvolutionData,
    feedbacks: FeedbackRecord[]
  ): void {
    const sceneStats: Record<string, { count: number; success: number }> = {};

    for (const feedback of feedbacks) {
      const scene = feedback.scene || 'unknown';
      if (!sceneStats[scene]) {
        sceneStats[scene] = { count: 0, success: 0 };
      }
      sceneStats[scene].count++;
      if (feedback.isSuccess) {
        sceneStats[scene].success++;
      }
    }

    // 更新进化数据
    evolutionData.scenePreferences = Object.entries(sceneStats).map(
      ([scene, stats]) => ({
        scene,
        frequency: stats.count,
        successRate: stats.count > 0 ? stats.success / stats.count : 0,
      })
    );

    // 按频率排序
    evolutionData.scenePreferences.sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * 学习沟通风格
   */
  private learnCommunicationStyle(
    evolutionData: PreferenceEvolutionData,
    feedbacks: FeedbackRecord[]
  ): void {
    // 基于输入长度和内容分析沟通风格
    const inputLengths = feedbacks.map((f) => f.inputText.length);
    const avgLength =
      inputLengths.reduce((sum, len) => sum + len, 0) / inputLengths.length;

    let style: 'direct' | 'detailed' | 'casual' | 'formal';
    let confidence: number;

    if (avgLength < 20) {
      style = 'direct';
      confidence = 0.7;
    } else if (avgLength < 100) {
      style = 'casual';
      confidence = 0.6;
    } else {
      style = 'detailed';
      confidence = 0.7;
    }

    evolutionData.communicationStyle = {
      style,
      confidence,
      evidence: [`平均输入长度: ${avgLength.toFixed(0)} 字符`],
    };
  }

  /**
   * 学习交互时间模式
   */
  private learnInteractionTimePatterns(
    evolutionData: PreferenceEvolutionData,
    feedbacks: FeedbackRecord[]
  ): void {
    const hourStats: Record<number, number> = {};

    for (const feedback of feedbacks) {
      const hour = new Date(feedback.timestamp).getHours();
      hourStats[hour] = (hourStats[hour] || 0) + 1;
    }

    evolutionData.interactionTimePatterns = Object.entries(hourStats).map(
      ([hour, count]) => ({
        hourOfDay: parseInt(hour),
        frequency: count,
      })
    );

    // 按频率排序
    evolutionData.interactionTimePatterns.sort(
      (a, b) => b.frequency - a.frequency
    );
  }

  /**
   * 计算学习置信度
   */
  private calculateLearningConfidence(feedbacks: FeedbackRecord[]): number {
    if (feedbacks.length < 5) return 0.2;
    if (feedbacks.length < 20) return 0.4;
    if (feedbacks.length < 50) return 0.6;
    if (feedbacks.length < 100) return 0.8;
    return 0.95;
  }

  /**
   * 基于工具偏好更新活动偏好
   */
  private updateActivityPreferences(
    profile: UserProfile,
    evolutionData: PreferenceEvolutionData
  ): void {
    for (const toolPref of evolutionData.toolPreferences.slice(0, 5)) {
      profile.preferences.activities[toolPref.toolName] = Math.min(
        1,
        toolPref.usageCount / 10
      );
    }
  }

  /**
   * 基于场景使用更新场景感知
   */
  private updateContextAwareness(
    profile: UserProfile,
    evolutionData: PreferenceEvolutionData
  ): void {
    for (const scenePref of evolutionData.scenePreferences.slice(0, 5)) {
      profile.contextAwareness.commonScenes[scenePref.scene] = Math.min(
        1,
        scenePref.frequency / 10
      );
    }
  }

  /**
   * 更新沟通风格
   */
  private updateCommunicationStyle(
    profile: UserProfile,
    evolutionData: PreferenceEvolutionData
  ): void {
    const styleMap: Record<
      string,
      'formal' | 'casual' | 'friendly' | 'professional'
    > = {
      direct: 'casual',
      detailed: 'professional',
      casual: 'friendly',
      formal: 'formal',
    };

    profile.preferences.communicationStyle =
      styleMap[evolutionData.communicationStyle.style] || 'friendly';
  }

  /**
   * 更新响应长度偏好
   */
  private updateResponseLengthPreference(
    profile: UserProfile,
    evolutionData: PreferenceEvolutionData
  ): void {
    profile.preferences.responseLength =
      evolutionData.responseLengthPreference.preferred;
  }

  /**
   * 更新交互频率
   */
  private updateInteractionFrequency(
    profile: UserProfile,
    evolutionData: PreferenceEvolutionData
  ): void {
    // 计算每日交互频率
    const totalDays = Math.max(
      1,
      Math.ceil(
        (Date.now() - evolutionData.lastUpdated) / (24 * 60 * 60 * 1000)
      )
    );
    const totalInteractions = evolutionData.toolPreferences.reduce(
      (sum, pref) => sum + pref.usageCount,
      0
    );

    profile.behaviorPatterns.interactionFrequency =
      totalInteractions / totalDays;

    // 更新偏好时间段
    profile.behaviorPatterns.preferredTimeSlots =
      evolutionData.interactionTimePatterns
        .slice(0, 5)
        .map((p) => `${p.hourOfDay}:00`);
  }

  /**
   * 启动定时更新
   */
  private startPeriodicUpdates(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    this.updateTimer = setInterval(async () => {
      const userIds = Array.from(this.evolutionData.keys());
      for (const userId of userIds) {
        try {
          await this.updateUserProfile(userId);
        } catch (error) {
          Logger.error(
            `❌ 更新用户画像失败: ${userId}`,
            error as Error,
            'ProfileEvolutionManager'
          );
        }
      }
    }, this.updateInterval);

    Logger.info(
      `⏰ 定时更新已启动 (间隔: ${this.updateInterval / 60000} 分钟)`,
      'ProfileEvolutionManager'
    );
  }

  /**
   * 保存进化数据
   */
  private saveEvolutionData(userId: string): void {
    const evolutionData = this.evolutionData.get(userId);
    if (!evolutionData) return;

    const filePath = path.join(
      this.evolutionDataDir,
      `${userId}_evolution.json`
    );
    try {
      fs.writeFileSync(
        filePath,
        JSON.stringify(evolutionData, null, 2),
        'utf-8'
      );
    } catch (error) {
      Logger.error(
        `❌ 保存进化数据失败: ${userId}`,
        error as Error,
        'ProfileEvolutionManager'
      );
    }
  }

  /**
   * 加载进化数据
   */
  private loadEvolutionData(): void {
    try {
      const files = fs.readdirSync(this.evolutionDataDir);
      for (const file of files) {
        if (file.endsWith('_evolution.json')) {
          const userId = file.replace('_evolution.json', '');
          const filePath = path.join(this.evolutionDataDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(content) as PreferenceEvolutionData;
          this.evolutionData.set(userId, data);
        }
      }
      Logger.info(
        `📂 加载了 ${this.evolutionData.size} 个用户的进化数据`,
        'ProfileEvolutionManager'
      );
    } catch (error) {
      Logger.error(
        '❌ 加载进化数据失败',
        error as Error,
        'ProfileEvolutionManager'
      );
    }
  }

  /**
   * 关闭进化系统
   */
  public shutdown(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    // 保存所有进化数据
    for (const userId of this.evolutionData.keys()) {
      this.saveEvolutionData(userId);
    }

    Logger.info('🔌 用户画像进化系统已关闭', 'ProfileEvolutionManager');
  }

  /**
   * 获取系统统计信息
   */
  public getStatistics(): {
    totalUsers: number;
    totalFeedbackRecords: number;
    averageLearningConfidence: number;
  } {
    const totalConfidence = Array.from(this.evolutionData.values()).reduce(
      (sum, data) => sum + data.learningConfidence,
      0
    );

    return {
      totalUsers: this.evolutionData.size,
      totalFeedbackRecords: this.feedbackRecords.length,
      averageLearningConfidence:
        this.evolutionData.size > 0
          ? totalConfidence / this.evolutionData.size
          : 0,
    };
  }

  /**
   * 学习使用模式 — 从会话数据中提取用户行为模式
   */
  learnUsagePattern(userId: string, sessionData: SessionData): void {
    if (!this.sessionPatterns.has(userId)) {
      this.sessionPatterns.set(userId, {
        sessions: [],
        taskFrequency: new Map(),
        toolFrequency: new Map(),
        hourFrequency: new Map(),
      });
    }

    const patterns = this.sessionPatterns.get(userId)!;
    patterns.sessions.push(sessionData);

    // 统计任务频率
    for (const task of sessionData.tasksPerformed) {
      patterns.taskFrequency.set(
        task,
        (patterns.taskFrequency.get(task) || 0) + 1
      );
    }

    // 统计工具频率
    for (const tool of sessionData.toolsUsed) {
      patterns.toolFrequency.set(
        tool,
        (patterns.toolFrequency.get(tool) || 0) + 1
      );
    }

    // 统计活跃时段
    for (const ts of sessionData.activityTimestamps) {
      const hour = new Date(ts).getHours();
      patterns.hourFrequency.set(
        hour,
        (patterns.hourFrequency.get(hour) || 0) + 1
      );
    }
  }

  /**
   * 预测下一个动作 — 基于历史模式
   */
  predictNextAction(userId: string): ActionPrediction | null {
    const patterns = this.sessionPatterns.get(userId);
    if (!patterns || patterns.sessions.length < 2) {
      return null;
    }

    // 找出最频繁的任务
    let topTask = '';
    let topTaskCount = 0;
    for (const [task, count] of patterns.taskFrequency) {
      if (count > topTaskCount) {
        topTask = task;
        topTaskCount = count;
      }
    }

    if (!topTask) {
      return null;
    }

    const totalSessions = patterns.sessions.length;
    const confidence = Math.min(0.95, (topTaskCount / totalSessions) * 0.8);

    return {
      predictedAction: topTask,
      confidence,
      reasoning: `基于 ${totalSessions} 次会话历史，"${topTask}" 出现频率最高 (${topTaskCount} 次)`,
    };
  }

  /**
   * 获取个性化推荐 — 基于学习到的使用模式
   */
  getPersonalizedRecommendations(userId: string): PersonalizedRecommendation[] {
    const patterns = this.sessionPatterns.get(userId);
    if (!patterns || patterns.sessions.length === 0) {
      return [];
    }

    const recommendations: PersonalizedRecommendation[] = [];

    // 基于最常用任务推荐
    const sortedTasks = Array.from(patterns.taskFrequency.entries()).sort(
      (a, b) => b[1] - a[1]
    );

    if (sortedTasks.length > 0 && sortedTasks[0][1] >= 2) {
      const [task, count] = sortedTasks[0];
      recommendations.push({
        type: 'task',
        description: `您经常执行 "${task}" 任务，建议创建快捷方式`,
        confidence: Math.min(0.9, count / patterns.sessions.length),
        action: `create_shortcut:${task}`,
      });
    }

    // 基于最常用工具推荐
    const sortedTools = Array.from(patterns.toolFrequency.entries()).sort(
      (a, b) => b[1] - a[1]
    );

    if (sortedTools.length > 0 && sortedTools[0][1] >= 2) {
      const [tool, count] = sortedTools[0];
      recommendations.push({
        type: 'tool',
        description: `您频繁使用 "${tool}"，建议配置为默认工具`,
        confidence: Math.min(0.9, count / patterns.sessions.length),
        action: `set_default_tool:${tool}`,
      });
    }

    // 基于活跃时段推荐
    const sortedHours = Array.from(patterns.hourFrequency.entries()).sort(
      (a, b) => b[1] - a[1]
    );

    if (sortedHours.length > 0 && sortedHours[0][1] >= 2) {
      const [hour, count] = sortedHours[0];
      recommendations.push({
        type: 'schedule',
        description: `您在 ${hour}:00 时段最活跃，建议安排重要任务`,
        confidence: Math.min(0.85, count / patterns.sessions.length),
        action: `schedule_around:${hour}`,
      });
    }

    return recommendations;
  }
}
