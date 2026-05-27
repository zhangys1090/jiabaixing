/**
 * 统一上下文管道 v2
 * 三重组合架构核心：数据主权 × 记忆深度 × 主动关怀的集成枢纽
 * 所有交互（主动/被动）都经过此管道构建上下文
 * 确保记忆深度被充分利用，同时数据访问经过主权审计
 *
 * v2 优化：
 * 1. 集成 LLMContextBuilder 进行智能记忆筛选
 * 2. 传递真实相关性分数（非固定 0.5）
 * 3. 场景感知记忆权重
 * 4. 记忆去重与压缩
 */

import { MemoryEngine } from '../memory/MemoryEngine';
import { DataSovereigntyPipeline } from '../security/DataSovereigntyPipeline';
import { LLMContextBuilder } from '../memory/LLMContextBuilder';
import { Logger } from '../utils/Logger';

export interface UnifiedContext {
  scene: string;
  emotion: {
    type: string;
    intensity: number;
  };
  memories: Array<{
    content: string;
    relevance: number;
    timestamp: string;
    type: string;
  }>;
  userProfile: {
    name: string;
    preferences: string[];
    emotionalPatterns: Array<{ type: string; frequency: number }>;
    recentTriggers: string[];
  };
  timeContext: {
    hour: number;
    timeSlot: string;
    dayOfWeek: string;
  };
  sovereigntyScore: number;
}

export class UnifiedContextPipeline {
  private memoryEngine: MemoryEngine | null = null;
  private sovereigntyPipeline: DataSovereigntyPipeline | null = null;
  private contextBuilder: LLMContextBuilder;

  constructor() {
    this.contextBuilder = new LLMContextBuilder({
      maxMemories: 8,
      minRelevance: 0.15,
      maxTotalLength: 2000,
      enableDeduplication: true,
      enableCompression: true,
    });
  }

  public setMemoryEngine(engine: MemoryEngine): void {
    this.memoryEngine = engine;
  }

  public setSovereigntyPipeline(pipeline: DataSovereigntyPipeline): void {
    this.sovereigntyPipeline = pipeline;
  }

  public async buildContext(
    input: string,
    userId: string
  ): Promise<UnifiedContext> {
    const startTime = Date.now();

    const scene = this.detectScene(input);
    const emotion = this.detectEmotion(input);
    const timeContext = this.buildTimeContext();

    const memories = await this.retrieveMemories(input, scene, emotion.type);
    const userProfile = this.buildUserProfile(userId);
    const sovereigntyScore = this.getSovereigntyScore();

    const context: UnifiedContext = {
      scene,
      emotion,
      memories,
      userProfile,
      timeContext,
      sovereigntyScore,
    };

    this.auditContextAccess(input, context);

    const elapsed = Date.now() - startTime;
    Logger.info(
      `📊 统一上下文构建完成: 场景=${scene}, 情绪=${emotion.type}, 记忆=${memories.length}条, 耗时=${elapsed}ms`,
      'UnifiedContextPipeline'
    );

    return context;
  }

  public async buildProactiveContext(
    triggerReason: string
  ): Promise<UnifiedContext> {
    const startTime = Date.now();

    const timeContext = this.buildTimeContext();
    const scene = this.inferSceneFromTime(timeContext);
    const emotion = { type: '平静', intensity: 2 };

    const memories = await this.retrieveProactiveMemories(triggerReason, scene);
    const userProfile = this.buildUserProfile('default');
    const sovereigntyScore = this.getSovereigntyScore();

    const context: UnifiedContext = {
      scene,
      emotion,
      memories,
      userProfile,
      timeContext,
      sovereigntyScore,
    };

    this.auditContextAccess(`proactive:${triggerReason}`, context);

    const elapsed = Date.now() - startTime;
    Logger.info(
      `📊 主动上下文构建完成: 触发=${triggerReason}, 场景=${scene}, 记忆=${memories.length}条, 耗时=${elapsed}ms`,
      'UnifiedContextPipeline'
    );

    return context;
  }

  private detectScene(input: string): string {
    const patterns: Array<{ type: string; keywords: string[] }> = [
      {
        type: 'development',
        keywords: ['代码', '编程', '开发', 'bug', '调试', '重构', '优化'],
      },
      {
        type: 'work',
        keywords: ['任务', '项目', '进度', '汇报', '会议', 'deadline'],
      },
      {
        type: 'comfort',
        keywords: ['难过', '累', '烦', '压力', '焦虑', '担心', '害怕'],
      },
      {
        type: 'greeting',
        keywords: ['你好', '早上好', '晚上好', '嗨', 'hello'],
      },
      {
        type: 'celebration',
        keywords: ['成功', '完成', '搞定', '太好了', '恭喜'],
      },
    ];

    const lower = input.toLowerCase();
    let bestScene = 'daily';
    let bestScore = 0;

    for (const pattern of patterns) {
      const matched = pattern.keywords.filter((k) => lower.includes(k)).length;
      const score = matched / pattern.keywords.length;
      if (score > bestScore) {
        bestScore = score;
        bestScene = pattern.type;
      }
    }

    return bestScene;
  }

  private detectEmotion(input: string): { type: string; intensity: number } {
    const emotionPatterns: Array<{
      type: string;
      keywords: string[];
      intensity: number;
    }> = [
      {
        type: '焦虑',
        keywords: ['焦虑', '担心', '害怕', '不安', '紧张'],
        intensity: 5,
      },
      {
        type: '悲伤',
        keywords: ['难过', '伤心', '悲伤', '哭', '失落'],
        intensity: 6,
      },
      {
        type: '烦躁',
        keywords: ['烦', '恼火', '生气', '愤怒', '受不了'],
        intensity: 5,
      },
      {
        type: '疲惫',
        keywords: ['累', '疲惫', '困', '没精神', '乏力'],
        intensity: 4,
      },
      {
        type: '兴奋',
        keywords: ['开心', '高兴', '兴奋', '太好了', '棒'],
        intensity: 5,
      },
    ];

    for (const pattern of emotionPatterns) {
      if (pattern.keywords.some((k) => input.includes(k))) {
        return { type: pattern.type, intensity: pattern.intensity };
      }
    }

    return { type: '平静', intensity: 2 };
  }

  private buildTimeContext(): UnifiedContext['timeContext'] {
    const now = new Date();
    const hour = now.getHours();
    const timeSlot =
      hour >= 6 && hour < 12
        ? '上午'
        : hour >= 12 && hour < 18
          ? '下午'
          : hour >= 18 && hour < 23
            ? '晚上'
            : '深夜';

    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    return {
      hour,
      timeSlot,
      dayOfWeek: dayNames[now.getDay()],
    };
  }

  private inferSceneFromTime(
    timeContext: UnifiedContext['timeContext']
  ): string {
    if (timeContext.timeSlot === '深夜') return 'comfort';
    if (timeContext.hour >= 7 && timeContext.hour < 10) return 'briefing';
    if (timeContext.hour >= 18 && timeContext.hour < 21) return 'daily';
    return 'daily';
  }

  /**
   * v2: 使用 LLMContextBuilder 进行智能记忆筛选
   */
  private async retrieveMemories(
    input: string,
    scene: string,
    emotion: string
  ): Promise<UnifiedContext['memories']> {
    if (!this.memoryEngine) return [];

    try {
      // 1. 检索原始记忆
      const items = await this.memoryEngine.preciseHybridRetrieval(
        input,
        scene,
        emotion,
        20 // 检索更多，让 LLMContextBuilder 筛选
      );

      // 2. 使用 LLMContextBuilder 智能筛选
      const builtContext = this.contextBuilder.buildContext(
        input,
        items,
        scene,
        emotion
      );

      // 3. 转换为 UnifiedContext 格式
      return builtContext.memories.map((sm) => ({
        content:
          typeof sm.memory.content === 'string'
            ? sm.memory.content
            : JSON.stringify(sm.memory.content),
        relevance: Math.round(sm.compositeScore * 100) / 100,
        timestamp:
          sm.memory.timestamp?.toISOString() || new Date().toISOString(),
        type: sm.memory.type,
      }));
    } catch (error) {
      Logger.error('记忆检索失败', error as Error, 'UnifiedContextPipeline');
      return [];
    }
  }

  /**
   * v2: 主动记忆检索也使用智能筛选
   */
  private async retrieveProactiveMemories(
    triggerReason: string,
    scene: string
  ): Promise<UnifiedContext['memories']> {
    if (!this.memoryEngine) return [];

    try {
      const queryMap: Record<string, string> = {
        morning_greeting: '今天 日程 待办',
        evening_checkin: '今天 完成 进展',
        late_night: '休息 睡眠 明天',
        long_silence: '最近 关注 话题',
        negative_emotion_trend: '情绪 最近 状态',
      };

      const query = queryMap[triggerReason] || '最近 关注';
      const items = await this.memoryEngine.preciseHybridRetrieval(
        query,
        scene,
        undefined,
        15
      );

      // 使用 LLMContextBuilder 筛选
      const builtContext = this.contextBuilder.buildContext(
        query,
        items,
        scene,
        '平静'
      );

      return builtContext.memories.map((sm) => ({
        content:
          typeof sm.memory.content === 'string'
            ? sm.memory.content
            : JSON.stringify(sm.memory.content),
        relevance: Math.round(sm.compositeScore * 100) / 100,
        timestamp:
          sm.memory.timestamp?.toISOString() || new Date().toISOString(),
        type: sm.memory.type,
      }));
    } catch (error) {
      Logger.error(
        '主动记忆检索失败',
        error as Error,
        'UnifiedContextPipeline'
      );
      return [];
    }
  }

  private buildUserProfile(_userId?: string): UnifiedContext['userProfile'] {
    if (!this.memoryEngine) {
      return {
        name: '',
        preferences: [],
        emotionalPatterns: [],
        recentTriggers: [],
      };
    }

    try {
      const profile = this.memoryEngine.getUserProfile();
      const basicInfo = profile.getBasicInfo();
      const devHabits = profile.getDevelopmentHabits();
      const emotionalPatterns = profile.getEmotionalPatterns();

      const preferences: string[] = [
        ...(devHabits.preferredLanguages || []),
        ...(devHabits.preferredFrameworks || []),
      ];

      const patterns = (emotionalPatterns.commonEmotions || []).map((e) => ({
        type: e.type,
        frequency: e.frequency,
      }));

      const recentTriggers = (emotionalPatterns.triggerEvents || [])
        .slice(0, 5)
        .map((t) => `${t.emotionType}@${t.timeSlot}`);

      return {
        name: basicInfo.name || '',
        preferences,
        emotionalPatterns: patterns,
        recentTriggers,
      };
    } catch (error) {
      Logger.error(
        '用户画像构建失败',
        error as Error,
        'UnifiedContextPipeline'
      );
      return {
        name: '',
        preferences: [],
        emotionalPatterns: [],
        recentTriggers: [],
      };
    }
  }

  private getSovereigntyScore(): number {
    if (!this.sovereigntyPipeline) return 100;
    try {
      const report = this.sovereigntyPipeline.generateReport();
      return report.sovereigntyScore;
    } catch {
      return 100;
    }
  }

  private auditContextAccess(input: string, _context?: UnifiedContext): void {
    if (!this.sovereigntyPipeline) return;

    this.sovereigntyPipeline.recordAccess({
      timestamp: new Date().toISOString(),
      dataType: 'memory',
      operation: 'read',
      purpose: `构建交互上下文: ${input.substring(0, 50)}`,
      source: 'UnifiedContextPipeline',
      target: 'MemoryEngine+UserProfile',
      dataSize: input.length,
      isLocal: true,
    });
  }
}
