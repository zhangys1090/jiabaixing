/**
 * ConversationCompressor - 对话压缩
 * 从MemoryEngine拆分出的对话压缩逻辑：
 * 1. 对话历史压缩
 * 2. 相关对话检索
 */

import Logger from '../utils/Logger';
import { ChineseTokenizer } from './ChineseTokenizer';
import { ShortTermMemory } from './ShortTermMemory';

export class ConversationCompressor {
  /**
   * 对话历史压缩
   * 保留最近N条对话，压缩旧对话
   * @param conversationId 会话ID
   * @param maxLength 最大保留条数
   * @param shortTermMemory 短期记忆实例
   * @param storeLongTermMemory 存储长期记忆的回调
   */
  async compressConversationHistory(
    conversationId: string,
    maxLength: number,
    shortTermMemory: ShortTermMemory,
    storeLongTermMemory: (
      content: Record<string, unknown>,
      scene?: string,
      emotion?: string
    ) => Promise<unknown>
  ): Promise<void> {
    try {
      const conversations = await shortTermMemory.getRecentConversations(
        maxLength * 3
      );

      if (conversations.length <= maxLength) {
        return;
      }

      const toCompress = conversations.slice(0, -maxLength);
      const toKeep = conversations.slice(-maxLength);

      if (toCompress.length === 0) {
        return;
      }

      const summaryParts: string[] = [];
      const topicSet = new Set<string>();
      const entityMap = new Map<string, number>();

      for (const conv of toCompress) {
        const content =
          typeof conv.content === 'string'
            ? conv.content
            : JSON.stringify(conv.content);

        const sentences = content.split(/[。！？；\n]/).filter((s) => s.trim());
        for (const sentence of sentences) {
          if (sentence.length > 10 && sentence.length < 100) {
            topicSet.add(sentence.trim());
          }
        }

        const entityPatterns = [
          /(?:我喜欢|我讨厌)\s*[?]*\s*([^\s'"]+)/g,
          /(?:我想要|我需要)\s*[?]*\s*([^\s'"]+)/g,
          /(?:我的|我们的)\s*(?:名字|名字是)\s*([^\s'"]{2,20})/g,
        ];

        for (const pattern of entityPatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const entity = match[1].trim();
            if (entity.length > 1 && entity.length < 30) {
              entityMap.set(entity, (entityMap.get(entity) || 0) + 1);
            }
          }
        }
      }

      const topTopics = Array.from(topicSet).slice(0, 5);
      if (topTopics.length > 0) {
        summaryParts.push('主题: ' + topTopics.join('; '));
      }

      const topEntities = Array.from(entityMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([entity]) => entity);
      if (topEntities.length > 0) {
        summaryParts.push('实体: ' + topEntities.join(', '));
      }

      const summary = summaryParts.join('\n');
      if (summary) {
        await storeLongTermMemory(
          {
            type: 'conversation_summary',
            conversationId,
            summary,
            compressedCount: toCompress.length,
            timestamp: new Date().toISOString(),
          },
          'conversation',
          'neutral'
        );

        Logger.info(
          '对话历史已压缩: 压缩了 ' + toCompress.length + ' 条记录',
          'ConversationCompressor'
        );
      }

      for (const conv of toKeep) {
        await shortTermMemory.store(conv.content, conv.scene, conv.emotion);
      }
    } catch (error) {
      Logger.error(
        '对话历史压缩失败',
        error as Error,
        'ConversationCompressor'
      );
    }
  }

  /**
   * 检索相关对话
   * 根据当前输入检索相关历史对话
   * @param currentInput 当前输入
   * @param limit 最大返回数量
   * @param shortTermMemory 短期记忆实例
   */
  async retrieveRelevantConversations(
    currentInput: string,
    limit: number,
    shortTermMemory: ShortTermMemory
  ): Promise<
    Array<{
      id: string;
      content: string;
      timestamp: Date;
      relevance: number;
      scene?: string;
      emotion?: string;
    }>
  > {
    try {
      const inputTokens = new Set(ChineseTokenizer.tokenize(currentInput));

      if (inputTokens.size === 0) {
        return [];
      }

      const conversations = await shortTermMemory.getRecentConversations(50);

      const scored: Array<{
        conversation: (typeof conversations)[0];
        score: number;
      }> = [];

      for (const conv of conversations) {
        const content =
          typeof conv.content === 'string'
            ? conv.content
            : JSON.stringify(conv.content);

        const convTokens = ChineseTokenizer.tokenize(content);

        const intersection = convTokens.filter((t) => inputTokens.has(t));
        const union = new Set([...inputTokens, ...convTokens]);

        const jaccardSimilarity =
          union.size > 0 ? intersection.length / union.size : 0;

        const keywordMatch = intersection.length;

        const recencyBonus =
          (Date.now() - new Date(conv.timestamp).getTime()) /
          (1000 * 60 * 60 * 24);
        const recencyWeight = Math.exp(-recencyBonus / 7);

        const score =
          jaccardSimilarity * 0.5 + keywordMatch * 0.1 + recencyWeight * 0.4;

        if (score > 0.05) {
          scored.push({ conversation: conv, score });
        }
      }

      scored.sort((a, b) => b.score - a.score);

      return scored.slice(0, limit).map(({ conversation, score }) => ({
        id: conversation.id,
        content:
          typeof conversation.content === 'string'
            ? conversation.content
            : JSON.stringify(conversation.content),
        timestamp: conversation.timestamp,
        relevance: score,
        scene: conversation.scene,
        emotion: conversation.emotion,
      }));
    } catch (error) {
      Logger.error(
        '检索相关对话失败',
        error as Error,
        'ConversationCompressor'
      );
      return [];
    }
  }
}
