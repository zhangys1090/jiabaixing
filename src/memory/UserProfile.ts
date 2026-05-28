/**
 * 用户画像系统 v2 - 精简版
 * 构建用户的基础信息、开发习惯、生活偏好、情绪模式、任务偏好五大维度画像
 * 优化：批量异步处理 + 防抖保存 + 关键词索引缓存
 */

import * as path from 'path';
import { EmotionTag, PersonaScene, SceneTag } from '../interfaces';
import { FileSystem } from '../io/FileSystem';
import { Logger } from '../utils/Logger';

const fileSystem = FileSystem.getInstance();

// 预编译的关键词索引 - 已精简
const _FOOD_KEYWORDS = new Set([
  '火锅',
  '烧烤',
  '日料',
  '西餐',
  '中餐',
  '咖啡',
  '奶茶',
  '甜品',
  '素食',
  '辣',
  '清淡',
  '外卖',
  '做饭',
  '烹饪',
]);
const _EXERCISE_KEYWORDS = new Set([
  '跑步',
  '游泳',
  '健身',
  '瑜伽',
  '篮球',
  '足球',
  '骑行',
  '散步',
  '爬山',
  '网球',
  '羽毛球',
  '运动',
]);
const _ENTERTAINMENT_KEYWORDS = new Set([
  '电影',
  '音乐',
  '游戏',
  '看书',
  '阅读',
  '追剧',
  '综艺',
  '动漫',
  '摄影',
  '画画',
  '旅行',
  '冥想',
]);
const _LANGUAGE_KEYWORDS = new Set([
  'javascript',
  'typescript',
  'python',
  'java',
  'go',
  'c++',
  'c#',
  'rust',
  'php',
  'ruby',
  'swift',
  'kotlin',
]);
const _FRAMEWORK_KEYWORDS = new Set([
  'react',
  'angular',
  'vue',
  'node.js',
  'express',
  'django',
  'spring',
  'flask',
  'laravel',
  'symfony',
  'asp.net',
  'next.js',
  'nuxt.js',
  'svelte',
]);
const _PROJECT_STRUCTURE_KEYWORDS = new Set([
  'src',
  'components',
  'utils',
  'api',
  'views',
  'pages',
  'services',
  'models',
  'controllers',
  'routes',
  'middlewares',
  'config',
  'assets',
]);
const _TOOL_KEYWORDS = new Set([
  'vscode',
  'intellij',
  'sublime',
  'vim',
  'emacs',
  'git',
  'docker',
  'npm',
  'yarn',
  'pip',
  'maven',
  'gradle',
]);
const CODE_ORGANIZATION_MAP: Record<string, string> = {
  modular: 'modular',
  functional: 'functional',
  'object-oriented': 'object-oriented',
  'component-based': 'component-based',
  'service-oriented': 'service-oriented',
};
const TESTING_APPROACH_MAP: Record<string, string> = {
  'unit-testing': 'unit-testing',
  'integration-testing': 'integration-testing',
  'end-to-end-testing': 'end-to-end-testing',
  tdd: 'tdd',
  bdd: 'bdd',
};
const DOCUMENTATION_STYLE_MAP: Record<string, string> = {
  jsdoc: 'jsdoc',
  tsdoc: 'tsdoc',
  docstring: 'docstring',
  markdown: 'markdown',
  swagger: 'swagger',
};
const VERSION_CONTROL_MAP: Record<string, string> = {
  git: 'git',
  svn: 'svn',
  mercurial: 'mercurial',
};
const DEPLOYMENT_MAP: Record<string, string> = {
  continuous: 'continuous',
  manual: 'manual',
  'ci/cd': 'ci/cd',
  docker: 'docker',
  kubernetes: 'kubernetes',
};
const PERFORMANCE_MAP: Record<string, string> = {
  profiling: 'profiling',
  caching: 'caching',
  optimization: 'optimization',
  benchmarking: 'benchmarking',
};
const SECURITY_MAP: Record<string, string> = {
  owasp: 'owasp',
  security: 'security',
  encryption: 'encryption',
  authentication: 'authentication',
};
const CODE_REVIEW_MAP: Record<string, string> = {
  'pull-request': 'pull-request',
  'code-review': 'code-review',
  'peer-review': 'peer-review',
};

/**
 * 用户基础信息
 */
export interface BasicInfo {
  userId: string;
  name: string;
  age?: number;
  gender?: string;
  location?: string;
  timezone?: string;
  language: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 开发习惯信息
 */
export interface DevelopmentHabits {
  preferredLanguages: string[]; // 偏好的编程语言
  preferredFrameworks: string[]; // 偏好的框架
  codingStyle: Record<string, unknown>; // 代码风格偏好
  commonTools: string[]; // 常用工具
  workingHours: { start: number; end: number }; // 工作时间
  debuggingApproach: string; // 调试方法偏好
  projectStructure: string[]; // 项目结构偏好
  codeOrganization: string; // 代码组织方式
  testingApproach: string; // 测试方法偏好
  documentationStyle: string; // 文档风格
  versionControl: string; // 版本控制偏好
  deploymentProcess: string; // 部署流程
  codeReviewProcess: string; // 代码审查流程
  performanceOptimization: string; // 性能优化方法
  securityPractices: string; // 安全实践
}

/**
 * 生活偏好信息
 */
export interface LifePreferences {
  dietaryPreferences: string[]; // 饮食偏好
  exerciseHabits: string[]; // 运动习惯
  sleepSchedule: { bedtime: number; wakeup: number }; // 睡眠时间表
  entertainmentPreferences: string[]; // 娱乐偏好
  travelPreferences: Record<string, unknown>;
  shoppingPreferences: Record<string, unknown>;
}

/**
 * 情绪模式信息
 */
export interface EmotionalPatterns {
  commonEmotions: { type: string; frequency: number }[]; // 常见情绪及频率
  triggerEvents: { emotionType: string; timeSlot: string; frequency: number }[];
  comfortStrategies: {
    emotionType: string;
    strategy: string;
    effectiveness: number;
  }[];
  stressThreshold: number; // 压力阈值
  emotionalResilience: number; // 情绪弹性
}

/**
 * 任务偏好信息
 */
export interface TaskPreferences {
  priorityOrder: string[]; // 任务优先级排序
  preferredWorkStyle: string; // 偏好的工作方式（专注/多任务）
  deadlineApproach: string; // 截止日期处理方式
  collaborationPreference: string; // 协作偏好
  taskComplexityPreference: string; // 任务复杂度偏好
}

/**
 * 用户画像更新数据
 */
export interface UserProfileUpdateData {
  emotion?: EmotionTag;
  scene?: SceneTag;
  input?: string;
  timestamp: Date;
}

/**
 * 用户画像类 v2
 * 优化：防抖保存 + 批量处理 + 关键词索引缓存
 */
export class UserProfile {
  private basicInfo: BasicInfo;
  private developmentHabits: DevelopmentHabits;
  private lifePreferences: LifePreferences;
  private emotionalPatterns: EmotionalPatterns;
  private taskPreferences: TaskPreferences;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000; // 5秒防抖
  private pendingUpdates = 0;

  constructor() {
    // 初始化默认值
    this.basicInfo = {
      userId: `user_${Date.now()}`,
      name: '',
      language: 'zh-CN',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.developmentHabits = {
      preferredLanguages: [],
      preferredFrameworks: [],
      codingStyle: {},
      commonTools: [],
      workingHours: { start: 9, end: 18 },
      debuggingApproach: 'systematic',
      projectStructure: ['src', 'components', 'utils', 'api', 'views'],
      codeOrganization: 'modular',
      testingApproach: 'unit-testing',
      documentationStyle: 'jsdoc',
      versionControl: 'git',
      deploymentProcess: 'continuous',
      codeReviewProcess: 'pull-request',
      performanceOptimization: 'profiling',
      securityPractices: 'owasp',
    };

    this.lifePreferences = {
      dietaryPreferences: [],
      exerciseHabits: [],
      sleepSchedule: { bedtime: 23, wakeup: 7 },
      entertainmentPreferences: [],
      travelPreferences: {},
      shoppingPreferences: {},
    };

    this.emotionalPatterns = {
      commonEmotions: [],
      triggerEvents: [],
      comfortStrategies: [],
      stressThreshold: 7,
      emotionalResilience: 6,
    };

    this.taskPreferences = {
      priorityOrder: [
        'urgent-important',
        'important-not-urgent',
        'urgent-not-important',
        'not-urgent-not-important',
      ],
      preferredWorkStyle: 'focused',
      deadlineApproach: 'early',
      collaborationPreference: 'independent',
      taskComplexityPreference: 'balanced',
    };
  }

  private getProfilePath(): string {
    return path.join(process.cwd(), 'data', 'user_profile.json');
  }

  /**
   * 加载用户画像
   */
  public async load(): Promise<void> {
    try {
      const profilePath = this.getProfilePath();
      const exists = await fileSystem.exists(profilePath);
      if (exists) {
        const data = await fileSystem.readJson<{
          basicInfo?: BasicInfo;
          developmentHabits?: DevelopmentHabits;
          lifePreferences?: LifePreferences;
          emotionalPatterns?: EmotionalPatterns;
          taskPreferences?: TaskPreferences;
        }>(profilePath);
        if (data.basicInfo)
          this.basicInfo = { ...this.basicInfo, ...data.basicInfo };
        if (data.developmentHabits)
          this.developmentHabits = {
            ...this.developmentHabits,
            ...data.developmentHabits,
          };
        if (data.lifePreferences)
          this.lifePreferences = {
            ...this.lifePreferences,
            ...data.lifePreferences,
          };
        if (data.emotionalPatterns)
          this.emotionalPatterns = {
            ...this.emotionalPatterns,
            ...data.emotionalPatterns,
          };
        if (data.taskPreferences)
          this.taskPreferences = {
            ...this.taskPreferences,
            ...data.taskPreferences,
          };
        Logger.info(
          `👤 用户画像已加载: 名字=${this.basicInfo.name || '未设置'}`,
          'UserProfile'
        );
      }
    } catch {
      Logger.warn('⚠️ 加载用户画像失败，使用默认值', 'UserProfile');
    }
  }

  /**
   * 立即保存用户画像（内部使用）
   */
  private async doSave(): Promise<void> {
    try {
      const profilePath = this.getProfilePath();
      const data = {
        basicInfo: this.basicInfo,
        developmentHabits: this.developmentHabits,
        lifePreferences: this.lifePreferences,
        emotionalPatterns: this.emotionalPatterns,
        taskPreferences: this.taskPreferences,
      };
      await fileSystem.writeJson(profilePath, data);
      this.pendingUpdates = 0;
      Logger.debug(
        `💾 用户画像已保存: 名字=${this.basicInfo.name || '未设置'}`,
        'UserProfile'
      );
    } catch {
      Logger.warn('⚠️ 保存用户画像失败', 'UserProfile');
    }
  }

  /**
   * 防抖保存用户画像
   */
  public async save(): Promise<void> {
    this.pendingUpdates++;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.doSave();
      this.saveTimer = null;
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * 更新用户画像
   */
  public async update(data: UserProfileUpdateData): Promise<void> {
    this.basicInfo.updatedAt = new Date();

    let needsSave = false;

    if (data.input) {
      const previousName = this.basicInfo.name;
      this.extractUserName(data.input);
      if (this.basicInfo.name && this.basicInfo.name !== previousName) {
        Logger.info(`👤 提取到用户名字: ${this.basicInfo.name}`, 'UserProfile');
        needsSave = true;
      }
    }

    if (data.emotion) {
      this.updateEmotionalPatterns(data.emotion, data.timestamp);
      needsSave = true;
    }

    if (data.input) {
      this.updateTaskPreferences(data.input);
      this.updateLifePreferences(data.input);
      needsSave = true;
    }

    if (data.scene) {
      this.updateScenePreferences(data.scene);
      needsSave = true;
    }

    if (needsSave) {
      await this.save();
    }
  }

  /**
   * 从输入中提取用户名字
   */
  private extractUserName(input: string): void {
    // 匹配"我叫XXX"、"我的名字是XXX"、"我是XXX"等模式
    // 排除疑问句（如"我叫什么名字"）
    const namePatterns = [
      /我叫([\u4e00-\u9fa5a-zA-Z]{1,10})(?=[，。！\s]|$)/,
      /我的名字是([\u4e00-\u9fa5a-zA-Z]{1,10})(?=[，。！\s]|$)/,
      /我是([\u4e00-\u9fa5a-zA-Z]{1,10})(?=[，。！\s]|$)/,
    ];

    // 常见疑问词和过滤词
    const questionWords = [
      '什么',
      '谁',
      '哪',
      '怎么',
      '多少',
      '几',
      '吗',
      '呢',
      '吧',
    ];
    const nonNames = ['家百星', 'jiabaixing', 'AI', '人工智能', '助手', '我'];

    for (const pattern of namePatterns) {
      const match = input.match(pattern);
      if (match && match[1]) {
        const extractedName = match[1].trim();
        // 过滤疑问词和非名字词汇
        if (
          extractedName.length >= 1 &&
          extractedName.length <= 10 &&
          !nonNames.includes(extractedName) &&
          !questionWords.some((q) => extractedName.includes(q))
        ) {
          this.basicInfo.name = extractedName;
          break;
        }
      }
    }
  }

  /**
   * 更新情绪模式
   */
  private updateEmotionalPatterns(emotion: EmotionTag, timestamp: Date): void {
    const existingEmotion = this.emotionalPatterns.commonEmotions.find(
      (e) => e.type === emotion.type
    );
    if (existingEmotion) {
      existingEmotion.frequency += 1;
    } else {
      this.emotionalPatterns.commonEmotions.push({
        type: emotion.type,
        frequency: 1,
      });
    }

    const hour = timestamp.getHours();
    const timeSlot =
      hour >= 6 && hour < 12
        ? '上午'
        : hour >= 12 && hour < 18
          ? '下午'
          : hour >= 18 && hour < 23
            ? '晚上'
            : '深夜';

    const existingTrigger = this.emotionalPatterns.triggerEvents.find(
      (t) => t.emotionType === emotion.type && t.timeSlot === timeSlot
    );
    if (existingTrigger) {
      existingTrigger.frequency += 1;
    } else if (this.emotionalPatterns.triggerEvents.length < 20) {
      this.emotionalPatterns.triggerEvents.push({
        emotionType: emotion.type,
        timeSlot,
        frequency: 1,
      });
    }

    if (emotion.intensity >= 5) {
      const comfortStrategy = this.inferComfortStrategy(emotion.type);
      const existingStrategy = this.emotionalPatterns.comfortStrategies.find(
        (s) => s.emotionType === emotion.type && s.strategy === comfortStrategy
      );
      if (existingStrategy) {
        existingStrategy.effectiveness = Math.min(
          1.0,
          existingStrategy.effectiveness + 0.05
        );
      } else if (this.emotionalPatterns.comfortStrategies.length < 15) {
        this.emotionalPatterns.comfortStrategies.push({
          emotionType: emotion.type,
          strategy: comfortStrategy,
          effectiveness: 0.5,
        });
      }
    }

    if (emotion.intensity > this.emotionalPatterns.stressThreshold) {
      this.emotionalPatterns.stressThreshold = Math.max(
        1,
        this.emotionalPatterns.stressThreshold - 0.5
      );
      this.emotionalPatterns.emotionalResilience = Math.max(
        1,
        this.emotionalPatterns.emotionalResilience - 0.3
      );
    } else if (
      emotion.intensity <
      this.emotionalPatterns.stressThreshold * 0.5
    ) {
      this.emotionalPatterns.stressThreshold = Math.min(
        10,
        this.emotionalPatterns.stressThreshold + 0.2
      );
      this.emotionalPatterns.emotionalResilience = Math.min(
        10,
        this.emotionalPatterns.emotionalResilience + 0.1
      );
    }
  }

  private inferComfortStrategy(emotionType: string): string {
    const strategyMap: Record<string, string> = {
      焦虑: '理性分析+行动建议',
      悲伤: '情感陪伴+温暖安慰',
      烦躁: '倾听理解+情绪疏导',
      疲惫: '体贴关怀+休息建议',
      兴奋: '积极回应+分享喜悦',
      困惑: '耐心解释+逐步引导',
    };
    return strategyMap[emotionType] || '温和陪伴+倾听理解';
  }

  private updateLifePreferences(input: string): void {
    const lowerInput = input.toLowerCase();

    // 使用预编译的 Set 进行 O(1) 查找
    for (const food of _FOOD_KEYWORDS) {
      if (
        lowerInput.includes(food) &&
        !this.lifePreferences.dietaryPreferences.includes(food)
      ) {
        this.lifePreferences.dietaryPreferences.push(food);
      }
    }

    for (const exercise of _EXERCISE_KEYWORDS) {
      if (
        lowerInput.includes(exercise) &&
        !this.lifePreferences.exerciseHabits.includes(exercise)
      ) {
        this.lifePreferences.exerciseHabits.push(exercise);
      }
    }

    for (const ent of _ENTERTAINMENT_KEYWORDS) {
      if (
        lowerInput.includes(ent) &&
        !this.lifePreferences.entertainmentPreferences.includes(ent)
      ) {
        this.lifePreferences.entertainmentPreferences.push(ent);
      }
    }

    const hour = new Date().getHours();
    if (hour >= 23 || hour < 5) {
      this.lifePreferences.sleepSchedule.bedtime = Math.min(
        this.lifePreferences.sleepSchedule.bedtime,
        hour >= 23 ? hour : hour + 24
      );
    }
    if (hour >= 5 && hour < 9) {
      this.lifePreferences.sleepSchedule.wakeup = Math.max(
        this.lifePreferences.sleepSchedule.wakeup,
        hour
      );
    }
  }

  /**
   * 更新任务偏好
   */
  private updateTaskPreferences(input: string): void {
    const lowerInput = input.toLowerCase();

    // 使用预编译的 Set 进行 O(1) 查找
    for (const lang of _LANGUAGE_KEYWORDS) {
      if (
        lowerInput.includes(lang) &&
        !this.developmentHabits.preferredLanguages.includes(lang)
      ) {
        this.developmentHabits.preferredLanguages.push(lang);
      }
    }

    for (const framework of _FRAMEWORK_KEYWORDS) {
      if (
        lowerInput.includes(framework) &&
        !this.developmentHabits.preferredFrameworks.includes(framework)
      ) {
        this.developmentHabits.preferredFrameworks.push(framework);
      }
    }

    for (const structure of _PROJECT_STRUCTURE_KEYWORDS) {
      if (
        lowerInput.includes(structure) &&
        !this.developmentHabits.projectStructure.includes(structure)
      ) {
        this.developmentHabits.projectStructure.push(structure);
      }
    }

    for (const tool of _TOOL_KEYWORDS) {
      if (
        lowerInput.includes(tool) &&
        !this.developmentHabits.commonTools.includes(tool)
      ) {
        this.developmentHabits.commonTools.push(tool);
      }
    }

    // 使用预编译的 Map 进行单值设置
    for (const [key, value] of Object.entries(CODE_ORGANIZATION_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.codeOrganization = value;
        break;
      }
    }

    for (const [key, value] of Object.entries(TESTING_APPROACH_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.testingApproach = value;
        break;
      }
    }

    for (const [key, value] of Object.entries(DOCUMENTATION_STYLE_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.documentationStyle = value;
        break;
      }
    }

    for (const [key, value] of Object.entries(VERSION_CONTROL_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.versionControl = value;
        break;
      }
    }

    for (const [key, value] of Object.entries(DEPLOYMENT_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.deploymentProcess = value;
        break;
      }
    }

    for (const [key, value] of Object.entries(CODE_REVIEW_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.codeReviewProcess = value;
        break;
      }
    }

    for (const [key, value] of Object.entries(PERFORMANCE_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.performanceOptimization = value;
        break;
      }
    }

    for (const [key, value] of Object.entries(SECURITY_MAP)) {
      if (lowerInput.includes(key)) {
        this.developmentHabits.securityPractices = value;
        break;
      }
    }
  }

  /**
   * 更新场景偏好
   */
  private updateScenePreferences(scene: SceneTag): void {
    // 简化实现：基于场景信息更新偏好
    // 实际实现应该进行更复杂的分析
    if (scene.type === 'development') {
      // 开发场景下，增加开发习惯的权重
      this.developmentHabits.workingHours = {
        start: Math.min(
          this.developmentHabits.workingHours.start,
          new Date().getHours()
        ),
        end: Math.max(
          this.developmentHabits.workingHours.end,
          new Date().getHours()
        ),
      };
    } else if (
      scene.type === PersonaScene.LEISURE ||
      scene.type === PersonaScene.IDLE
    ) {
      // 休息场景下，记录休息时间
      const currentHour = new Date().getHours();
      this.lifePreferences.sleepSchedule = {
        bedtime: Math.min(
          this.lifePreferences.sleepSchedule.bedtime,
          currentHour
        ),
        wakeup: Math.max(
          this.lifePreferences.sleepSchedule.wakeup,
          currentHour
        ),
      };
    }
  }

  /**
   * 获取用户基础信息
   */
  public getBasicInfo(): BasicInfo {
    return { ...this.basicInfo };
  }

  /**
   * 获取开发习惯
   */
  public getDevelopmentHabits(): DevelopmentHabits {
    return { ...this.developmentHabits };
  }

  /**
   * 获取生活偏好
   */
  public getLifePreferences(): LifePreferences {
    return { ...this.lifePreferences };
  }

  /**
   * 获取情绪模式
   */
  public getEmotionalPatterns(): EmotionalPatterns {
    return { ...this.emotionalPatterns };
  }

  /**
   * 获取任务偏好
   */
  public getTaskPreferences(): TaskPreferences {
    return { ...this.taskPreferences };
  }

  /**
   * 设置用户基础信息
   */
  public setBasicInfo(info: Partial<BasicInfo>): void {
    this.basicInfo = { ...this.basicInfo, ...info, updatedAt: new Date() };
  }

  /**
   * 设置开发习惯
   */
  public setDevelopmentHabits(habits: Partial<DevelopmentHabits>): void {
    this.developmentHabits = { ...this.developmentHabits, ...habits };
    this.basicInfo.updatedAt = new Date();
  }

  /**
   * 设置生活偏好
   */
  public setLifePreferences(preferences: Partial<LifePreferences>): void {
    this.lifePreferences = { ...this.lifePreferences, ...preferences };
    this.basicInfo.updatedAt = new Date();
  }

  /**
   * 设置情绪模式
   */
  public setEmotionalPatterns(patterns: Partial<EmotionalPatterns>): void {
    this.emotionalPatterns = { ...this.emotionalPatterns, ...patterns };
    this.basicInfo.updatedAt = new Date();
  }

  /**
   * 设置任务偏好
   */
  public setTaskPreferences(preferences: Partial<TaskPreferences>): void {
    this.taskPreferences = { ...this.taskPreferences, ...preferences };
    this.basicInfo.updatedAt = new Date();
  }

  /**
   * P2增强：从进化数据同步到用户画像
   * 将 ProfileEvolutionManager 学到的偏好写回到 UserProfile
   */
  public syncProfileFromEvolution(evolutionData: {
    communicationStyle?: { style: string; confidence: number };
    interactionTimePatterns?: Array<{ hourOfDay: number; frequency: number }>;
    responseLengthPreference?: { preferred: string; confidence: number };
    toolPreferences?: Array<{
      toolName: string;
      usageCount: number;
      successRate: number;
    }>;
  }): boolean {
    let changed = false;

    if (
      evolutionData.communicationStyle &&
      evolutionData.communicationStyle.confidence > 0.5
    ) {
      const styleToWorkStyle: Record<string, string> = {
        direct: 'focused',
        detailed: 'focused',
        casual: 'multi-tasking',
        formal: 'focused',
      };
      const workStyle =
        styleToWorkStyle[evolutionData.communicationStyle.style];
      if (workStyle && this.taskPreferences.preferredWorkStyle !== workStyle) {
        this.taskPreferences.preferredWorkStyle = workStyle;
        changed = true;
      }
    }

    if (
      evolutionData.toolPreferences &&
      evolutionData.toolPreferences.length > 0
    ) {
      const topTools = evolutionData.toolPreferences
        .filter((t) => t.successRate > 0.7)
        .slice(0, 5)
        .map((t) => t.toolName);
      if (topTools.length > 0) {
        const newTools = topTools.filter(
          (t) => !this.developmentHabits.commonTools.includes(t)
        );
        if (newTools.length > 0) {
          this.developmentHabits.commonTools = [
            ...this.developmentHabits.commonTools,
            ...newTools,
          ];
          changed = true;
        }
      }
    }

    if (changed) {
      this.basicInfo.updatedAt = new Date();
    }

    return changed;
  }

  /**
   * 获取用户画像的完整表示
   */
  public toJSON(): unknown {
    return {
      basicInfo: this.basicInfo,
      developmentHabits: this.developmentHabits,
      lifePreferences: this.lifePreferences,
      emotionalPatterns: this.emotionalPatterns,
      taskPreferences: this.taskPreferences,
    };
  }

  /**
   * 打印用户画像信息（用于调试）
   */
  public print(): void {
    Logger.info('\n👤 用户画像信息', 'UserProfile');
    Logger.info('=====================================', 'UserProfile');
    Logger.info(
      `基础信息: ${JSON.stringify(this.basicInfo, null, 2)}`,
      'UserProfile'
    );
    Logger.info(
      `开发习惯: ${JSON.stringify(this.developmentHabits, null, 2)}`,
      'UserProfile'
    );
    Logger.info(
      `生活偏好: ${JSON.stringify(this.lifePreferences, null, 2)}`,
      'UserProfile'
    );
    Logger.info(
      `情绪模式: ${JSON.stringify(this.emotionalPatterns, null, 2)}`,
      'UserProfile'
    );
    Logger.info(
      `任务偏好: ${JSON.stringify(this.taskPreferences, null, 2)}`,
      'UserProfile'
    );
    Logger.info('=====================================', 'UserProfile');
  }
}
