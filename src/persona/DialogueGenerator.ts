/**
 * 对话生成器 v2
 * 调用 LLMProvider 生成回复，自动注入人格摘要、召回的记忆、场景语气指令
 *
 * v2 优化：
 * 1. 智能记忆排序：按相关性分数排序，高相关性记忆优先
 * 2. 记忆重要性标注：在 prompt 中标注记忆的相关性等级
 * 3. 动态记忆数量：根据场景调整记忆数量
 * 4. 记忆时效性提示：标注记忆的时效性
 */

import * as fs from 'fs';
import * as path from 'path';
import { LLMProvider } from '../models/LLMProvider';
import { Logger } from '../utils/Logger';
import { PersonaCore } from './PersonaCore';

/**
 * 记忆项接口
 */
export interface MemoryContextItem {
  content: string;
  type: string;
  timestamp?: Date;
  relevance?: number;
}

/**
 * 用户画像摘要
 */
export interface UserProfileSummary {
  name?: string;
  preferredLanguage?: string;
  preferredFrameworks?: string[];
  commonPatterns?: string[];
  recentTopics?: string[];
  behaviorHints?: string[];
}

/**
 * 场景配置
 */
interface SceneConfig {
  maxMemories: number;
  minRelevance: number;
  relevanceThreshold: number;
  enableTimeHint: boolean;
  enableRelevanceLabel: boolean;
}

const SCENE_CONFIGS: Record<string, SceneConfig> = {
  development: {
    maxMemories: 6,
    minRelevance: 0.2,
    relevanceThreshold: 0.5,
    enableTimeHint: true,
    enableRelevanceLabel: true,
  },
  work: {
    maxMemories: 5,
    minRelevance: 0.25,
    relevanceThreshold: 0.5,
    enableTimeHint: true,
    enableRelevanceLabel: true,
  },
  comfort: {
    maxMemories: 8,
    minRelevance: 0.15,
    relevanceThreshold: 0.4,
    enableTimeHint: true,
    enableRelevanceLabel: false,
  },
  greeting: {
    maxMemories: 3,
    minRelevance: 0.3,
    relevanceThreshold: 0.5,
    enableTimeHint: false,
    enableRelevanceLabel: false,
  },
  celebration: {
    maxMemories: 5,
    minRelevance: 0.2,
    relevanceThreshold: 0.5,
    enableTimeHint: true,
    enableRelevanceLabel: false,
  },
  daily: {
    maxMemories: 5,
    minRelevance: 0.2,
    relevanceThreshold: 0.5,
    enableTimeHint: true,
    enableRelevanceLabel: false,
  },
  briefing: {
    maxMemories: 8,
    minRelevance: 0.15,
    relevanceThreshold: 0.4,
    enableTimeHint: true,
    enableRelevanceLabel: true,
  },
};

/**
 * 对话生成器
 */
export class DialogueGenerator {
  constructor(
    private llm: LLMProvider,
    private personaCore: PersonaCore
  ) {}

  /**
   * 生成回复
   * @param input 用户输入
   * @param sceneTag 场景标签
   * @param memoryContext 召回的记忆上下文
   * @param userProfileSummary 用户画像摘要
   * @returns 生成的回复
   */
  async generate(
    input: string,
    sceneTag: string,
    memoryContext: MemoryContextItem[],
    userProfileSummary?: UserProfileSummary
  ): Promise<string> {
    try {
      const systemPrompt = this.buildSystemPrompt(sceneTag);
      const userPrompt = this.buildUserPrompt(
        input,
        memoryContext,
        userProfileSummary,
        sceneTag
      );

      Logger.info(
        `📝 生成对话: 场景=${sceneTag}, 记忆数=${memoryContext.length}`,
        'DialogueGenerator'
      );

      const response = await this.llm.chat(userPrompt, [], systemPrompt);

      Logger.info(
        `✅ 对话生成完成 (${response.length} 字符)`,
        'DialogueGenerator'
      );
      return response;
    } catch (error) {
      Logger.error('❌ 对话生成失败', error as Error, 'DialogueGenerator');
      return this.generateFallbackReply(input, sceneTag);
    }
  }

  /**
   * 构建 System Prompt
   * 包含人格摘要 + 场景语气指令 + 边界提醒
   */
  private buildSystemPrompt(sceneTag: string): string {
    const personaSummary = this.personaCore.buildPersonaSummary();
    const sceneInstruction =
      this.personaCore.buildSceneToneInstruction(sceneTag);

    return `${personaSummary}

${sceneInstruction}

重要提醒：
- 回复要自然、有温度，像真人对话
- 如果记忆上下文中有具体细节（文件名、任务名、偏好），自然地引用——这会让消息真诚而非套话
- 不要机械地列出要点，像正常人一样说话
- 控制回复长度，日常对话不超过50字，技术解释不超过200字`;
  }

  /**
   * 构建 User Prompt
   * 包含用户输入 + 召回的记忆摘要 + 用户画像摘要
   *
   * v2 优化：
   * - 按相关性排序
   * - 标注相关性等级
   * - 动态调整记忆数量
   */
  private buildUserPrompt(
    input: string,
    memoryContext: MemoryContextItem[],
    userProfileSummary?: UserProfileSummary,
    sceneTag: string = 'daily'
  ): string {
    const parts: string[] = [];
    const config = SCENE_CONFIGS[sceneTag] || SCENE_CONFIGS.daily;

    // 用户输入
    parts.push(`用户输入：${input}`);

    // 记忆上下文 - v2 智能排序和筛选
    if (memoryContext.length > 0) {
      const sortedMemories = this.sortAndFilterMemories(memoryContext, config);

      if (sortedMemories.length > 0) {
        parts.push('\n相关记忆（可自然引用其中的具体信息，但不要逐字复述）：');
        sortedMemories.forEach((memory, index) => {
          const timeHint =
            config.enableTimeHint && memory.timestamp
              ? `(${this.formatTimeAgo(memory.timestamp)})`
              : '';

          const relevanceLabel = config.enableRelevanceLabel
            ? this.getRelevanceLabel(memory.relevance)
            : '';

          parts.push(
            `${index + 1}. [${memory.type}]${relevanceLabel} ${memory.content} ${timeHint}`
          );
        });
      }
    }

    // 用户画像摘要
    if (userProfileSummary) {
      const profileParts: string[] = [];

      if (userProfileSummary.name) {
        profileParts.push(`用户称呼：${userProfileSummary.name}`);
      }
      if (userProfileSummary.preferredLanguage) {
        profileParts.push(`偏好语言：${userProfileSummary.preferredLanguage}`);
      }
      if (
        userProfileSummary.preferredFrameworks &&
        userProfileSummary.preferredFrameworks.length > 0
      ) {
        profileParts.push(
          `常用框架：${userProfileSummary.preferredFrameworks.join('、')}`
        );
      }
      if (
        userProfileSummary.recentTopics &&
        userProfileSummary.recentTopics.length > 0
      ) {
        profileParts.push(
          `最近关注：${userProfileSummary.recentTopics.join('、')}`
        );
      }
      if (
        userProfileSummary.behaviorHints &&
        userProfileSummary.behaviorHints.length > 0
      ) {
        profileParts.push(
          `行为模式：${userProfileSummary.behaviorHints.join('；')}`
        );
      }

      if (profileParts.length > 0) {
        parts.push(`\n用户画像：\n${profileParts.join('\n')}`);
      }
    }

    parts.push('\n请根据以上信息生成回复。自然、有温度、不啰嗦。');

    return parts.join('\n');
  }

  /**
   * 排序和筛选记忆
   */
  private sortAndFilterMemories(
    memories: MemoryContextItem[],
    config: SceneConfig
  ): MemoryContextItem[] {
    return memories
      .filter((m) => (m.relevance || 0) >= config.minRelevance)
      .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
      .slice(0, config.maxMemories);
  }

  /**
   * 获取相关性标签
   */
  private getRelevanceLabel(relevance?: number): string {
    if (!relevance) return '';
    if (relevance >= 0.8) return '[高相关]';
    if (relevance >= 0.5) return '[相关]';
    return '[参考]';
  }

  /**
   * 生成主动消息（用于 Scheduler 主动交互）
   */
  async generateProactiveMessage(
    reason: string,
    sceneTag: string,
    context: string,
    memoryContext: MemoryContextItem[]
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(sceneTag);

    const reasonGuidance: Record<string, string> = {
      long_silence:
        '用户已经很久没和你说话了。像一位细心的秘书——不要问"你在干嘛"，而是自然地提到你可能注意到的事。',
      negative_emotion_trend:
        '你注意到用户最近情绪不太好。不需要直接说"你不开心吧"，而是温和地表达关切。',
      morning_greeting:
        '现在是早晨。一句从容的早安，可以自然地带出今天的重点。',
      evening_checkin: '晚上了。问一下今天怎么样，是否需要帮你整理明天的安排。',
      late_night: '已经深夜了。提醒休息。不要唠叨。',
      scheduled: '定时问候。根据时间来定语气——早上干练，下午从容，晚上温暖。',
      behavior_pattern: '根据用户的行为模式，预判可能需要的服务。',
    };

    const guidance = reasonGuidance[reason] || reasonGuidance.scheduled;

    // 主动消息也使用智能记忆筛选
    const sortedMemories = memoryContext
      .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
      .slice(0, 5);

    let memoryContextStr = '';
    if (sortedMemories.length > 0) {
      memoryContextStr =
        '\n相关记忆：\n' +
        sortedMemories
          .map((m, i) => `${i + 1}. [${m.type}] ${m.content}`)
          .join('\n');
    }

    const userPrompt = `触发原因：${reason}
${guidance}

已知上下文：
${context}
${memoryContextStr}

当前场景：${sceneTag}

请生成一条简短、自然的主动消息。不超过40字。`;

    try {
      const response = await this.llm.chat(userPrompt, [], systemPrompt);
      return response;
    } catch (error) {
      Logger.error('❌ 主动消息生成失败', error as Error, 'DialogueGenerator');
      return this.generateProactiveFallback(reason);
    }
  }

  /**
   * 降级回复（LLM 不可用时）
   */
  private generateFallbackReply(input: string, sceneTag: string): string {
    const trimmed = input.trim().toLowerCase();

    // 文件读取: "读一下CLAUDE.MD"、"查看日志文件"、"打开README"
    const fileReadMatch = trimmed.match(
      /^(?:读|读取|查看|打开|展示|显示)\s*(?:一下|取)?\s*([^\s，。]{1,80})/i
    );
    if (fileReadMatch) {
      let filePath = fileReadMatch[1].trim();
      if (!filePath.endsWith('.md') && !path.extname(filePath)) {
        filePath = filePath + '.md';
      }
      const fullPath = path.resolve(process.cwd(), filePath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          if (lines.length > 200) {
            return `${filePath} 内容如下（共 ${lines.length} 行，显示前 200 行）：\n\n${lines.slice(0, 200).join('\n')}\n\n...（余 ${lines.length - 200} 行已省略）`;
          }
          return `${filePath} 内容如下：\n\n${content}`;
        } catch {
          return `读取 ${filePath} 时出错。`;
        }
      }
      const altPath = path.resolve(process.cwd(), 'src', filePath);
      if (fs.existsSync(altPath)) {
        try {
          const content = fs.readFileSync(altPath, 'utf-8');
          const lines = content.split('\n');
          if (lines.length > 200) {
            return `${filePath} 内容如下（共 ${lines.length} 行，显示前 200 行）：\n\n${lines.slice(0, 200).join('\n')}\n\n...（余 ${lines.length - 200} 行已省略）`;
          }
          return `${filePath} 内容如下：\n\n${content}`;
        } catch {
          return `读取 ${filePath} 时出错。`;
        }
      }
      return `未找到文件: ${filePath}`;
    }

    // 问候类
    if (/^你好|^hello|^hi|^嗨/.test(trimmed)) {
      return sceneTag === 'development'
        ? '你好。有什么需要处理的吗？'
        : '你好。今天有什么安排？';
    }

    if (/^早|^早安|^早上好/.test(trimmed)) {
      return '早上好。今天有什么计划？';
    }

    if (/^晚安/.test(trimmed)) {
      return '晚安，早点休息。';
    }

    if (/^谢谢|^感谢/.test(trimmed)) {
      return '不客气。还有其他需要吗？';
    }

    if (/^你是谁|^你叫什么/.test(trimmed)) {
      return '我是家百星，你的私人秘书。有什么事需要处理的吗？';
    }

    if (/^在吗|^在干嘛/.test(trimmed)) {
      return '在。你说。';
    }

    // 开发场景
    if (sceneTag === 'development') {
      return '收到。告诉我具体需求。';
    }

    return '收到。告诉我你想做什么。';
  }

  /**
   * 主动消息降级
   */
  private generateProactiveFallback(reason: string): string {
    const fallbacks: Record<string, string> = {
      long_silence: '有什么需要我处理的吗？随时说。',
      negative_emotion_trend: '在呢。想聊聊的话我听着。',
      morning_greeting: '早上好。今天有什么计划？',
      evening_checkin: '今天怎么样？需要整理明天的安排吗？',
      late_night: '不早了，记得早点休息。',
      scheduled: '有什么需要我做的吗？',
      behavior_pattern: '根据你的习惯，可能需要这个提醒。',
    };

    return fallbacks[reason] || fallbacks.scheduled;
  }

  /**
   * 格式化时间差
   */
  private formatTimeAgo(date: Date | string | number): string {
    const now = new Date();
    const dateObj = date instanceof Date ? date : new Date(date);
    const diff = now.getTime() - dateObj.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}天前`;
    if (hours > 0) return `${hours}小时前`;
    if (minutes > 0) return `${minutes}分钟前`;
    return '刚刚';
  }
}
