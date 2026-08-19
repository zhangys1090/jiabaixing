/**
 * 短期记忆（近端记忆）
 * 存储最近30天的所有对话、任务执行记录、用户行为日志、工具调用结果
 * 使用文件系统存储，带写入队列防并发
 */

import * as fs from 'fs';
import * as path from 'path';
import { MemoryContent } from '../interfaces';
import { FileSystem } from '../io/FileSystem';
import { Logger } from '../utils/Logger';
import { BaseMemoryStore } from './BaseMemoryStore';
import { ChineseTokenizer } from './ChineseTokenizer';
import { MemoryItem, MemoryType } from './MemoryEngine';

const fileSystem = new FileSystem();

/**
 * @deprecated 短期记忆核心逻辑已迁移至 Python agent/memory (AGENTS.md §0.1)。
 * 本类仅保留为类型契约/本地回退存根，不再由生产代码实例化。运行时走 Python。
 */
import { emitDeprecationWarning } from '../shared/deprecationWarning';
emitDeprecationWarning(
  'ShortTermMemory',
  'Python MemoryEngine (AGENT_BACKEND=python)',
  'V6.0'
);

export class ShortTermMemory extends BaseMemoryStore {
  private storagePath: string;
  private memories: MemoryItem[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private static readonly MAX_MEMORIES = 5000;

  constructor(storagePath: string = './data/short_term_memory.json') {
    super({
      enableOperationLogging: true,
      enableErrorRetry: true,
      maxRetryAttempts: 2,
    });
    this.storagePath = storagePath;
  }

  protected getStoreName(): string {
    return '短期记忆';
  }

  public async initialize(): Promise<void> {
    await this.executeTransaction('initialize', async () => {
      const dataDir = path.dirname(this.storagePath);
      await fileSystem.exists(dataDir).then(async (exists) => {
        if (!exists) {
          await fs.promises.mkdir(dataDir, { recursive: true });
        }
      });

      const exists = await fileSystem.exists(this.storagePath);
      if (exists) {
        const data = await fileSystem.readFile(this.storagePath);
        this.memories = JSON.parse(data);
      }

      this.initialized = true;
    });
  }

  public async store(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    this.ensureInitialized();

    const memoryItem: MemoryItem = {
      id: `short_term_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      type: MemoryType.SHORT_TERM,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };

    await this.executeTransaction('store', async () => {
      this.memories.push(memoryItem);

      if (this.memories.length > ShortTermMemory.MAX_MEMORIES) {
        this.memories = this.memories.slice(-ShortTermMemory.MAX_MEMORIES);
      }

      this.enqueueSave();
    });

    return memoryItem;
  }

  public async retrieve(
    query: string,
    requirements: string[]
  ): Promise<MemoryItem[]> {
    this.ensureInitialized();

    return this.executeTransaction('retrieve', async () => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      let filteredMemories = this.memories.filter((memory) => {
        const memoryDate = new Date(memory.timestamp);
        return memoryDate >= thirtyDaysAgo;
      });

      if (query) {
        const queryTokens = ChineseTokenizer.tokenize(query);
        if (queryTokens.length > 0) {
          filteredMemories = filteredMemories.filter((memory) => {
            const contentStr =
              typeof memory.content === 'string'
                ? memory.content
                : JSON.stringify(memory.content);
            const contentTokens = ChineseTokenizer.tokenize(contentStr);
            const queryTokenSet = new Set(queryTokens);
            const matchCount = contentTokens.filter((t) =>
              queryTokenSet.has(t)
            ).length;
            return matchCount > 0;
          });

          filteredMemories.sort((a, b) => {
            const contentStrA =
              typeof a.content === 'string'
                ? a.content
                : JSON.stringify(a.content);
            const contentStrB =
              typeof b.content === 'string'
                ? b.content
                : JSON.stringify(b.content);
            const tokensA = ChineseTokenizer.tokenize(contentStrA);
            const tokensB = ChineseTokenizer.tokenize(contentStrB);
            const queryTokenSet = new Set(queryTokens);
            const matchA = tokensA.filter((t) => queryTokenSet.has(t)).length;
            const matchB = tokensB.filter((t) => queryTokenSet.has(t)).length;
            return matchB - matchA;
          });
        } else {
          const queryLower = query.toLowerCase();
          filteredMemories = filteredMemories.filter((memory) => {
            const contentStr = JSON.stringify(memory.content).toLowerCase();
            return contentStr.includes(queryLower);
          });
        }
      }

      for (const req of requirements) {
        filteredMemories = filteredMemories.filter((memory) => {
          const contentStr = JSON.stringify(memory.content).toLowerCase();
          return (
            contentStr.includes(req.toLowerCase()) ||
            (memory.scene && memory.scene.includes(req)) ||
            (memory.emotion && memory.emotion.includes(req))
          );
        });
      }

      return filteredMemories.slice(0, 10);
    }).catch(() => []);
  }

  public async retrieveByEmotionAndScene(
    emotionType: string,
    sceneType: string
  ): Promise<MemoryItem[]> {
    this.ensureInitialized();

    return this.executeTransaction('retrieveByEmotionAndScene', async () => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      let filteredMemories = this.memories.filter((memory) => {
        const memoryDate = new Date(memory.timestamp);
        return memoryDate >= thirtyDaysAgo;
      });

      if (emotionType) {
        filteredMemories = filteredMemories.filter(
          (memory) => memory.emotion === emotionType
        );
      }

      if (sceneType) {
        filteredMemories = filteredMemories.filter(
          (memory) => memory.scene === sceneType
        );
      }

      filteredMemories.sort((a, b) => {
        const dateA = new Date(a.timestamp).getTime();
        const dateB = new Date(b.timestamp).getTime();
        return dateB - dateA;
      });

      return filteredMemories.slice(0, 10);
    }).catch(() => []);
  }

  public async save(): Promise<void> {
    this.ensureInitialized();

    await this.executeTransaction('save', async () => {
      await this.cleanupExpired();
      await fileSystem.writeFile(
        this.storagePath,
        JSON.stringify(this.memories, null, 2)
      );
    });
  }

  private enqueueSave(): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.cleanupExpired();
        await fileSystem.writeFile(
          this.storagePath,
          JSON.stringify(this.memories, null, 2)
        );
      } catch (error) {
        Logger.error('短期记忆写入失败', error as Error, 'ShortTermMemory');
      }
    });
  }

  public async cleanupExpired(): Promise<void> {
    this.ensureInitialized();

    await this.executeTransaction('cleanupExpired', async () => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const initialCount = this.memories.length;
      this.memories = this.memories.filter((memory) => {
        const memoryDate = new Date(memory.timestamp);
        return memoryDate >= thirtyDaysAgo;
      });

      const deletedCount = initialCount - this.memories.length;
      if (deletedCount > 0) {
        void deletedCount;
      }
    });
  }

  public async shutdown(): Promise<void> {
    await this.executeTransaction('shutdown', async () => {
      await this.writeQueue;
      await this.save();
      this.initialized = false;
    });
  }

  /** 获取所有记忆项的副本 */
  public getAll(): MemoryItem[] {
    return [...this.memories];
  }

  public async getRecentConversations(
    limit: number = 50
  ): Promise<MemoryItem[]> {
    this.ensureInitialized();

    return this.executeTransaction('getRecentConversations', async () => {
      const conversationMemories = this.memories
        .filter((memory) => {
          const contentStr =
            typeof memory.content === 'string'
              ? memory.content
              : JSON.stringify(memory.content);
          return (
            contentStr.includes('user_input') ||
            contentStr.includes('response') ||
            contentStr.includes('message') ||
            memory.scene === 'chat' ||
            memory.scene === 'daily'
          );
        })
        .sort((a, b) => {
          const dateA = new Date(a.timestamp).getTime();
          const dateB = new Date(b.timestamp).getTime();
          return dateB - dateA;
        })
        .slice(0, limit);

      return conversationMemories;
    }).catch(() => []);
  }
}
