import { IMemoryEngine } from './JiabaixingCore';
import { UserProfileSummary } from '../persona/DialogueGenerator';
import { Logger } from '../utils/Logger';

/**
 * MemoryAssistant 依赖接口
 */
export interface MemoryAssistantDeps {
  memoryEngine: IMemoryEngine | null;
}

/**
 * 记忆辅助方法
 * 从 JiabaixingCore 中提取的记忆相关实例方法
 */
export class MemoryAssistant {
  private memoryEngine: IMemoryEngine | null;

  constructor(deps: MemoryAssistantDeps) {
    this.memoryEngine = deps.memoryEngine;
  }

  /**
   * 构建用户画像摘要
   */
  async buildUserProfileSummary(
    userId?: string
  ): Promise<UserProfileSummary | undefined> {
    if (this.memoryEngine?.getUserProfileSummary && userId) {
      try {
        const profile = await this.memoryEngine.getUserProfileSummary(userId);
        return {
          name: profile.name,
          preferredLanguage: profile.preferredLanguage,
          preferredFrameworks: profile.preferredFrameworks,
          recentTopics: profile.recentTopics,
        };
      } catch {
        // 忽略画像获取失败
      }
    }

    return undefined;
  }

  /**
   * v3: 自动记忆检索——在 FC 循环前自动注入相关记忆，不依赖 LLM 主动调用 memory_recall
   * P2增强：添加记忆去重，避免相似记忆重复注入
   */
  async autoRetrieveMemories(
    input: string,
    _userId?: string
  ): Promise<string[]> {
    if (!this.memoryEngine?.retrieveRelevant) {
      return [];
    }
    try {
      const memories = await this.memoryEngine.retrieveRelevant({
        query: input,
        limit: 10,
      });

      if (!memories || memories.length === 0) return [];

      const formatted = (
        memories as Array<{
          content: string;
          type?: string;
          timestamp?: Date;
          relevance?: number;
        }>
      ).map(
        (m) =>
          `[${m.type || '记忆'}] ${m.content}${m.timestamp ? `（${new Date(m.timestamp).toLocaleDateString('zh-CN')}）` : ''}`
      );

      // P2增强：基于Jaccard相似度的记忆去重
      const deduped = this.deduplicateMemoryStrings(formatted);

      // 只返回前5条去重后的记忆
      return deduped.slice(0, 5);
    } catch {
      return [];
    }
  }

  /**
   * P2: 基于Jaccard相似度的记忆去重
   */
  deduplicateMemoryStrings(memories: string[]): string[] {
    if (memories.length <= 1) return memories;

    const result: string[] = [];
    const seen = new Set<string>();

    for (const memory of memories) {
      if (seen.has(memory)) continue;

      let isDuplicate = false;
      const memTokens = this.tokenizeForDedup(memory);

      for (const existing of result) {
        const exTokensArray = this.tokenizeForDedup(existing);
        const exTokenSet = new Set(exTokensArray);
        const intersection = memTokens.filter((t) => exTokenSet.has(t));
        const union = new Set([...memTokens, ...exTokensArray]);
        const similarity =
          union.size === 0 ? 0 : intersection.length / union.size;

        if (similarity > 0.7) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        seen.add(memory);
        result.push(memory);
      }
    }

    return result;
  }

  private tokenizeForDedup(text: string): string[] {
    const tokens: string[] = [];
    const cleaned = text.replace(/[\[\]（）()，。！？、：；""''【】-]/g, ' ');

    for (const word of cleaned.split(/\s+/)) {
      const trimmed = word.trim();
      if (trimmed.length >= 2) {
        tokens.push(trimmed.toLowerCase());
      }
    }

    return tokens;
  }

  /**
   * v3: 自动知识提取——对话结束后异步提取关键信息存入记忆
   * 不依赖 LLM 主动调用 memory_store
   */
  async autoExtractKnowledge(
    input: string,
    response: string,
    _userId?: string
  ): Promise<void> {
    if (!this.memoryEngine?.storeShortTermMemory) return;

    const extracted: Array<{ content: string; category: string }> = [];

    // 1. 提取用户偏好
    const preferencePatterns = [
      {
        pattern: /我(?:喜欢|爱|偏好|习惯|常用|一般|通常)\s*([^。，！？]+)/,
        category: 'preference',
      },
      {
        pattern: /我(?:不喜欢|讨厌|反感|不用|从不)\s*([^。，！？]+)/,
        category: 'preference',
      },
      {
        pattern: /我(?:是|在|做|从事)\s*([^。，！？]{3,30})/,
        category: 'fact',
      },
      {
        pattern:
          /我(?:明天|下周|后天|过几天|待会|稍后)\s*(?:要|需要|准备|打算)\s*([^。，！？]+)/,
        category: 'task',
      },
    ];

    for (const { pattern, category } of preferencePatterns) {
      const match = input.match(pattern);
      if (match && match[1].trim().length > 2) {
        extracted.push({ content: match[1].trim(), category });
      }
    }

    // 2. 提取确认的任务
    if (
      response.includes('已') &&
      (response.includes('设置') ||
        response.includes('添加') ||
        response.includes('保存'))
    ) {
      const taskMatch = input.match(
        /(?:设置|添加|创建|安排|提醒)\s*([^。，！？]+)/
      );
      if (taskMatch) {
        extracted.push({
          content: `任务/提醒: ${taskMatch[1].trim()}`,
          category: 'task',
        });
      }
    }

    // 3. 存储
    for (const item of extracted) {
      try {
        await this.memoryEngine.storeShortTermMemory(item.content, item.category);
        Logger.info(
          `🧠 自动提取知识: [${item.category}] ${item.content}`,
          'MemoryAssistant'
        );
      } catch (error) {
        Logger.debug(
          `知识存储失败（非关键）: ${(error as Error).message}`,
          'MemoryAssistant'
        );
      }
    }
  }
}
